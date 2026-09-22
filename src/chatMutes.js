const pool = require("./db");

async function setChatMuted(userId, chatType, chatKey, muted) {
  if (muted) {
    await pool.query(
      "INSERT INTO chat_mutes (user_id, chat_type, chat_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [userId, chatType, chatKey]
    );
  } else {
    await pool.query(
      "DELETE FROM chat_mutes WHERE user_id=$1 AND chat_type=$2 AND chat_key=$3",
      [userId, chatType, chatKey]
    );
  }
}

async function isChatMuted(userId, chatType, chatKey) {
  const row = await pool.query(
    "SELECT 1 FROM chat_mutes WHERE user_id=$1 AND chat_type=$2 AND chat_key=$3",
    [userId, chatType, chatKey]
  );
  return row.rowCount > 0;
}

module.exports = { setChatMuted, isChatMuted };
