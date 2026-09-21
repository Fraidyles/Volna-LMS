const request = require("supertest");
const crypto = require("crypto");
const { app, pool, createUser, loginAs } = require("./helpers");

async function createStream(name) {
  const id = "stream-" + crypto.randomUUID().slice(0, 8);
  await pool.query("INSERT INTO streams (id, name) VALUES ($1,$2)", [id, name]);
  return id;
}

async function assignStream(userId, streamId) {
  await pool.query("UPDATE users SET stream_id=$1 WHERE id=$2", [streamId, userId]);
}

afterAll(async () => { await pool.end(); });

describe("Общение потока (когорта)", () => {
  test("врач из потока видит и отправляет сообщения в беседу своего потока", async () => {
    const streamId = await createStream("Поток тест А");
    const user = await createUser({ role: "student" });
    await assignStream(user.id, streamId);
    const cookie = await loginAs(user);

    const postRes = await request(app).post(`/api/stream-messages/${streamId}`).set("Cookie", cookie)
      .send({ text: "Привет, коллеги!" });
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/stream-messages/${streamId}`).set("Cookie", cookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.messages.length).toBe(1);
    expect(getRes.body.messages[0].body).toBe("Привет, коллеги!");
    expect(getRes.body.messages[0].author_role).toBe("student");
  });

  test("врач из ДРУГОГО потока не может читать или писать в чужую беседу (403)", async () => {
    const streamId = await createStream("Поток тест Б");
    const otherStreamId = await createStream("Поток тест В");
    const user = await createUser({ role: "student" });
    await assignStream(user.id, otherStreamId);
    const cookie = await loginAs(user);

    const getRes = await request(app).get(`/api/stream-messages/${streamId}`).set("Cookie", cookie);
    expect(getRes.status).toBe(403);

    const postRes = await request(app).post(`/api/stream-messages/${streamId}`).set("Cookie", cookie)
      .send({ text: "Подглядываю" });
    expect(postRes.status).toBe(403);
  });

  test("врач без назначенного потока не может писать ни в один чат потока (403)", async () => {
    const streamId = await createStream("Поток тест Г");
    const user = await createUser({ role: "student" }); // stream_id остаётся NULL
    const cookie = await loginAs(user);

    const getRes = await request(app).get(`/api/stream-messages/${streamId}`).set("Cookie", cookie);
    expect(getRes.status).toBe(403);
  });

  test("куратор/админ может читать и писать в чат ЛЮБОГО потока (модерация)", async () => {
    const streamId = await createStream("Поток тест Д");
    const staff = await createUser({ role: "curator" });
    const cookie = await loginAs(staff);

    const postRes = await request(app).post(`/api/stream-messages/${streamId}`).set("Cookie", cookie)
      .send({ text: "Всем привет, я ваш куратор" });
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/stream-messages/${streamId}`).set("Cookie", cookie);
    expect(getRes.body.messages[0].author_role).toBe("curator");
  });

  test("сообщения одного потока не видны в чате другого потока (изоляция)", async () => {
    const streamA = await createStream("Поток тест Е");
    const streamB = await createStream("Поток тест Ж");
    const userA = await createUser({ role: "student" });
    await assignStream(userA.id, streamA);
    const cookieA = await loginAs(userA);
    await request(app).post(`/api/stream-messages/${streamA}`).set("Cookie", cookieA).send({ text: "Только для потока А" });

    const userB = await createUser({ role: "student" });
    await assignStream(userB.id, streamB);
    const cookieB = await loginAs(userB);
    const getResB = await request(app).get(`/api/stream-messages/${streamB}`).set("Cookie", cookieB);
    expect(getResB.body.messages.length).toBe(0);
  });

  test("пустое сообщение отклоняется (400)", async () => {
    const streamId = await createStream("Поток тест З");
    const user = await createUser({ role: "student" });
    await assignStream(user.id, streamId);
    const cookie = await loginAs(user);
    const res = await request(app).post(`/api/stream-messages/${streamId}`).set("Cookie", cookie).send({ text: "   " });
    expect(res.status).toBe(400);
  });

  test("сообщение в несуществующий поток возвращает 404", async () => {
    const user = await createUser({ role: "curator" });
    const cookie = await loginAs(user);
    const res = await request(app).post("/api/stream-messages/no-such-stream").set("Cookie", cookie).send({ text: "test" });
    expect(res.status).toBe(404);
  });
});
