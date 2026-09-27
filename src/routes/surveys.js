const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { notify } = require("../notifications");

// Анкеты и опросы: администратор собирает анкету из вопросов (один вариант,
// несколько вариантов, шкала, свободный ответ), врачи заполняют её у себя на
// главной, персонал видит сводку по каждому вопросу и ответы поимённо.
const router = express.Router();
const STAFF = ["curator", "admin", "super_admin"];
const ADMIN = ["admin", "super_admin"];
const TYPES = ["single", "multi", "scale", "text"];

function cleanQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: "Добавьте хотя бы один вопрос" };
  if (raw.length > 50) return { error: "Не больше 50 вопросов" };
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {};
    const type = TYPES.indexOf(q.type) !== -1 ? q.type : null;
    const text = String(q.text || "").trim();
    if (!type) return { error: `Вопрос ${i + 1}: неизвестный тип` };
    if (!text) return { error: `Вопрос ${i + 1}: напишите формулировку` };
    const item = { id: typeof q.id === "string" && /^[\w-]{1,64}$/.test(q.id) ? q.id : crypto.randomUUID().slice(0, 12), type, text: text.slice(0, 500), required: !!q.required };
    if (type === "single" || type === "multi") {
      const opts = (Array.isArray(q.options) ? q.options : []).map((o) => String(o || "").trim().slice(0, 200)).filter(Boolean);
      if (opts.length < 2) return { error: `Вопрос ${i + 1}: нужно минимум два варианта ответа` };
      item.options = opts.slice(0, 20);
    }
    if (type === "scale") item.max = q.max === 10 || q.max === "10" ? 10 : 5;
    out.push(item);
  }
  const ids = new Set(out.map((q) => q.id));
  if (ids.size !== out.length) return { error: "Повторяющиеся вопросы" };
  return { questions: out };
}

function readSurvey(body) {
  const title = String((body && body.title) || "").trim();
  if (!title || title.length > 200) return { error: "Укажите название анкеты" };
  const q = cleanQuestions(body.questions);
  if (q.error) return q;
  return {
    title, description: String(body.description || "").trim().slice(0, 2000) || null,
    questions: q.questions, courseId: body.courseId || null, active: body.active === undefined ? true : !!body.active
  };
}

/* ---------- Персонал ---------- */

router.get("/", authRequired, requireRole(...STAFF), async (req, res) => {
  const r = await pool.query(
    `SELECT s.*, c.title AS course_title,
       (SELECT COUNT(*)::int FROM survey_responses sr WHERE sr.survey_id=s.id) AS responses_count,
       (SELECT COUNT(*)::int FROM users u WHERE u.role='student' AND
          (s.course_id IS NULL OR EXISTS (SELECT 1 FROM progress p WHERE p.user_id=u.id AND p.course_id=s.course_id))) AS audience_count
     FROM surveys s LEFT JOIN courses c ON c.id=s.course_id ORDER BY s.active DESC, s.created_at DESC`
  );
  res.json({ surveys: r.rows });
});

router.post("/", authRequired, requireRole(...ADMIN), async (req, res) => {
  const s = readSurvey(req.body || {});
  if (s.error) return res.status(400).json({ error: "invalid_input", message: s.error });
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO surveys (id, title, description, questions, course_id, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, s.title, s.description, JSON.stringify(s.questions), s.courseId, s.active, req.user.id]
  );
  // Новая активная анкета — уведомление каждому врачу из её аудитории.
  if (s.active) {
    const aud = await pool.query(
      s.courseId ? "SELECT user_id AS id FROM progress WHERE course_id=$1" : "SELECT id FROM users WHERE role='student'",
      s.courseId ? [s.courseId] : []
    );
    for (const u of aud.rows) await notify(u.id, "survey_new", "Новая анкета", `«${s.title}» — займёт пару минут, она на главной.`);
  }
  await logAction(req.user, "survey.create", "survey", id, s.title, { questions: s.questions.length }, false);
  res.json({ ok: true, id });
});

router.put("/:id", authRequired, requireRole(...ADMIN), async (req, res) => {
  const s = readSurvey(req.body || {});
  if (s.error) return res.status(400).json({ error: "invalid_input", message: s.error });
  const r = await pool.query(
    "UPDATE surveys SET title=$1, description=$2, questions=$3, course_id=$4, active=$5 WHERE id=$6",
    [s.title, s.description, JSON.stringify(s.questions), s.courseId, s.active, req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "survey.update", "survey", req.params.id, s.title, { active: s.active }, false);
  res.json({ ok: true });
});

router.delete("/:id", authRequired, requireRole(...ADMIN), async (req, res) => {
  const r = await pool.query("DELETE FROM surveys WHERE id=$1 RETURNING title", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "survey.delete", "survey", req.params.id, r.rows[0].title, {}, false);
  res.json({ ok: true });
});

// Сводка по каждому вопросу + ответы поимённо. Сводка — по всем ответам (это
// общая статистика анкеты), поимённый список куратору — только по его врачам.
router.get("/:id/results", authRequired, requireRole(...STAFF), async (req, res) => {
  const s = await pool.query("SELECT s.*, c.title AS course_title FROM surveys s LEFT JOIN courses c ON c.id=s.course_id WHERE s.id=$1", [req.params.id]);
  if (!s.rowCount) return res.status(404).json({ error: "not_found" });
  const survey = s.rows[0];
  const all = await pool.query("SELECT answers FROM survey_responses WHERE survey_id=$1", [survey.id]);

  const summary = survey.questions.map((q) => {
    const vals = all.rows.map((r) => (r.answers || {})[q.id]).filter((v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
    const out = { id: q.id, answered: vals.length };
    if (q.type === "single" || q.type === "multi") {
      out.counts = q.options.map(() => 0);
      vals.forEach((v) => (Array.isArray(v) ? v : [v]).forEach((i) => { if (out.counts[i] !== undefined) out.counts[i]++; }));
    } else if (q.type === "scale") {
      out.counts = Array(q.max).fill(0);
      vals.forEach((v) => { if (out.counts[v - 1] !== undefined) out.counts[v - 1]++; });
      out.avg = vals.length ? Math.round((vals.reduce((a, b) => a + Number(b), 0) / vals.length) * 10) / 10 : null;
    }
    return out;
  });

  const params = [survey.id];
  let scope = "";
  if (req.user.role === "curator") { params.push(req.user.id); scope = " AND (u.assigned_curator_id=$2 OR u.assigned_curator_id IS NULL)"; }
  const responses = await pool.query(
    `SELECT sr.id, sr.answers, sr.created_at, u.id AS student_id, u.name AS student_name,
       CASE WHEN u.avatar_file IS NULL THEN NULL ELSE 'api/auth/avatar/' || u.avatar_file END AS avatar_url
     FROM survey_responses sr JOIN users u ON u.id=sr.user_id WHERE sr.survey_id=$1${scope} ORDER BY sr.created_at DESC`,
    params
  );
  // Кто из аудитории анкеты ещё не ответил — куратору, чтобы было кому напомнить
  // (в его скоупе, как и поимённый список).
  const pParams = [survey.id];
  let pWhere = "u.role='student' AND NOT EXISTS (SELECT 1 FROM survey_responses sr WHERE sr.survey_id=$1 AND sr.user_id=u.id)";
  if (survey.course_id) { pParams.push(survey.course_id); pWhere += ` AND EXISTS (SELECT 1 FROM progress p WHERE p.user_id=u.id AND p.course_id=$${pParams.length})`; }
  if (req.user.role === "curator") { pParams.push(req.user.id); pWhere += ` AND (u.assigned_curator_id=$${pParams.length} OR u.assigned_curator_id IS NULL)`; }
  const pending = await pool.query(
    `SELECT u.id AS student_id, u.name AS student_name,
       CASE WHEN u.avatar_file IS NULL THEN NULL ELSE 'api/auth/avatar/' || u.avatar_file END AS avatar_url
     FROM users u WHERE ${pWhere} ORDER BY u.name`,
    pParams
  );
  res.json({ survey, summary, total: all.rowCount, responses: responses.rows, pending: pending.rows });
});

/* ---------- Врач ---------- */

router.get("/mine", authRequired, requireRole("student"), async (req, res) => {
  const r = await pool.query(
    `SELECT s.id, s.title, s.description, s.questions, s.created_at, sr.answers AS my_answers, sr.created_at AS answered_at
     FROM surveys s LEFT JOIN survey_responses sr ON sr.survey_id=s.id AND sr.user_id=$1
     WHERE s.active AND (s.course_id IS NULL OR EXISTS (SELECT 1 FROM progress p WHERE p.user_id=$1 AND p.course_id=s.course_id))
     ORDER BY (sr.id IS NULL) DESC, s.created_at DESC`,
    [req.user.id]
  );
  res.json({ surveys: r.rows });
});

router.post("/:id/respond", authRequired, requireRole("student"), async (req, res) => {
  const s = await pool.query(
    `SELECT * FROM surveys s WHERE s.id=$1 AND s.active AND
       (s.course_id IS NULL OR EXISTS (SELECT 1 FROM progress p WHERE p.user_id=$2 AND p.course_id=s.course_id))`,
    [req.params.id, req.user.id]
  );
  if (!s.rowCount) return res.status(404).json({ error: "not_found", message: "Анкета не найдена или уже закрыта" });
  const raw = (req.body && req.body.answers) || {};
  const answers = {};
  for (const q of s.rows[0].questions) {
    let v = raw[q.id];
    if (q.type === "single") v = Number.isInteger(v) && v >= 0 && v < q.options.length ? v : null;
    else if (q.type === "multi") v = Array.isArray(v) ? Array.from(new Set(v.filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length))).sort() : [];
    else if (q.type === "scale") v = Number.isInteger(v) && v >= 1 && v <= q.max ? v : null;
    else v = typeof v === "string" ? v.trim().slice(0, 5000) : "";
    const empty = v === null || v === "" || (Array.isArray(v) && !v.length);
    if (q.required && empty) return res.status(400).json({ error: "required", message: `Ответьте на вопрос «${q.text}»`, questionId: q.id });
    if (!empty) answers[q.id] = v;
  }
  await pool.query(
    `INSERT INTO survey_responses (id, survey_id, user_id, answers) VALUES ($1,$2,$3,$4)
     ON CONFLICT (survey_id, user_id) DO UPDATE SET answers=$4, created_at=now()`,
    [crypto.randomUUID(), req.params.id, req.user.id, JSON.stringify(answers)]
  );
  res.json({ ok: true, answers });
});

module.exports = router;
