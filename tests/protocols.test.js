const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Протоколы", () => {
  test("куратор видит список протоколов и правит текст гайда, но не может создавать/удалять протокол или привязывать уроки (403)", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const createRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол для куратора", summary: "" });
    const protoId = createRes.body.id;

    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);

    const listRes = await request(app).get("/api/protocols").set("Cookie", cookie);
    expect(listRes.status).toBe(200);

    const guideRes = await request(app).put(`/api/protocols/${protoId}/guides/therapist`).set("Cookie", cookie)
      .send({ guideHtml: "Куратор написал гайд" });
    expect(guideRes.status).toBe(200);

    const createBlocked = await request(app).post("/api/protocols").set("Cookie", cookie)
      .send({ title: "Не должно создаться" });
    expect(createBlocked.status).toBe(403);

    const deleteBlocked = await request(app).delete(`/api/protocols/${protoId}`).set("Cookie", cookie);
    expect(deleteBlocked.status).toBe(403);

    const linkBlocked = await request(app).put(`/api/protocols/${protoId}/lessons`).set("Cookie", cookie).send({ lessonIds: [] });
    expect(linkBlocked.status).toBe(403);
  });

  test("врач без роли admin/curator/super_admin не может открыть список протоколов из админки (403)", async () => {
    const student = await createUser({ role: "student" });
    const cookie = await loginAs(student);
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

  test("гайд/summary хранятся как плоский текст — переносы строк и символы < > сохраняются как есть", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const multiline = "Шаг 1: дозировка < 10 мг\nШаг 2: контроль через 2 недели";

    const createRes = await request(app).post("/api/protocols").set("Cookie", cookie)
      .send({ title: "Протокол с переносами", summary: multiline });
    expect(createRes.status).toBe(200);
    expect(createRes.body.summary).toBe(multiline);

    const guideRes = await request(app).put(`/api/protocols/${createRes.body.id}/guides/therapist`).set("Cookie", cookie)
      .send({ guideHtml: multiline });
    expect(guideRes.status).toBe(200);
    expect(guideRes.body.guideHtml).toBe(multiline);

    const listRes = await request(app).get("/api/protocols").set("Cookie", cookie);
    const proto = listRes.body.protocols.find((p) => p.id === createRes.body.id);
    expect(proto.summary).toBe(multiline);
    expect(proto.guides[0].guideHtml).toBe(multiline);
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
    await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,'therapist')", [student.id]);
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
    await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,'therapist')", [student.id]);
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
    await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,'therapist')", [student.id]);
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

describe("Файлы-вложения к гайдам протоколов", () => {
  test("куратор прикладывает файл к гайду (даже без текста), врач может его скачать, куратор — удалить", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const course = await seedCourse();
    const protoRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол с вложением", summary: "" });
    const protoId = protoRes.body.id;
    await request(app).put(`/api/protocols/${protoId}/lessons`).set("Cookie", adminCookie)
      .send({ lessonIds: [course.lessonIds[0]] });

    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);

    const uploadRes = await request(app)
      .post(`/api/protocols/${protoId}/guides/therapist/files`)
      .set("Cookie", curatorCookie)
      .attach("file", Buffer.from("%PDF-1.4 памятка"), { filename: "pamyatka.pdf", contentType: "application/pdf" });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.file.originalName).toBe("pamyatka.pdf");
    const fileId = uploadRes.body.file.id;

    // Текст гайда не заполняли — вложение создало пустую строку гайда само по себе.
    const listRes = await request(app).get("/api/protocols").set("Cookie", curatorCookie);
    const guide = listRes.body.protocols.find((p) => p.id === protoId).guides.find((g) => g.specializationId === "therapist");
    expect(guide.guideHtml).toBe("");
    expect(guide.files.length).toBe(1);
    expect(guide.files[0].id).toBe(fileId);

    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,'therapist')", [student.id]);
    const studentCookie = await loginAs(student);
    await request(app).post("/api/course/lesson-done").set("Cookie", studentCookie).send({ lessonId: course.lessonIds[0] });

    const studentProtocols = await request(app).get("/api/course/protocols").set("Cookie", studentCookie);
    const studentGuide = studentProtocols.body.forYou[0].guides.find((g) => g.specializationId === "therapist");
    expect(studentGuide.files.length).toBe(1);

    const downloadRes = await request(app)
      .get(`/api/protocols/${protoId}/guides/therapist/files/${fileId}/download`)
      .set("Cookie", studentCookie);
    expect(downloadRes.status).toBe(200);
    expect(Buffer.from(downloadRes.body).toString()).toContain("памятка");

    const studentDeleteBlocked = await request(app)
      .delete(`/api/protocols/${protoId}/guides/therapist/files/${fileId}`)
      .set("Cookie", studentCookie);
    expect(studentDeleteBlocked.status).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/protocols/${protoId}/guides/therapist/files/${fileId}`)
      .set("Cookie", curatorCookie);
    expect(deleteRes.status).toBe(200);

    const afterDelete = await request(app).get("/api/protocols").set("Cookie", curatorCookie);
    const guideAfter = afterDelete.body.protocols.find((p) => p.id === protoId).guides.find((g) => g.specializationId === "therapist");
    expect(guideAfter.files.length).toBe(0);
  });

  test("недопустимый формат файла отклоняется (400)", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const protoRes = await request(app).post("/api/protocols").set("Cookie", adminCookie)
      .send({ title: "Протокол", summary: "" });

    const res = await request(app)
      .post(`/api/protocols/${protoRes.body.id}/guides/therapist/files`)
      .set("Cookie", adminCookie)
      .attach("file", Buffer.from("#!/bin/sh\necho hi"), { filename: "script.sh", contentType: "text/x-sh" });
    expect(res.status).toBe(400);
  });
});
