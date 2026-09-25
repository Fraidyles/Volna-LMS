const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => {
  course = await seedCourse();
  // Этот файл проверяет скоуп куратора на самой выдаче сертификата, а не факт того,
  // включена ли она на курсе, — поэтому включаем сразу (иначе выдача 403-илась бы
  // ещё до проверки скоупа, см. courses.certificates_enabled).
  await pool.query("UPDATE courses SET certificates_enabled=true");
});
afterAll(async () => { await pool.end(); });

async function assignCurator(studentId, curatorId) {
  await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [curatorId, studentId]);
}

describe("Ролевой скоуп куратора", () => {
  test("список /staff/students куратору показывает только своих + неназначенных", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const mine = await createUser({ role: "student", courseId: course.courseId });
    const unassigned = await createUser({ role: "student", courseId: course.courseId });
    const someoneElses = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(mine.id, curatorA.id);
    await assignCurator(someoneElses.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const res = await request(app).get("/api/staff/students").set("Cookie", cookie);
    const ids = res.body.students.map((s) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(unassigned.id);
    expect(ids).not.toContain(someoneElses.id);
  });

  test("админ и супер-админ видят всех врачей независимо от куратора", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const forA = await createUser({ role: "student", courseId: course.courseId });
    const forB = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(forA.id, curatorA.id);
    await assignCurator(forB.id, curatorB.id);

    const admin = await createUser({ role: "admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).get("/api/staff/students").set("Cookie", cookie);
    const ids = res.body.students.map((s) => s.id);
    expect(ids).toContain(forA.id);
    expect(ids).toContain(forB.id);
  });

  test("GET /staff/students/:id — куратор не может открыть чужого врача (403)", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const student = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(student.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const res = await request(app).get(`/api/staff/students/${student.id}`).set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  test("куратор МОЖЕТ открыть неназначенного врача", async () => {
    const curatorA = await createUser({ role: "curator" });
    const student = await createUser({ role: "student", courseId: course.courseId });

    const cookie = await loginAs(curatorA);
    const res = await request(app).get(`/api/staff/students/${student.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  test("PATCH access/block — куратор не может блокировать чужого врача (403)", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const student = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(student.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const res = await request(app).patch(`/api/staff/students/${student.id}/access/block`).set("Cookie", cookie)
      .send({ blocked: true });
    expect(res.status).toBe(403);

    const check = await pool.query("SELECT access_blocked FROM progress WHERE user_id=$1", [student.id]);
    expect(check.rows[0].access_blocked).toBe(false);
  });

  test("сертификат — куратор не может выдать чужому врачу (403), своему — можно", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    const own = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(stranger.id, curatorB.id);
    await assignCurator(own.id, curatorA.id);

    const cookie = await loginAs(curatorA);
    const forbidden = await request(app).post(`/api/course/certificate/${stranger.id}/issue`).set("Cookie", cookie);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app).post(`/api/course/certificate/${own.id}/issue`).set("Cookie", cookie);
    expect(allowed.status).toBe(200);
  });

  test("массовая выдача сертификатов куратором молча пропускает чужих врачей", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const own = await createUser({ role: "student", courseId: course.courseId });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(own.id, curatorA.id);
    await assignCurator(stranger.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const res = await request(app).post("/api/course/certificate/bulk-issue").set("Cookie", cookie)
      .send({ studentIds: [own.id, stranger.id] });
    expect(res.status).toBe(200);
    expect(res.body.issued).toBe(1);

    const strangerCert = await pool.query("SELECT certificate_status FROM progress WHERE user_id=$1", [stranger.id]);
    expect(strangerCert.rows[0].certificate_status).not.toBe("issued");
  });

  test("чат с врачом — куратор не видит и не может писать чужому врачу (403)", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(stranger.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const getRes = await request(app).get(`/api/messages/${stranger.id}`).set("Cookie", cookie);
    expect(getRes.status).toBe(403);

    const postRes = await request(app).post("/api/messages").set("Cookie", cookie)
      .send({ studentId: stranger.id, text: "Привет" });
    expect(postRes.status).toBe(403);
  });

  test("массовое изменение продукта/оплаты куратором молча пропускает чужих врачей", async () => {
    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const own = await createUser({ role: "student", courseId: course.courseId });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await assignCurator(own.id, curatorA.id);
    await assignCurator(stranger.id, curatorB.id);

    const cookie = await loginAs(curatorA);
    const res = await request(app).post("/api/staff/students/bulk-field").set("Cookie", cookie)
      .send({ ids: [own.id, stranger.id], field: "payment_status", value: "paid" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const strangerRow = await pool.query("SELECT payment_status FROM users WHERE id=$1", [stranger.id]);
    expect(strangerRow.rows[0].payment_status).not.toBe("paid");
  });
});
