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

describe("Ссылка на Telegram-группу потока", () => {
  const { app: a2, pool: p2, createUser: cu, loginAs: la } = require("./helpers");
  const request2 = require("supertest");
  test("без схемы, @имя и telegram.me приводятся к https://t.me/…, не-телеграм — отказ", async () => {
    const c = await la(await cu({ role: "curator" }));
    const mk = (telegramUrl) => request2(a2).post("/api/streams").set("Cookie", c).send({ name: "Поток " + Math.random(), telegramUrl });
    const ids = {};
    for (const [inp, want] of [["t.me/+AbCdEf123", "https://t.me/+AbCdEf123"], ["@longevity_group", "https://t.me/longevity_group"],
                               ["http://telegram.me/joinchat/XyZ", "https://t.me/joinchat/XyZ"], ["https://t.me/durov", "https://t.me/durov"]]) {
      const r = await mk(inp); expect(r.status).toBe(200); ids[want] = r.body.id;
      const row = await p2.query("SELECT telegram_url FROM streams WHERE id=$1", [r.body.id]);
      expect(row.rows[0].telegram_url).toBe(want);
    }
    for (const bad of ["javascript:alert(1)", "https://evil.example/t.me/x", "просто текст"]) {
      const r = await mk(bad); expect(r.status).toBe(400); expect(r.body.error).toBe("invalid_telegram_url");
    }
    const id = Object.values(ids)[0];
    const upd = await request2(a2).patch(`/api/streams/${id}`).set("Cookie", c).send({ telegramUrl: "t.me/new_group" });
    expect(upd.body.telegramUrl).toBe("https://t.me/new_group");
    expect((await request2(a2).patch(`/api/streams/${id}`).set("Cookie", c).send({ telegramUrl: "javascript:x" })).status).toBe(400);
    expect((await request2(a2).patch(`/api/streams/${id}`).set("Cookie", c).send({ telegramUrl: "" })).body.telegramUrl).toBeNull();
  });
});
