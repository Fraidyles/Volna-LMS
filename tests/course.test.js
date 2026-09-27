const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;

beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

describe("Курс врача", () => {
  test("GET /course возвращает уроки, тест (без ответов) и прогресс", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    const res = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
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

  test("GET /course и PUT /heartbeat отмечают врача «онлайн» для куратора", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curator.id, user.id]);
    const cookie = await loginAs(user);

    // Пока врач ни разу не заходил в курс — last_seen_at пуст, online=false.
    const before = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(before.body.student.online).toBe(false);

    await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    const afterLoad = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(afterLoad.body.student.online).toBe(true);

    // Хартбит без реального прохождения курса — тоже продлевает "онлайн",
    // но НЕ трогает last_active_at (тот завязан на стрик и дайджест).
    await pool.query("UPDATE progress SET last_seen_at = now() - interval '10 minutes' WHERE user_id=$1", [user.id]);
    const stale = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(stale.body.student.online).toBe(false);

    const hb = await request(app).put("/api/course/heartbeat").set("Cookie", cookie);
    expect(hb.status).toBe(200);
    const afterHeartbeat = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(afterHeartbeat.body.student.online).toBe(true);
  });

  test("POST /course/offline мгновенно гасит «онлайн» — как закрытие вкладки в Telegram/VK", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curator.id, user.id]);
    const cookie = await loginAs(user);

    await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    const online = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(online.body.student.online).toBe(true);

    // last_seen_at свежий (только что закрыл вкладку) — но online должен стать false
    // немедленно, не дожидаясь устаревания last_seen_at.
    const off = await request(app).post("/api/course/offline").set("Cookie", cookie);
    expect(off.status).toBe(200);
    const afterOffline = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(afterOffline.body.student.online).toBe(false);
    expect(new Date(afterOffline.body.student.last_seen_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  test("lesson-done с несуществующим id урока — 404, а не молчаливое зачисление очков", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    const res = await request(app).post("/api/course/lesson-done").set("Cookie", cookie)
      .send({ lessonId: "no-such-lesson-id" });
    expect(res.status).toBe(404);

    // Подделанный id не должен был попасть в completed_lessons — иначе счётчик
    // "N / total уроков" на главной врача мог бы показать N больше total.
    const after = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(after.body.progress.completed_lessons).not.toContain("no-such-lesson-id");
  });

  test("балл теста считается на сервере — подделать через клиент нельзя", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    // Отправляем заведомо неверные ответы на оба вопроса (правильный везде индекс 0)
    const wrongAnswers = {};
    wrongAnswers[course.questionIds[0]] = 2;
    wrongAnswers[course.questionIds[1]] = 2;
    const res = await request(app).post("/api/course/quiz-submit").set("Cookie", cookie).send({ answers: wrongAnswers, courseId: course.courseId });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.completed).toBe(false);

    // А теперь верные — балл должен быть 100
    const rightAnswers = {};
    rightAnswers[course.questionIds[0]] = 0;
    rightAnswers[course.questionIds[1]] = 0;
    const res2 = await request(app).post("/api/course/quiz-submit").set("Cookie", cookie).send({ answers: rightAnswers, courseId: course.courseId });
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
    const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
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
    const targetCourse = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", targetCookie);
    const hiddenLesson = targetCourse.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(hiddenLesson.hiddenForMe).toBe(true);

    const otherCookie = await loginAs(otherUser);
    const otherCourse = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", otherCookie);
    const notHiddenLesson = otherCourse.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(notHiddenLesson.hiddenForMe).toBe(false);

    const doneRes = await request(app).post("/api/course/lesson-done").set("Cookie", targetCookie)
      .send({ lessonId: course.lessonIds[0] });
    expect(doneRes.status).toBe(403);
    expect(doneRes.body.error).toBe("content_hidden");
  });

  test("дрип: урок с drip_days ещё не открылся врачу, зарегистрированному недавно (403 + dripLockedForMe)", async () => {
    await pool.query("UPDATE lessons SET drip_days=7 WHERE id=$1", [course.lessonIds[1]]);
    try {
      const user = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(user);

      const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
      const lesson = getRes.body.lessons.find((l) => l.id === course.lessonIds[1]);
      expect(lesson.dripLockedForMe).toBe(true);
      expect(lesson.availableAt).toBeTruthy();

      const doneRes = await request(app).post("/api/course/lesson-done").set("Cookie", cookie)
        .send({ lessonId: course.lessonIds[1] });
      expect(doneRes.status).toBe(403);
      expect(doneRes.body.error).toBe("content_drip_locked");
    } finally {
      await pool.query("UPDATE lessons SET drip_days=NULL WHERE id=$1", [course.lessonIds[1]]);
    }
  });

  test("дрип: урок открывается сам, когда прошло достаточно дней с регистрации врача", async () => {
    await pool.query("UPDATE lessons SET drip_days=7 WHERE id=$1", [course.lessonIds[1]]);
    try {
      const user = await createUser({ role: "student", courseId: course.courseId });
      await pool.query("UPDATE progress SET created_at=now() - interval '8 days' WHERE user_id=$1", [user.id]);
      const cookie = await loginAs(user);

      const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
      const lesson = getRes.body.lessons.find((l) => l.id === course.lessonIds[1]);
      expect(lesson.dripLockedForMe).toBe(false);

      const doneRes = await request(app).post("/api/course/lesson-done").set("Cookie", cookie)
        .send({ lessonId: course.lessonIds[1] });
      expect(doneRes.status).toBe(200);
    } finally {
      await pool.query("UPDATE lessons SET drip_days=NULL WHERE id=$1", [course.lessonIds[1]]);
    }
  });

  test("расписание урока: куратор назначает дату открытия конкретному врачу — переопределяет дрип", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const cookie = await loginAs(staff);
    const futureIso = new Date(Date.now() + 3 * 86400000).toISOString();

    const setRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/schedule`).set("Cookie", cookie)
      .send({ studentIds: [student.id], unlockAt: futureIso });
    expect(setRes.status).toBe(200);
    expect(setRes.body.updated).toBe(1);

    const studentCookie = await loginAs(student);
    const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", studentCookie);
    const lesson = getRes.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(lesson.dripLockedForMe).toBe(true);
    expect(lesson.scheduledForMe).toBe(true);

    const doneRes = await request(app).post("/api/course/lesson-done").set("Cookie", studentCookie)
      .send({ lessonId: course.lessonIds[0] });
    expect(doneRes.status).toBe(403);
  });

  test("расписание урока: массовое назначение без studentIds применяется ко всем врачам в скоупе куратора", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const own = await createUser({ role: "student", courseId: course.courseId });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorA.id, own.id]);
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorB.id, stranger.id]);

    const cookie = await loginAs(curatorA);
    const futureIso = new Date(Date.now() + 2 * 86400000).toISOString();
    const res = await request(app).put(`/api/course/lessons/${course.lessonIds[1]}/schedule`).set("Cookie", cookie)
      .send({ unlockAt: futureIso });
    expect(res.status).toBe(200);

    const scheduleRes = await request(app).get(`/api/course/lessons/${course.lessonIds[1]}/schedule`).set("Cookie", cookie);
    const ownRow = scheduleRes.body.schedule.find((r) => r.student_id === own.id);
    expect(ownRow.unlock_at).toBeTruthy();
    const strangerRow = scheduleRes.body.schedule.find((r) => r.student_id === stranger.id);
    expect(strangerRow).toBeUndefined(); // куратор A не видит чужого врача даже в списке расписания
  });

  test("расписание урока: очистка (unlockAt пустой) удаляет переопределение и возвращает обычный дрип", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const futureIso = new Date(Date.now() + 3 * 86400000).toISOString();
    await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/schedule`).set("Cookie", cookie)
      .send({ studentIds: [student.id], unlockAt: futureIso });

    const clearRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/schedule`).set("Cookie", cookie)
      .send({ studentIds: [student.id], unlockAt: null });
    expect(clearRes.status).toBe(200);

    const studentCookie = await loginAs(student);
    const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", studentCookie);
    const lesson = getRes.body.lessons.find((l) => l.id === course.lessonIds[0]);
    expect(lesson.scheduledForMe).toBe(false);
    expect(lesson.dripLockedForMe).toBe(false);
  });

  test("геймификация: первая активность за день ставит стрик=1, повторная в тот же день не меняет его", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const r1 = await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });
    expect(r1.body.gamification.currentStreak).toBe(1);

    const r2 = await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[1] });
    expect(r2.body.gamification.currentStreak).toBe(1); // тот же день — не задваиваем

    const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(getRes.body.gamification.currentStreak).toBe(1);
    expect(getRes.body.gamification.longestStreak).toBe(1);
  });

  test("геймификация: активность вчера + сегодня продлевает стрик, разрыв в днях сбрасывает его", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query(
      "UPDATE progress SET current_streak=3, longest_streak=3, last_streak_date=(now() - interval '1 day')::date WHERE user_id=$1",
      [user.id]
    );
    const cookie = await loginAs(user);
    const r1 = await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });
    expect(r1.body.gamification.currentStreak).toBe(4);
    expect(r1.body.gamification.longestStreak).toBe(4);

    const user2 = await createUser({ role: "student", courseId: course.courseId });
    await pool.query(
      "UPDATE progress SET current_streak=5, longest_streak=5, last_streak_date=(now() - interval '3 days')::date WHERE user_id=$1",
      [user2.id]
    );
    const cookie2 = await loginAs(user2);
    const r2 = await request(app).post("/api/course/lesson-done").set("Cookie", cookie2).send({ lessonId: course.lessonIds[0] });
    expect(r2.body.gamification.currentStreak).toBe(1);
    expect(r2.body.gamification.longestStreak).toBe(5); // рекорд не уменьшается
  });

  test("геймификация: lesson-done тоже возвращает актуальные очки (не только GET /course)", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);
    const r1 = await request(app).post("/api/course/lesson-done").set("Cookie", cookie).send({ lessonId: course.lessonIds[0] });
    // 1 урок * 20 + стрик 1*5 = 25
    expect(r1.body.gamification.points).toBe(25);
  });

  test("геймификация: очки в GET /course считаются из уроков, теста, сертификата и стрика", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query(
      `UPDATE progress SET completed_lessons=$1, completed=true, quiz_score=80,
       certificate_status='issued', current_streak=2 WHERE user_id=$2`,
      [JSON.stringify([course.lessonIds[0], course.lessonIds[1]]), user.id]
    );
    const cookie = await loginAs(user);
    const res = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    // 2 урока * 20 + тест 80 + сертификат 100 + стрик 2*5 = 230
    expect(res.body.gamification.points).toBe(230);
  });

  test("геймификация: очки не превышают 1000 (порог обмена на скидку 25%)", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    // Огромный стрик один даёт 300*5=1500 очков — без потолка ушло бы далеко за 1000.
    await pool.query(
      `UPDATE progress SET completed_lessons=$1, completed=true, quiz_score=100,
       certificate_status='issued', current_streak=300 WHERE user_id=$2`,
      [JSON.stringify(course.lessonIds), user.id]
    );
    const cookie = await loginAs(user);
    const res = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(res.body.gamification.points).toBe(1000);
  });

  test("онбординг-чеклист: по умолчанию не скрыт, врач может закрыть его вручную", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const before = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(before.body.progress.onboarding_dismissed).toBe(false);

    const dismissRes = await request(app).put("/api/course/onboarding-dismiss").set("Cookie", cookie);
    expect(dismissRes.status).toBe(200);

    const after = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(after.body.progress.onboarding_dismissed).toBe(true);
  });

  test("«Мои материалы»: врач может сохранить и убрать урок из закладок", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const before = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(before.body.bookmarkedLessonIds).toEqual([]);

    const addRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/bookmark`).set("Cookie", cookie)
      .send({ bookmarked: true });
    expect(addRes.status).toBe(200);

    const after = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(after.body.bookmarkedLessonIds).toEqual([course.lessonIds[0]]);

    await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/bookmark`).set("Cookie", cookie)
      .send({ bookmarked: false });
    const afterRemove = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(afterRemove.body.bookmarkedLessonIds).toEqual([]);
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

  test("заметка к уроку сохраняется и удаляется пустой строкой", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const saveRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/note`).set("Cookie", cookie)
      .send({ note: "Спросить куратора про дозировки" });
    expect(saveRes.status).toBe(200);

    const getRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(getRes.body.progress.lesson_notes[course.lessonIds[0]]).toBe("Спросить куратора про дозировки");

    await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/note`).set("Cookie", cookie).send({ note: "" });
    const getRes2 = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(getRes2.body.progress.lesson_notes[course.lessonIds[0]]).toBeUndefined();
  });

  // Текущий (демо) курс по умолчанию certificates_enabled=false — эта проверка
  // должна идти РАНЬШЕ остальных тестов на сертификаты в этом файле, иначе они уже
  // включат флаг. Обновляем ВСЕ строки courses (а не одну через LIMIT 1) — в тестах
  // их накапливается несколько (каждый файл сеет свой курс), и сам маршрут читает
  // флаг через "SELECT ... LIMIT 1" без ORDER BY: после UPDATE именно найденной по
  // LIMIT 1 строки её физическая позиция в куче может измениться (MVCC), и следующий
  // такой же запрос вернёт уже другую, непроставленную строку. В проде это не имеет
  // значения — там курс всегда ровно один.
  test("выдача сертификата заблокирована, пока courses.certificates_enabled=false (демо-курс)", async () => {
    await pool.query("UPDATE courses SET certificates_enabled=false");
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET completed=true WHERE user_id=$1", [student.id]);

    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", cookie).send({ courseId: course.courseId });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("certificates_disabled");

    const check = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1", [student.id]);
    expect(check.rows[0].certificate_status).not.toBe("issued");
  });

  test("массовая выдача сертификатов — только тем, кто сдал тест", async () => {
    await pool.query("UPDATE courses SET certificates_enabled=true");
    const passed = await createUser({ role: "student", courseId: course.courseId });
    const notPassed = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET completed=true, certificate_status='pending' WHERE user_id=$1", [passed.id]);

    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/course/certificate/bulk-issue").set("Cookie", cookie)
      .send({ studentIds: [passed.id, notPassed.id], courseId: course.courseId });
    expect(res.status).toBe(200);
    expect(res.body.issued).toBe(2); // маршрут выдаёт всем переданным id — фильтрация по факту сдачи теста делается на фронтенде при выборе

    const check = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1", [passed.id]);
    expect(check.rows[0].certificate_status).toBe("issued");
  });

  test("сертификат: скачивание недоступно до выдачи, доступно и стабильно после", async () => {
    await pool.query("UPDATE courses SET certificates_enabled=true");
    const student = await createUser({ role: "student", courseId: course.courseId });
    const studentCookie = await loginAs(student);

    const before = await request(app).get("/api/course/certificate/download").query({ courseId: course.courseId }).set("Cookie", studentCookie);
    expect(before.status).toBe(403);

    const admin = await createUser({ role: "super_admin" });
    const adminCookie = await loginAs(admin);
    const issueRes = await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", adminCookie).send({ courseId: course.courseId });
    expect(issueRes.status).toBe(200);

    const dl = await request(app).get("/api/course/certificate/download").query({ courseId: course.courseId }).set("Cookie", studentCookie);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(dl.body.length).toBeGreaterThan(1000); // непустой PDF, а не заглушка

    const numRow = await pool.query("SELECT certificate_number FROM progress WHERE user_id=$1", [student.id]);
    const number = numRow.rows[0].certificate_number;
    expect(number).toMatch(/^MD-\d{4}-[A-Z0-9]{6}$/);

    // Повторная выдача (например, второй клик куратора) не должна перевыпускать номер —
    // иначе старый скачанный файл разошёлся бы с тем, что хранится в базе.
    await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", adminCookie).send({ courseId: course.courseId });
    const numRow2 = await pool.query("SELECT certificate_number FROM progress WHERE user_id=$1", [student.id]);
    expect(numRow2.rows[0].certificate_number).toBe(number);

    // Куратор/админ тоже может скачать тот же файл через свою ручку.
    const staffDl = await request(app).get(`/api/staff/students/${student.id}/certificate/download`).set("Cookie", adminCookie);
    expect(staffDl.status).toBe(200);
    expect(staffDl.headers["content-type"]).toBe("application/pdf");
  });

  // Ниже — конструктор курса. Роуты резолвят "курс" через `SELECT id FROM courses LIMIT 1`
  // (в проде курс всегда один, так и останется), поэтому тесты сами один раз узнают,
  // на какой courses.id это разрешится в этом прогоне, и дальше работают только с ним —
  // без предположений о том, что это обязательно course.courseId из seedCourse() этого файла.
  // Ставим эти тесты последними в файле: они удаляют уроки/вопросы вплоть до последнего,
  // так что ничего более раннего в этом файле их не переживёт.
  describe("Конструктор курса (админ/супер-админ)", () => {
    test("урок: можно добавить, переставить порядок и удалить", async () => {
      const admin = await createUser({ role: "super_admin" });
      const cookie = await loginAs(admin);
      const targetCourseId = (await pool.query("SELECT id FROM courses LIMIT 1")).rows[0].id;

      const createRes = await request(app).post("/api/course/lessons").set("Cookie", cookie)
        .send({ courseId: course.courseId, title: "Новый урок", duration: "4 мин", html: "<p>Текст нового урока</p>" });
      expect(createRes.status).toBe(200);
      const newId = createRes.body.id;

      const afterCreate = await pool.query("SELECT id, idx FROM lessons WHERE course_id=$1 ORDER BY idx", [targetCourseId]);
      expect(afterCreate.rows.find((r) => r.id === newId)).toBeTruthy();

      const reversedOrder = afterCreate.rows.map((r) => r.id).reverse();
      const reorderRes = await request(app).put("/api/course/lessons/reorder").set("Cookie", cookie)
        .send({ orderedIds: reversedOrder });
      expect(reorderRes.status).toBe(200);
      const afterReorder = await pool.query("SELECT id FROM lessons WHERE course_id=$1 ORDER BY idx", [targetCourseId]);
      expect(afterReorder.rows.map((r) => r.id)).toEqual(reversedOrder);

      const deleteRes = await request(app).delete(`/api/course/lessons/${newId}`).set("Cookie", cookie);
      expect(deleteRes.status).toBe(200);
      const afterDelete = await pool.query("SELECT id FROM lessons WHERE id=$1", [newId]);
      expect(afterDelete.rowCount).toBe(0);
    });

    test("урок: удалённый через откат в журнале восстанавливается", async () => {
      const admin = await createUser({ role: "super_admin" });
      const cookie = await loginAs(admin);

      const createRes = await request(app).post("/api/course/lessons").set("Cookie", cookie)
        .send({ courseId: course.courseId, title: "Урок для отката", duration: "3 мин", html: "<p>Контент</p>" });
      const lessonId = createRes.body.id;

      const deleteRes = await request(app).delete(`/api/course/lessons/${lessonId}`).set("Cookie", cookie);
      expect(deleteRes.status).toBe(200);

      const logRow = await pool.query(
        "SELECT id FROM audit_log WHERE action='content.lesson_deleted' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
        [lessonId]
      );
      expect(logRow.rowCount).toBe(1);

      const revertRes = await request(app).post(`/api/staff/audit-log/${logRow.rows[0].id}/revert`).set("Cookie", cookie);
      expect(revertRes.status).toBe(200);

      const restored = await pool.query("SELECT title FROM lessons WHERE id=$1", [lessonId]);
      expect(restored.rowCount).toBe(1);
      expect(restored.rows[0].title).toBe("Урок для отката");
    });

    test("урок: нельзя удалить последний оставшийся в курсе", async () => {
      const admin = await createUser({ role: "super_admin" });
      const cookie = await loginAs(admin);
      const targetCourseId = (await pool.query("SELECT id FROM courses LIMIT 1")).rows[0].id;

      let remaining = (await pool.query("SELECT id FROM lessons WHERE course_id=$1 ORDER BY idx", [targetCourseId])).rows.map((r) => r.id);
      // Съедаем все, кроме одного — оставшиеся удаления должны проходить успешно.
      while (remaining.length > 1) {
        const res = await request(app).delete(`/api/course/lessons/${remaining[0]}`).set("Cookie", cookie);
        expect(res.status).toBe(200);
        remaining.shift();
      }
      const lastAttempt = await request(app).delete(`/api/course/lessons/${remaining[0]}`).set("Cookie", cookie);
      expect(lastAttempt.status).toBe(400);
      expect(lastAttempt.body.error).toBe("last_lesson");
    });

    test("тест: можно добавить, переставить и удалить вопрос; нельзя удалить последний", async () => {
      const admin = await createUser({ role: "super_admin" });
      const cookie = await loginAs(admin);
      const targetCourseId = (await pool.query("SELECT id FROM courses LIMIT 1")).rows[0].id;

      const createRes = await request(app).post("/api/course/quiz-admin").set("Cookie", cookie)
        .send({ courseId: course.courseId, question: "Новый вопрос?", options: ["А", "Б"], correct: 0 });
      expect(createRes.status).toBe(200);
      const newQId = createRes.body.id;

      const afterCreate = await pool.query("SELECT id FROM quiz_questions WHERE course_id=$1 ORDER BY idx", [targetCourseId]);
      const reversedOrder = afterCreate.rows.map((r) => r.id).reverse();
      const reorderRes = await request(app).put("/api/course/quiz-admin/reorder").set("Cookie", cookie)
        .send({ orderedIds: reversedOrder });
      expect(reorderRes.status).toBe(200);

      let remaining = reversedOrder.slice();
      while (remaining.length > 1) {
        const res = await request(app).delete(`/api/course/quiz-admin/${remaining[0]}`).set("Cookie", cookie);
        expect(res.status).toBe(200);
        remaining.shift();
      }
      const lastAttempt = await request(app).delete(`/api/course/quiz-admin/${remaining[0]}`).set("Cookie", cookie);
      expect(lastAttempt.status).toBe(400);
      expect(lastAttempt.body.error).toBe("last_question");
    });

    test("дрип: можно назначить и снять задержку открытия урока", async () => {
      const admin = await createUser({ role: "super_admin" });
      const cookie = await loginAs(admin);
      const targetCourseId = (await pool.query("SELECT id FROM courses LIMIT 1")).rows[0].id;
      const anyLesson = (await pool.query("SELECT id FROM lessons WHERE course_id=$1 LIMIT 1", [targetCourseId])).rows[0].id;

      const setRes = await request(app).put(`/api/course/lessons/${anyLesson}/drip`).set("Cookie", cookie).send({ dripDays: 7 });
      expect(setRes.status).toBe(200);
      const check1 = await pool.query("SELECT drip_days FROM lessons WHERE id=$1", [anyLesson]);
      expect(check1.rows[0].drip_days).toBe(7);

      const clearRes = await request(app).put(`/api/course/lessons/${anyLesson}/drip`).set("Cookie", cookie).send({ dripDays: null });
      expect(clearRes.status).toBe(200);
      const check2 = await pool.query("SELECT drip_days FROM lessons WHERE id=$1", [anyLesson]);
      expect(check2.rows[0].drip_days).toBeNull();
    });

    test("куратор не может пользоваться конструктором курса (403)", async () => {
      const curator = await createUser({ role: "curator" });
      const cookie = await loginAs(curator);
      const res = await request(app).post("/api/course/lessons").set("Cookie", cookie)
        .send({ courseId: course.courseId, title: "x", duration: "1 мин", html: "<p>x</p>" });
      expect(res.status).toBe(403);
    });
  });

  describe("Видео с таймкодами и поурочный тест", () => {
    // Не через POST /course/lessons: та ручка создаёт урок в "первом попавшемся"
    // курсе (SELECT ... LIMIT 1 без ORDER BY, см. её реализацию) — при параллельном
    // запуске нескольких тестовых файлов, каждый из которых сам сеет свой курс,
    // это может оказаться не тем course.courseId, что использован в этом файле.
    // Вставляем урок напрямую в ИМЕННО этот курс, как и seedCourse() в helpers.js.
    async function makeLesson() {
      const id = "lesson-video-" + crypto.randomUUID().slice(0, 8);
      await pool.query(
        "INSERT INTO lessons (id, course_id, idx, title, duration, html) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, course.courseId, 99, "Урок с видео", "10 мин", "<p>Интро</p>"]
      );
      return id;
    }

    test("админ сохраняет видео и главы, врач видит их в GET /course", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();

      const videoRes = await request(app).put(`/api/course/lessons/${lessonId}/video`).set("Cookie", adminCookie).send({
        videoUrl: "https://example.com/video.mp4",
        timecodes: [
          { time: 30, title: "Введение", summary: "<p>О чём урок</p>" },
          { time: 5, title: "Приветствие" }
        ]
      });
      expect(videoRes.status).toBe(200);
      expect(videoRes.body.timecodes.length).toBe(2);
      expect(videoRes.body.timecodes[0].time).toBe(5); // отсортированы по времени

      const student = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(student);
      const courseRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
      const lessonOut = courseRes.body.lessons.find((l) => l.id === lessonId);
      expect(lessonOut.videoUrl).toBe("https://example.com/video.mp4");
      expect(lessonOut.videoTimecodes.length).toBe(2);
      expect(lessonOut.videoTimecodes[0].title).toBe("Приветствие");
    });

    test("глава без времени или названия отклоняется (400)", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const res = await request(app).put(`/api/course/lessons/${lessonId}/video`).set("Cookie", adminCookie).send({
        timecodes: [{ time: 10 }]
      });
      expect(res.status).toBe(400);
    });

    test("сводка главы хранится как плоский текст — переносы строк и символы < > сохраняются как есть", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const multiline = "Норма < 5 ммоль/л\nПри отклонении — повторный анализ";
      const res = await request(app).put(`/api/course/lessons/${lessonId}/video`).set("Cookie", adminCookie).send({
        timecodes: [{ time: 5, title: "Норма", summary: multiline }]
      });
      expect(res.status).toBe(200);
      expect(res.body.timecodes[0].summary).toBe(multiline);
    });

    test("админ создаёт поурочный тест, он не попадает в итоговый тест курса", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();

      const qRes = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "Сколько будет 2+2?", options: ["3", "4", "5"], correct: 1 });
      expect(qRes.status).toBe(200);

      const finalQuizRes = await request(app).get("/api/course/quiz-admin").query({ courseId: course.courseId }).set("Cookie", adminCookie);
      expect(finalQuizRes.body.quiz.some((q) => q.id === qRes.body.id)).toBe(false);

      const lessonQuizRes = await request(app).get(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie);
      expect(lessonQuizRes.body.quiz.length).toBe(1);
      expect(lessonQuizRes.body.quiz[0].correct).toBe(1);
    });

    test("врач проходит поурочный тест — считается балл, урок помечается пройденным, очки растут", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const q1 = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "В1", options: ["a", "b"], correct: 0 });
      const q2 = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "В2", options: ["a", "b"], correct: 1 });

      const student = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(student);

      const answers = {}; answers[q1.body.id] = 0; answers[q2.body.id] = 0; // второй ответ неверный
      const submitRes = await request(app).post(`/api/course/lessons/${lessonId}/quiz-submit`).set("Cookie", cookie)
        .send({ answers });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.score).toBe(50);
      expect(submitRes.body.completedLessons).toContain(lessonId);
      // Разбор после отправки: сколько верно и какой ответ был правильным.
      expect(submitRes.body.correctCount).toBe(1);
      expect(submitRes.body.total).toBe(2);
      const rv2 = submitRes.body.review.find((r) => r.id === q2.body.id);
      expect(rv2).toEqual({ id: q2.body.id, correct: 1, chosen: 0 });

      const courseRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
      expect(courseRes.body.progress.lesson_quiz_scores[lessonId]).toBe(50);
    });

    test("тест несуществующего/чужого урока — 404, тест урока без вопросов — 404", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();

      const student = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(student);

      const noSuchLesson = await request(app).post("/api/course/lessons/no-such-id/quiz-submit").set("Cookie", cookie).send({ answers: {} });
      expect(noSuchLesson.status).toBe(404);

      const noQuiz = await request(app).post(`/api/course/lessons/${lessonId}/quiz-submit`).set("Cookie", cookie).send({ answers: {} });
      expect(noQuiz.status).toBe(404);
      expect(noQuiz.body.error).toBe("no_quiz");
    });

    test("последний вопрос поурочного теста удалить нельзя", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const q1 = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "В1", options: ["a", "b"], correct: 0 });

      const res = await request(app).delete(`/api/course/quiz-admin/${q1.body.id}`).set("Cookie", adminCookie);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("last_question");
    });

    test("удалённый вопрос поурочного теста восстанавливается через откат ИМЕННО в свой урок, а не в итоговый тест курса", async () => {
      // Откат доступен только super_admin (см. requireRole на /audit-log/:id/revert).
      const admin = await createUser({ role: "super_admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      // Два вопроса — иначе сработает защита "последний вопрос нельзя удалить".
      await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "Останется", options: ["a", "b"], correct: 0 });
      const toDelete = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "Удалим и откатим", options: ["a", "b"], correct: 1 });

      const deleteRes = await request(app).delete(`/api/course/quiz-admin/${toDelete.body.id}`).set("Cookie", adminCookie);
      expect(deleteRes.status).toBe(200);

      const logRow = await pool.query(
        "SELECT id FROM audit_log WHERE action='content.quiz_deleted' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
        [toDelete.body.id]
      );
      expect(logRow.rowCount).toBe(1);

      const revertRes = await request(app).post(`/api/staff/audit-log/${logRow.rows[0].id}/revert`).set("Cookie", adminCookie);
      expect(revertRes.status).toBe(200);

      const restored = await pool.query("SELECT lesson_id, question FROM quiz_questions WHERE id=$1", [toDelete.body.id]);
      expect(restored.rowCount).toBe(1);
      expect(restored.rows[0].lesson_id).toBe(lessonId);

      // И не "утёк" в итоговый тест курса.
      const finalQuizRes = await request(app).get("/api/course/quiz-admin").query({ courseId: course.courseId }).set("Cookie", adminCookie);
      expect(finalQuizRes.body.quiz.some((q) => q.id === toDelete.body.id)).toBe(false);
    });

    test("удалённый через POST вопрос поурочного теста откатывается (content.lesson_quiz_created)", async () => {
      const admin = await createUser({ role: "super_admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const createRes = await request(app).post(`/api/course/lessons/${lessonId}/quiz-admin`).set("Cookie", adminCookie)
        .send({ question: "Вопрос для отката создания", options: ["a", "b"], correct: 0 });

      const logRow = await pool.query(
        "SELECT id FROM audit_log WHERE action='content.lesson_quiz_created' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
        [createRes.body.id]
      );
      expect(logRow.rowCount).toBe(1);

      const revertRes = await request(app).post(`/api/staff/audit-log/${logRow.rows[0].id}/revert`).set("Cookie", adminCookie);
      expect(revertRes.status).toBe(200);

      const check = await pool.query("SELECT id FROM quiz_questions WHERE id=$1", [createRes.body.id]);
      expect(check.rowCount).toBe(0);
    });

    test("админ загружает видео файлом — врач получает рабочую ссылку на раздачу с сервера", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();

      const uploadRes = await request(app)
        .post(`/api/course/lessons/${lessonId}/video-upload`)
        .set("Cookie", adminCookie)
        .attach("file", Buffer.from("поддельные байты видео"), { filename: "urok1.mp4", contentType: "video/mp4" });
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body.videoUrl).toBe(`api/course/lessons/${lessonId}/video-file`);

      const student = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(student);
      const courseRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
      const lessonOut = courseRes.body.lessons.find((l) => l.id === lessonId);
      expect(lessonOut.videoUrl).toBe(`api/course/lessons/${lessonId}/video-file`);

      const fileRes = await request(app).get(`/api/course/lessons/${lessonId}/video-file`).set("Cookie", cookie);
      expect(fileRes.status).toBe(200);
      expect(Buffer.from(fileRes.body).toString()).toBe("поддельные байты видео");

      // Старая страница присылает прежний абсолютный адрес того же файла вместе с
      // главами — это не «новая ссылка», файл не должен удалиться.
      const saveRes = await request(app).put(`/api/course/lessons/${lessonId}/video`).set("Cookie", adminCookie)
        .send({ videoUrl: `/api/course/lessons/${lessonId}/video-file`, timecodes: [] });
      expect(saveRes.status).toBe(200);
      expect((await request(app).get(`/api/course/lessons/${lessonId}/video-file`).set("Cookie", cookie)).status).toBe(200);
    });

    test("недопустимый формат видео отклоняется (400)", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();
      const res = await request(app)
        .post(`/api/course/lessons/${lessonId}/video-upload`)
        .set("Cookie", adminCookie)
        .attach("file", Buffer.from("не видео"), { filename: "script.exe", contentType: "application/octet-stream" });
      expect(res.status).toBe(400);
    });

    test("повторная загрузка видео заменяет файл, ручной ввод ссылки поверх загруженного файла убирает его раздачу", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const lessonId = await makeLesson();

      await request(app).post(`/api/course/lessons/${lessonId}/video-upload`).set("Cookie", adminCookie)
        .attach("file", Buffer.from("первая версия"), { filename: "v1.mp4", contentType: "video/mp4" });
      const firstFile = (await pool.query("SELECT video_filename FROM lessons WHERE id=$1", [lessonId])).rows[0].video_filename;

      await request(app).post(`/api/course/lessons/${lessonId}/video-upload`).set("Cookie", adminCookie)
        .attach("file", Buffer.from("вторая версия"), { filename: "v2.mp4", contentType: "video/mp4" });
      const secondFile = (await pool.query("SELECT video_filename FROM lessons WHERE id=$1", [lessonId])).rows[0].video_filename;
      expect(secondFile).not.toBe(firstFile);

      // Ручной ввод внешней ссылки поверх загруженного файла — файл должен перестать раздаваться (404).
      await request(app).put(`/api/course/lessons/${lessonId}/video`).set("Cookie", adminCookie)
        .send({ videoUrl: "https://example.com/external.mp4", timecodes: [] });
      const afterManualUrl = await pool.query("SELECT video_filename, video_url FROM lessons WHERE id=$1", [lessonId]);
      expect(afterManualUrl.rows[0].video_filename).toBe(null);
      expect(afterManualUrl.rows[0].video_url).toBe("https://example.com/external.mp4");

      const staleFileRes = await request(app).get(`/api/course/lessons/${lessonId}/video-file`).set("Cookie", adminCookie);
      expect(staleFileRes.status).toBe(404);
    });

    test("удаление урока с загруженным видео проходит без ошибок (файл подчищается)", async () => {
      const admin = await createUser({ role: "admin" });
      const adminCookie = await loginAs(admin);
      const l1 = await makeLesson();
      const l2 = await makeLesson(); // курс должен остаться не пустым после удаления l1
      await request(app).post(`/api/course/lessons/${l1}/video-upload`).set("Cookie", adminCookie)
        .attach("file", Buffer.from("видео на удаление"), { filename: "delete-me.mp4", contentType: "video/mp4" });

      const delRes = await request(app).delete(`/api/course/lessons/${l1}`).set("Cookie", adminCookie);
      expect(delRes.status).toBe(200);
      const check = await pool.query("SELECT id FROM lessons WHERE id=$1", [l1]);
      expect(check.rowCount).toBe(0);
    });
  });
});

describe("Модули курса — итоговый тест и мини-опрос", () => {
  async function makeLesson(title) {
    const id = "lesson-module-" + crypto.randomUUID().slice(0, 8);
    await pool.query(
      "INSERT INTO lessons (id, course_id, idx, title, duration, html) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, course.courseId, 100, title || "Урок модуля", "5 мин", "<p>Контент</p>"]
    );
    return id;
  }

  test("админ создаёт модуль, привязывает уроки — врач видит его в GET /course с правильным составом", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const l1 = await makeLesson("Урок A");
    const l2 = await makeLesson("Урок B");

    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль 1" });
    expect(modRes.status).toBe(200);
    const moduleId = modRes.body.id;

    await request(app).put(`/api/course/lessons/${l1}/module`).set("Cookie", adminCookie).send({ moduleId });
    await request(app).put(`/api/course/lessons/${l2}/module`).set("Cookie", adminCookie).send({ moduleId });

    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);
    const courseRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    const modOut = courseRes.body.modules.find((m) => m.id === moduleId);
    expect(modOut).toBeTruthy();
    expect(modOut.lessonIds.sort()).toEqual([l1, l2].sort());
    expect(courseRes.body.lessons.find((l) => l.id === l1).moduleId).toBe(moduleId);
  });

  test("куратор и врач не могут создавать модули или назначать уроки (403)", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const res = await request(app).post("/api/course/modules").set("Cookie", curatorCookie).send({ courseId: course.courseId, title: "Не должно создаться" });
    expect(res.status).toBe(403);
  });

  test("тест модуля не попадает ни в итоговый тест курса, ни в поурочный", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль с тестом" });
    const moduleId = modRes.body.id;

    const qRes = await request(app).post(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "Сколько будет 3+3?", options: ["5", "6", "7"], correct: 1 });
    expect(qRes.status).toBe(200);

    const finalQuizRes = await request(app).get("/api/course/quiz-admin").query({ courseId: course.courseId }).set("Cookie", adminCookie);
    expect(finalQuizRes.body.quiz.some((q) => q.id === qRes.body.id)).toBe(false);

    const moduleQuizRes = await request(app).get(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie);
    expect(moduleQuizRes.body.quiz.length).toBe(1);
    expect(moduleQuizRes.body.quiz[0].correct).toBe(1);
  });

  test("врач проходит тест модуля — балл сохраняется в module_quiz_scores, completed_lessons не трогается", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль для прохождения" });
    const moduleId = modRes.body.id;
    const q1 = await request(app).post(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "В1", options: ["a", "b"], correct: 0 });
    const q2 = await request(app).post(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "В2", options: ["a", "b"], correct: 1 });

    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);
    const beforeLessons = (await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie)).body.progress.completed_lessons;

    const answers = {}; answers[q1.body.id] = 0; answers[q2.body.id] = 0; // второй неверный
    const submitRes = await request(app).post(`/api/course/modules/${moduleId}/quiz-submit`).set("Cookie", cookie).send({ answers });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.score).toBe(50);

    const courseRes = await request(app).get("/api/course/content/" + course.courseId).set("Cookie", cookie);
    expect(courseRes.body.progress.module_quiz_scores[moduleId]).toBe(50);
    expect(courseRes.body.progress.completed_lessons).toEqual(beforeLessons);
  });

  test("тест несуществующего модуля и модуля без вопросов — 404", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль без теста" });

    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);

    const noSuchModule = await request(app).post("/api/course/modules/no-such-id/quiz-submit").set("Cookie", cookie).send({ answers: {} });
    expect(noSuchModule.status).toBe(404);

    const noQuiz = await request(app).post(`/api/course/modules/${modRes.body.id}/quiz-submit`).set("Cookie", cookie).send({ answers: {} });
    expect(noQuiz.status).toBe(404);
    expect(noQuiz.body.error).toBe("no_quiz");
  });

  test("врач отправляет мини-опрос (оценка + комментарий), админ видит его и среднюю оценку; повторная отправка обновляет, а не дублирует", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль с отзывами" });
    const moduleId = modRes.body.id;

    const student = await createUser({ role: "student", courseId: course.courseId, name: "Отзывчивый Врач" });
    const cookie = await loginAs(student);

    const fbRes = await request(app).post(`/api/course/modules/${moduleId}/feedback`).set("Cookie", cookie)
      .send({ rating: 4, comment: "Было полезно, но длинновато" });
    expect(fbRes.status).toBe(200);

    let feedbackList = await request(app).get(`/api/course/modules/${moduleId}/feedback`).set("Cookie", adminCookie);
    expect(feedbackList.body.count).toBe(1);
    expect(feedbackList.body.average).toBe(4);
    expect(feedbackList.body.feedback[0].comment).toBe("Было полезно, но длинновато");
    expect(feedbackList.body.feedback[0].userName).toBe("Отзывчивый Врач");

    // Повторная отправка от того же врача обновляет отзыв, а не добавляет второй.
    await request(app).post(`/api/course/modules/${moduleId}/feedback`).set("Cookie", cookie)
      .send({ rating: 5, comment: "" });
    feedbackList = await request(app).get(`/api/course/modules/${moduleId}/feedback`).set("Cookie", adminCookie);
    expect(feedbackList.body.count).toBe(1);
    expect(feedbackList.body.average).toBe(5);
    expect(feedbackList.body.feedback[0].comment).toBe(null);
  });

  test("оценка вне диапазона 1-5 отклоняется (400)", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль валидации" });

    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);
    const res = await request(app).post(`/api/course/modules/${modRes.body.id}/feedback`).set("Cookie", cookie).send({ rating: 7 });
    expect(res.status).toBe(400);
  });

  test("куратор и врач не могут смотреть отзывы по модулю (403)", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль приватности" });

    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const res = await request(app).get(`/api/course/modules/${modRes.body.id}/feedback`).set("Cookie", curatorCookie);
    expect(res.status).toBe(403);
  });

  test("удаление модуля отвязывает уроки (module_id=null), но сами уроки остаются", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const l1 = await makeLesson("Урок при удалении модуля");
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль на удаление" });
    const moduleId = modRes.body.id;
    await request(app).put(`/api/course/lessons/${l1}/module`).set("Cookie", adminCookie).send({ moduleId });

    const delRes = await request(app).delete(`/api/course/modules/${moduleId}`).set("Cookie", adminCookie);
    expect(delRes.status).toBe(200);

    const lessonCheck = await pool.query("SELECT module_id FROM lessons WHERE id=$1", [l1]);
    expect(lessonCheck.rowCount).toBe(1);
    expect(lessonCheck.rows[0].module_id).toBe(null);
  });

  test("откат: созданный модуль удаляется (content.module_created)", async () => {
    const admin = await createUser({ role: "super_admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль для отката" });

    const logRow = await pool.query(
      "SELECT id FROM audit_log WHERE action='content.module_created' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
      [modRes.body.id]
    );
    expect(logRow.rowCount).toBe(1);
    const revertRes = await request(app).post(`/api/staff/audit-log/${logRow.rows[0].id}/revert`).set("Cookie", adminCookie);
    expect(revertRes.status).toBe(200);

    const check = await pool.query("SELECT id FROM modules WHERE id=$1", [modRes.body.id]);
    expect(check.rowCount).toBe(0);
  });

  test("откат: удалённый вопрос теста модуля восстанавливается ИМЕННО в свой модуль", async () => {
    const admin = await createUser({ role: "super_admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль для отката вопроса" });
    const moduleId = modRes.body.id;
    await request(app).post(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "Останется", options: ["a", "b"], correct: 0 });
    const toDelete = await request(app).post(`/api/course/modules/${moduleId}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "Удалим и откатим", options: ["a", "b"], correct: 1 });

    const deleteRes = await request(app).delete(`/api/course/quiz-admin/${toDelete.body.id}`).set("Cookie", adminCookie);
    expect(deleteRes.status).toBe(200);

    const logRow = await pool.query(
      "SELECT id FROM audit_log WHERE action='content.quiz_deleted' AND target_id=$1 ORDER BY created_at DESC LIMIT 1",
      [toDelete.body.id]
    );
    const revertRes = await request(app).post(`/api/staff/audit-log/${logRow.rows[0].id}/revert`).set("Cookie", adminCookie);
    expect(revertRes.status).toBe(200);

    const restored = await pool.query("SELECT module_id FROM quiz_questions WHERE id=$1", [toDelete.body.id]);
    expect(restored.rows[0].module_id).toBe(moduleId);

    const finalQuizRes = await request(app).get("/api/course/quiz-admin").query({ courseId: course.courseId }).set("Cookie", adminCookie);
    expect(finalQuizRes.body.quiz.some((q) => q.id === toDelete.body.id)).toBe(false);
  });

  test("последний вопрос теста модуля удалить нельзя", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const modRes = await request(app).post("/api/course/modules").set("Cookie", adminCookie).send({ courseId: course.courseId, title: "Модуль с одним вопросом" });
    const q1 = await request(app).post(`/api/course/modules/${modRes.body.id}/quiz-admin`).set("Cookie", adminCookie)
      .send({ question: "Единственный", options: ["a", "b"], correct: 0 });

    const res = await request(app).delete(`/api/course/quiz-admin/${q1.body.id}`).set("Cookie", adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("last_question");
  });
});
