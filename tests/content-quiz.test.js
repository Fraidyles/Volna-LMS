// Контент курса (src/content.js + content-lesson-quiz.js): в каждом уроке —
// 10 вопросов разных типов, все проходят ту же проверку, что вопрос куратора,
// верный ответ даёт полный балл, а врач не получает правильных ответов.
const { LESSONS, QUIZ } = require("../src/content");
const { validateQuestion, gradeQuestion, publicQuestion, token } = require("../src/quiz");

const rows = QUIZ.map((q) => Object.assign({ id: q.id }, (() => {
  const v = validateQuestion(Object.assign({ type: "single" }, q));
  return v.error ? { error: v.error } : { qtype: v.qtype, question: v.question, options: v.options, correct: v.correct, payload: v.payload, lessonId: q.lessonId };
})()));

function rightAnswer(q) {
  const p = q.payload;
  if (q.qtype === "single") return q.correct;
  if (q.qtype === "multi") return p.correct;
  if (q.qtype === "number") return p.answer;
  if (q.qtype === "order") return q.options.map((_, i) => token(q.id, i));
  if (q.qtype === "match") { const m = {}; p.right.forEach((_, i) => { m[i] = token(q.id, "r" + i); }); return m; }
  return p.steps.map((s) => (s.type === "number" ? s.answer : s.correct));
}

test("все вопросы корректны, id не повторяются", () => {
  expect(rows.filter((r) => r.error)).toEqual([]);
  expect(new Set(QUIZ.map((q) => q.id)).size).toBe(QUIZ.length);
});

test.each(LESSONS.map((l) => [l.id]))("урок %s: 10 вопросов, не меньше 4 типов, есть клинический случай", (lessonId) => {
  const own = rows.filter((r) => r.lessonId === lessonId);
  expect(own).toHaveLength(10);
  expect(new Set(own.map((r) => r.qtype)).size).toBeGreaterThanOrEqual(4);
  expect(own.some((r) => r.qtype === "case")).toBe(true);
  // первый вопрос — обычный: тест не начинается со сложного типа
  expect(own[0].qtype).toBe("single");
});

test("верный ответ — полный балл, врач не видит ответов", () => {
  rows.forEach((q) => {
    expect([q.id, gradeQuestion(q, rightAnswer(q)).score]).toEqual([q.id, 1]);
    if (q.qtype !== "single" && q.qtype !== "multi") expect(JSON.stringify(publicQuestion(q))).not.toMatch(/"(correct|answer|min|max)"/);
  });
});
