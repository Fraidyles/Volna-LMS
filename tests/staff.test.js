const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

afterAll(async () => { await pool.end(); });

describe("Права доступа персонала", () => {
  test("врач не может открыть список учеников (403)", async () => {
    const student = await createUser({ role: "student" });
    const cookie = await loginAs(student);
    const res = await request(app).get("/api/staff/students").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  test("куратор видит список учеников", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).get("/api/staff/students").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.students)).toBe(true);
  });

  test("PATCH /students/:id/curator отклоняет несуществующий и не-кураторский id (без 500 и без порчи данных)", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const student = await createUser({ role: "student" });

    const garbage = await request(app).patch(`/api/staff/students/${student.id}/curator`).set("Cookie", cookie)
      .send({ curatorId: "no-such-id" });
    expect(garbage.status).toBe(400);

    // id самого врача не должен приниматься как id куратора — это не сотрудник.
    const selfAsCurator = await request(app).patch(`/api/staff/students/${student.id}/curator`).set("Cookie", cookie)
      .send({ curatorId: student.id });
    expect(selfAsCurator.status).toBe(400);

    const another = await createUser({ role: "curator" });
    const ok = await request(app).patch(`/api/staff/students/${student.id}/curator`).set("Cookie", cookie)
      .send({ curatorId: another.id });
    expect(ok.status).toBe(200);
  });

  test("список учеников включает quiz_answers — нужно для повопросной аналитики дашборда", async () => {
    const course = await seedCourse();
    const student = await createUser({ role: "student", courseId: course.courseId });
    const studentCookie = await loginAs(student);
    var answers = {};
    answers[course.questionIds[0]] = 0;
    answers[course.questionIds[1]] = 2;
    await request(app).post("/api/course/quiz-submit").set("Cookie", studentCookie).send({ answers });

    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).get("/api/staff/students").set("Cookie", cookie);
    const row = res.body.students.find((s) => s.id === student.id);
    expect(row.quiz_answers).toEqual(answers);
  });

  test("куратор видит команду на чтение, но не может управлять ею", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const readRes = await request(app).get("/api/staff/team").set("Cookie", cookie);
    expect(readRes.status).toBe(200);

    const admin = await createUser({ role: "admin" });
    const removeRes = await request(app).delete(`/api/staff/team/${admin.id}`).set("Cookie", cookie);
    expect(removeRes.status).toBe(403);
  });

  test("администратор видит команду", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).get("/api/staff/team").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  test("куратор не может пригласить администратора (403)", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).post("/api/invites").set("Cookie", cookie)
      .send({ email: `newadmin.${Date.now()}@example.com`, role: "admin" });
    expect(res.status).toBe(403);
  });

  test("администратор не может пригласить другого администратора (только super_admin)", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).post("/api/invites").set("Cookie", cookie)
      .send({ email: `newadmin2.${Date.now()}@example.com`, role: "admin" });
    expect(res.status).toBe(403);
  });

  test("куратор может пригласить врача", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const res = await request(app).post("/api/invites").set("Cookie", cookie)
      .send({ email: `newdoc.${Date.now()}@example.com`, role: "student" });
    expect(res.status).toBe(200);
  });

  test("приглашение по email назначает роль при регистрации", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const email = `invited-curator.${Date.now()}@example.com`;
    await request(app).post("/api/invites").set("Cookie", cookie).send({ email, role: "curator" });

    const registerRes = await request(app).post("/api/auth/register").send({
      email, password: "password123", name: "Приглашённый Куратор"
    });
    expect(registerRes.status).toBe(200);
    expect(registerRes.body.user.role).toBe("curator");
  });

  test("массовое приглашение: валидные email приглашены, некорректные и уже зарегистрированные пропущены", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const existing = await createUser({ role: "student" });
    const good1 = `bulk1.${Date.now()}@example.com`;
    const good2 = `bulk2.${Date.now()}@example.com`;

    const res = await request(app).post("/api/invites/bulk").set("Cookie", cookie)
      .send({ emails: [good1, good2, "не-email", existing.email] });

    expect(res.status).toBe(200);
    expect(res.body.created).toEqual(expect.arrayContaining([good1, good2]));
    expect(res.body.skipped.length).toBe(2);
  });

  test("журнал действий недоступен куратору, доступен администратору", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const forbidden = await request(app).get("/api/staff/audit-log").set("Cookie", curatorCookie);
    expect(forbidden.status).toBe(403);

    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const allowed = await request(app).get("/api/staff/audit-log").set("Cookie", adminCookie);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.log)).toBe(true);
  });

  test("журнал действий: фильтр по action, actorId, датам и свободному тексту", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const student = await createUser({ role: "student" });

    await pool.query("UPDATE progress SET access_blocked=true WHERE user_id=$1", [student.id]);
    await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", adminCookie)
      .send({ blocked: false });

    const byAction = await request(app).get("/api/staff/audit-log").query({ action: "access.unblock" }).set("Cookie", adminCookie);
    expect(byAction.status).toBe(200);
    expect(byAction.body.log.length).toBeGreaterThan(0);
    expect(byAction.body.log.every((r) => r.action === "access.unblock")).toBe(true);

    const byActor = await request(app).get("/api/staff/audit-log").query({ actorId: admin.id }).set("Cookie", adminCookie);
    expect(byActor.body.log.every((r) => r.actor_id === admin.id)).toBe(true);

    const byQ = await request(app).get("/api/staff/audit-log").query({ q: student.name }).set("Cookie", adminCookie);
    expect(byQ.body.log.some((r) => r.target_name === student.name)).toBe(true);

    const futureOnly = await request(app).get("/api/staff/audit-log").query({ dateFrom: "2099-01-01" }).set("Cookie", adminCookie);
    expect(futureOnly.body.log.length).toBe(0);

    const noMatch = await request(app).get("/api/staff/audit-log").query({ action: "no.such.action" }).set("Cookie", adminCookie);
    expect(noMatch.body.log.length).toBe(0);
  });

  test("журнал действий: /audit-log/actions отдаёт список различных действий", async () => {
    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).get("/api/staff/audit-log/actions").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(res.body.actions.length).toBeGreaterThan(0);
  });

  test("куратор может поправить контактные данные врача", async () => {
    const curator = await createUser({ role: "curator" });
    const cookie = await loginAs(curator);
    const student = await createUser({ role: "student" });
    const res = await request(app).patch(`/api/staff/students/${student.id}/profile`).set("Cookie", cookie)
      .send({ workplace: "Городская клиника №5", phone: "+7 900 111-22-33" });
    expect(res.status).toBe(200);

    const check = await request(app).get(`/api/staff/students/${student.id}`).set("Cookie", cookie);
    expect(check.body.student.workplace).toBe("Городская клиника №5");
    expect(check.body.student.phone).toBe("+7 900 111-22-33");
  });

  test("приватные заметки куратора о враче — врач их не видит", async () => {
    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const student = await createUser({ role: "student" });

    const createRes = await request(app).post(`/api/staff/students/${student.id}/notes`).set("Cookie", curatorCookie)
      .send({ body: "Пропускает эфиры, стоит позвонить" });
    expect(createRes.status).toBe(200);

    const listRes = await request(app).get(`/api/staff/students/${student.id}/notes`).set("Cookie", curatorCookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.notes.length).toBe(1);
    expect(listRes.body.notes[0].body).toBe("Пропускает эфиры, стоит позвонить");

    const studentCookie = await loginAs(student);
    const forbidden = await request(app).get(`/api/staff/students/${student.id}/notes`).set("Cookie", studentCookie);
    expect(forbidden.status).toBe(403);
  });

  test("смена роли: администратор не может назначать роль «администратор» (это только у главного администратора), как и при приглашении", async () => {
    const admin = await createUser({ role: "admin" });
    const adminCookie = await loginAs(admin);
    const curator = await createUser({ role: "curator" });

    const promote = await request(app).patch(`/api/staff/team/${curator.id}/role`).set("Cookie", adminCookie)
      .send({ role: "admin" });
    expect(promote.status).toBe(403);

    const otherAdmin = await createUser({ role: "admin" });
    const forbidden = await request(app).patch(`/api/staff/team/${otherAdmin.id}/role`).set("Cookie", adminCookie)
      .send({ role: "curator" });
    expect(forbidden.status).toBe(403);
  });

  test("смена роли: главный администратор может повысить куратора и понизить админа обратно", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const curator = await createUser({ role: "curator" });

    const promote = await request(app).patch(`/api/staff/team/${curator.id}/role`).set("Cookie", cookie)
      .send({ role: "admin" });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe("admin");

    const demote = await request(app).patch(`/api/staff/team/${curator.id}/role`).set("Cookie", cookie)
      .send({ role: "curator" });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe("curator");
  });
});
