const crypto = require("crypto");
const pool = require("./db");

async function notify(userId, type, title, body) {
  await pool.query(
    "INSERT INTO notifications (id, user_id, type, title, body) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), userId, type, title, body || null]
  );
}

// Разослать всем врачам сразу — используется для событий уровня курса
// (например, «появился новый урок»), а не конкретного человека.
async function notifyAllStudents(type, title, body) {
  const rows = await pool.query("SELECT id FROM users WHERE role='student'");
  for (const row of rows.rows) {
    await notify(row.id, type, title, body);
  }
}

module.exports = { notify, notifyAllStudents };
