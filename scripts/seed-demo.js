// Демо-данные для показа функционала: 3 «входа» (врач/куратор/админ) + 30 обычных
// врачей на демо-курсе с разным прогрессом, лидами, реферальными связями и потоками.
// Второй курс/мультикурс и сертификаты сюда специально не заводятся — это уже
// готовые функции платформы (админка → «Курсы»), их проще показать вживую, создав
// курс через интерфейс и включив у него сертификаты, чем подделывать в сиде.
//
//   node scripts/seed-demo.js
//
// Безопасно перезапускать: все сущности созданы с фиксированными id и заводятся
// через ON CONFLICT DO UPDATE — повторный запуск обновит те же строки, а не
// наплодит дубли. Требует, чтобы `npm run migrate` и `npm run seed` были
// выполнены раньше (нужны demo-курс и справочник специализаций).
//
// НЕ предназначен для продакшена с настоящими врачами — это учебные/витринные
// данные для просмотра интерфейса.

require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../src/db");
const { generateReferralCode } = require("../src/util");

const COURSE_A_ID = "longevity-demo"; // существующий демо-курс из src/content.js
const CURATOR_ID = "demo-curator";
const ADMIN_ID = "demo-admin";
const STUDENT_ID = "demo-student";
const STREAM1_ID = "demo-stream-1";
const STREAM2_ID = "demo-stream-2";

const CURATOR_EMAIL = "curator-demo@dolgoletie.local";
const CURATOR_PASSWORD = "DemoCurator2026!";
const ADMIN_EMAIL = "admin-demo@dolgoletie.local";
const ADMIN_PASSWORD = "DemoAdmin2026!";
const STUDENT_EMAIL = "student-demo@dolgoletie.local";
const STUDENT_PASSWORD = "DemoDoctor2026!";
const BULK_PASSWORD = "Doctor2026!"; // общий пароль для 30 рядовых демо-врачей

const FIRST_NAMES_F = ["Анна", "Елена", "Ольга", "Мария", "Ирина", "Наталья", "Светлана", "Татьяна", "Юлия", "Екатерина"];
const FIRST_NAMES_M = ["Александр", "Дмитрий", "Сергей", "Андрей", "Михаил", "Игорь", "Владимир", "Алексей", "Николай", "Павел"];
const LAST_NAMES = ["Иванов", "Петров", "Смирнов", "Кузнецов", "Соколов", "Попов", "Лебедев", "Козлов", "Новиков", "Морозов",
  "Волков", "Соловьёв", "Васильев", "Зайцев", "Павлов", "Семёнов", "Голубев", "Виноградов", "Богданов", "Воробьёв"];
const CLINICS = ["Клиника «Здоровье+»", "МЦ «Ренессанс»", "Частная практика", "Городская поликлиника №14",
  "Клиника долголетия «Вита»", "МЦ «Альфа-Мед»", "Санаторий «Заря»", "Клиника «Медсервис»"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}
function daysAgo(n) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000); }
function fullName() {
  const isF = Math.random() < 0.5;
  const first = isF ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
  const last = pick(LAST_NAMES) + (isF ? "а" : "");
  return first + " " + last;
}
function phone(n) { return "+7 9" + String(10 + (n % 89)).padStart(2, "0") + "-" + String(100 + n * 7).slice(-3) + "-" + String(1000 + n * 13).slice(-4); }

async function upsertUser(id, { email, name, role, curatorId, product, payment, createdAt, phoneNum, workplace }) {
  const hash = await bcrypt.hash(
    role === "curator" ? CURATOR_PASSWORD : role === "admin" ? ADMIN_PASSWORD : id === STUDENT_ID ? STUDENT_PASSWORD : BULK_PASSWORD,
    10
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, workplace, phone, product, payment_status, assigned_curator_id, referral_code, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       email=$2, password_hash=$3, name=$4, role=$5, workplace=$6, phone=$7,
       product=$8, payment_status=$9, assigned_curator_id=$10, created_at=$12`,
    [id, email, hash, name, role, workplace || null, phoneNum || null, product || "longevity", payment || "unpaid",
      curatorId || null, generateReferralCode(), createdAt || new Date()]
  );
}

async function upsertProgress(userId, courseId, opts) {
  await pool.query(
    `INSERT INTO progress (user_id, course_id, completed_lessons, quiz_score, completed, certificate_status,
       certificate_number, certificate_issued_at, certificate_issued_by, requested_full_access, requested_full_access_at,
       last_active_at, current_streak, longest_streak, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (user_id, course_id) DO UPDATE SET
       completed_lessons=$3, quiz_score=$4, completed=$5, certificate_status=$6,
       certificate_number=$7, certificate_issued_at=$8, certificate_issued_by=$9,
       requested_full_access=$10, requested_full_access_at=$11, last_active_at=$12,
       current_streak=$13, longest_streak=$14`,
    [
      userId, courseId, JSON.stringify(opts.completedLessons || []), opts.quizScore ?? null,
      !!opts.completed, opts.certStatus || "none", opts.certNumber || null, opts.certIssuedAt || null,
      opts.certIssuedBy || null, !!opts.requestedFullAccess, opts.requestedAt || null,
      opts.lastActiveAt || new Date(), opts.streak || 0, opts.longestStreak || opts.streak || 0,
      opts.createdAt || daysAgo(20)
    ]
  );
}

(async () => {
  console.log("Засеиваю демо-данные...");

  // Второй курс сюда специально не заводим: создание курса — уже готовая функция
  // (админка → «Курсы»), удобнее показать её вживую, чем засеивать за администратора.

  // ---------- Специализации ----------
  const specs = (await pool.query("SELECT id FROM specializations")).rows.map((r) => r.id);
  if (!specs.length) {
    console.error("Справочник специализаций пуст — сначала выполните `npm run migrate`.");
    process.exit(1);
  }

  // ---------- Три «входа»: куратор, админ, врач ----------
  await upsertUser(CURATOR_ID, { email: CURATOR_EMAIL, name: "Демо Куратор", role: "curator", product: "longevity", payment: "paid", createdAt: daysAgo(60), phoneNum: "+7 900-000-0001" });
  await upsertUser(ADMIN_ID, { email: ADMIN_EMAIL, name: "Демо Администратор", role: "admin", product: "longevity", payment: "paid", createdAt: daysAgo(60), phoneNum: "+7 900-000-0002" });
  await upsertUser(STUDENT_ID, {
    email: STUDENT_EMAIL, name: "Демо Врач", role: "student", curatorId: CURATOR_ID, product: "longevity",
    payment: "paid", createdAt: daysAgo(14), phoneNum: "+7 900-000-0003", workplace: "Клиника «Здоровье+»"
  });
  await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [STUDENT_ID, specs[0]]);
  await pool.query("INSERT INTO progress (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING", [STUDENT_ID, COURSE_A_ID]);
  await upsertProgress(STUDENT_ID, COURSE_A_ID, {
    completedLessons: ["l1", "l2", "l3", "l4"], lastActiveAt: daysAgo(1), streak: 4, longestStreak: 6, createdAt: daysAgo(14)
  });
  console.log("Три «входа» готовы:");
  console.log("  Врач:    " + STUDENT_EMAIL + " / " + STUDENT_PASSWORD);
  console.log("  Куратор: " + CURATOR_EMAIL + " / " + CURATOR_PASSWORD);
  console.log("  Админ:   " + ADMIN_EMAIL + " / " + ADMIN_PASSWORD);

  // Несколько уведомлений демо-врачу — чтобы «Центр уведомлений» не был пустым.
  await pool.query("DELETE FROM notifications WHERE user_id=$1", [STUDENT_ID]);
  const notifs = [
    ["welcome", "Добро пожаловать на платформу!", "Начните с первого урока курса «Медицина Долголетия»."],
    ["new_lesson", "Открылся новый урок", "«Четыре опоры программы долголетия» — уже доступен."],
    ["certificate_issued", "Напоминание", "Пройдите итоговый тест демо-курса, чтобы завершить обучение."]
  ];
  for (let i = 0; i < notifs.length; i++) {
    const [type, title, body] = notifs[i];
    await pool.query(
      "INSERT INTO notifications (id, user_id, type, title, body, read_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [crypto.randomUUID(), STUDENT_ID, type, title, body, i === 0 ? daysAgo(13) : null, daysAgo(13 - i * 4)]
    );
  }

  // ---------- Два потока с Telegram-группами ----------
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
  await pool.query(
    `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    ["demo-event-past", "Разбор клинических случаев", new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      "19:00", 60, "Демо Куратор", STREAM1_ID, "https://example.com/webinar", "Прошедший эфир — для демонстрации истории.", CURATOR_ID]
  );
  await pool.query(
    `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    ["demo-event-upcoming", "Вопрос-ответ с куратором", new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      "19:00", 45, "Демо Куратор", STREAM2_ID, "https://example.com/webinar2", "Ближайший эфир.", CURATOR_ID]
  );
  console.log("Два потока с Telegram-ссылками и по одному эфиру (прошедший/будущий) готовы.");

  // ---------- 30 обычных демо-врачей ----------
  const buckets = [
    ...Array(7).fill("inactive"),
    ...Array(5).fill("new"),
    ...Array(10).fill("in_progress"),
    ...Array(8).fill("completed_a")
  ]; // 30 штук

  const requestedFullAccessIdx = new Set(pickN([...Array(30).keys()], 5));
  const referralPairs = [[2, 0], [5, 1], [10, 3], [20, 4]]; // [индекс реферала, индекс того кто пригласил]
  const referredMap = new Map(referralPairs.map(([a, b]) => [a, b]));
  const doctorIds = [];

  for (let i = 0; i < buckets.length; i++) {
    const idx = i + 1;
    const id = "demo-doctor-" + String(idx).padStart(2, "0");
    doctorIds.push(id);
    const email = "doctor" + String(idx).padStart(2, "0") + "@demo.local";
    const name = fullName();
    const bucket = buckets[i];
    const curatorId = i % 2 === 0 ? CURATOR_ID : null; // половина — «мои» у демо-куратора, половина без куратора (видна любому)
    const spec1 = pick(specs);
    const product = pick(["longevity", "longevity", "longevity", "personal_brand"]);
    const payment = pick(["paid", "paid", "partial", "unpaid"]);

    let createdAt, completedLessonsA, lastActiveA, completedA, quizScoreA, streak;
    if (bucket === "inactive") {
      createdAt = daysAgo(40 + idx);
      completedLessonsA = pickN(["l1", "l2", "l3", "l4", "l5"], Math.random() < 0.5 ? 0 : 1);
      lastActiveA = daysAgo(10 + idx); // >7 дней назад → попадает в инбокс куратора «неактивны»
      completedA = false; quizScoreA = null; streak = 0;
    } else if (bucket === "new") {
      createdAt = daysAgo(Math.floor(Math.random() * 3));
      completedLessonsA = [];
      lastActiveA = daysAgo(0);
      completedA = false; quizScoreA = null; streak = 1;
    } else if (bucket === "in_progress") {
      createdAt = daysAgo(5 + idx);
      completedLessonsA = ["l1", "l2", "l3", "l4", "l5"].slice(0, 1 + (idx % 4));
      lastActiveA = daysAgo(Math.floor(Math.random() * 3));
      completedA = false; quizScoreA = Math.random() < 0.4 ? 40 + (idx % 3) * 10 : null; streak = 1 + (idx % 4);
    } else { // completed_a
      createdAt = daysAgo(20 + idx);
      completedLessonsA = ["l1", "l2", "l3", "l4", "l5"];
      lastActiveA = daysAgo(Math.floor(Math.random() * 5));
      completedA = true; quizScoreA = 70 + (idx % 3) * 10; streak = 3 + (idx % 4);
    }

    await upsertUser(id, {
      email, name, role: "student", curatorId, product, payment, createdAt, phoneNum: phone(idx), workplace: pick(CLINICS)
    });
    await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, spec1]);
    await pool.query("UPDATE users SET stream_id=$1 WHERE id=$2", [idx % 2 === 0 ? STREAM1_ID : STREAM2_ID, id]);
    if (referredMap.has(i)) {
      await pool.query("UPDATE users SET referred_by=$1 WHERE id=$2", [doctorIds[referredMap.get(i)] || null, id]);
    }

    const requested = requestedFullAccessIdx.has(i);
    await pool.query("INSERT INTO progress (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING", [id, COURSE_A_ID]);
    await upsertProgress(id, COURSE_A_ID, {
      completedLessons: completedLessonsA, quizScore: quizScoreA, completed: completedA,
      certStatus: completedA ? "pending" : "none", lastActiveAt: lastActiveA, streak, createdAt,
      requestedFullAccess: requested, requestedAt: requested ? daysAgo(Math.floor(Math.random() * 10)) : null
    });
  }

  console.log("30 демо-врачей готовы: 7 неактивных (для инбокса куратора), 5 новых, 10 в процессе, 8 завершили демо-курс.");
  console.log("Общий пароль для всех 30: " + BULK_PASSWORD + " (email вида doctor01@demo.local .. doctor30@demo.local)");
  console.log("Готово.");
  await pool.end();
})().catch((e) => {
  console.error("Ошибка сида демо-данных:", e);
  process.exit(1);
});
