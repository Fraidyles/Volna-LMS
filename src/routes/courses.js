const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

// Куратор тоже должен видеть список курсов (чтобы записать врача на дополнительный
// курс, см. /staff/students/:id/enroll) — редактирует и создаёт только admin/super_admin.
router.get("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.title, c.certificates_enabled, c.created_at, COUNT(p.user_id)::int AS enrolled_count
     FROM courses c LEFT JOIN progress p ON p.course_id = c.id
     GROUP BY c.id ORDER BY c.created_at`
  );
  res.json({
    courses: result.rows.map((r) => ({
      id: r.id, title: r.title, certificatesEnabled: r.certificates_enabled,
      createdAt: r.created_at, enrolledCount: r.enrolled_count
    }))
  });
});

router.post("/", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название курса" });
  }
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO courses (id, title) VALUES ($1,$2)", [id, title.trim()]);
  await logAction(req.user, "course.create", "course", id, title.trim(), {}, true);
  res.json({ ok: true, id, title: title.trim() });
});

router.put("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title, certificatesEnabled } = req.body || {};
  const before = await pool.query("SELECT title, certificates_enabled FROM courses WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });

  const nextTitle = title !== undefined ? title : before.rows[0].title;
  if (!nextTitle || !nextTitle.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название курса" });
  }
  const nextCertsEnabled = certificatesEnabled !== undefined ? !!certificatesEnabled : before.rows[0].certificates_enabled;

  await pool.query(
    "UPDATE courses SET title=$1, certificates_enabled=$2 WHERE id=$3",
    [nextTitle.trim(), nextCertsEnabled, req.params.id]
  );
  await logAction(req.user, "course.update", "course", req.params.id, nextTitle.trim(), {
    before: { title: before.rows[0].title, certificatesEnabled: before.rows[0].certificates_enabled }
  });
  res.json({ ok: true });
});

// Удаление курса каскадно уносит все его уроки/тесты/модули и прогресс записанных
// врачей (FK ON DELETE CASCADE везде, включая progress — см. Этап 23 в schema.sql,
// сам аккаунт врача при этом не трогается) — это разрушительно и безвозвратно,
// поэтому требуем подтверждение названием курса (тот же паттерн, что и везде в
// проекте для опасных удалений), а не просто кнопку "Удалить".
router.delete("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { confirmTitle } = req.body || {};
  const course = await pool.query("SELECT title FROM courses WHERE id=$1", [req.params.id]);
  if (!course.rowCount) return res.status(404).json({ error: "not_found" });
  if ((confirmTitle || "").trim() !== course.rows[0].title) {
    return res.status(400).json({ error: "confirm_mismatch", message: "Название для подтверждения не совпадает" });
  }

  const enrolled = await pool.query("SELECT COUNT(*)::int AS c FROM progress WHERE course_id=$1", [req.params.id]);
  await pool.query("DELETE FROM courses WHERE id=$1", [req.params.id]);
  await logAction(req.user, "course.delete", "course", req.params.id, course.rows[0].title, {
    before: { title: course.rows[0].title, enrolledCount: enrolled.rows[0].c }
  }, true);
  res.json({ ok: true });
});

module.exports = router;
