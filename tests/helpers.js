const request = require("supertest");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const app = require("../src/server");
const pool = require("../src/db");

async function seedCourse() {
  const courseId = "test-course-" + crypto.randomUUID().slice(0, 8);
  await pool.query("INSERT INTO courses (id, title) VALUES ($1,$2)", [courseId, "Тестовый курс"]);
  const lessonIds = [];
  for (let i = 0; i < 2; i++) {
    const id = "lesson-" + crypto.randomUUID().slice(0, 8);
    await pool.query(
      "INSERT INTO lessons (id, course_id, idx, title, duration, html) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, courseId, i, "Урок " + (i + 1), "5 мин", "<p>Контент урока " + (i + 1) + "</p>"]
    );
    lessonIds.push(id);
  }
  const questionIds = [];
  for (let i = 0; i < 2; i++) {
    const id = "q-" + crypto.randomUUID().slice(0, 8);
    await pool.query(
      "INSERT INTO quiz_questions (id, course_id, idx, question, options, correct) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, courseId, i, "Вопрос " + (i + 1), JSON.stringify(["А", "Б", "В"]), 0]
    );
    questionIds.push(id);
  }
  return { courseId, lessonIds, questionIds };
}

async function createUser({ role = "student", name = "Тест Тестов", specialization = "терапевт", password = "password123", courseId = null } = {}) {
  const email = `test.${crypto.randomUUID()}@example.com`;
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 4); // низкая стоимость — тесты быстрее
  await pool.query(
    "INSERT INTO users (id, email, password_hash, name, role, specialization) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, email, hash, name, role, specialization]
  );
  if (role === "student") {
    // Важно: id курсов — случайные строки, а не последовательные номера, поэтому
    // "последний созданный" нельзя надёжно определить сортировкой. Если тест работает
    // с конкретным курсом (из seedCourse), он обязан передать его id явно.
    let cid = courseId;
    if (!cid) {
      // ORDER BY created_at DESC — тесты не изолируют БД между файлами (общий прогон
      // без TRUNCATE между ними), так что к моменту более позднего файла courses уже
      // содержит несколько строк; берём самый НЕДАВНО созданный (свой для этого файла).
      const course = await pool.query("SELECT id FROM courses ORDER BY created_at DESC LIMIT 1");
      cid = course.rowCount ? course.rows[0].id : null;
    }
    if (cid) {
      await pool.query("INSERT INTO progress (user_id, course_id) VALUES ($1,$2)", [id, cid]);
    }
  }
  return { id, email, password, name, role };
}

// Возвращает cookie-строку для использования в supertest: .set("Cookie", cookie)
async function loginAs(user, userAgent) {
  const req = request(app).post("/api/auth/login");
  if (userAgent) req.set("User-Agent", userAgent);
  const res = await req.send({ email: user.email, password: user.password });
  const cookie = res.headers["set-cookie"];
  return cookie;
}

module.exports = { app, pool, seedCourse, createUser, loginAs };
