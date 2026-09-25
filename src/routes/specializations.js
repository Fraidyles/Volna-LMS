const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

// Публично (без авторизации) — форма регистрации показывает список специализаций
// ДО того, как врач вошёл в систему.
router.get("/", async (req, res) => {
  const result = await pool.query("SELECT id, name FROM specializations ORDER BY name");
  res.json({ specializations: result.rows });
});

router.post("/", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название специализации" });
  }
  const id = crypto.randomUUID();
  try {
    await pool.query("INSERT INTO specializations (id, name) VALUES ($1,$2)", [id, name.trim()]);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "duplicate", message: "Такая специализация уже есть" });
    throw e;
  }
  await logAction(req.user, "specialization.create", "specialization", id, name.trim(), {});
  res.json({ id, name: name.trim() });
});

router.put("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название специализации" });
  }
  const before = await pool.query("SELECT name FROM specializations WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  try {
    await pool.query("UPDATE specializations SET name=$1 WHERE id=$2", [name.trim(), req.params.id]);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "duplicate", message: "Такая специализация уже есть" });
    throw e;
  }
  await logAction(req.user, "specialization.update", "specialization", req.params.id, name.trim(), {
    before: { name: before.rows[0].name }
  });
  res.json({ ok: true });
});

router.delete("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT name FROM specializations WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });

  // Специализация может быть уже назначена врачам или использоваться в гайдах
  // протоколов — молча ронять эти связи через ON DELETE CASCADE было бы опасно
  // (врач тихо лишится специализации, протокол — гайда), поэтому запрещаем удаление,
  // пока есть ссылки, и просим сначала переназначить их.
  const inUse = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM user_specializations WHERE specialization_id=$1) AS users_count,
       (SELECT COUNT(*)::int FROM user_specialization_interests WHERE specialization_id=$1) AS interests_count,
       (SELECT COUNT(*)::int FROM protocol_guides WHERE specialization_id=$1) AS guides_count`,
    [req.params.id]
  );
  const u = inUse.rows[0];
  if (u.users_count > 0 || u.interests_count > 0 || u.guides_count > 0) {
    return res.status(400).json({
      error: "in_use",
      message: "Эта специализация используется у врачей или в гайдах протоколов — сначала переназначьте их"
    });
  }

  await pool.query("DELETE FROM specializations WHERE id=$1", [req.params.id]);
  await logAction(req.user, "specialization.delete", "specialization", req.params.id, before.rows[0].name, {});
  res.json({ ok: true });
});

module.exports = router;
