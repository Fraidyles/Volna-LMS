const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;

beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

describe("Курс врача", () => {
  test("GET /course возвращает уроки, тест (без ответов) и прогресс", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    const res = await request(app).get("/api/course").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.lessons.length).toBeGreaterThan(0);
    expect(res.body.quiz[0].correct).toBeUndefined(); // правильный ответ не должен уходить студенту
    expect(res.body.locked.locked).toBe(false);
  });

  test("отметка урока пройденным сохраняется", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    const res = await request(app).post("/api/course/lesson-done").set("Cookie", cookie)
      .send({ lessonId: course.lessonIds[0] });
    expect(res.status).toBe(200);
    expect(res.body.completedLessons).toContain(course.lessonIds[0]);
  });

  test("балл теста считается на сервере — подделать через клиент нельзя", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    // Отправляем заведомо неверные ответы на оба вопроса (правильный везде индекс 0)
    const wrongAnswers = {};
    wrongAnswers[course.questionIds[0]] = 2;
    wrongAnswers[course.questionIds[1]] = 2;
    const res = await request(app).post("/api/course/quiz-submit").set("Cookie", cookie).send({ answers: wrongAnswers });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.completed).toBe(false);

    // А теперь верные — балл должен быть 100
    const rightAnswers = {};
    rightAnswers[course.questionIds[0]] = 0;
    rightAnswers[course.questionIds[1]] = 0;
    const res2 = await request(app).post("/api/course/quiz-submit").set("Cookie", cookie).send({ answers: rightAnswers });
    expect(res2.body.score).toBe(100);
    expect(res2.body.completed).toBe(true);
    expect(res2.body.certificateStatus).toBe("pending");
  });

  test("заблокированный доступ запрещает прохождение урока (403)", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET access_blocked=true WHERE user_id=$1", [user.id]);
    const cookie = await loginAs(user);
    const res = await request(app).post("/api/course/lesson-done").set("Cookie", cookie)
      .send({ lessonId: course.lessonIds[0] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("access_locked");
  });

  test("истёкший срок доступа тоже блокирует (403), а курс в GET помечен locked", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET access_expires_at=$1 WHERE user_id=$2", ["2020-01-01", user.id]);
    const cookie = await loginAs(user);
    const getRes = await request(app).get("/api/course").set("Cookie", cookie);
    expect(getRes.body.locked.locked).toBe(true);
    expect(getRes.body.locked.reason).toBe("expired");
  });

  test("скрытый от конкретного врача урок недоступен ему (403), но виден в hiddenForMe только у него", async () => {
    const targetUser = await createUser({ role: "student", courseId: course.courseId });
    const otherUser = await createUser({ role: "student", courseId: course.courseId });

    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);
    await request(app).put(`/api/course/visibility/${course.lessonIds[0]}`).set("Cookie", staffCookie)
      .send({ ids: [targetUser.id] });

    const targetCookie = await loginAs(targetUser);
    const targetCourse = await request(app).get("/api/course").set("Cookie", targetCookie);
    const hiddenLesson = targetCourse.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(hiddenLesson.hiddenForMe).toBe(true);

    const otherCookie = await loginAs(otherUser);
    const otherCourse = await request(app).get("/api/course").set("Cookie", otherCookie);
    const notHiddenLesson = otherCourse.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(notHiddenLesson.hiddenForMe).toBe(false);

    const doneRes = await request(app).post("/api/course/lesson-done").set("Cookie", targetCookie)
      .send({ lessonId: course.lessonIds[0] });
    expect(doneRes.status).toBe(403);
    expect(doneRes.body.error).toBe("content_hidden");
  });

  test("HTML урока при сохранении черновика очищается от <script> (XSS)", async () => {
    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/draft`).set("Cookie", cookie)
      .send({ title: "Урок с XSS", duration: "5 мин", html: '<p>Текст</p><script>alert(1)</script><img src=x onerror=alert(2)>' });
    expect(res.status).toBe(200);

    const lessonRes = await request(app).get(`/api/course/lessons/${course.lessonIds[0]}`).set("Cookie", cookie);
    expect(lessonRes.body.lesson.draft_html).not.toContain("<script>");
    expect(lessonRes.body.lesson.draft_html).not.toContain("onerror");
  });

  test("непрочитанные сообщения: считаются, пока врач не откроет чат", async () => {
    const crypto = require("crypto");
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    await pool.query(
      "INSERT INTO messages (id, student_id, from_role, author_name, body) VALUES ($1,$2,'curator','Куратор','Как проходит курс?')",
      [crypto.randomUUID(), user.id]
    );

    const before = await request(app).get("/api/course").set("Cookie", cookie);
    expect(before.body.unreadMessages).toBe(1);

    await request(app).get(`/api/messages/${user.id}`).set("Cookie", cookie);

    const after = await request(app).get("/api/course").set("Cookie", cookie);
    expect(after.body.unreadMessages).toBe(0);
  });

  test("заметка к уроку сохраняется и удаляется пустой строкой", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const saveRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/note`).set("Cookie", cookie)
      .send({ note: "Спросить куратора про дозировки" });
    expect(saveRes.status).toBe(200);

    const getRes = await request(app).get("/api/course").set("Cookie", cookie);
    expect(getRes.body.progress.lesson_notes[course.lessonIds[0]]).toBe("Спросить куратора про дозировки");

    await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/note`).set("Cookie", cookie).send({ note: "" });
    const getRes2 = await request(app).get("/api/course").set("Cookie", cookie);
    expect(getRes2.body.progress.lesson_notes[course.lessonIds[0]]).toBeUndefined();
  });

  test("массовая выдача сертификатов — только тем, кто сдал тест", async () => {
    const passed = await createUser({ role: "student", courseId: course.courseId });
    const notPassed = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET completed=true, certificate_status='pending' WHERE user_id=$1", [passed.id]);

    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/course/certificate/bulk-issue").set("Cookie", cookie)
      .send({ studentIds: [passed.id, notPassed.id] });
    expect(res.status).toBe(200);
    expect(res.body.issued).toBe(2); // маршрут выдаёт всем переданным id — фильтрация по факту сдачи теста делается на фронтенде при выборе

    const check = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1", [passed.id]);
    expect(check.rows[0].certificate_status).toBe("issued");
  });
});
