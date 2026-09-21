require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("./db");
const { COURSE, LESSONS, QUIZ } = require("./content");

(async () => {
  await pool.query(
    "INSERT INTO courses (id, title) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET title=$2",
    [COURSE.id, COURSE.title]
  );

  for (let i = 0; i < LESSONS.length; i++) {
    const l = LESSONS[i];
    await pool.query(
      `INSERT INTO lessons (id, course_id, idx, title, duration, html)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET idx=$3, title=$4, duration=$5, html=$6`,
      [l.id, COURSE.id, i, l.title, l.duration, l.html]
    );
  }
  console.log("Уроки загружены:", LESSONS.length);

  for (let i = 0; i < QUIZ.length; i++) {
    const q = QUIZ[i];
    await pool.query(
      `INSERT INTO quiz_questions (id, course_id, idx, question, options, correct)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET idx=$3, question=$4, options=$5, correct=$6`,
      [q.id, COURSE.id, i, q.question, JSON.stringify(q.options), q.correct]
    );
  }
  console.log("Вопросы теста загружены:", QUIZ.length);

  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
  if (email && password && password !== "замените_на_надёжный_пароль") {
    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO users (id,email,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)",
        [crypto.randomUUID(), email, hash, process.env.BOOTSTRAP_ADMIN_NAME || "Главный администратор", "super_admin"]
      );
      console.log("Создан главный администратор:", email);
    } else {
      console.log("Главный администратор уже существует:", email);
    }
  } else {
    console.log("BOOTSTRAP_ADMIN_EMAIL/PASSWORD не заданы в .env — пропускаю создание главного администратора.");
  }

  console.log("Сид выполнен.");
  await pool.end();
})().catch((e) => {
  console.error("Ошибка сида:", e);
  process.exit(1);
});
