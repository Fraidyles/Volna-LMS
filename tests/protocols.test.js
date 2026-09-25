const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Протоколы", () => {
  test("куратор не может управлять протоколами — только admin/super_admin (403)", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).get("/api/protocols").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  test("админ создаёт протокол, гайды по специализациям и привязывает к уроку", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const course = await seedCourse();

    const createRes = await request(app).post("/api/protocols").set("Cookie", cookie)
      .send({ title: "Протокол витамина D", summary: "Базовый протокол восполнения дефицита" });
    expect(createRes.status).toBe(200);
    const id = createRes.body.id;

    const guideRes = await request(app).put(`/api/protocols/${id}/guides/therapist`).set("Cookie", cookie)
      .send({ guideHtml: "<p>Применение у терапевта</p>" });
    expect(guideRes.status).toBe(200);

    const guideRes2 = await request(app).put(`/api/protocols/${id}/guides/cardiologist`).set("Cookie", cookie)
      .send({ guideHtml: "<p>Применение у кардиолога</p>" });
    expect(guideRes2.status).toBe(200);

    const linkRes = await request(app).put(`/api/protocols/${id}/lessons`).set("Cookie", cookie)
      .send({ lessonIds: [course.lessonIds[0]] });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.lessonIds).toEqual([course.lessonIds[0]]);

    const listRes = await request(app).get("/api/protocols").set("Cookie", cookie);
    const proto = listRes.body.protocols.find((p) => p.id === id);
    expect(proto.guides.length).toBe(2);
    expect(proto.lessonIds).toEqual([course.lessonIds[0]]);

    const deleteGuideRes = await request(app).delete(`/api/protocols/${id}/guides/cardiologist`).set("Cookie", cookie);
    expect(deleteGuideRes.status).toBe(200);
    const afterDelete = await request(app).get("/api/protocols").set("Cookie", cookie);
    expect(afterDelete.body.protocols.find((p) => p.id === id).guides.length).toBe(1);
  });

  test("пустое название протокола отклоняется (400)", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/protocols").set("Cookie", cookie).send({ title: "  " });
    expect(res.status).toBe(400);
  });

  test("врач видит разблокированные протоколы только после прохождения урока, разделены по релевантности", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const course = await seedCourse();

    const protoRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол Омега-3", summary: "Базовый гайд" });
    const protoId = protoRes.body.id;
    await request(app).put(`/api/protocols/${protoId}/guides/therapist`).set("Cookie", adminCookie)
      .send({ guideHtml: "<p>Для терапевта</p>" });
    await request(app).put(`/api/protocols/${protoId}/lessons`).set("Cookie", adminCookie)
      .send({ lessonIds: [course.lessonIds[0]] });

    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET specialization_id='therapist' WHERE id=$1", [student.id]);
    const cookie = await loginAs(student);

    const beforeRes = await request(app).get("/api/course/protocols").set("Cookie", cookie);
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.forYou).toEqual([]);
    expect(beforeRes.body.additional).toEqual([]);

    await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });

    const afterRes = await request(app).get("/api/course/protocols").set("Cookie", cookie);
    expect(afterRes.body.forYou.length).toBe(1);
    expect(afterRes.body.forYou[0].id).toBe(protoId);
    expect(afterRes.body.additional).toEqual([]);
  });

  test("протокол без гайда под специализацию/интересы врача попадает в «дополнительные»", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const course = await seedCourse();

    const protoRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол для дерматолога", summary: "" });
    const protoId = protoRes.body.id;
    await request(app).put(`/api/protocols/${protoId}/guides/dermatocosmetologist`).set("Cookie", adminCookie)
      .send({ guideHtml: "<p>Для дерматолога</p>" });
    await request(app).put(`/api/protocols/${protoId}/lessons`).set("Cookie", adminCookie)
      .send({ lessonIds: [course.lessonIds[0]] });

    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET specialization_id='therapist' WHERE id=$1", [student.id]);
    const cookie = await loginAs(student);
    await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });

    const res = await request(app).get("/api/course/protocols").set("Cookie", cookie);
    expect(res.body.forYou).toEqual([]);
    expect(res.body.additional.length).toBe(1);
    expect(res.body.additional[0].id).toBe(protoId);
  });

  test("протокол попадает в «по вашей специализации», если совпадает с «хочу развиваться»", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const course = await seedCourse();

    const protoRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол anti-age", summary: "" });
    const protoId = protoRes.body.id;
    await request(app).put(`/api/protocols/${protoId}/guides/anti_age`).set("Cookie", adminCookie)
      .send({ guideHtml: "<p>Для anti-age</p>" });
    await request(app).put(`/api/protocols/${protoId}/lessons`).set("Cookie", adminCookie)
      .send({ lessonIds: [course.lessonIds[0]] });

    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET specialization_id='therapist' WHERE id=$1", [student.id]);
    await pool.query(
      "INSERT INTO user_specialization_interests (user_id, specialization_id) VALUES ($1,'anti_age')", [student.id]
    );
    const cookie = await loginAs(student);
    await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });

    const res = await request(app).get("/api/course/protocols").set("Cookie", cookie);
    expect(res.body.forYou.length).toBe(1);
    expect(res.body.forYou[0].id).toBe(protoId);
  });
});
