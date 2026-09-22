const express = require("express");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// Единый список мьютов текущего пользователя (оба типа чатов сразу) — фронтенду
// нужен один запрос при загрузке, а не отдельный на каждый чат/поток.
router.get("/", authRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT chat_type, chat_key FROM chat_mutes WHERE user_id=$1",
    [req.user.id]
  );
  res.json({ mutes: result.rows });
});

module.exports = router;
