const express = require("express");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT id, type, title, body, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
    [req.user.id]
  );
  const unread = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id=$1 AND read_at IS NULL",
    [req.user.id]
  );
  res.json({ notifications: result.rows, unreadCount: unread.rows[0].cnt });
});

router.post("/:id/read", authRequired, async (req, res) => {
  await pool.query(
    "UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL",
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

router.post("/read-all", authRequired, async (req, res) => {
  await pool.query(
    "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
    [req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
