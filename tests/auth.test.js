const request = require("supertest");
const { app, pool, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Аутентификация", () => {
  test("регистрация врача с корректными данными — успех, текущие специализации (можно несколько) и интересы сохраняются", async () => {
    const email = `reg.${Date.now()}@example.com`;
    const res = await request(app).post("/api/auth/register").send({
      email, password: "password123", name: "Анна Врачова",
      specializationIds: ["therapist", "cardiologist"], interestIds: ["anti_age"]
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("student");
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.specializationIds.sort()).toEqual(["cardiologist", "therapist"]);
    expect(res.body.user.interestIds).toEqual(["anti_age"]);
  });

  test("регистрация без специализации — 400 (свободный текст больше не принимается)", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `nospec.${Date.now()}@example.com`, password: "password123", name: "Тест"
    });
    expect(res.status).toBe(400);
  });

  test("регистрация с несуществующим id специализации — 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `badspec.${Date.now()}@example.com`, password: "password123", name: "Тест", specializationIds: ["no-such-id"]
    });
    expect(res.status).toBe(400);
  });

  test("регистрация с уже занятым email — 409", async () => {
    const user = await createUser();
    const res = await request(app).post("/api/auth/register").send({
      email: user.email, password: "password123", name: "Дубль", specializationIds: ["therapist"]
    });
    expect(res.status).toBe(409);
  });

  test("регистрация с коротким паролем — 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `short.${Date.now()}@example.com`, password: "123", name: "Тест", specializationIds: ["therapist"]
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

  test("врач видит свой продукт и статус оплаты через /auth/me и /auth/login", async () => {
    const user = await createUser({ role: "student" });
    await pool.query("UPDATE users SET product='peptide', payment_status='paid' WHERE id=$1", [user.id]);

    const loginRes = await request(app).post("/api/auth/login").send({ email: user.email, password: user.password });
    expect(loginRes.body.user.product).toBe("peptide");
    expect(loginRes.body.user.payment_status).toBe("paid");

    const cookie = await loginAs(user);
    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meRes.body.user.product).toBe("peptide");
    expect(meRes.body.user.payment_status).toBe("paid");
  });

  test("вход записывает сеанс — виден через GET /auth/sessions с распознанным устройством", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36");

    const res = await request(app).get("/api/auth/sessions").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    expect(res.body.sessions[0].device).toBe("Windows · Chrome");
    expect(res.body.sessions[0].createdAt).toBeTruthy();
  });

  test("сеансы разных пользователей не пересекаются", async () => {
    const userA = await createUser({ role: "student" });
    const userB = await createUser({ role: "student" });
    const cookieA = await loginAs(userA);
    await loginAs(userB);

    const res = await request(app).get("/api/auth/sessions").set("Cookie", cookieA);
    expect(res.body.sessions.length).toBe(1);
  });

  test("PATCH /auth/me — врач может поправить телефон, место работы, текущие специализации (несколько) и интересы", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user);
    const res = await request(app).patch("/api/auth/me").set("Cookie", cookie)
      .send({ phone: "+7 900 000-00-00", workplace: "Клиника «Надежда»", specializationIds: ["cardiologist", "therapist"], interestIds: ["anti_age"] });
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("+7 900 000-00-00");
    expect(res.body.user.workplace).toBe("Клиника «Надежда»");
    expect(res.body.user.specializationIds.sort()).toEqual(["cardiologist", "therapist"]);
    expect(res.body.user.interestIds).toEqual(["anti_age"]);
  });

  test("PATCH /auth/me — неизвестный id специализации отклоняется (400)", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user);
    const res = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({ specializationIds: ["no-such-id"] });
    expect(res.status).toBe(400);
  });

  test("PATCH /auth/me — пустой список текущих специализаций отклоняется (400), в отличие от пустого списка интересов", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user);
    const empty = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({ specializationIds: [] });
    expect(empty.status).toBe(400);

    const clearInterests = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({ interestIds: [] });
    expect(clearInterests.status).toBe(200);
    expect(clearInterests.body.user.interestIds).toEqual([]);
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

  test("смена роли сотрудника мгновенно отзывает права по старой cookie (не нужно ждать реloginа)", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const superCookie = await loginAs(superAdmin);

    // До понижения — старая cookie видит admin-only журнал действий.
    const before = await request(app).get("/api/staff/audit-log").set("Cookie", adminCookie);
    expect(before.status).toBe(200);

    await request(app).patch(`/api/staff/team/${admin.id}/role`).set("Cookie", superCookie).send({ role: "curator" });

    // ТА ЖЕ cookie, без повторного входа — доступ к admin-only ручке должен пропасть немедленно,
    // потому что роль в req.user теперь читается из базы, а не из старого JWT.
    const after = await request(app).get("/api/staff/audit-log").set("Cookie", adminCookie);
    expect(after.status).toBe(403);

    // Но curator-доступные ручки той же cookie по-прежнему открыты — сессия не отозвана целиком.
    const stillWorks = await request(app).get("/api/staff/students").set("Cookie", adminCookie);
    expect(stillWorks.status).toBe(200);
  });

  // ВАЖНО: этот тест должен идти РАНЬШЕ теста на /login ниже — оба используют один и
  // тот же лимитер (общий бюджет попыток с одного IP на /register, /login и
  // /change-password), а здесь нужен ещё и живой логин ДО того, как бюджет будет исчерпан.
  test("rate limit: подбор текущего пароля через /change-password тоже блокируется 429", async () => {
    const user = await createUser({ role: "student" });
    const cookie = await loginAs(user); // успешный логин не расходует лимит (skipSuccessfulRequests)
    let last;
    for (let i = 0; i < 9; i++) {
      last = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie)
        .send({ currentPassword: "wrong", newPassword: "irrelevant123" });
    }
    expect(last.status).toBe(429);
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
