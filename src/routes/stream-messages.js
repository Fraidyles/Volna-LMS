const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

function isStaff(role) {
  return role === "curator" || role === "admin" || role === "super_admin";
}

// Врач может читать/писать только в чат СВОЕГО потока — проверяем его текущий
// stream_id в базе, а не то, что он передал в URL.
async function canAccessStream(user, streamId) {
  if (isStaff(user.role)) return true;
  if (user.role !== "student") return false;
  const row = await pool.query("SELECT stream_id FROM users WHERE id=$1", [user.id]);
  return row.rowCount && row.rows[0].stream_id === streamId;
}

router.get("/:streamId", authRequired, async (req, res) => {
  const { streamId } = req.params;
  if (!(await canAccessStream(req.user, streamId))) {
    return res.status(403).json({ error: "forbidden" });
  }
  const result = await pool.query(
    "SELECT id, author_id, author_name, author_role, body, created_at FROM stream_messages WHERE stream_id=$1 ORDER BY created_at ASC",
    [streamId]
  );
  res.json({ messages: result.rows });
});

router.post("/:streamId", authRequired, async (req, res) => {
  const { streamId } = req.params;
  const text = req.body && req.body.text;
  if (!text || !text.trim()) return res.status(400).json({ error: "invalid_input" });
  if (!(await canAccessStream(req.user, streamId))) {
    return res.status(403).json({ error: "forbidden" });
  }
  const stream = await pool.query("SELECT id FROM streams WHERE id=$1", [streamId]);
  if (!stream.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query(
    "INSERT INTO stream_messages (id, stream_id, author_id, author_name, author_role, body) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), streamId, req.user.id, req.user.name, req.user.role, text.trim()]
  );
  res.json({ ok: true });
});

module.exports = router;
