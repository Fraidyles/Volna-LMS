// Глоссарий: контент (каждый термин находится в тексте своего урока) и API
// (врач видит термины своего курса и отмечает открытые статьи; чужой курс — нет).
const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");
const { GLOSSARY } = require("../src/content-glossary");
const { LESSONS } = require("../src/content");

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matchers = (g) => g.aliases.map((a) => {
  const caps = a.length <= 5 && a === a.toUpperCase() && /[A-ZА-ЯЁ]/.test(a);
  return new RegExp("(^|[^A-Za-zА-Яа-яЁё0-9])(" + esc(a) + ")(?![A-Za-zА-Яа-яЁё0-9])", caps ? "" : "i");
});

afterAll(async () => { await pool.end(); });

describe("контент глоссария", () => {
  test("id уникальны, у каждого термина есть урок, название и написания", () => {
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
    const lessonIds = LESSONS.map((l) => l.id);
    GLOSSARY.forEach((g) => {
      expect(lessonIds).toContain(g.lessonId);
      expect(g.title && g.aliases.length).toBeTruthy();
    });
  });
  test.each(GLOSSARY.map((g) => [g.id, g]))("%s встречается в тексте своего урока", (_, g) => {
    const text = LESSONS.find((l) => l.id === g.lessonId).html.replace(/<[^>]+>/g, " ");
    expect(matchers(g).some((re) => re.test(text))).toBe(true);
  });
  test("в каждом уроке есть хотя бы один термин", () => {
    LESSONS.forEach((l) => expect(GLOSSARY.some((g) => g.lessonId === l.id)).toBe(true));
  });
});

describe("API глоссария", () => {
  let course, other, termId, otherTermId, student, staff;
  beforeAll(async () => {
    course = await seedCourse(); other = await seedCourse();
    termId = "g-test-" + crypto.randomUUID().slice(0, 8);
    otherTermId = "g-test-" + crypto.randomUUID().slice(0, 8);
    await pool.query("INSERT INTO glossary_terms (id, course_id, lesson_id, idx, title, aliases, body) VALUES ($1,$2,$3,0,'Термин','[\"термин\"]','{\"key\":{\"text\":\"главное\"}}')", [termId, course.courseId, course.lessonIds[0]]);
    await pool.query("INSERT INTO glossary_terms (id, course_id, idx, title) VALUES ($1,$2,0,'Чужой')", [otherTermId, other.courseId]);
    student = await loginAs(await createUser({ courseId: course.courseId }));
    staff = await loginAs(await createUser({ role: "curator" }));
  });

  test("врач получает термины своего курса, пока ничего не открыто", async () => {
    const r = await request(app).get("/api/glossary?courseId=" + course.courseId).set("Cookie", student);
    expect(r.status).toBe(200);
    expect(r.body.terms).toEqual([expect.objectContaining({ id: termId, lessonId: course.lessonIds[0], aliases: ["термин"], body: { key: { text: "главное" } } })]);
    expect(r.body.seen).toEqual([]);
  });
  test("открытая статья запоминается, повторное открытие не дублирует", async () => {
    expect((await request(app).post("/api/glossary/" + termId + "/seen").set("Cookie", student)).status).toBe(200);
    expect((await request(app).post("/api/glossary/" + termId + "/seen").set("Cookie", student)).status).toBe(200);
    const r = await request(app).get("/api/glossary?courseId=" + course.courseId).set("Cookie", student);
    expect(r.body.seen).toEqual([termId]);
  });
  test("чужой курс и термины чужого курса врачу недоступны", async () => {
    expect((await request(app).get("/api/glossary?courseId=" + other.courseId).set("Cookie", student)).status).toBe(404);
    expect((await request(app).post("/api/glossary/" + otherTermId + "/seen").set("Cookie", student)).status).toBe(404);
  });
  test("персонал видит глоссарий любого курса (предпросмотр), но не отмечает", async () => {
    const r = await request(app).get("/api/glossary?courseId=" + other.courseId).set("Cookie", staff);
    expect(r.status).toBe(200);
    expect(r.body.terms.map((t) => t.id)).toEqual([otherTermId]);
    expect((await request(app).post("/api/glossary/" + termId + "/seen").set("Cookie", staff)).status).toBe(403);
  });
});

describe("раздел «Термины»: куратор и админ правят глоссарий", () => {
  let course, curator, admin, student, termId;
  beforeAll(async () => {
    course = await seedCourse();
    await pool.query("UPDATE lessons SET html=$1 WHERE id=$2", ["<p>Возрастной <b>гипогонадизм</b> и ПСА.</p>", course.lessonIds[0]]);
    curator = await loginAs(await createUser({ role: "curator" }));
    admin = await loginAs(await createUser({ role: "admin" }));
    student = await loginAs(await createUser({ courseId: course.courseId }));
  });

  test("проверка написаний показывает уроки, где слово найдено (аббревиатура — с учётом регистра)", async () => {
    const r = await request(app).post("/api/glossary/check").set("Cookie", curator).send({ courseId: course.courseId, aliases: ["гипогонадизм"] });
    expect(r.body.foundIn).toEqual([course.lessonIds[0]]);
    const low = await request(app).post("/api/glossary/check").set("Cookie", curator).send({ courseId: course.courseId, aliases: ["пса"] });
    expect(low.body.foundIn).toEqual([course.lessonIds[0]]); // не заглавными — ищется без учёта регистра
    const caps = await request(app).post("/api/glossary/check").set("Cookie", curator).send({ courseId: course.courseId, aliases: ["ПС"] });
    expect(caps.body.foundIn).toEqual([]); // целым словом
  });

  test("куратор создаёт термин; обязательны название и написания", async () => {
    expect((await request(app).post("/api/glossary").set("Cookie", curator).send({ courseId: course.courseId, title: "", aliases: ["x"] })).status).toBe(400);
    expect((await request(app).post("/api/glossary").set("Cookie", curator).send({ courseId: course.courseId, title: "Т", aliases: [] })).status).toBe(400);
    const r = await request(app).post("/api/glossary").set("Cookie", curator).send({
      courseId: course.courseId, title: "Гипогонадизм", category: "Эндокринология", lessonId: course.lessonIds[0],
      aliases: ["гипогонадизм", "гипогонадизм", " "], lead: "Коротко",
      body: { key: { label: "Главное", text: "Ниже 8", scale: [["< 8", "гипогонадизм", "bad"], ["", "", "ok"], ["x", "y", "зелёный"]] },
        actions: [["unknown-icon", "Шаг", "пояснение"], ["check", "", "без заголовка — отбросится"]], more: [["Абзац", "Текст"]] }
    });
    expect(r.status).toBe(200);
    termId = r.body.id;
    const row = (await pool.query("SELECT * FROM glossary_terms WHERE id=$1", [termId])).rows[0];
    expect(row.aliases).toEqual(["гипогонадизм"]);
    expect(row.body.key.scale).toEqual([["< 8", "гипогонадизм", "bad"], ["x", "y", "ok"]]);
    expect(row.body.actions).toEqual([["check", "Шаг", "пояснение"]]);
    const list = await request(app).get("/api/glossary/admin?courseId=" + course.courseId).set("Cookie", curator);
    expect(list.body.terms.find((t) => t.id === termId).foundIn).toEqual([course.lessonIds[0]]);
  });

  test("админ правит, урок другого курса не принимается", async () => {
    const other = await seedCourse();
    expect((await request(app).put("/api/glossary/" + termId).set("Cookie", admin).send({ title: "Т", aliases: ["т"], lessonId: other.lessonIds[0] })).status).toBe(400);
    expect((await request(app).put("/api/glossary/" + termId).set("Cookie", admin).send({ title: "Гипогонадизм (правка)", aliases: ["гипогонадизм"], lessonId: course.lessonIds[0] })).status).toBe(200);
    expect((await pool.query("SELECT title FROM glossary_terms WHERE id=$1", [termId])).rows[0].title).toBe("Гипогонадизм (правка)");
  });

  test("врачу правка и удаление недоступны; удаление убирает и отметки «открыл»", async () => {
    expect((await request(app).put("/api/glossary/" + termId).set("Cookie", student).send({ title: "x", aliases: ["x"] })).status).toBe(403);
    expect((await request(app).get("/api/glossary/admin?courseId=" + course.courseId).set("Cookie", student)).status).toBe(403);
    await request(app).post("/api/glossary/" + termId + "/seen").set("Cookie", student);
    expect((await request(app).delete("/api/glossary/" + termId).set("Cookie", student)).status).toBe(403);
    expect((await request(app).delete("/api/glossary/" + termId).set("Cookie", curator)).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM glossary_seen WHERE term_id=$1", [termId])).rows[0].n).toBe(0);
    const log = await pool.query("SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at", [termId]);
    expect(log.rows.map((x) => x.action)).toEqual(["glossary.create", "glossary.update", "glossary.delete"]);
  });
});
