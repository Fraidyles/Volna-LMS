const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

function parseCsvLines(text) {
  // Убираем BOM, разбиваем на строки — тесты используют только простые поля
  // без запятых/кавычек внутри, полный парсинг не нужен.
  return text.replace(/^﻿/, "").split("\r\n").filter((l) => l.length);
}

describe("Экспорт CSV — защита от formula injection", () => {
  test("значение, начинающееся с =/+/-/@ (имя, заданное самим врачом), не уходит в CSV как формула", async () => {
    const course = await seedCourse();
    // "=" — злонамеренная попытка; "+7..." — обычный номер телефона, тоже опасный
    // для Excel символ в начале поля, должен получить защиту так же, как формула.
    const student = await createUser({ role: "student", name: "=1+1", courseId: course.courseId });
    await pool.query("UPDATE users SET phone=$1 WHERE id=$2", ["+79991112233", student.id]);
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);

    const res = await request(app).get("/api/staff/students/export.csv").query({ courseId: course.courseId }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/,=1\+1,/);
    expect(res.text).toContain("'=1+1");
    expect(res.text).toContain("'+79991112233");
  });
});

describe("Экспорт CSV", () => {
  test("экспорт списка врачей — CSV с BOM, заголовком и данными врача", async () => {
    const course = await seedCourse();
    const student = await createUser({ role: "student", name: "Иванов Иван", courseId: course.courseId });
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);

    const res = await request(app).get("/api/staff/students/export.csv").query({ courseId: course.courseId }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/students\.csv/);
    const text = res.text.startsWith("﻿") ? res.text : res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = parseCsvLines(text);
    expect(lines[0]).toContain("Имя");
    expect(lines.some((l) => l.includes("Иванов Иван") && l.includes(student.email))).toBe(true);
  });

  test("куратор видит в экспорте только своих + неназначенных врачей", async () => {
    const course = await seedCourse();
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const mine = await createUser({ role: "student", name: "Мой Врач", courseId: course.courseId });
    const theirs = await createUser({ role: "student", name: "Чужой Врач", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorA.id, mine.id]);
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorB.id, theirs.id]);

    const cookie = await loginAs(curatorA);
    const res = await request(app).get("/api/staff/students/export.csv").query({ courseId: course.courseId }).set("Cookie", cookie);
    expect(res.text).toContain("Мой Врач");
    expect(res.text).not.toContain("Чужой Врач");
  });

  test("экспорт заявок на полный курс — только те, кто оставил заявку, с датой", async () => {
    const course = await seedCourse();
    const requested = await createUser({ role: "student", name: "Хочет Полный Курс", courseId: course.courseId });
    const notRequested = await createUser({ role: "student", name: "Не Просил", courseId: course.courseId });
    const cookie1 = await loginAs(requested);
    await request(app).post("/api/course/request-full-access").set("Cookie", cookie1).send({ courseId: course.courseId });

    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/leads/export.csv").query({ courseId: course.courseId }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Хочет Полный Курс");
    expect(res.text).not.toContain("Не Просил");
  });

  test("экспорт аудит-лога уважает фильтр по action", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const student = await createUser({ role: "student" });
    await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", cookie).send({ blocked: true });

    const res = await request(app).get("/api/staff/audit-log/export.csv").query({ action: "access.block" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain("access.block");
    expect(res.text).not.toContain("access.unblock");
  });
});

describe("Импорт врачей из CSV", () => {
  test("создаёт аккаунты, записывает на курс, пропускает дубликаты и некорректные строки", async () => {
    const course = await seedCourse();
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const existing = await createUser({ role: "student", courseId: course.courseId });

    const csv = "Имя,Email,Телефон,Место работы,Специализация,Поток\n" +
      "Новый Врач,new.doctor@example.com,+79990001122,Клиника №1,,\n" +
      `Дубликат,${existing.email},,,,\n` +
      ",noemail@example.com,,,,\n" +
      "Без Email,,,,,\n";

    const res = await request(app)
      .post("/api/staff/students/import")
      .set("Cookie", cookie)
      .field("courseId", course.courseId)
      .attach("file", Buffer.from(csv, "utf8"), { filename: "import.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.created.length).toBe(1);
    expect(res.body.created[0].email).toBe("new.doctor@example.com");
    expect(res.body.created[0].tempPassword).toBeTruthy();
    expect(res.body.skipped.length).toBe(3);

    const created = await pool.query("SELECT id, name, phone, workplace FROM users WHERE email=$1", ["new.doctor@example.com"]);
    expect(created.rowCount).toBe(1);
    expect(created.rows[0].name).toBe("Новый Врач");
    expect(created.rows[0].phone).toBe("+79990001122");

    const progressRow = await pool.query("SELECT course_id FROM progress WHERE user_id=$1", [created.rows[0].id]);
    expect(progressRow.rowCount).toBe(1);
    expect(progressRow.rows[0].course_id).toBe(course.courseId);
  });

  test("специализация и поток подбираются по названию, при отсутствии совпадения — не назначаются", async () => {
    const course = await seedCourse();
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const streamId = "stream-" + Date.now();
    await pool.query("INSERT INTO streams (id, name) VALUES ($1,'Поток Осень')", [streamId]);

    const csv = "Имя,Email,Телефон,Место работы,Специализация,Поток\n" +
      "Точное Совпадение,exact.match@example.com,,,терапевт,Поток Осень\n" +
      "Без Совпадения,no.match@example.com,,,несуществующая специализация,Несуществующий поток\n";

    const res = await request(app)
      .post("/api/staff/students/import")
      .set("Cookie", cookie)
      .field("courseId", course.courseId)
      .attach("file", Buffer.from(csv, "utf8"), { filename: "import.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.created.length).toBe(2);
    const exact = res.body.created.find((c) => c.email === "exact.match@example.com");
    const noMatch = res.body.created.find((c) => c.email === "no.match@example.com");
    expect(exact.specializationMatched).toBe(true);
    expect(exact.streamMatched).toBe(true);
    expect(noMatch.specializationMatched).toBe(false);
    expect(noMatch.streamMatched).toBe(false);

    const noMatchUser = await pool.query("SELECT stream_id FROM users WHERE email=$1", ["no.match@example.com"]);
    expect(noMatchUser.rows[0].stream_id).toBeNull();
  });

  test("куратор не может импортировать больше лимита строк за раз (400)", async () => {
    const course = await seedCourse();
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    let csv = "Имя,Email\n";
    for (let i = 0; i < 501; i++) csv += `Врач ${i},doctor${i}@example.com\n`;

    const res = await request(app)
      .post("/api/staff/students/import")
      .set("Cookie", cookie)
      .field("courseId", course.courseId)
      .attach("file", Buffer.from(csv, "utf8"), { filename: "import.csv", contentType: "text/csv" });
    expect(res.status).toBe(400);
  });

  test("без файла — 400, а не 500", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/staff/students/import").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  test("гонка: два параллельных импорта с одним и тем же email — второй аккуратно пропускается, а не 500", async () => {
    const course = await seedCourse();
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const csv = "Имя,Email\nВрач Гонки,race.doctor@example.com\n";

    const [res1, res2] = await Promise.all([
      request(app).post("/api/staff/students/import").set("Cookie", cookie).field("courseId", course.courseId)
        .attach("file", Buffer.from(csv, "utf8"), { filename: "a.csv", contentType: "text/csv" }),
      request(app).post("/api/staff/students/import").set("Cookie", cookie).field("courseId", course.courseId)
        .attach("file", Buffer.from(csv, "utf8"), { filename: "b.csv", contentType: "text/csv" })
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const totalCreated = res1.body.created.length + res2.body.created.length;
    const totalSkipped = res1.body.skipped.length + res2.body.skipped.length;
    expect(totalCreated).toBe(1);
    expect(totalSkipped).toBe(1);

    const dbCheck = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE email=$1", ["race.doctor@example.com"]);
    expect(dbCheck.rows[0].c).toBe(1);
  });

  test("врач не может импортировать (403)", async () => {
    const student = await createUser({ role: "student" });
    const cookie = await loginAs(student);
    const res = await request(app)
      .post("/api/staff/students/import")
      .set("Cookie", cookie)
      .attach("file", Buffer.from("Имя,Email\nX,x@example.com\n", "utf8"), { filename: "import.csv", contentType: "text/csv" });
    expect(res.status).toBe(403);
  });
});
