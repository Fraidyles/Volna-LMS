// Глоссарий курса. Врач получает термины своего курса и список уже открытых им
// статей (по нему фронтенд решает, подсвечивать ли термин в следующих уроках);
// персонал — термины любого курса (предпросмотр «как видит врач»).
const express = require("express");
const pool = require("../db");
const crypto = require("crypto");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { validateTerm, lessonsWith } = require("../glossary");

const router = express.Router();

function termOut(r) {
  return { id: r.id, lessonId: r.lesson_id, title: r.title, category: r.category, aliases: r.aliases, lead: r.lead, body: r.body };
}

router.get("/", authRequired, async (req, res) => {
  const courseId = String(req.query.courseId || "");
  if (!courseId) return res.status(400).json({ error: "invalid_input" });
  if (req.user.role === "student") {
    const enrolled = await pool.query("SELECT 1 FROM progress WHERE user_id=$1 AND course_id=$2", [req.user.id, courseId]);
    if (!enrolled.rowCount) return res.status(404).json({ error: "no_progress" });
  }
  const terms = await pool.query("SELECT * FROM glossary_terms WHERE course_id=$1 ORDER BY idx", [courseId]);
  let seen = [];
  if (req.user.role === "student") {
    const s = await pool.query(
      "SELECT gs.term_id FROM glossary_seen gs JOIN glossary_terms t ON t.id = gs.term_id WHERE gs.user_id=$1 AND t.course_id=$2",
      [req.user.id, courseId]
    );
    seen = s.rows.map((r) => r.term_id);
  }
  res.json({ terms: terms.rows.map(termOut), seen });
});

// Врач открыл статью — запоминаем (повторные открытия ничего не меняют).
router.post("/:id/seen", authRequired, requireRole("student"), async (req, res) => {
  const t = await pool.query(
    "SELECT t.id FROM glossary_terms t JOIN progress p ON p.course_id = t.course_id AND p.user_id=$2 WHERE t.id=$1",
    [req.params.id, req.user.id]
  );
  if (!t.rowCount) return res.status(404).json({ error: "not_found" });
  // Сотрудник в кабинете врача (просмотр глазами врача) ничего врачу не отмечает.
  if (!req.user.imp) {
    await pool.query("INSERT INTO glossary_seen (user_id, term_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.user.id, req.params.id]);
  }
  res.json({ ok: true });
});

/* ---------- Раздел «Термины» у куратора и администратора ---------- */
const STAFF = ["curator", "admin", "super_admin"];

// Список с тем, в каких уроках термин реально найден, — чтобы в админке было видно
// термин, который не подсветится (написания не совпадают с текстом урока).
router.get("/admin", authRequired, requireRole(...STAFF), async (req, res) => {
  const courseId = String(req.query.courseId || "");
  if (!courseId) return res.json({ terms: [] });
  const [terms, lessons] = await Promise.all([
    pool.query("SELECT * FROM glossary_terms WHERE course_id=$1 ORDER BY idx, title", [courseId]),
    pool.query("SELECT id, html FROM lessons WHERE course_id=$1 ORDER BY idx", [courseId])
  ]);
  res.json({ terms: terms.rows.map((r) => Object.assign(termOut(r), { foundIn: lessonsWith(r.aliases, lessons.rows) })) });
});

// Живая проверка в форме термина: где в уроках курса находятся введённые написания.
router.post("/check", authRequired, requireRole(...STAFF), async (req, res) => {
  const courseId = String((req.body && req.body.courseId) || "");
  const aliases = (Array.isArray(req.body && req.body.aliases) ? req.body.aliases : []).map((a) => String(a || "").trim()).filter(Boolean).slice(0, 20);
  if (!courseId || !aliases.length) return res.json({ foundIn: [] });
  const lessons = await pool.query("SELECT id, html FROM lessons WHERE course_id=$1 ORDER BY idx", [courseId]);
  res.json({ foundIn: lessonsWith(aliases, lessons.rows) });
});

async function checkLesson(courseId, lessonId) {
  if (!lessonId) return true;
  const r = await pool.query("SELECT 1 FROM lessons WHERE id=$1 AND course_id=$2", [lessonId, courseId]);
  return r.rowCount > 0;
}

router.post("/", authRequired, requireRole(...STAFF), async (req, res) => {
  const courseId = String((req.body && req.body.courseId) || "");
  const course = await pool.query("SELECT id FROM courses WHERE id=$1", [courseId]);
  if (!course.rowCount) return res.status(400).json({ error: "invalid_input", message: "Не выбран курс" });
  const v = validateTerm(req.body);
  if (v.error) return res.status(400).json({ error: "invalid_input", message: v.error });
  if (!(await checkLesson(courseId, v.value.lessonId))) return res.status(400).json({ error: "invalid_input", message: "Урок не из этого курса" });
  const id = "g-" + crypto.randomUUID().slice(0, 12);
  const idx = await pool.query("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM glossary_terms WHERE course_id=$1", [courseId]);
  const t = v.value;
  await pool.query(
    `INSERT INTO glossary_terms (id, course_id, lesson_id, idx, title, category, aliases, lead, body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, courseId, t.lessonId, idx.rows[0].n, t.title, t.category, JSON.stringify(t.aliases), t.lead, JSON.stringify(t.body)]
  );
  await logAction(req.user, "glossary.create", "glossary", id, t.title, {});
  res.json({ ok: true, id });
});

router.put("/:id", authRequired, requireRole(...STAFF), async (req, res) => {
  const cur = await pool.query("SELECT course_id FROM glossary_terms WHERE id=$1", [req.params.id]);
  if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
  const v = validateTerm(req.body);
  if (v.error) return res.status(400).json({ error: "invalid_input", message: v.error });
  if (!(await checkLesson(cur.rows[0].course_id, v.value.lessonId))) return res.status(400).json({ error: "invalid_input", message: "Урок не из этого курса" });
  const t = v.value;
  await pool.query(
    "UPDATE glossary_terms SET lesson_id=$2, title=$3, category=$4, aliases=$5, lead=$6, body=$7 WHERE id=$1",
    [req.params.id, t.lessonId, t.title, t.category, JSON.stringify(t.aliases), t.lead, JSON.stringify(t.body)]
  );
  await logAction(req.user, "glossary.update", "glossary", req.params.id, t.title, {});
  res.json({ ok: true });
});

router.delete("/:id", authRequired, requireRole(...STAFF), async (req, res) => {
  const cur = await pool.query("DELETE FROM glossary_terms WHERE id=$1 RETURNING title", [req.params.id]);
  if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "glossary.delete", "glossary", req.params.id, cur.rows[0].title, {});
  res.json({ ok: true });
});

module.exports = router;
