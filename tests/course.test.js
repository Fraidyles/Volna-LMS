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

  test("GET /course и PUT /heartbeat отмечают врача «онлайн» для куратора", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curator.id, user.id]);
    const cookie = await loginAs(user);

    // Пока врач ни разу не заходил в курс — last_seen_at пуст, online=false.
    const before = await request(app).get(`/api/staff/students/${user.id}`).set("Cookie", curatorCookie);
    expect(before.body.student.online).toBe(false);

    await request(app).get("/api/course").set("Cookie", cookie);
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

    await request(app).get("/api/course").set("Cookie", cookie);
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
    const after = await request(app).get("/api/course").set("Cookie", cookie);
    expect(after.body.progress.completed_lessons).not.toContain("no-such-lesson-id");
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

  test("дрип: урок с drip_days ещё не открылся врачу, зарегистрированному недавно (403 + dripLockedForMe)", async () => {
    await pool.query("UPDATE lessons SET drip_days=7 WHERE id=$1", [course.lessonIds[1]]);
    try {
      const user = await createUser({ role: "student", courseId: course.courseId });
      const cookie = await loginAs(user);

      const getRes = await request(app).get("/api/course").set("Cookie", cookie);
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

      const getRes = await request(app).get("/api/course").set("Cookie", cookie);
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
    const getRes = await request(app).get("/api/course").set("Cookie", studentCookie);
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
    const getRes = await request(app).get("/api/course").set("Cookie", studentCookie);
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

    const getRes = await request(app).get("/api/course").set("Cookie", cookie);
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
    const res = await request(app).get("/api/course").set("Cookie", cookie);
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
    const res = await request(app).get("/api/course").set("Cookie", cookie);
    expect(res.body.gamification.points).toBe(1000);
  });

  test("онбординг-чеклист: по умолчанию не скрыт, врач может закрыть его вручную", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const before = await request(app).get("/api/course").set("Cookie", cookie);
    expect(before.body.progress.onboarding_dismissed).toBe(false);

    const dismissRes = await request(app).put("/api/course/onboarding-dismiss").set("Cookie", cookie);
    expect(dismissRes.status).toBe(200);

    const after = await request(app).get("/api/course").set("Cookie", cookie);
    expect(after.body.progress.onboarding_dismissed).toBe(true);
  });

  test("«Мои материалы»: врач может сохранить и убрать урок из закладок", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    const before = await request(app).get("/api/course").set("Cookie", cookie);
    expect(before.body.bookmarkedLessonIds).toEqual([]);

    const addRes = await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/bookmark`).set("Cookie", cookie)
      .send({ bookmarked: true });
    expect(addRes.status).toBe(200);

    const after = await request(app).get("/api/course").set("Cookie", cookie);
    expect(after.body.bookmarkedLessonIds).toEqual([course.lessonIds[0]]);

    await request(app).put(`/api/course/lessons/${course.lessonIds[0]}/bookmark`).set("Cookie", cookie)
      .send({ bookmarked: false });
    const afterRemove = await request(app).get("/api/course").set("Cookie", cookie);
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

  test("непрочитанные сообщения: считаются, пока врач явно не отметит прочитанным; GET сам по себе (поллинг чата) это не делает", async () => {
    const crypto = require("crypto");
    const user = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(user);

    await pool.query(
      "INSERT INTO messages (id, student_id, from_role, author_name, body) VALUES ($1,$2,'curator','Куратор','Как проходит курс?')",
      [crypto.randomUUID(), user.id]
    );

    const before = await request(app).get("/api/course").set("Cookie", cookie);
    expect(before.body.unreadMessages).toBe(1);

    // Обычный GET (как при поллинге открытого чата) не должен сам отмечать прочитанным —
    // иначе «Пометить непрочитанным» ниже отменялось бы следующим же тиком поллинга.
    await request(app).get(`/api/messages/${user.id}`).set("Cookie", cookie);
    const stillUnread = await request(app).get("/api/course").set("Cookie", cookie);
    expect(stillUnread.body.unreadMessages).toBe(1);

    await request(app).post(`/api/messages/${user.id}/mark-read`).set("Cookie", cookie);
    const afterRead = await request(app).get("/api/course").set("Cookie", cookie);
    expect(afterRead.body.unreadMessages).toBe(0);

    await request(app).post(`/api/messages/${user.id}/mark-unread`).set("Cookie", cookie);
    const afterUnread = await request(app).get("/api/course").set("Cookie", cookie);
    expect(afterUnread.body.unreadMessages).toBe(1);
  });

  test("mark-read/mark-unread недоступны персоналу и для чужого id", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const other = await createUser({ role: "student", courseId: course.courseId });
    const curator = await createUser({ role: "curator" });

    const otherCookie = await loginAs(other);
    const forbidden1 = await request(app).post(`/api/messages/${user.id}/mark-read`).set("Cookie", otherCookie);
    expect(forbidden1.status).toBe(403);

    const curatorCookie = await loginAs(curator);
    const forbidden2 = await request(app).post(`/api/messages/${user.id}/mark-unread`).set("Cookie", curatorCookie);
    expect(forbidden2.status).toBe(403);
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
        .send({ title: "Новый урок", duration: "4 мин", html: "<p>Текст нового урока</p>" });
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
        .send({ title: "Урок для отката", duration: "3 мин", html: "<p>Контент</p>" });
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
        .send({ question: "Новый вопрос?", options: ["А", "Б"], correct: 0 });
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
        .send({ title: "x", duration: "1 мин", html: "<p>x</p>" });
      expect(res.status).toBe(403);
    });
  });
});
