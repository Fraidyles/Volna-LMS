const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

const api = (method, path, cookie, body) => {
  const r = request(app)[method](path).set("Cookie", cookie);
  return body ? r.send(body) : r;
};

describe("Задания к урокам с проверкой куратором", () => {
  let admin, adminCookie, lessonId;
  beforeAll(async () => {
    admin = await createUser({ role: "admin" });
    adminCookie = await loginAs(admin);
    lessonId = course.lessonIds[0];
  });

  test("только администратор настраивает задание; врач видит его в уроке", async () => {
    const curator = await createUser({ role: "curator" });
    const cc = await loginAs(curator);
    expect((await api("put", `/api/assignments/lessons/${lessonId}/config`, cc, { prompt: "x" })).status).toBe(403);

    const res = await api("put", `/api/assignments/lessons/${lessonId}/config`, adminCookie, { prompt: "Опишите пациента", required: true });
    expect(res.status).toBe(200);

    const student = await createUser({ courseId: course.courseId });
    const sc = await loginAs(student);
    const content = await api("get", `/api/course/content/${course.courseId}`, sc);
    const l = content.body.lessons.find((x) => x.id === lessonId);
    expect(l.assignment).toEqual({ prompt: "Опишите пациента", required: true });
    expect(content.body.assignments).toEqual({});
  });

  test("стоп-урок не засчитывается без принятого ответа; принятие засчитывает его", async () => {
    const student = await createUser({ courseId: course.courseId });
    const sc = await loginAs(student);

    const done = await api("post", "/api/course/lesson-done", sc, { lessonId });
    expect(done.status).toBe(409);
    expect(done.body.error).toBe("assignment_required");

    expect((await api("post", `/api/assignments/lessons/${lessonId}`, sc, { answer: "  " })).status).toBe(400);
    const sub = await api("post", `/api/assignments/lessons/${lessonId}`, sc, { answer: "Пациентка 52 лет" });
    expect(sub.status).toBe(200);
    expect(sub.body.submission.status).toBe("pending");

    const list = await api("get", "/api/assignments", adminCookie).query({ status: "pending", courseId: course.courseId });
    const row = list.body.submissions.find((s) => s.user_id === student.id);
    expect(row).toBeTruthy();
    expect(row.lesson_title).toBe("Урок 1");
    expect(list.body.counts.pending).toBeGreaterThanOrEqual(1);

    // вернуть без комментария нельзя
    expect((await api("post", `/api/assignments/${row.id}/review`, adminCookie, { decision: "return" })).status).toBe(400);
    const ret = await api("post", `/api/assignments/${row.id}/review`, adminCookie, { decision: "return", comment: "Добавьте анализы" });
    expect(ret.status).toBe(200);
    expect((await api("post", `/api/assignments/${row.id}/review`, adminCookie, { decision: "accept" })).status).toBe(409);

    const again = await api("post", `/api/assignments/lessons/${lessonId}`, sc, { answer: "Пациентка 52 лет, ферритин 12" });
    expect(again.body.submission.attempts).toBe(2);
    expect(again.body.submission.history.map((h) => h.kind)).toEqual(["submit", "return", "submit"]);

    const acc = await api("post", `/api/assignments/${row.id}/review`, adminCookie, { decision: "accept", comment: "Отлично" });
    expect(acc.status).toBe(200);
    const pr = await pool.query("SELECT completed_lessons FROM progress WHERE user_id=$1 AND course_id=$2", [student.id, course.courseId]);
    expect(pr.rows[0].completed_lessons).toContain(lessonId);

    const notes = await pool.query("SELECT type FROM notifications WHERE user_id=$1 ORDER BY created_at", [student.id]);
    expect(notes.rows.map((n) => n.type)).toEqual(expect.arrayContaining(["assignment_returned", "assignment_accepted"]));

    // принятый ответ больше не меняется
    expect((await api("post", `/api/assignments/lessons/${lessonId}`, sc, { answer: "ещё" })).status).toBe(409);
    const content = await api("get", `/api/course/content/${course.courseId}`, sc);
    expect(content.body.assignments[lessonId].status).toBe("accepted");
    expect(content.body.assignments[lessonId].curatorComment).toBe("Отлично");
  });

  test("куратор не проверяет ответы чужих врачей и не видит их в очереди", async () => {
    const mine = await createUser({ role: "curator" });
    const other = await createUser({ role: "curator" });
    const student = await createUser({ courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [other.id, student.id]);
    const sc = await loginAs(student);
    await api("post", `/api/assignments/lessons/${lessonId}`, sc, { answer: "ответ" });

    const otherNotes = await pool.query("SELECT type FROM notifications WHERE user_id=$1", [other.id]);
    expect(otherNotes.rows.map((n) => n.type)).toContain("assignment_submitted");

    const mc = await loginAs(mine);
    const list = await api("get", "/api/assignments", mc).query({ status: "all" });
    expect(list.body.submissions.some((s) => s.user_id === student.id)).toBe(false);
    const sid = (await pool.query("SELECT id FROM assignment_submissions WHERE user_id=$1", [student.id])).rows[0].id;
    expect((await api("post", `/api/assignments/${sid}/review`, mc, { decision: "accept" })).status).toBe(403);
  });

  test("необязательное задание урок не держит", async () => {
    const l2 = course.lessonIds[1];
    await api("put", `/api/assignments/lessons/${l2}/config`, adminCookie, { prompt: "По желанию", required: false });
    const student = await createUser({ courseId: course.courseId });
    const sc = await loginAs(student);
    expect((await api("post", "/api/course/lesson-done", sc, { lessonId: l2 })).status).toBe(200);
  });

  test("лента ответов собирает задания, отзывы и анкеты", async () => {
    const feed = await api("get", "/api/assignments/feed", adminCookie).query({ courseId: course.courseId });
    expect(feed.status).toBe(200);
    expect(feed.body.items.some((i) => i.type === "assignment")).toBe(true);
    const onlyA = await api("get", "/api/assignments/feed", adminCookie).query({ type: "assignment" });
    expect(onlyA.body.items.every((i) => i.type === "assignment")).toBe(true);
    const student = await createUser({ courseId: course.courseId });
    expect((await api("get", "/api/assignments/feed", await loginAs(student))).status).toBe(403);
  });
});

describe("Продукты, заказы, оплаты и рассрочка", () => {
  let admin, ac;
  beforeAll(async () => { admin = await createUser({ role: "admin" }); ac = await loginAs(admin); });

  test("рассрочка: график, частичная оплата, полная оплата открывает курс продукта", async () => {
    const otherCourse = "paid-course-" + Date.now();
    await pool.query("INSERT INTO courses (id, title) VALUES ($1,$2)", [otherCourse, "Полная программа"]);
    const prod = await api("post", "/api/orders/products", ac, { title: "Полная программа", price: 90001, courseId: otherCourse, maxInstallments: 3 });
    expect(prod.status).toBe(200);

    const student = await createUser({ courseId: course.courseId });
    expect((await api("post", "/api/orders", ac, { userId: student.id, productId: prod.body.id, installments: 4 })).status).toBe(400);
    const created = await api("post", "/api/orders", ac, { userId: student.id, productId: prod.body.id, installments: 3, firstDueDate: "2026-01-31" });
    expect(created.status).toBe(200);
    const o = created.body.order;
    expect(o.amount).toBe(90001);
    expect(o.payments.map((p) => p.amount)).toEqual([30001, 30000, 30000]);
    expect(o.payments.map((p) => p.due_date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(o.status).toBe("new");
    expect(o.overdue_amount).toBe(90001);

    const p1 = await api("post", `/api/orders/${o.id}/payments/${o.payments[0].id}/pay`, ac);
    expect(p1.body.status).toBe("partial");
    expect((await pool.query("SELECT payment_status FROM users WHERE id=$1", [student.id])).rows[0].payment_status).toBe("partial");
    expect((await api("post", `/api/orders/${o.id}/payments/${o.payments[0].id}/pay`, ac)).status).toBe(409);

    await api("post", `/api/orders/${o.id}/payments/${o.payments[1].id}/pay`, ac);
    const last = await api("post", `/api/orders/${o.id}/payments/${o.payments[2].id}/pay`, ac);
    expect(last.body.status).toBe("paid");
    expect((await pool.query("SELECT payment_status FROM users WHERE id=$1", [student.id])).rows[0].payment_status).toBe("paid");
    const enrolled = await pool.query("SELECT 1 FROM progress WHERE user_id=$1 AND course_id=$2", [student.id, otherCourse]);
    expect(enrolled.rowCount).toBe(1);

    const undo = await api("post", `/api/orders/${o.id}/payments/${o.payments[2].id}/unpay`, ac);
    expect(undo.body.status).toBe("partial");

    const list = await api("get", "/api/orders", ac);
    expect(list.body.orders.some((x) => x.id === o.id)).toBe(true);
    expect(list.body.summary.received).toBeGreaterThanOrEqual(60001);

    const mine = await api("get", "/api/orders/mine", await loginAs(student));
    expect(mine.body.orders[0].payments.length).toBe(3);

    // продукт с заказами удалить нельзя
    expect((await api("delete", `/api/orders/products/${prod.body.id}`, ac)).status).toBe(409);
  });

  test("заказ без продукта, оплата сразу, отмена", async () => {
    const student = await createUser({ courseId: course.courseId });
    const created = await api("post", "/api/orders", ac, { userId: student.id, title: "Консультация", amount: 5000, paidNow: true });
    expect(created.body.order.status).toBe("paid");
    expect((await api("post", `/api/orders/${created.body.order.id}/cancel`, ac)).status).toBe(200);
    const one = await api("get", `/api/orders/${created.body.order.id}`, ac);
    expect(one.body.order.status).toBe("cancelled");
  });

  test("куратор не создаёт продукты и не видит заказы чужих врачей; врач не видит чужие заказы", async () => {
    const cur = await createUser({ role: "curator" });
    const cc = await loginAs(cur);
    expect((await api("post", "/api/orders/products", cc, { title: "x", price: 1 })).status).toBe(403);
    const other = await createUser({ role: "curator" });
    const student = await createUser({ courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [other.id, student.id]);
    const created = await api("post", "/api/orders", ac, { userId: student.id, title: "Курс", amount: 100 });
    expect((await api("get", `/api/orders/${created.body.order.id}`, cc)).status).toBe(403);
    expect((await api("post", "/api/orders", cc, { userId: student.id, title: "Курс", amount: 100 })).status).toBe(403);
    const list = await api("get", "/api/orders", cc);
    expect(list.body.orders.some((x) => x.user_id === student.id)).toBe(false);
    const stranger = await createUser({ courseId: course.courseId });
    expect((await api("get", `/api/orders/${created.body.order.id}`, await loginAs(stranger))).status).toBe(403);
  });
});

describe("Анкеты и опросы", () => {
  let admin, ac;
  beforeAll(async () => { admin = await createUser({ role: "admin" }); ac = await loginAs(admin); });

  const questions = [
    { type: "single", text: "Ваш стаж?", options: ["до 5 лет", "5–15", "15+"], required: true },
    { type: "multi", text: "Что интересно?", options: ["Гормоны", "Питание", "Сон"] },
    { type: "scale", text: "Насколько полезно?", max: 5, required: true },
    { type: "text", text: "Пожелания" }
  ];

  test("проверка формы анкеты", async () => {
    expect((await api("post", "/api/surveys", ac, { title: "", questions })).status).toBe(400);
    expect((await api("post", "/api/surveys", ac, { title: "А", questions: [] })).status).toBe(400);
    expect((await api("post", "/api/surveys", ac, { title: "А", questions: [{ type: "single", text: "?", options: ["один"] }] })).status).toBe(400);
    const cur = await loginAs(await createUser({ role: "curator" }));
    expect((await api("post", "/api/surveys", cur, { title: "А", questions })).status).toBe(403);
  });

  test("врач заполняет анкету, персонал видит сводку и ответы", async () => {
    const student = await createUser({ courseId: course.courseId });
    const created = await api("post", "/api/surveys", ac, { title: "Знакомство", questions, courseId: course.courseId });
    expect(created.status).toBe(200);
    const sc = await loginAs(student);

    const notes = await pool.query("SELECT type FROM notifications WHERE user_id=$1", [student.id]);
    expect(notes.rows.map((n) => n.type)).toContain("survey_new");

    const mine = await api("get", "/api/surveys/mine", sc);
    const s = mine.body.surveys.find((x) => x.id === created.body.id);
    expect(s.my_answers).toBeNull();
    const [q1, q2, q3, q4] = s.questions;

    const missing = await api("post", `/api/surveys/${s.id}/respond`, sc, { answers: { [q1.id]: 1 } });
    expect(missing.status).toBe(400);
    expect(missing.body.questionId).toBe(q3.id);

    const ok = await api("post", `/api/surveys/${s.id}/respond`, sc, { answers: { [q1.id]: 1, [q2.id]: [2, 0, 9], [q3.id]: 4, [q4.id]: " Больше практики " } });
    expect(ok.status).toBe(200);
    expect(ok.body.answers[q2.id]).toEqual([0, 2]);
    expect(ok.body.answers[q4.id]).toBe("Больше практики");

    const res = await api("get", `/api/surveys/${s.id}/results`, ac);
    expect(res.body.total).toBe(1);
    expect(res.body.summary[0].counts).toEqual([0, 1, 0]);
    expect(res.body.summary[2].avg).toBe(4);
    expect(res.body.responses[0].student_name).toBe(student.name);
    expect(res.body.pending.some((x) => x.student_id === student.id)).toBe(false);
    const notYet = await createUser({ courseId: course.courseId });
    const res2 = await api("get", `/api/surveys/${s.id}/results`, ac);
    expect(res2.body.pending.some((x) => x.student_id === notYet.id)).toBe(true);

    const feed = await api("get", "/api/assignments/feed", ac).query({ type: "survey" });
    const item = feed.body.items.find((i) => i.survey_id === s.id);
    expect(item.lines).toEqual(expect.arrayContaining([{ q: "Ваш стаж?", a: "5–15" }, { q: "Что интересно?", a: "Гормоны, Сон" }]));

    // анкета другого курса врачу не видна
    const other = await createUser({ role: "student" });
    await pool.query("DELETE FROM progress WHERE user_id=$1", [other.id]);
    const om = await api("get", "/api/surveys/mine", await loginAs(other));
    expect(om.body.surveys.some((x) => x.id === s.id)).toBe(false);

    // закрытая анкета больше не принимает ответы
    await api("put", `/api/surveys/${s.id}`, ac, { title: "Знакомство", questions: s.questions, courseId: course.courseId, active: false });
    expect((await api("post", `/api/surveys/${s.id}/respond`, sc, { answers: { [q1.id]: 0, [q3.id]: 5 } })).status).toBe(404);
  });
});
