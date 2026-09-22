const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

async function createStream(name) {
  const id = "stream-" + crypto.randomUUID().slice(0, 8);
  await pool.query("INSERT INTO streams (id, name) VALUES ($1,$2)", [id, name]);
  return id;
}

describe("Мьют чатов", () => {
  test("врач мьютит свой чат с куратором — unreadMessages форсируется в 0", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    await request(app).post("/api/messages").set("Cookie", curatorCookie)
      .send({ studentId: student.id, text: "Есть новости по курсу" });

    const cookie = await loginAs(student);
    const before = await request(app).get("/api/course").set("Cookie", cookie);
    expect(before.body.unreadMessages).toBe(1);
    expect(before.body.curatorChatMuted).toBe(false);

    const muteRes = await request(app).put(`/api/messages/${student.id}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(muteRes.status).toBe(200);

    const after = await request(app).get("/api/course").set("Cookie", cookie);
    expect(after.body.unreadMessages).toBe(0);
    expect(after.body.curatorChatMuted).toBe(true);

    await request(app).put(`/api/messages/${student.id}/mute`).set("Cookie", cookie).send({ muted: false });
    const unmuted = await request(app).get("/api/course").set("Cookie", cookie);
    expect(unmuted.body.unreadMessages).toBe(1);
  });

  test("врач не может замьютить чужой чат (403)", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const other = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(other);
    const res = await request(app).put(`/api/messages/${student.id}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(res.status).toBe(403);
  });

  test("куратор мьютит чат конкретного врача со своей стороны, это отражается в его /chat-mutes", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);

    const res = await request(app).put(`/api/messages/${student.id}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(res.status).toBe(200);

    const listRes = await request(app).get("/api/chat-mutes").set("Cookie", cookie);
    expect(listRes.body.mutes).toEqual(expect.arrayContaining([{ chat_type: "curator", chat_key: student.id }]));
  });

  test("куратор не может замьютить чат чужого врача (403)", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorB.id, stranger.id]);

    const cookie = await loginAs(curatorA);
    const res = await request(app).put(`/api/messages/${stranger.id}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(res.status).toBe(403);
  });

  test("врач мьютит беседу СВОЕГО потока", async () => {
    const streamId = await createStream("Поток мьют-тест");
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET stream_id=$1 WHERE id=$2", [streamId, student.id]);
    const cookie = await loginAs(student);

    const res = await request(app).put(`/api/stream-messages/${streamId}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(res.status).toBe(200);

    const listRes = await request(app).get("/api/chat-mutes").set("Cookie", cookie);
    expect(listRes.body.mutes).toEqual(expect.arrayContaining([{ chat_type: "stream", chat_key: streamId }]));
  });

  test("врач не может замьютить чужой поток (403)", async () => {
    const streamId = await createStream("Поток мьют-тест 2");
    const student = await createUser({ role: "student", courseId: course.courseId }); // без stream_id
    const cookie = await loginAs(student);
    const res = await request(app).put(`/api/stream-messages/${streamId}/mute`).set("Cookie", cookie).send({ muted: true });
    expect(res.status).toBe(403);
  });

  test("GET /chat-mutes отдаёт мьюты обоих типов вместе", async () => {
    const streamId = await createStream("Поток мьют-тест 3");
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET stream_id=$1 WHERE id=$2", [streamId, student.id]);
    const cookie = await loginAs(student);

    await request(app).put(`/api/messages/${student.id}/mute`).set("Cookie", cookie).send({ muted: true });
    await request(app).put(`/api/stream-messages/${streamId}/mute`).set("Cookie", cookie).send({ muted: true });

    const listRes = await request(app).get("/api/chat-mutes").set("Cookie", cookie);
    const types = listRes.body.mutes.map((m) => m.chat_type).sort();
    expect(types).toEqual(["curator", "stream"]);
  });
});
