const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

router.get("/:studentId", authRequired, async (req, res) => {
  const { studentId } = req.params;
  if (req.user.role === "student" && req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  const result = await pool.query(
    "SELECT id, from_role, author_name, body, created_at FROM messages WHERE student_id=$1 ORDER BY created_at ASC",
    [studentId]
  );
  // Врач читает свой же чат — отмечаем момент прочтения, чтобы бейдж непрочитанного
  // на вкладке «Сообщения» погас (см. unreadMessages в GET /course).
  if (req.user.role === "student") {
    await pool.query("UPDATE progress SET messages_read_at=now() WHERE user_id=$1", [studentId]);
  }
  res.json({ messages: result.rows });
});

router.post("/", authRequired, async (req, res) => {
  const { studentId, text } = req.body || {};
  if (!studentId || !text || !text.trim()) return res.status(400).json({ error: "invalid_input" });
  if (req.user.role === "student" && req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  const fromRole = req.user.role === "student" ? "student" : "curator";
  await pool.query(
    "INSERT INTO messages (id, student_id, from_role, author_name, body) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), studentId, fromRole, req.user.name, text.trim()]
  );
  res.json({ ok: true });
});

module.exports = router;
