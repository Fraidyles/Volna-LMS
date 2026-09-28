// Глоссарий курса. Врач получает термины своего курса и список уже открытых им
// статей (по нему фронтенд решает, подсвечивать ли термин в следующих уроках);
// персонал — термины любого курса (предпросмотр «как видит врач»).
const express = require("express");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");

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

module.exports = router;
