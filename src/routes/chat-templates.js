const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

// Общая библиотека шаблонов на всю команду (не персональная — см. комментарий
// в schema.sql), поэтому доступ у всех curator/admin/super_admin одинаковый:
// создавать, править и удалять может любой, кто вообще видит чаты.
router.get("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    "SELECT id, title, body, created_by, created_at FROM chat_templates ORDER BY created_at ASC"
  );
  res.json({ templates: result.rows });
});

router.post("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !title.trim() || !body || !body.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название и текст шаблона" });
  }
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO chat_templates (id, title, body, created_by) VALUES ($1,$2,$3,$4)",
    [id, title.trim(), body.trim(), req.user.name]
  );
  await logAction(req.user, "chat_template.create", "chat_template", id, title.trim(), { body: body.trim() });
  res.json({ id, title: title.trim(), body: body.trim() });
});

router.put("/:id", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !title.trim() || !body || !body.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название и текст шаблона" });
  }
  const result = await pool.query(
    "UPDATE chat_templates SET title=$1, body=$2 WHERE id=$3 RETURNING id",
    [title.trim(), body.trim(), req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "chat_template.update", "chat_template", req.params.id, title.trim(), { body: body.trim() });
  res.json({ ok: true });
});

router.delete("/:id", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const existing = await pool.query("SELECT title FROM chat_templates WHERE id=$1", [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM chat_templates WHERE id=$1", [req.params.id]);
  await logAction(req.user, "chat_template.delete", "chat_template", req.params.id, existing.rows[0].title, {});
  res.json({ ok: true });
});

module.exports = router;
