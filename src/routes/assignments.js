const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { notify } = require("../notifications");
const { canManageStudent } = require("../access");

// Задания к урокам (как в GetCourse): врач пишет ответ, куратор принимает его
// или возвращает на доработку с комментарием. Плюс «Лента ответов» — всё, что
// врачи написали по урокам (ответы на задания, отзывы по модулям, анкеты), в
// одном месте для куратора.
const router = express.Router();

const MAX_ANSWER = 20000;
const MAX_COMMENT = 5000;
const STAFF = ["curator", "admin", "super_admin"];

// Куратор видит своих врачей и ещё никому не назначенных — как во всём остальном.
function scopeSql(user, alias, paramIdx) {
  if (user.role !== "curator") return { sql: "", params: [] };
  return { sql: ` AND (${alias}.assigned_curator_id = $${paramIdx} OR ${alias}.assigned_curator_id IS NULL)`, params: [user.id] };
}

/* ---------- Врач ---------- */

router.post("/lessons/:lessonId", authRequired, requireRole("student"), async (req, res) => {
  const answer = String((req.body && req.body.answer) || "").trim();
  if (!answer) return res.status(400).json({ error: "invalid_input", message: "Напишите ответ" });
  if (answer.length > MAX_ANSWER) return res.status(400).json({ error: "invalid_input", message: "Ответ слишком длинный" });

  const lesson = await pool.query(
    "SELECT id, course_id, title, assignment_prompt FROM lessons WHERE id=$1", [req.params.lessonId]
  );
  if (!lesson.rowCount || !(lesson.rows[0].assignment_prompt || "").trim()) {
    return res.status(404).json({ error: "not_found", message: "У этого урока нет задания" });
  }
  const l = lesson.rows[0];
  const pr = await pool.query(
    "SELECT access_blocked, access_expires_at FROM progress WHERE user_id=$1 AND course_id=$2", [req.user.id, l.course_id]
  );
  if (!pr.rowCount) return res.status(404).json({ error: "not_found", message: "Урок не найден в вашем курсе" });
  const p = pr.rows[0];
  const expired = p.access_expires_at && new Date(p.access_expires_at).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (p.access_blocked || expired) return res.status(403).json({ error: "access_locked", message: "Доступ к курсу ограничен" });

  const existing = await pool.query("SELECT id, status, history, attempts FROM assignment_submissions WHERE lesson_id=$1 AND user_id=$2", [l.id, req.user.id]);
  const entry = { at: new Date().toISOString(), kind: "submit", by: req.user.id, name: req.user.name, text: answer };
  let id;
  if (existing.rowCount) {
    const ex = existing.rows[0];
    if (ex.status === "accepted") return res.status(409).json({ error: "already_accepted", message: "Ответ уже принят куратором" });
    id = ex.id;
    const history = (ex.history || []).concat([entry]);
    // Правка ответа, который ещё ждёт проверки, — не новая попытка.
    const attempts = ex.status === "returned" ? ex.attempts + 1 : ex.attempts;
    await pool.query(
      `UPDATE assignment_submissions SET answer=$1, status='pending', submitted_at=now(), history=$2, attempts=$3 WHERE id=$4`,
      [answer, JSON.stringify(history), attempts, id]
    );
  } else {
    id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO assignment_submissions (id, lesson_id, course_id, user_id, answer, history) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, l.id, l.course_id, req.user.id, answer, JSON.stringify([entry])]
    );
  }
  await pool.query("UPDATE progress SET last_active_at=now() WHERE user_id=$1 AND course_id=$2", [req.user.id, l.course_id]);

  const cur = await pool.query("SELECT assigned_curator_id FROM users WHERE id=$1", [req.user.id]);
  if (cur.rowCount && cur.rows[0].assigned_curator_id) {
    await notify(cur.rows[0].assigned_curator_id, "assignment_submitted", "Новый ответ на задание",
      `${req.user.name} — урок «${l.title}».`);
  }
  const row = await pool.query("SELECT status, answer, submitted_at, attempts, history FROM assignment_submissions WHERE id=$1", [id]);
  res.json({ ok: true, submission: { status: row.rows[0].status, answer: row.rows[0].answer, submittedAt: row.rows[0].submitted_at, attempts: row.rows[0].attempts, history: row.rows[0].history } });
});

/* ---------- Персонал: очередь проверки ---------- */

router.get("/", authRequired, requireRole(...STAFF), async (req, res) => {
  const status = req.query.status || "pending";
  const params = [];
  let where = "u.role='student'";
  if (status !== "all") {
    if (["pending", "accepted", "returned"].indexOf(status) === -1) return res.status(400).json({ error: "invalid_input" });
    params.push(status); where += ` AND a.status=$${params.length}`;
  }
  if (req.query.courseId) { params.push(req.query.courseId); where += ` AND a.course_id=$${params.length}`; }
  if (req.query.lessonId) { params.push(req.query.lessonId); where += ` AND a.lesson_id=$${params.length}`; }
  if (req.query.studentId) { params.push(req.query.studentId); where += ` AND a.user_id=$${params.length}`; }
  const sc = scopeSql(req.user, "u", params.length + 1);
  where += sc.sql; params.push(...sc.params);

  const rows = await pool.query(
    `SELECT a.id, a.lesson_id, a.course_id, a.user_id, a.answer, a.status, a.curator_comment, a.reviewed_at,
            a.submitted_at, a.attempts, a.history,
            l.idx AS lesson_idx, l.title AS lesson_title, l.assignment_prompt, l.assignment_required,
            c.title AS course_title, u.name AS student_name, u.email AS student_email,
            CASE WHEN u.avatar_file IS NULL THEN NULL ELSE 'api/auth/avatar/' || u.avatar_file END AS avatar_url,
            r.name AS reviewer_name
     FROM assignment_submissions a
     JOIN users u ON u.id = a.user_id
     JOIN lessons l ON l.id = a.lesson_id
     JOIN courses c ON c.id = a.course_id
     LEFT JOIN users r ON r.id = a.reviewed_by
     WHERE ${where}
     ORDER BY CASE WHEN a.status='pending' THEN a.submitted_at END ASC NULLS LAST, COALESCE(a.reviewed_at, a.submitted_at) DESC
     LIMIT 300`,
    params
  );

  // Счётчики по статусам — для вкладок, с тем же скоупом и фильтром курса.
  const cParams = [];
  let cWhere = "u.role='student'";
  if (req.query.courseId) { cParams.push(req.query.courseId); cWhere += ` AND a.course_id=$${cParams.length}`; }
  const csc = scopeSql(req.user, "u", cParams.length + 1);
  cWhere += csc.sql; cParams.push(...csc.params);
  const counts = await pool.query(
    `SELECT a.status, COUNT(*)::int AS n FROM assignment_submissions a JOIN users u ON u.id = a.user_id WHERE ${cWhere} GROUP BY a.status`,
    cParams
  );
  const byStatus = { pending: 0, accepted: 0, returned: 0 };
  counts.rows.forEach((r) => { byStatus[r.status] = r.n; });

  res.json({ submissions: rows.rows, counts: byStatus });
});

router.post("/:id/review", authRequired, requireRole(...STAFF), async (req, res) => {
  const decision = req.body && req.body.decision;
  const comment = String((req.body && req.body.comment) || "").trim();
  if (decision !== "accept" && decision !== "return") return res.status(400).json({ error: "invalid_input" });
  if (decision === "return" && !comment) {
    return res.status(400).json({ error: "comment_required", message: "Напишите, что доработать — врач увидит комментарий" });
  }
  if (comment.length > MAX_COMMENT) return res.status(400).json({ error: "invalid_input", message: "Комментарий слишком длинный" });

  const found = await pool.query(
    `SELECT a.*, l.title AS lesson_title, u.name AS student_name FROM assignment_submissions a
     JOIN lessons l ON l.id = a.lesson_id JOIN users u ON u.id = a.user_id WHERE a.id=$1`,
    [req.params.id]
  );
  if (!found.rowCount) return res.status(404).json({ error: "not_found" });
  const a = found.rows[0];
  if (!(await canManageStudent(req.user, a.user_id))) {
    return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  }
  if (a.status !== "pending") {
    return res.status(409).json({ error: "already_reviewed", message: "Этот ответ уже проверен" });
  }

  const status = decision === "accept" ? "accepted" : "returned";
  const history = (a.history || []).concat([{ at: new Date().toISOString(), kind: decision, by: req.user.id, name: req.user.name, text: comment || null }]);
  await pool.query(
    `UPDATE assignment_submissions SET status=$1, curator_comment=$2, reviewed_by=$3, reviewed_at=now(), history=$4 WHERE id=$5`,
    [status, comment || null, req.user.id, JSON.stringify(history), a.id]
  );

  // Принятый ответ засчитывает урок — для стоп-урока это единственный способ его пройти.
  if (decision === "accept") {
    const pr = await pool.query("SELECT completed_lessons FROM progress WHERE user_id=$1 AND course_id=$2", [a.user_id, a.course_id]);
    if (pr.rowCount) {
      const list = pr.rows[0].completed_lessons || [];
      if (!list.includes(a.lesson_id)) {
        list.push(a.lesson_id);
        await pool.query("UPDATE progress SET completed_lessons=$1 WHERE user_id=$2 AND course_id=$3", [JSON.stringify(list), a.user_id, a.course_id]);
      }
    }
    await notify(a.user_id, "assignment_accepted", "Задание принято",
      `Куратор принял ваш ответ к уроку «${a.lesson_title}».` + (comment ? ` Комментарий: ${comment}` : ""));
  } else {
    await notify(a.user_id, "assignment_returned", "Задание вернули на доработку",
      `Урок «${a.lesson_title}»: ${comment}`);
  }
  await logAction(req.user, decision === "accept" ? "assignment.accept" : "assignment.return", "student", a.user_id, a.student_name,
    { lessonId: a.lesson_id, lessonTitle: a.lesson_title }, false);
  res.json({ ok: true, status });
});

/* ---------- Настройка задания у урока (администратор) ---------- */

router.put("/lessons/:lessonId/config", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const prompt = String((req.body && req.body.prompt) || "").trim();
  const required = !!(req.body && req.body.required) && !!prompt;
  if (prompt.length > MAX_ANSWER) return res.status(400).json({ error: "invalid_input", message: "Слишком длинная формулировка" });
  const r = await pool.query(
    "UPDATE lessons SET assignment_prompt=$1, assignment_required=$2 WHERE id=$3 RETURNING title",
    [prompt || null, required, req.params.lessonId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "assignment.config", "lesson", req.params.lessonId, r.rows[0].title, { required, hasPrompt: !!prompt }, false);
  res.json({ ok: true, assignment: prompt ? { prompt, required } : null });
});

/* ---------- Лента ответов ---------- */

// Всё, что врачи написали по обучению, одной лентой по времени: ответы на задания,
// отзывы о модулях, заполненные анкеты. Фильтр ?type=assignment|feedback|survey.
router.get("/feed", authRequired, requireRole(...STAFF), async (req, res) => {
  const type = req.query.type || "all";
  const courseId = req.query.courseId || null;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const items = [];

  const scope = (alias, params) => {
    const sc = scopeSql(req.user, alias, params.length + 1);
    params.push(...sc.params);
    return sc.sql;
  };
  const who = `u.id AS student_id, u.name AS student_name,
    CASE WHEN u.avatar_file IS NULL THEN NULL ELSE 'api/auth/avatar/' || u.avatar_file END AS avatar_url`;

  if (type === "all" || type === "assignment") {
    const p = [];
    let w = "u.role='student'";
    if (courseId) { p.push(courseId); w += ` AND a.course_id=$${p.length}`; }
    w += scope("u", p);
    p.push(limit);
    const r = await pool.query(
      `SELECT a.id, a.answer AS text, a.status, a.submitted_at AS at, a.attempts, a.curator_comment,
              l.idx AS lesson_idx, l.title AS lesson_title, c.title AS course_title, ${who}
       FROM assignment_submissions a JOIN users u ON u.id=a.user_id JOIN lessons l ON l.id=a.lesson_id JOIN courses c ON c.id=a.course_id
       WHERE ${w} ORDER BY a.submitted_at DESC LIMIT $${p.length}`, p
    );
    r.rows.forEach((x) => items.push(Object.assign({ type: "assignment" }, x)));
  }
  if (type === "all" || type === "feedback") {
    const p = [];
    let w = "u.role='student'";
    if (courseId) { p.push(courseId); w += ` AND m.course_id=$${p.length}`; }
    w += scope("u", p);
    p.push(limit);
    const r = await pool.query(
      `SELECT f.id, f.comment AS text, f.rating, f.created_at AS at, m.title AS module_title, c.title AS course_title, ${who}
       FROM module_feedback f JOIN users u ON u.id=f.user_id JOIN modules m ON m.id=f.module_id JOIN courses c ON c.id=m.course_id
       WHERE ${w} ORDER BY f.created_at DESC LIMIT $${p.length}`, p
    );
    r.rows.forEach((x) => items.push(Object.assign({ type: "feedback" }, x)));
  }
  if (type === "all" || type === "survey") {
    const p = [];
    let w = "u.role='student'";
    if (courseId) { p.push(courseId); w += ` AND (s.course_id IS NULL OR s.course_id=$${p.length})`; }
    w += scope("u", p);
    p.push(limit);
    const r = await pool.query(
      `SELECT sr.id, sr.answers, sr.created_at AS at, s.id AS survey_id, s.title AS survey_title, s.questions, ${who}
       FROM survey_responses sr JOIN users u ON u.id=sr.user_id JOIN surveys s ON s.id=sr.survey_id
       WHERE ${w} ORDER BY sr.created_at DESC LIMIT $${p.length}`, p
    );
    r.rows.forEach((x) => {
      // Короткая выжимка ответов — вопрос: ответ, чтобы в ленте было видно суть.
      const lines = (x.questions || []).map((q) => {
        const v = (x.answers || {})[q.id];
        if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
        let shown;
        if (q.type === "single") shown = (q.options || [])[v];
        else if (q.type === "multi") shown = (Array.isArray(v) ? v : []).map((i) => (q.options || [])[i]).filter(Boolean).join(", ");
        else if (q.type === "scale") shown = v + " из " + (q.max || 5);
        else shown = String(v);
        return shown ? { q: q.text, a: shown } : null;
      }).filter(Boolean);
      items.push({ type: "survey", id: x.id, at: x.at, survey_id: x.survey_id, survey_title: x.survey_title, lines,
        student_id: x.student_id, student_name: x.student_name, avatar_url: x.avatar_url });
    });
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ items: items.slice(0, limit) });
});

module.exports = router;
