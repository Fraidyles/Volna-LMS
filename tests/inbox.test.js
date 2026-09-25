const request = require("supertest");
const crypto = require("crypto");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

async function ageRegistration(userId, daysAgo) {
  await pool.query("UPDATE users SET created_at = now() - ($2 || ' days')::interval WHERE id=$1", [userId, daysAgo]);
}

async function sendMessage(studentId, fromRole, text, daysAgo) {
  await pool.query(
    "INSERT INTO messages (id, student_id, from_role, author_name, body, created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval)",
    [crypto.randomUUID(), studentId, fromRole, fromRole === "student" ? "Врач" : "Куратор", text, daysAgo]
  );
}

describe("Инбокс куратора «требует внимания»", () => {
  test("врач не может открыть инбокс (403)", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  test("неактивный 8+ дней врач попадает в список, активный недавно — нет", async () => {
    const stale = await createUser({ role: "student", courseId: course.courseId });
    await ageRegistration(stale.id, 8);
    const fresh = await createUser({ role: "student", courseId: course.courseId });

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ids = res.body.inactive.map((r) => r.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  test("врач, завершивший демо-курс, не считается неактивным даже без активности 8+ дней", async () => {
    const finished = await createUser({ role: "student", courseId: course.courseId });
    await ageRegistration(finished.id, 10);
    await pool.query("UPDATE progress SET completed=true WHERE user_id=$1", [finished.id]);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.inactive.map((r) => r.id);
    expect(ids).not.toContain(finished.id);
  });

  test("сообщение врача старше 24 часов без ответа куратора попадает в unanswered", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    await sendMessage(student.id, "student", "Здравствуйте, вопрос по уроку 3", 2);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.unanswered.map((r) => r.id);
    expect(ids).toContain(student.id);
  });

  test("если куратор ответил ПОСЛЕ сообщения врача, тред не считается неотвеченным", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    await sendMessage(student.id, "student", "Вопрос", 2);
    await sendMessage(student.id, "curator", "Ответ куратора", 1);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.unanswered.map((r) => r.id);
    expect(ids).not.toContain(student.id);
  });

  test("сообщение врача младше 24 часов пока не считается просроченным", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    await sendMessage(student.id, "student", "Только что написал", 0);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.unanswered.map((r) => r.id);
    expect(ids).not.toContain(student.id);
  });

  test("завершивший тест, но без выданного сертификата — в pendingCertificates", async () => {
    // Сигнал считается только если у курса включена выдача сертификатов
    // (см. courses.certificates_enabled) — на демо-курсе по умолчанию выключено.
    await pool.query("UPDATE courses SET certificates_enabled=true");
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET completed=true, quiz_score=80, certificate_status='pending' WHERE user_id=$1", [student.id]);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.pendingCertificates.map((r) => r.id);
    expect(ids).toContain(student.id);
  });

  test("сертификаты выключены на курсе — pendingCertificates всегда пуст (не висит вечной ложной тревогой)", async () => {
    await pool.query("UPDATE courses SET certificates_enabled=false");
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET completed=true, quiz_score=80, certificate_status='pending' WHERE user_id=$1", [student.id]);

    const staff = await createUser({ role: "super_admin" });
    const cookie = await loginAs(staff);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    expect(res.body.pendingCertificates).toEqual([]);
  });

  test("куратор видит в инбоксе только своих + неназначенных врачей", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });

    const mine = await createUser({ role: "student", courseId: course.courseId });
    await ageRegistration(mine.id, 8);
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorA.id, mine.id]);

    const theirs = await createUser({ role: "student", courseId: course.courseId });
    await ageRegistration(theirs.id, 8);
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorB.id, theirs.id]);

    const unassigned = await createUser({ role: "student", courseId: course.courseId });
    await ageRegistration(unassigned.id, 8);

    const cookie = await loginAs(curatorA);
    const res = await request(app).get("/api/staff/inbox").set("Cookie", cookie);
    const ids = res.body.inactive.map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(unassigned.id);
    expect(ids).not.toContain(theirs.id);
  });
});
