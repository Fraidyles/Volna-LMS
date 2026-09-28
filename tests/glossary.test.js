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
  afterAll(async () => { await pool.end(); });

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
