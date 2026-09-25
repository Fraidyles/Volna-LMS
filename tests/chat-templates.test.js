const request = require("supertest");
const { app, pool, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Шаблоны сообщений в чатах", () => {
  test("врач не может видеть/создавать шаблоны (403)", async () => {
    const student = await createUser({ role: "student" });
    const cookie = await loginAs(student);
    const getRes = await request(app).get("/api/chat-templates").set("Cookie", cookie);
    expect(getRes.status).toBe(403);
    const postRes = await request(app).post("/api/chat-templates").set("Cookie", cookie)
      .send({ title: "Т", body: "Текст" });
    expect(postRes.status).toBe(403);
  });

  test("куратор создаёт, видит, правит и удаляет шаблон", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);

    const createRes = await request(app).post("/api/chat-templates").set("Cookie", cookie)
      .send({ title: "Приветствие", body: "Добрый день! Как продвигается обучение?" });
    expect(createRes.status).toBe(200);
    const id = createRes.body.id;

    const listRes = await request(app).get("/api/chat-templates").set("Cookie", cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.templates.some((t) => t.id === id)).toBe(true);

    const updateRes = await request(app).put(`/api/chat-templates/${id}`).set("Cookie", cookie)
      .send({ title: "Приветствие 2", body: "Обновлённый текст" });
    expect(updateRes.status).toBe(200);

    const afterUpdate = await request(app).get("/api/chat-templates").set("Cookie", cookie);
    const updated = afterUpdate.body.templates.find((t) => t.id === id);
    expect(updated.title).toBe("Приветствие 2");
    expect(updated.body).toBe("Обновлённый текст");

    const deleteRes = await request(app).delete(`/api/chat-templates/${id}`).set("Cookie", cookie);
    expect(deleteRes.status).toBe(200);

    const afterDelete = await request(app).get("/api/chat-templates").set("Cookie", cookie);
    expect(afterDelete.body.templates.some((t) => t.id === id)).toBe(false);
  });

  test("библиотека шаблонов общая для команды — виден шаблон, созданный другим куратором", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const cookieA = await loginAs(curatorA);
    const cookieB = await loginAs(curatorB);

    const createRes = await request(app).post("/api/chat-templates").set("Cookie", cookieA)
      .send({ title: "Общий шаблон", body: "Текст для всех кураторов" });
    expect(createRes.status).toBe(200);
    const id = createRes.body.id;

    const listRes = await request(app).get("/api/chat-templates").set("Cookie", cookieB);
    expect(listRes.body.templates.some((t) => t.id === id)).toBe(true);

    await request(app).delete(`/api/chat-templates/${id}`).set("Cookie", cookieA);
  });

  test("пустые title/body отклоняются (400)", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).post("/api/chat-templates").set("Cookie", cookie)
      .send({ title: "  ", body: "Текст" });
    expect(res.status).toBe(400);
  });

  test("PUT/DELETE несуществующего id — 404", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const putRes = await request(app).put("/api/chat-templates/no-such-id").set("Cookie", cookie)
      .send({ title: "Т", body: "Текст" });
    expect(putRes.status).toBe(404);
    const delRes = await request(app).delete("/api/chat-templates/no-such-id").set("Cookie", cookie);
    expect(delRes.status).toBe(404);
  });
});
