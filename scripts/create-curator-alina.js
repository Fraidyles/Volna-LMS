// Разовый скрипт: реальный аккаунт куратора для демонстрации — Алина Шашкова.
// В отличие от scripts/seed-demo.js это не витринные, а настоящие учётные данные
// конкретного человека, поэтому вынесено отдельно и не трогает остальные демо-сиды.
// Пароль сознательно не хранится в коде (это реальный пароль живого человека,
// а не демо-данные) — передаётся переменной окружения при запуске:
//
//   CURATOR_PASSWORD='...' node scripts/create-curator-alina.js
//
// Требует, чтобы `npm run migrate`, `npm run seed` и `node scripts/seed-demo.js`
// были выполнены раньше (нужны демо-курс и демо-врачи, часть которых этот скрипт
// назначает куратору, чтобы её «Ученики»/аналитика/инбокс не были пустыми).
// Безопасно перезапускать: пользователь и назначения — через ON CONFLICT/идемпотентные
// UPDATE, повторный запуск не наплодит дублей.

require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../src/db");
const { generateReferralCode } = require("../src/util");

const CURATOR_ID = "curator-alina-shashkova";
const CURATOR_EMAIL = "alina.shashkova@gmail.com";
const CURATOR_PASSWORD = process.env.CURATOR_PASSWORD;
const CURATOR_NAME = "Алина Шашкова";

if (!CURATOR_PASSWORD) {
  console.error("Задайте пароль через переменную окружения: CURATOR_PASSWORD='...' node scripts/create-curator-alina.js");
  process.exit(1);
}

const STREAM1_ID = "demo-stream-1";
const STREAM2_ID = "demo-stream-2";

// Часть демо-врачей из scripts/seed-demo.js — «её» ученики (остальные демо-врачи
// без куратора всё равно видны ей через общую зону видимости, см. staff.js).
const MY_DOCTOR_IDS = Array.from({ length: 12 }, (_, i) => "demo-doctor-" + String(i + 1).padStart(2, "0"));

function daysAgo(n) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000); }
function inDays(n) { return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }

(async () => {
  console.log("Создаю куратора Алину Шашкову...");

  const hash = await bcrypt.hash(CURATOR_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, product, payment_status, referral_code, created_at)
     VALUES ($1,$2,$3,$4,'curator','longevity','paid',$5,$6)
     ON CONFLICT (id) DO UPDATE SET email=$2, password_hash=$3, name=$4, role='curator'`,
    [CURATOR_ID, CURATOR_EMAIL, hash, CURATOR_NAME, generateReferralCode(), daysAgo(45)]
  );
  console.log("Куратор создан: " + CURATOR_EMAIL + " (пароль — тот, что передали в CURATOR_PASSWORD)");

  // ---------- Назначить ей часть существующих демо-врачей ----------
  const existing = await pool.query("SELECT id FROM users WHERE id = ANY($1::text[]) AND role='student'", [MY_DOCTOR_IDS]);
  if (existing.rowCount) {
    await pool.query(
      "UPDATE users SET assigned_curator_id=$1 WHERE id = ANY($2::text[]) AND role='student'",
      [CURATOR_ID, existing.rows.map((r) => r.id)]
    );
    console.log("Назначено «своих» врачей: " + existing.rowCount + " (остальные демо-врачи без куратора всё равно видны ей).");
  } else {
    console.log("Демо-врачи (scripts/seed-demo.js) не найдены — пропускаю назначение, запустите сид врачей отдельно, если нужно.");
  }

  // ---------- Потоки и эфиры: переиспользуем демо-потоки, если есть, иначе создаём ----------
  await pool.query(
    `INSERT INTO streams (id, name, start_date, telegram_url, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=$2, start_date=$3, telegram_url=$4`,
    [STREAM1_ID, "Поток №1 — весна 2026", "2026-03-01", "https://t.me/+demo_stream_1", daysAgo(90)]
  );
  await pool.query(
    `INSERT INTO streams (id, name, start_date, telegram_url, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=$2, start_date=$3, telegram_url=$4`,
    [STREAM2_ID, "Поток №2 — осень 2026", "2026-09-01", "https://t.me/+demo_stream_2", daysAgo(20)]
  );

  // Три эфира от её имени: прошедший, сегодняшний (чтобы было видно «идёт сейчас»
  // при подходящем времени) и будущий — чтобы «Расписание» показывало весь жизненный цикл.
  const events = [
    ["alina-event-past", "Разбор клинических случаев месяца", new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
      "19:00", 60, STREAM1_ID, "https://example.com/webinar-past", "Прошедший эфир — запись доступна в группе потока."],
    ["alina-event-today", "Вопрос-ответ с куратором", new Date().toISOString().slice(0, 10),
      "19:00", 45, STREAM2_ID, "https://example.com/webinar-today", "Открытый эфир для обоих потоков — присоединяйтесь."],
    ["alina-event-upcoming", "Разбор домашних заданий: гормональная терапия", inDays(6),
      "18:30", 50, STREAM1_ID, "https://example.com/webinar-upcoming", "Ближайший эфир."]
  ];
  for (const [id, title, date, time, dur, streamId, url, desc] of events) {
    await pool.query(
      `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET title=$2, event_date=$3, event_time=$4, duration_min=$5, stream_id=$7, join_url=$8, description=$9`,
      [id, title, date, time, dur, CURATOR_NAME, streamId, url, desc, CURATOR_ID]
    );
  }
  console.log("Потоки готовы, 3 эфира от её имени (прошедший/сегодня/будущий).");

  // ---------- Уведомления куратору — чтобы «Центр уведомлений» не был пустым ----------
  await pool.query("DELETE FROM notifications WHERE user_id=$1", [CURATOR_ID]);
  const notifs = [
    ["welcome", "Добро пожаловать в панель куратора!", "Здесь — ваши врачи, расписание эфиров, проверка заданий и аналитика по потоку."],
    ["assignment_submitted", "Новый ответ на задание", "Врач прислал ответ на домашнее задание — ждёт проверки в разделе «Ответы врачей»."],
    ["full_access_requested", "Заявка на полную программу", "Врач из вашего потока отправил заявку на полный курс — посмотрите в карточке врача."],
    ["new_lesson", "Открылся новый урок", "«Эстетическая медицина: инъекционные методики» — доступен врачам потока."]
  ];
  for (let i = 0; i < notifs.length; i++) {
    const [type, title, body] = notifs[i];
    await pool.query(
      "INSERT INTO notifications (id, user_id, type, title, body, read_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [crypto.randomUUID(), CURATOR_ID, type, title, body, i === 0 ? daysAgo(5) : null, daysAgo(5 - i)]
    );
  }
  console.log("Уведомления куратору добавлены (3 непрочитанных).");

  console.log("\nГотово. Email для входа: " + CURATOR_EMAIL);
  await pool.end();
})().catch((e) => {
  console.error("Ошибка создания куратора:", e);
  process.exit(1);
});
