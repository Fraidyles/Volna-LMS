const crypto = require("crypto");
const pool = require("./db");

async function notify(userId, type, title, body) {
  await pool.query(
    "INSERT INTO notifications (id, user_id, type, title, body) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), userId, type, title, body || null]
  );
}

// Разослать всем врачам сразу — используется для общеплатформенных событий
// (не привязанных к конкретному курсу).
async function notifyAllStudents(type, title, body) {
  const rows = await pool.query("SELECT id FROM users WHERE role='student'");
  for (const row of rows.rows) {
    await notify(row.id, type, title, body);
  }
}

// То же самое, но только тем врачам, кто записан именно на этот курс (см. progress) —
// «появился новый урок» в курсе А не должно прилетать врачу, который учится только на курсе Б.
async function notifyEnrolledStudents(courseId, type, title, body) {
  const rows = await pool.query("SELECT user_id FROM progress WHERE course_id=$1", [courseId]);
  for (const row of rows.rows) {
    await notify(row.user_id, type, title, body);
  }
}

module.exports = { notify, notifyAllStudents, notifyEnrolledStudents };
