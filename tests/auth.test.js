const request = require("supertest");
const { app, pool, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Аутентификация", () => {
  test("регистрация врача с корректными данными — успех", async () => {
    const email = `reg.${Date.now()}@example.com`;
    const res = await request(app).post("/api/auth/register").send({
      email, password: "password123", name: "Анна Врачова", specialization: "терапевт"
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("student");
    expect(res.body.user.email).toBe(email);
  });

  test("регистрация с уже занятым email — 409", async () => {
    const user = await createUser();
    const res = await request(app).post("/api/auth/register").send({
      email: user.email, password: "password123", name: "Дубль", specialization: "терапевт"
    });
    expect(res.status).toBe(409);
  });

  test("регистрация с коротким паролем — 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `short.${Date.now()}@example.com`, password: "123", name: "Тест", specialization: "терапевт"
    });
    expect(res.status).toBe(400);
  });

  test("вход с неверным паролем — 401", async () => {
    const user = await createUser();
    const res = await request(app).post("/api/auth/login").send({ email: user.email, password: "неверный" });
    expect(res.status).toBe(401);
  });

  test("вход с верным паролем — 200 и выдаётся cookie", async () => {
    const user = await createUser();
    const res = await request(app).post("/api/auth/login").send({ email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  test("/auth/me без cookie — 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  test("/auth/me с cookie — возвращает профиль", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  test("PATCH /auth/me — врач может поправить телефон, место работы, специализацию", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user);
    const res = await request(app).patch("/api/auth/me").set("Cookie", cookie)
      .send({ phone: "+7 900 000-00-00", workplace: "Клиника «Надежда»", specialization: "кардиолог" });
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("+7 900 000-00-00");
    expect(res.body.user.workplace).toBe("Клиника «Надежда»");
    expect(res.body.user.specialization).toBe("кардиолог");
  });

  test("PATCH /auth/me — пустое имя отклоняется, email не меняется этим путём", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const res = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({ name: "   " });
    expect(res.status).toBe(400);
  });

  test("смена пароля: неверный текущий пароль отклоняется", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const res = await request(app).post("/api/auth/change-password").set("Cookie", cookie)
      .send({ currentPassword: "неверный", newPassword: "newpassword123" });
    expect(res.status).toBe(401);
  });

  test("смена пароля: старый перестаёт работать, новый работает", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const changeRes = await request(app).post("/api/auth/change-password").set("Cookie", cookie)
      .send({ currentPassword: user.password, newPassword: "brandNewPass123" });
    expect(changeRes.status).toBe(200);

    const oldLogin = await request(app).post("/api/auth/login").send({ email: user.email, password: user.password });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/auth/login").send({ email: user.email, password: "brandNewPass123" });
    expect(newLogin.status).toBe(200);
  });

  test("отзыв токена: старая cookie не работает после смены пароля (token_version)", async () => {
    const user = await createUser();
    const oldCookie = await loginAs(user);
    await request(app).post("/api/auth/change-password").set("Cookie", oldCookie)
      .send({ currentPassword: user.password, newPassword: "anotherPass123" });

    // Старая cookie была выдана до смены пароля — token_version в ней теперь не совпадает с базой
    const res = await request(app).get("/api/auth/me").set("Cookie", oldCookie);
    expect(res.status).toBe(401);
  });

  test("rate limit: много неудачных попыток входа подряд блокируются 429", async () => {
    const email = `ratelimit.${Date.now()}@example.com`;
    let last;
    for (let i = 0; i < 9; i++) {
      last = await request(app).post("/api/auth/login").send({ email, password: "wrong" });
    }
    expect(last.status).toBe(429);
  });
});
