// Проверки по итогам аудита изменений за сутки: фото профиля, регистрация
// сотрудника без приглашения, данные коллекции протоколов, доступ к заданиям,
// стоп-урок и итоговый тест, продукты вне продажи, отмена заказов.
const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

const api = (method, path, cookie, body) => {
  const r = request(app)[method](path).set("Cookie", cookie);
  return body ? r.send(body) : r;
};
const PNG_HEAD = Buffer.from("89504e470d0a1a0a", "hex");
const png = (size) => "data:image/png;base64," + Buffer.concat([PNG_HEAD, Buffer.alloc(size - PNG_HEAD.length, 1)]).toString("base64");

describe("Фото профиля", () => {
  test("загрузка, выдача только вошедшим, удаление", async () => {
    const u = await createUser({ courseId: course.courseId });
    const c = await loginAs(u);
    const up = await api("put", "/api/auth/me/avatar", c, { image: png(2000) });
    expect(up.status).toBe(200);
    expect(up.body.avatar_url).toMatch(/^api\/auth\/avatar\/[\w-]+\.png$/);

    const me = await api("get", "/api/auth/me", c);
    expect(me.body.user.avatar_url).toBe(up.body.avatar_url);
    expect(me.body.user.avatar_file).toBeUndefined();

    expect((await api("get", "/" + up.body.avatar_url, c)).status).toBe(200);
    expect((await request(app).get("/" + up.body.avatar_url)).status).toBe(401);

    expect((await api("delete", "/api/auth/me/avatar", c)).status).toBe(200);
    expect((await api("get", "/" + up.body.avatar_url, c)).status).toBe(404);
    expect((await api("get", "/api/auth/me", c)).body.user.avatar_url).toBeNull();
  });

  test("фото до 300 КБ проходит (общий лимит 100 КБ его не режет), больше — отказ", async () => {
    const c = await loginAs(await createUser({ courseId: course.courseId }));
    expect((await api("put", "/api/auth/me/avatar", c, { image: png(250 * 1024) })).status).toBe(200);
    const big = await api("put", "/api/auth/me/avatar", c, { image: png(310 * 1024) });
    expect(big.status).toBe(400);
    expect(big.body.error).toBe("too_large");
  });

  test("содержимое должно совпадать с заявленным типом", async () => {
    const c = await loginAs(await createUser({ courseId: course.courseId }));
    const fake = "data:image/png;base64," + Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    expect((await api("put", "/api/auth/me/avatar", c, { image: fake })).status).toBe(400);
    expect((await api("put", "/api/auth/me/avatar", c, { image: "data:text/html;base64,AAAA" })).status).toBe(400);
  });

  test("имя файла в адресе не выводит за пределы папки", async () => {
    const c = await loginAs(await createUser({ courseId: course.courseId }));
    expect((await api("get", "/api/auth/avatar/..%2F..%2Fpackage.json", c)).status).toBe(404);
  });

  test("в списке врачей и команды — адрес фото", async () => {
    const u = await createUser({ courseId: course.courseId });
    await api("put", "/api/auth/me/avatar", await loginAs(u), { image: png(1000) });
    const adm = await loginAs(await createUser({ role: "admin" }));
    const st = await api("get", `/api/staff/students/${u.id}`, adm);
    expect(st.body.student.avatar_url).toMatch(/^api\/auth\/avatar\//);
  });
});

describe("Регистрация сотрудника", () => {
  test("код сотрудника без приглашения на этот email — понятный отказ, а не «укажите специализацию»", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `staff.${crypto.randomUUID()}@example.com`, password: "password123", name: "Куратор Без Приглашения", staffInviteCode: "ABCDEF12"
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_staff_invite");
  });
});

describe("Коллекция протоколов", () => {
  test("врач без пройденных уроков получает сводку курса, а не только пустые списки", async () => {
    const c = await loginAs(await createUser({ courseId: course.courseId }));
    const r = await api("get", "/api/course/protocols", c).query({ courseId: course.courseId });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("totalInCourse");
    expect(r.body.forYou).toEqual([]);
  });
});

describe("Задания и стоп-урок", () => {
  let adminC;
  beforeAll(async () => { adminC = await loginAs(await createUser({ role: "admin" })); });

  test("ответ на задание в скрытом от врача уроке не принимается", async () => {
    const lessonId = course.lessonIds[1];
    await api("put", `/api/assignments/lessons/${lessonId}/config`, adminC, { prompt: "Задание урока 2" });
    const u = await createUser({ courseId: course.courseId });
    await api("put", `/api/course/visibility/${lessonId}`, adminC, { ids: [u.id] });
    const res = await api("post", `/api/assignments/lessons/${lessonId}`, await loginAs(u), { answer: "ответ" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("content_hidden");
    await api("put", `/api/course/visibility/${lessonId}`, adminC, { ids: [] });
    await api("put", `/api/assignments/lessons/${lessonId}/config`, adminC, { prompt: "" });
  });

  test("итоговый тест закрыт, пока стоп-урок не принят", async () => {
    const lessonId = course.lessonIds[0];
    await api("put", `/api/assignments/lessons/${lessonId}/config`, adminC, { prompt: "Опишите случай", required: true });
    const u = await createUser({ courseId: course.courseId });
    const c = await loginAs(u);
    const answers = {}; course.questionIds.forEach((id) => { answers[id] = 0; });

    const blocked = await api("post", "/api/course/quiz-submit", c, { courseId: course.courseId, answers });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("assignments_pending");

    await api("post", `/api/assignments/lessons/${lessonId}`, c, { answer: "Случай" });
    const sid = (await pool.query("SELECT id FROM assignment_submissions WHERE user_id=$1", [u.id])).rows[0].id;
    await api("post", `/api/assignments/${sid}/review`, adminC, { decision: "accept" });
    expect((await api("post", "/api/course/quiz-submit", c, { courseId: course.courseId, answers })).status).toBe(200);
    await api("put", `/api/assignments/lessons/${lessonId}/config`, adminC, { prompt: "" });
  });
});

describe("Заказы: продукт вне продажи, отмена всех заказов", () => {
  test("на скрытый продукт новый заказ не оформить", async () => {
    const ac = await loginAs(await createUser({ role: "admin" }));
    const p = await api("post", "/api/orders/products", ac, { title: "Архив", price: 100, active: false });
    const u = await createUser({ courseId: course.courseId });
    const r = await api("post", "/api/orders", ac, { userId: u.id, productId: p.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("product_inactive");
  });

  test("отмена единственного оплаченного заказа — врач больше не «оплачено»", async () => {
    const ac = await loginAs(await createUser({ role: "admin" }));
    const u = await createUser({ courseId: course.courseId });
    const o = await api("post", "/api/orders", ac, { userId: u.id, title: "Консультация", amount: 1000, paidNow: true });
    expect((await pool.query("SELECT payment_status FROM users WHERE id=$1", [u.id])).rows[0].payment_status).toBe("paid");
    await api("post", `/api/orders/${o.body.order.id}/cancel`, ac);
    expect((await pool.query("SELECT payment_status FROM users WHERE id=$1", [u.id])).rows[0].payment_status).toBe("unpaid");
  });
});

describe("Статус оплаты: один источник правды", () => {
  test("у врача с заказами ручная смена статуса отклоняется, массовая — пропускает его", async () => {
    const ac = await loginAs(await createUser({ role: "admin" }));
    const withOrder = await createUser({ courseId: course.courseId });
    const plain = await createUser({ courseId: course.courseId });
    await api("post", "/api/orders", ac, { userId: withOrder.id, title: "Курс", amount: 500 });
    const single = await api("patch", `/api/staff/students/${withOrder.id}/payment`, ac, { paymentStatus: "paid" });
    expect(single.status).toBe(409);
    expect((await api("patch", `/api/staff/students/${plain.id}/payment`, ac, { paymentStatus: "paid" })).status).toBe(200);
    const bulk = await api("post", "/api/staff/students/bulk-field", ac, { ids: [withOrder.id, plain.id], field: "payment_status", value: "partial" });
    expect(bulk.body.updated).toBe(1);
    expect(bulk.body.skippedWithOrders).toBe(1);
    expect((await pool.query("SELECT payment_status FROM users WHERE id=$1", [withOrder.id])).rows[0].payment_status).toBe("unpaid");
  });
});
