require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("./db");
const { COURSE, MODULES, LESSONS, QUIZ, PROTOCOLS, LESSON_PROTOCOLS, PROTOCOL_GUIDES } = require("./content");

(async () => {
  await pool.query(
    "INSERT INTO courses (id, title) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET title=$2",
    [COURSE.id, COURSE.title]
  );

  // Модули, уроки и вопросы теста этого курса полностью описаны в content.js —
  // удаляем из БД всё, что курсу принадлежит, но больше не упомянуто в файле
  // (переименованные/удалённые уроки, старые вопросы теста под прежний текст).
  const moduleIds = MODULES.map((m) => m.id);
  const lessonIds = LESSONS.map((l) => l.id);
  const quizIds = QUIZ.map((q) => q.id);
  await pool.query("DELETE FROM lessons WHERE course_id=$1 AND id <> ALL($2::text[])", [COURSE.id, lessonIds]);
  await pool.query("DELETE FROM quiz_questions WHERE course_id=$1 AND id <> ALL($2::text[])", [COURSE.id, quizIds]);
  await pool.query("DELETE FROM modules WHERE course_id=$1 AND id <> ALL($2::text[])", [COURSE.id, moduleIds]);

  // Протоколы (в отличие от модулей/уроков) не привязаны к course_id в схеме, поэтому
  // безусловную "удалить всё, что не в списке" уборку по ним не делаем — это мог бы
  // быть протокол другого курса. Здесь разово удаляем только 6 конкретных протоколов
  // с старыми случайными id, замененных на человекочитаемые id ниже (иначе они
  // останутся в БД как беспривязные дубликаты, видимые админу в списке протоколов).
  await pool.query(
    `DELETE FROM protocols WHERE id IN (
       '8f8f572c-ea2c-4b3f-bdb3-80e673e041f0', '7c547375-2b62-48c3-bb0b-c29891a939d2',
       'afb236fa-0b40-4349-8ac2-77380329758d', 'ac36c5da-dea3-4eb8-94f4-f70d803f0087',
       '34eae193-9501-4988-93e5-a54092f09b73', 'bec4047c-b770-4dec-86e1-991f3c342a4e'
     )`
  );

  for (const m of MODULES) {
    await pool.query(
      `INSERT INTO modules (id, course_id, idx, title) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET idx=$3, title=$4`,
      [m.id, COURSE.id, m.idx, m.title]
    );
  }
  console.log("Модули загружены:", MODULES.length);

  for (let i = 0; i < LESSONS.length; i++) {
    const l = LESSONS[i];
    await pool.query(
      `INSERT INTO lessons (id, course_id, idx, title, duration, html, module_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET idx=$3, title=$4, duration=$5, html=$6, module_id=$7`,
      [l.id, COURSE.id, i, l.title, l.duration, l.html, l.moduleId]
    );
  }
  console.log("Уроки загружены:", LESSONS.length);

  const quizIdxByGroup = new Map();
  for (const q of QUIZ) {
    const groupKey = q.lessonId || "__final__";
    const idx = quizIdxByGroup.get(groupKey) || 0;
    quizIdxByGroup.set(groupKey, idx + 1);
    await pool.query(
      `INSERT INTO quiz_questions (id, course_id, lesson_id, idx, question, options, correct)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET lesson_id=$3, idx=$4, question=$5, options=$6, correct=$7`,
      [q.id, COURSE.id, q.lessonId, idx, q.question, JSON.stringify(q.options), q.correct]
    );
  }
  console.log("Вопросы теста загружены:", QUIZ.length);

  for (const p of PROTOCOLS) {
    await pool.query(
      `INSERT INTO protocols (id, title, summary) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET title=$2, summary=$3`,
      [p.id, p.title, p.summary]
    );
  }
  for (const lp of LESSON_PROTOCOLS) {
    await pool.query(
      "INSERT INTO lesson_protocols (lesson_id, protocol_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [lp.lessonId, lp.protocolId]
    );
  }
  for (const g of PROTOCOL_GUIDES) {
    await pool.query(
      `INSERT INTO protocol_guides (id, protocol_id, specialization_id, guide_html) VALUES ($1,$2,$3,$4)
       ON CONFLICT (protocol_id, specialization_id) DO UPDATE SET guide_html=$4`,
      [g.id, g.protocolId, g.specializationId, g.guideHtml]
    );
  }
  console.log("Протоколы загружены:", PROTOCOLS.length, "| привязки к урокам:", LESSON_PROTOCOLS.length, "| гайды по специализациям:", PROTOCOL_GUIDES.length);

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
