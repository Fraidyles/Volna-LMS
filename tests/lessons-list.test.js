// Раздел «Уроки» у персонала: /course/materials отдаёт модуль, наличие видео и
// число вопросов теста урока — из них строятся плашки состояния в списке.
const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course, admin, curator;
beforeAll(async () => {
  course = await seedCourse();
  admin = await loginAs(await createUser({ role: "admin" }));
  curator = await loginAs(await createUser({ role: "curator" }));
});
afterAll(async () => { await pool.end(); });

test("у урока — модуль, видео и число вопросов теста урока", async () => {
  const [l1, l2] = course.lessonIds;
  const moduleId = "m-" + crypto.randomUUID().slice(0, 8);
  await pool.query("INSERT INTO modules (id, course_id, idx, title) VALUES ($1,$2,0,$3)", [moduleId, course.courseId, "Основы"]);
  await pool.query("UPDATE lessons SET module_id=$1, video_url=$2 WHERE id=$3", [moduleId, "https://example.com/v.mp4", l1]);
  for (let i = 0; i < 3; i++) {
    await pool.query("INSERT INTO quiz_questions (id, course_id, idx, question, options, correct, lesson_id) VALUES ($1,$2,$3,$4,$5,0,$6)",
      ["q-" + crypto.randomUUID().slice(0, 8), course.courseId, 10 + i, "Вопрос урока", JSON.stringify(["А", "Б"]), l1]);
  }
  const res = await request(app).get("/api/course/materials?courseId=" + course.courseId).set("Cookie", admin);
  expect(res.status).toBe(200);
  const a = res.body.lessons.find((l) => l.id === l1), b = res.body.lessons.find((l) => l.id === l2);
  expect(a).toMatchObject({ module_id: moduleId, module_title: "Основы", has_video: true, quiz_count: 3, duration: "5 мин" });
  // вопросы итогового теста (без lesson_id) урокам не засчитываются
  expect(b).toMatchObject({ module_id: null, module_title: null, has_video: false, quiz_count: 0 });
});

test("куратор видит тот же список (без правок)", async () => {
  const res = await request(app).get("/api/course/materials?courseId=" + course.courseId).set("Cookie", curator);
  expect(res.status).toBe(200);
  expect(res.body.lessons.map((l) => l.id)).toEqual(course.lessonIds);
});
