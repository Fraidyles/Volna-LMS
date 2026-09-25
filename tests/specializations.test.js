const request = require("supertest");
const { app, pool, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Справочник специализаций", () => {
  test("GET /specializations доступен без авторизации (нужен на форме регистрации)", async () => {
    const res = await request(app).get("/api/specializations");
    expect(res.status).toBe(200);
    expect(res.body.specializations.length).toBeGreaterThan(0);
    expect(res.body.specializations.some((s) => s.id === "therapist")).toBe(true);
  });

  test("врач/куратор не может добавлять специализации (403)", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).post("/api/specializations").set("Cookie", cookie).send({ name: "Новая" });
    expect(res.status).toBe(403);
  });

  test("админ создаёт, переименовывает и удаляет специализацию", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);

    const createRes = await request(app).post("/api/specializations").set("Cookie", cookie).send({ name: "Аллерголог" });
    expect(createRes.status).toBe(200);
    const id = createRes.body.id;

    const dupRes = await request(app).post("/api/specializations").set("Cookie", cookie).send({ name: "Аллерголог" });
    expect(dupRes.status).toBe(400);

    const renameRes = await request(app).put(`/api/specializations/${id}`).set("Cookie", cookie).send({ name: "Аллерголог-иммунолог" });
    expect(renameRes.status).toBe(200);

    const deleteRes = await request(app).delete(`/api/specializations/${id}`).set("Cookie", cookie);
    expect(deleteRes.status).toBe(200);

    const listRes = await request(app).get("/api/specializations");
    expect(listRes.body.specializations.some((s) => s.id === id)).toBe(false);
  });

  test("нельзя удалить специализацию, которая уже назначена врачу", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const student = await createUser({ role: "student" });
    await pool.query("UPDATE users SET specialization_id='therapist' WHERE id=$1", [student.id]);

    const res = await request(app).delete("/api/specializations/therapist").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});
