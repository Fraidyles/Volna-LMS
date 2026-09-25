const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Мультикурс — врач учится сразу на нескольких курсах", () => {
  test("админ создаёт курс через POST /api/courses, он появляется в списке", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/courses").set("Cookie", cookie).send({ title: "Кардиология для терапевтов" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();

    const list = await request(app).get("/api/courses").set("Cookie", cookie);
    expect(list.status).toBe(200);
    const created = list.body.courses.find((c) => c.id === res.body.id);
    expect(created).toBeTruthy();
    expect(created.title).toBe("Кардиология для терапевтов");
    expect(created.enrolledCount).toBe(0);
  });

  test("куратор не может создавать/удалять курсы (403), но видит список", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const createRes = await request(app).post("/api/courses").set("Cookie", cookie).send({ title: "Не должно создаться" });
    expect(createRes.status).toBe(403);
    const listRes = await request(app).get("/api/courses").set("Cookie", cookie);
    expect(listRes.status).toBe(200);
  });

  test("врач записан только на курс А — GET /course/content/:courseB даёт 404", async () => {
    const courseA = await seedCourse();
    const courseB = await seedCourse();
    const student = await createUser({ role: "student", courseId: courseA.courseId });
    const cookie = await loginAs(student);

    const okA = await request(app).get("/api/course/content/" + courseA.courseId).set("Cookie", cookie);
    expect(okA.status).toBe(200);

    const failB = await request(app).get("/api/course/content/" + courseB.courseId).set("Cookie", cookie);
    expect(failB.status).toBe(404);

    const enrollments = await request(app).get("/api/course/enrollments").set("Cookie", cookie);
    expect(enrollments.body.enrollments.length).toBe(1);
    expect(enrollments.body.enrollments[0].courseId).toBe(courseA.courseId);
  });

  test("куратор записывает врача на второй курс — прогресс по курсам независим", async () => {
    const courseA = await seedCourse();
    const courseB = await seedCourse();
    const student = await createUser({ role: "student", courseId: courseA.courseId });
    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);

    const enrollRes = await request(app).post(`/api/staff/students/${student.id}/enroll`).set("Cookie", staffCookie)
      .send({ courseId: courseB.courseId });
    expect(enrollRes.status).toBe(200);

    // Повторная запись на тот же курс — 400, а не тихий дубликат строки progress.
    const dupRes = await request(app).post(`/api/staff/students/${student.id}/enroll`).set("Cookie", staffCookie)
      .send({ courseId: courseB.courseId });
    expect(dupRes.status).toBe(400);
    expect(dupRes.body.error).toBe("already_enrolled");

    const cookie = await loginAs(student);
    const enrollments = await request(app).get("/api/course/enrollments").set("Cookie", cookie);
    expect(enrollments.body.enrollments.length).toBe(2);

    // Проходим урок ТОЛЬКО в курсе А.
    await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: courseA.lessonIds[0] });

    const contentA = await request(app).get("/api/course/content/" + courseA.courseId).set("Cookie", cookie);
    expect(contentA.body.progress.completed_lessons).toContain(courseA.lessonIds[0]);

    const contentB = await request(app).get("/api/course/content/" + courseB.courseId).set("Cookie", cookie);
    expect(contentB.body.progress.completed_lessons).toEqual([]);
  });

  test("сертификат курса А не выдаётся вместе с курсом Б — courseId обязателен и разделяет статусы", async () => {
    const courseA = await seedCourse();
    const courseB = await seedCourse();
    await pool.query("UPDATE courses SET certificates_enabled=true WHERE id=$1", [courseA.courseId]);
    const student = await createUser({ role: "student", courseId: courseA.courseId });
    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);
    await request(app).post(`/api/staff/students/${student.id}/enroll`).set("Cookie", staffCookie).send({ courseId: courseB.courseId });

    await pool.query(
      "UPDATE progress SET completed=true, quiz_score=90, certificate_status='pending' WHERE user_id=$1 AND course_id=$2",
      [student.id, courseA.courseId]
    );

    const issueRes = await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", staffCookie)
      .send({ courseId: courseA.courseId });
    expect(issueRes.status).toBe(200);

    const progA = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1 AND course_id=$2", [student.id, courseA.courseId]);
    expect(progA.rows[0].certificate_status).toBe("issued");
    const progB = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1 AND course_id=$2", [student.id, courseB.courseId]);
    expect(progB.rows[0].certificate_status).toBe("none");

    // Выдать сертификат за курс Б (сертификаты там выключены) — запрещено.
    const issueBRes = await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", staffCookie)
      .send({ courseId: courseB.courseId });
    expect(issueBRes.status).toBe(403);
  });

  test("GET /staff/students?courseId= показывает врача только в разрезе своего курса", async () => {
    const courseA = await seedCourse();
    const courseB = await seedCourse();
    const student = await createUser({ role: "student", courseId: courseA.courseId });
    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);

    const listA = await request(app).get("/api/staff/students").query({ courseId: courseA.courseId }).set("Cookie", staffCookie);
    const rowA = listA.body.students.find((s) => s.id === student.id);
    expect(rowA).toBeTruthy();
    expect(rowA.course_id).toBe(courseA.courseId);

    // В разрезе курса Б врач тоже виден (LEFT JOIN — не пропадает из общего списка), но без прогресса по нему.
    const listB = await request(app).get("/api/staff/students").query({ courseId: courseB.courseId }).set("Cookie", staffCookie);
    const rowB = listB.body.students.find((s) => s.id === student.id);
    expect(rowB).toBeTruthy();
    expect(rowB.course_id).toBeNull();
  });

  test("удаление курса требует точного совпадения названия для подтверждения", async () => {
    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const createRes = await request(app).post("/api/courses").set("Cookie", cookie).send({ title: "Курс на удаление" });
    const courseId = createRes.body.id;

    const wrongConfirm = await request(app).delete("/api/courses/" + courseId).set("Cookie", cookie).send({ confirmTitle: "неверно" });
    expect(wrongConfirm.status).toBe(400);

    const rightConfirm = await request(app).delete("/api/courses/" + courseId).set("Cookie", cookie).send({ confirmTitle: "Курс на удаление" });
    expect(rightConfirm.status).toBe(200);

    const check = await pool.query("SELECT id FROM courses WHERE id=$1", [courseId]);
    expect(check.rowCount).toBe(0);
  });
});
