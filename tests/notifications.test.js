const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => {
  course = await seedCourse();
  // Этот файл проверяет сами уведомления, а не факт того, включена ли выдача
  // сертификатов на курсе (см. courses.certificates_enabled) — включаем сразу.
  await pool.query("UPDATE courses SET certificates_enabled=true");
});
afterAll(async () => { await pool.end(); });

describe("Центр уведомлений", () => {
  test("снятие блокировки доступа создаёт уведомление врачу", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET access_blocked=true WHERE user_id=$1", [user.id]);
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);

    await request(app).patch(`/api/staff/students/${user.id}/access/block`).set("Cookie", staffCookie)
      .send({ blocked: false });

    const cookie = await loginAs(user);
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications[0].type).toBe("access_unblocked");
  });

  test("блокировка доступа НЕ создаёт уведомление (только снятие)", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);
    await request(app).patch(`/api/staff/students/${user.id}/access/block`).set("Cookie", staffCookie)
      .send({ blocked: true });

    const cookie = await loginAs(user);
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(res.body.unreadCount).toBe(0);
  });

  test("выдача сертификата создаёт уведомление", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);
    await request(app).post(`/api/course/certificate/${user.id}/issue`).set("Cookie", staffCookie);

    const cookie = await loginAs(user);
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(res.body.notifications.some((n) => n.type === "certificate_issued")).toBe(true);
  });

  test("новый урок оповещает ВСЕХ врачей", async () => {
    const userA = await createUser({ role: "student", courseId: course.courseId });
    const userB = await createUser({ role: "student", courseId: course.courseId });
    const admin = await createUser({ role: "super_admin" });
    const adminCookie = await loginAs(admin);

    const createRes = await request(app).post("/api/course/lessons").set("Cookie", adminCookie)
      .send({ title: "Уведомляемый урок", duration: "3 мин", html: "<p>Текст</p>" });
    expect(createRes.status).toBe(200);

    const cookieA = await loginAs(userA);
    const resA = await request(app).get("/api/notifications").set("Cookie", cookieA);
    expect(resA.body.notifications.some((n) => n.type === "new_lesson")).toBe(true);

    const cookieB = await loginAs(userB);
    const resB = await request(app).get("/api/notifications").set("Cookie", cookieB);
    expect(resB.body.notifications.some((n) => n.type === "new_lesson")).toBe(true);

    await request(app).delete(`/api/course/lessons/${createRes.body.id}`).set("Cookie", adminCookie);
  });

  test("снятие видимости с урока для конкретного врача создаёт уведомление именно ему", async () => {
    const target = await createUser({ role: "student", courseId: course.courseId });
    const other = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "super_admin" });
    const staffCookie = await loginAs(staff);

    await request(app).put(`/api/course/visibility/${course.lessonIds[0]}`).set("Cookie", staffCookie)
      .send({ ids: [target.id] });
    await request(app).put(`/api/course/visibility/${course.lessonIds[0]}`).set("Cookie", staffCookie)
      .send({ ids: [] });

    const targetCookie = await loginAs(target);
    const targetRes = await request(app).get("/api/notifications").set("Cookie", targetCookie);
    expect(targetRes.body.notifications.some((n) => n.type === "content_unlocked")).toBe(true);

    const otherCookie = await loginAs(other);
    const otherRes = await request(app).get("/api/notifications").set("Cookie", otherCookie);
    expect(otherRes.body.notifications.some((n) => n.type === "content_unlocked")).toBe(false);
  });

  test("пометка уведомления прочитанным уменьшает unreadCount", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);
    await request(app).post(`/api/course/certificate/${user.id}/issue`).set("Cookie", staffCookie);

    const cookie = await loginAs(user);
    const before = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(before.body.unreadCount).toBe(1);

    const notifId = before.body.notifications[0].id;
    const readRes = await request(app).post(`/api/notifications/${notifId}/read`).set("Cookie", cookie);
    expect(readRes.status).toBe(200);

    const after = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(after.body.unreadCount).toBe(0);
  });

  test("read-all помечает прочитанными все уведомления пользователя", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);
    await request(app).post(`/api/course/certificate/${user.id}/issue`).set("Cookie", staffCookie);
    await pool.query("UPDATE progress SET access_blocked=true WHERE user_id=$1", [user.id]);
    await request(app).patch(`/api/staff/students/${user.id}/access/block`).set("Cookie", staffCookie).send({ blocked: false });

    const cookie = await loginAs(user);
    const before = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(before.body.unreadCount).toBe(2);

    await request(app).post("/api/notifications/read-all").set("Cookie", cookie);
    const after = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(after.body.unreadCount).toBe(0);
  });

  test("нельзя прочитать чужое уведомление", async () => {
    const user = await createUser({ role: "student", courseId: course.courseId });
    const other = await createUser({ role: "student", courseId: course.courseId });
    const staff = await createUser({ role: "curator" });
    const staffCookie = await loginAs(staff);
    await request(app).post(`/api/course/certificate/${user.id}/issue`).set("Cookie", staffCookie);

    const cookie = await loginAs(user);
    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    const notifId = list.body.notifications[0].id;

    const otherCookie = await loginAs(other);
    await request(app).post(`/api/notifications/${notifId}/read`).set("Cookie", otherCookie);

    const stillUnread = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(stillUnread.body.unreadCount).toBe(1);
  });
});
