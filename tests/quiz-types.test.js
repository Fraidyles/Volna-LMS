// Типы вопросов тестов: проверка ввода куратора, что врач не видит правильных
// ответов, подсчёт балла (в т.ч. частичного) и разбор в тесте урока.
const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");
const { gradeQuestion, publicQuestion, validateQuestion } = require("../src/quiz");

let course, admin;
beforeAll(async () => {
  course = await seedCourse();
  admin = await loginAs(await createUser({ role: "admin" }));
});
afterAll(async () => { await pool.end(); });

const api = (method, path, cookie, body) => {
  const r = request(app)[method](path).set("Cookie", cookie);
  return body ? r.send(body) : r;
};
async function makeLesson() {
  const id = "lesson-qt-" + crypto.randomUUID().slice(0, 8);
  await pool.query("INSERT INTO lessons (id, course_id, idx, title, duration, html) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, course.courseId, 98, "Урок с разными вопросами", "5 мин", "<p>Текст</p>"]);
  return id;
}
const add = (lessonId, body) => api("post", `/api/course/lessons/${lessonId}/quiz-admin`, admin, body);

describe("Проверка ввода куратора", () => {
  test("у каждого типа — свои обязательные поля", () => {
    expect(validateQuestion({ type: "multi", question: "?", options: ["a", "b"], correct: [] }).error).toBeTruthy();
    expect(validateQuestion({ type: "order", question: "?", options: ["a", "b"] }).error).toMatch(/минимум 3/);
    expect(validateQuestion({ type: "number", question: "?", answer: "abc" }).error).toBeTruthy();
    expect(validateQuestion({ type: "number", question: "?", answer: "8,5", tolerance: "0,5" })).toMatchObject({ payload: { min: 8, max: 9 } });
    expect(validateQuestion({ type: "match", question: "?", options: ["a", "b"], right: ["x"] }).error).toBeTruthy();
    expect(validateQuestion({ type: "match", question: "?", options: ["a", "b"], right: ["x", "x"] }).error).toMatch(/повторяться/);
    expect(validateQuestion({ type: "case", question: "?", scenario: "", steps: [] }).error).toMatch(/случай/);
    expect(validateQuestion({ type: "case", question: "?", scenario: "Пациент", steps: [{ type: "single", question: "?", options: ["a"] }] }).error).toMatch(/Шаг 1/);
  });

  test("куратор создаёт вопрос каждого типа через API", async () => {
    const lessonId = await makeLesson();
    const bodies = [
      { type: "single", question: "S", options: ["a", "b"], correct: 1 },
      { type: "multi", question: "M", options: ["a", "b", "c"], correct: [0, 2] },
      { type: "order", question: "O", options: ["1", "2", "3"] },
      { type: "number", question: "N", answer: 40, tolerance: 0, unit: "лет" },
      { type: "match", question: "P", options: ["зонулин", "кальпротектин"], right: ["тонкий", "толстый"] },
      { type: "case", question: "C", scenario: "Пациентка 52 лет", steps: [
        { type: "single", question: "c1", options: ["x", "y"], correct: 0 },
        { type: "number", question: "c2", answer: 8, tolerance: 1, unit: "нед" }] }
    ];
    for (const b of bodies) expect((await add(lessonId, b)).status).toBe(200);
    const list = await api("get", `/api/course/lessons/${lessonId}/quiz-admin`, admin);
    expect(list.body.quiz.map((q) => q.qtype)).toEqual(["single", "multi", "order", "number", "match", "case"]);
    expect(list.body.quiz[1].payload.correct).toEqual([0, 2]);
  });
});

describe("Врач не видит правильных ответов", () => {
  test("порядок и пары перемешаны и помечены метками, числа и шаги случая — без ответа", () => {
    const order = publicQuestion({ id: "q-o", qtype: "order", question: "O", options: ["a", "b", "c", "d"], payload: {} });
    expect(order.items.map((i) => i.text)).not.toEqual(["a", "b", "c", "d"]);
    expect(order.items.every((i) => /^[0-9a-f]{10}$/.test(i.token))).toBe(true);
    const match = publicQuestion({ id: "q-m", qtype: "match", question: "P", options: ["l1", "l2", "l3"], payload: { right: ["r1", "r2", "r3"] } });
    expect(match.right.map((r) => r.text)).not.toEqual(["r1", "r2", "r3"]);
    const num = publicQuestion({ id: "q-n", qtype: "number", question: "N", options: [], payload: { answer: 40, min: 40, max: 40, unit: "лет" } });
    expect(num).toEqual({ id: "q-n", type: "number", question: "N", unit: "лет" });
    const cs = publicQuestion({ id: "q-c", qtype: "case", question: "C", options: [], payload: { scenario: "S", steps: [{ type: "multi", question: "?", options: ["a", "b"], correct: [1] }, { type: "number", question: "?", answer: 3, min: 3, max: 3, unit: "" }] } });
    expect(JSON.stringify(cs)).not.toMatch(/correct|answer|"min"|"max"/);
  });

  test("в GET /course/content нет правильных ответов", async () => {
    const lessonId = await makeLesson();
    await add(lessonId, { type: "multi", question: "M", options: ["a", "b", "c"], correct: [0, 2] });
    await add(lessonId, { type: "number", question: "N", answer: 40, tolerance: 0 });
    const st = await createUser({ courseId: course.courseId });
    const res = await api("get", `/api/course/content/${course.courseId}`, await loginAs(st));
    const lesson = res.body.lessons.find((l) => l.id === lessonId);
    expect(lesson.quiz.map((q) => q.type)).toEqual(["multi", "number"]);
    expect(JSON.stringify(lesson.quiz)).not.toMatch(/"correct"|"answer"|"min"|"max"|"payload"/);
  });
});

describe("Подсчёт балла", () => {
  const row = (qtype, extra) => Object.assign({ id: "q-" + qtype, qtype, question: "?", options: [], correct: 0, payload: {} }, extra);

  test("несколько верных — частичный балл, лишний выбор штрафуется", () => {
    const q = row("multi", { options: ["a", "b", "c", "d"], payload: { correct: [0, 2] } });
    expect(gradeQuestion(q, [0, 2]).score).toBe(1);
    expect(gradeQuestion(q, [0]).score).toBe(0.5);
    expect(gradeQuestion(q, [0, 1]).score).toBe(0);
    expect(gradeQuestion(q, [0, 1, 2, 3]).score).toBe(0);
  });

  test("порядок — доля шагов на своих местах", () => {
    const q = row("order", { options: ["a", "b", "c", "d"] });
    const pub = publicQuestion(q);
    const byText = (t) => pub.items.find((i) => i.text === t).token;
    expect(gradeQuestion(q, ["a", "b", "c", "d"].map(byText)).score).toBe(1);
    expect(gradeQuestion(q, ["b", "a", "c", "d"].map(byText)).score).toBe(0.5);
    expect(gradeQuestion(q, []).score).toBe(0);
  });

  test("число — в пределах допуска, запятая тоже понимается", () => {
    const q = row("number", { payload: { answer: 8, min: 7, max: 9, unit: "нед" } });
    expect(gradeQuestion(q, "8,5").score).toBe(1);
    expect(gradeQuestion(q, 9).score).toBe(1);
    expect(gradeQuestion(q, 10).score).toBe(0);
    expect(gradeQuestion(q, "").score).toBe(0);
  });

  test("число — дробный ответ можно округлить до целого", () => {
    const q = row("number", { payload: { answer: 66.7, min: 66.6, max: 66.8, unit: "млрд $" } });
    expect(gradeQuestion(q, 67).score).toBe(1);
    expect(gradeQuestion(q, 66).score).toBe(1);
    expect(gradeQuestion(q, "66,7").score).toBe(1);
    expect(gradeQuestion(q, 65).score).toBe(0);
    expect(gradeQuestion(q, 66.2).score).toBe(0);
    // целый ответ — только в пределах допуска
    const w = row("number", { payload: { answer: 26, min: 26, max: 26, unit: "баллов" } });
    expect(gradeQuestion(w, 25).score).toBe(0);
  });

  test("сопоставление — доля верных пар", () => {
    const q = row("match", { options: ["l0", "l1"], payload: { right: ["r0", "r1"] } });
    const pub = publicQuestion(q);
    const tok = (t) => pub.right.find((r) => r.text === t).token;
    expect(gradeQuestion(q, { 0: tok("r0"), 1: tok("r1") }).score).toBe(1);
    expect(gradeQuestion(q, { 0: tok("r0"), 1: tok("r0") }).score).toBe(0.5);
    expect(gradeQuestion(q, { 0: tok("r1"), 1: tok("r0") }).score).toBe(0);
  });

  test("клинический случай — среднее по шагам", () => {
    const q = row("case", { payload: { scenario: "S", steps: [
      { type: "single", question: "1", options: ["a", "b"], correct: 1 },
      { type: "multi", question: "2", options: ["a", "b", "c"], correct: [0, 1] },
      { type: "number", question: "3", answer: 40, min: 40, max: 40 }] } });
    expect(gradeQuestion(q, [1, [0, 1], 40]).score).toBe(1);
    const half = gradeQuestion(q, [1, [0], 30]);
    expect(half.score).toBeCloseTo(0.5);
    expect(half.steps.map((s) => s.score)).toEqual([1, 0.5, 0]);
  });
});

describe("Тест урока: балл и разбор по новым типам", () => {
  test("частичный балл идёт в итоговый процент, разбор содержит верные ответы", async () => {
    const lessonId = await makeLesson();
    await add(lessonId, { type: "multi", question: "M", options: ["a", "b", "c", "d"], correct: [0, 2] });
    await add(lessonId, { type: "number", question: "N", answer: 40, tolerance: 0, unit: "лет" });
    const st = await createUser({ courseId: course.courseId });
    const c = await loginAs(st);
    const content = await api("get", `/api/course/content/${course.courseId}`, c);
    const [qm, qn] = content.body.lessons.find((l) => l.id === lessonId).quiz;
    const res = await api("post", `/api/course/lessons/${lessonId}/quiz-submit`, c, { answers: { [qm.id]: [0], [qn.id]: "40" } });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(75);           // (0.5 + 1) / 2
    expect(res.body.correctCount).toBe(1);
    const rm = res.body.review.find((r) => r.id === qm.id);
    expect(rm).toMatchObject({ type: "multi", score: 0.5, chosen: [0], correct: [0, 2] });
    const rn = res.body.review.find((r) => r.id === qn.id);
    expect(rn.correct).toMatchObject({ answer: 40, unit: "лет" });
  });
});

describe("Итоговый тест: балл по каждому вопросу для аналитики", () => {
  test("quiz_results сохраняется и отдаётся в списке врачей", async () => {
    const st = await createUser({ courseId: course.courseId });
    const c = await loginAs(st);
    const content = await api("get", `/api/course/content/${course.courseId}`, c);
    const answers = {}; content.body.quiz.forEach((q) => { answers[q.id] = 0; });
    const r = await api("post", "/api/course/quiz-submit", c, { courseId: course.courseId, answers });
    expect(r.status).toBe(200);
    const row = await pool.query("SELECT quiz_results FROM progress WHERE user_id=$1", [st.id]);
    expect(Object.keys(row.rows[0].quiz_results).length).toBe(content.body.quiz.length);
  });
});
