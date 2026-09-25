const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => {
  course = await seedCourse();
  // Этот файл проверяет сам механизм отката, а не факт того, включена ли выдача
  // сертификатов на курсе (см. courses.certificates_enabled) — включаем сразу.
  await pool.query("UPDATE courses SET certificates_enabled=true");
});
afterAll(async () => { await pool.end(); });

async function lastLogId(action, targetId) {
  const r = await pool.query(
    "SELECT id FROM audit_log WHERE action=$1 AND target_id=$2 ORDER BY created_at DESC LIMIT 1",
    [action, targetId]
  );
  return r.rowCount ? r.rows[0].id : null;
}

describe("Откат действий (только главный администратор)", () => {
  test("куратор не может откатывать действия (403), даже если действие обратимо", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const superCookie = await loginAs(superAdmin);
    const student = await createUser({ role: "student" });

    await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", superCookie).send({ blocked: true });
    const logId = await lastLogId("access.block", student.id);

    const curator = await createUser({ role: "curator" });
    const curatorCookie = await loginAs(curator);
    const res = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", curatorCookie);
    expect(res.status).toBe(403);
  });

  test("откат блокировки доступа возвращает access_blocked к прежнему значению", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const student = await createUser({ role: "student" });

    await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", cookie).send({ blocked: true });
    let progress = await pool.query("SELECT access_blocked FROM progress WHERE user_id=$1", [student.id]);
    expect(progress.rows[0].access_blocked).toBe(true);

    const logId = await lastLogId("access.block", student.id);
    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(200);

    progress = await pool.query("SELECT access_blocked FROM progress WHERE user_id=$1", [student.id]);
    expect(progress.rows[0].access_blocked).toBe(false);
  });

  test("откат выдачи сертификата возвращает статус на pending", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const student = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET certificate_status='pending', completed=true, quiz_score=100 WHERE user_id=$1", [student.id]);

    await request(app).post(`/api/course/certificate/${student.id}/issue`).set("Cookie", cookie).send({ courseId: course.courseId });
    let progress = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1", [student.id]);
    expect(progress.rows[0].certificate_status).toBe("issued");

    const logId = await lastLogId("certificate.issue", student.id);
    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(200);

    progress = await pool.query("SELECT certificate_status, certificate_issued_at FROM progress WHERE user_id=$1", [student.id]);
    expect(progress.rows[0].certificate_status).toBe("pending");
    expect(progress.rows[0].certificate_issued_at).toBeNull();
  });

  test("повторный откат одного и того же действия — ошибка", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const student = await createUser({ role: "student" });

    await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", cookie).send({ blocked: true });
    const logId = await lastLogId("access.block", student.id);

    const first = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(second.status).toBe(400);
  });

  test("откат создания потока удаляет поток", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);

    const createRes = await request(app).post("/api/streams").set("Cookie", cookie).send({ name: "Тестовый поток отката" });
    const streamId = createRes.body.id;
    const logId = await lastLogId("stream.create", streamId);

    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(200);

    const check = await pool.query("SELECT id FROM streams WHERE id=$1", [streamId]);
    expect(check.rowCount).toBe(0);
  });

  test("откат удаления потока восстанавливает его с теми же данными", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);

    const createRes = await request(app).post("/api/streams").set("Cookie", cookie).send({ name: "Поток для удаления", startDate: "2026-05-01" });
    const streamId = createRes.body.id;

    await request(app).delete(`/api/streams/${streamId}`).set("Cookie", cookie);
    let check = await pool.query("SELECT id FROM streams WHERE id=$1", [streamId]);
    expect(check.rowCount).toBe(0);

    const logId = await lastLogId("stream.delete", streamId);
    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(200);

    check = await pool.query("SELECT id, name, start_date FROM streams WHERE id=$1", [streamId]);
    expect(check.rowCount).toBe(1);
    expect(check.rows[0].name).toBe("Поток для удаления");
  });

  test("откат изменения вопроса теста возвращает прежний текст и правильный ответ", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const questionId = course.questionIds[0];

    const before = await pool.query("SELECT question, correct FROM quiz_questions WHERE id=$1", [questionId]);

    await request(app).put(`/api/course/quiz-admin/${questionId}`).set("Cookie", cookie)
      .send({ question: "Изменённый вопрос", options: ["X", "Y", "Z"], correct: 1 });

    let after = await pool.query("SELECT question, correct FROM quiz_questions WHERE id=$1", [questionId]);
    expect(after.rows[0].question).toBe("Изменённый вопрос");

    const logId = await lastLogId("content.quiz_edited", questionId);
    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(200);

    after = await pool.query("SELECT question, correct FROM quiz_questions WHERE id=$1", [questionId]);
    expect(after.rows[0].question).toBe(before.rows[0].question);
    expect(after.rows[0].correct).toBe(before.rows[0].correct);
  });

  test("действие без before-снимка (записанное без revertible) не откатывается", async () => {
    const superAdmin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(superAdmin);
    const student = await createUser({ role: "student" });

    await request(app).post(`/api/staff/students/${student.id}/reset-password`).set("Cookie", cookie);
    const logId = await lastLogId("password.reset_by_staff", student.id);

    const revertRes = await request(app).post(`/api/staff/audit-log/${logId}/revert`).set("Cookie", cookie);
    expect(revertRes.status).toBe(400);
  });
});
