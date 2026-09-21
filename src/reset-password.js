/**
 * Восстановление пароля главного администратора (или любого пользователя) напрямую
 * через терминал сервера — на случай если зайти в панель уже некому.
 *
 * Использование:
 *   node src/reset-password.js email@example.com новыйПароль123
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("./db");

(async () => {
  const email = (process.argv[2] || "").trim().toLowerCase();
  const password = process.argv[3] || "";

  if (!email || !password || password.length < 6) {
    console.log("Использование: node src/reset-password.js email@example.com новыйПароль (от 6 символов)");
    process.exit(1);
  }

  const existing = await pool.query("SELECT id, name, role FROM users WHERE email=$1", [email]);
  if (!existing.rowCount) {
    console.log("Пользователь с email " + email + " не найден.");
    await pool.end();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query("UPDATE users SET password_hash=$1, token_version = token_version + 1 WHERE email=$2", [hash, email]);

  const u = existing.rows[0];
  console.log("Пароль обновлён для " + u.name + " (" + email + ", роль: " + u.role + ").");
  await pool.end();
})().catch((e) => {
  console.error("Ошибка:", e);
  process.exit(1);
});
