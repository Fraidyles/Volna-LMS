const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");
const { canManageStudent } = require("../access");

const router = express.Router();

router.get("/:studentId", authRequired, async (req, res) => {
  const { studentId } = req.params;
  if (req.user.role === "student" && req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (req.user.role !== "student" && !(await canManageStudent(req.user, studentId))) {
    return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  }
  const result = await pool.query(
    "SELECT id, from_role, author_name, body, created_at FROM messages WHERE student_id=$1 ORDER BY created_at ASC",
    [studentId]
  );
  res.json({ messages: result.rows });
});

// Отмечать прочитанным нарочно вынесено из GET выше в отдельное явное действие:
// GET дергает ещё и фоновый поллинг открытого чата каждые 4с, и если бы он сам
// отмечал прочитанным на каждый тик, «Пометить непрочитанным» ниже отменялось бы
// следующим же тиком поллинга, пока чат остаётся открытым.
router.post("/:studentId/mark-read", authRequired, async (req, res) => {
  const { studentId } = req.params;
  if (req.user.role !== "student" || req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await pool.query("UPDATE progress SET messages_read_at=now() WHERE user_id=$1", [studentId]);
  res.json({ ok: true });
});

// Врач сам возвращает свой чат в непрочитанные — как «Пометить непрочитанным» в почте,
// например если хочет вернуться к сообщению куратора позже.
router.post("/:studentId/mark-unread", authRequired, async (req, res) => {
  const { studentId } = req.params;
  if (req.user.role !== "student" || req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  await pool.query("UPDATE progress SET messages_read_at=NULL WHERE user_id=$1", [studentId]);
  res.json({ ok: true });
});

router.post("/", authRequired, async (req, res) => {
  const { studentId, text } = req.body || {};
  if (!studentId || !text || !text.trim()) return res.status(400).json({ error: "invalid_input" });
  if (req.user.role === "student" && req.user.id !== studentId) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (req.user.role !== "student" && !(await canManageStudent(req.user, studentId))) {
    return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
  }
  const fromRole = req.user.role === "student" ? "student" : "curator";
  await pool.query(
    "INSERT INTO messages (id, student_id, from_role, author_name, body) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), studentId, fromRole, req.user.name, text.trim()]
  );
  res.json({ ok: true });
});

module.exports = router;
