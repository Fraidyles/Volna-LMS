const crypto = require("crypto");
const pool = require("./db");

const TTL_MS = 24 * 60 * 60 * 1000;
// Без похожих на письме/экране символов (0/O, 1/I) — код читают с экрана и диктуют.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function isFresh(generatedAt) {
  return Date.now() - new Date(generatedAt).getTime() < TTL_MS;
}

// Возвращает действующий код для показа в админке — если старого нет или ему
// больше 24 часов, перевыпускает новый тут же (без отдельного крон-джоба:
// ротация "раз в сутки" реализована лениво, при первом обращении после истечения).
async function getStaffInviteCode() {
  const existing = await pool.query("SELECT code, generated_at FROM staff_invite_code WHERE id='current'");
  if (existing.rowCount && isFresh(existing.rows[0].generated_at)) {
    return { code: existing.rows[0].code, generatedAt: existing.rows[0].generated_at };
  }
  const code = randomCode(8);
  const result = await pool.query(
    `INSERT INTO staff_invite_code (id, code, generated_at) VALUES ('current', $1, now())
     ON CONFLICT (id) DO UPDATE SET code=$1, generated_at=now()
     RETURNING code, generated_at`,
    [code]
  );
  return { code: result.rows[0].code, generatedAt: result.rows[0].generated_at };
}

// Проверка при регистрации — намеренно НЕ перевыпускает код и не создаёт его,
// если ни один admin/super_admin ни разу не открывал вкладку «Команда»: до этого
// момента кода просто не существует, и регистрация с ролью сотрудника невозможна
// в принципе, что и требуется (без явного действия администратора роль никому не достанется).
async function verifyStaffInviteCode(input) {
  if (!input || typeof input !== "string") return false;
  const existing = await pool.query("SELECT code, generated_at FROM staff_invite_code WHERE id='current'");
  if (!existing.rowCount || !isFresh(existing.rows[0].generated_at)) return false;
  return existing.rows[0].code === input.trim().toUpperCase();
}

module.exports = { getStaffInviteCode, verifyStaffInviteCode, TTL_MS };
