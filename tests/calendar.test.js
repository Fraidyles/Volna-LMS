const request = require("supertest");
const crypto = require("crypto");
const { app, pool, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Приватность эфиров по потокам", () => {
  // Раньше GET /events отдавал ВСЕ эфиры любому авторизованному врачу, а фильтр
  // "видны только эфиры своего потока" был только на фронтенде — join_url и прочие
  // детали чужого потока можно было получить прямым запросом к API.
  test("врач не видит join_url и детали эфира чужого потока через API", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);

    const streamRes = await request(app).post("/api/streams").set("Cookie", curatorCookie)
      .send({ name: "Приватный поток" });
    const streamId = streamRes.body.id;

    await request(app).post("/api/events").set("Cookie", curatorCookie).send({
      title: "Секретный созвон", date: "2027-01-01", time: "10:00",
      streamId, joinUrl: "https://zoom.example.com/secret-link"
    });

    const outsider = await createUser({ role: "student" }); // без stream_id вовсе
    const outsiderCookie = await loginAs(outsider);
    const res = await request(app).get("/api/events").set("Cookie", outsiderCookie);
    expect(res.status).toBe(200);
    const leaked = res.body.events.find((e) => e.stream_id === streamId);
    expect(leaked).toBeUndefined();
  });

  test("врач своего потока видит эфир этого потока, а персонал видит все эфиры", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const streamRes = await request(app).post("/api/streams").set("Cookie", curatorCookie)
      .send({ name: "Поток врача" });
    const streamId = streamRes.body.id;

    await request(app).post("/api/events").set("Cookie", curatorCookie).send({
      title: "Эфир потока", date: "2027-01-02", time: "11:00", streamId
    });

    const member = await createUser({ role: "student" });
    await pool.query("UPDATE users SET stream_id=$1 WHERE id=$2", [streamId, member.id]);
    const memberCookie = await loginAs(member);

    const memberRes = await request(app).get("/api/events").set("Cookie", memberCookie);
    expect(memberRes.body.events.some((e) => e.stream_id === streamId)).toBe(true);

    const staffRes = await request(app).get("/api/events").set("Cookie", curatorCookie);
    expect(staffRes.body.events.some((e) => e.stream_id === streamId)).toBe(true);
  });
});
