const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");
const { mskYesterdayWindow } = require("../src/dailyDigest");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

describe("Дайджест куратора «отчёт за вчера»", () => {
  test("врач не может открыть дайджест (403)", async () => {
    const student = await createUser({ role: "student", courseId: course.courseId });
    const cookie = await loginAs(student);
    const res = await request(app).get("/api/staff/daily-digest").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  test("считает регистрации, активность и сертификаты именно за вчера (МСК)", async () => {
    const { start } = mskYesterdayWindow();
    const yesterdayMoment = new Date(start.getTime() + 3600000); // час после полуночи МСК — точно внутри окна
    const tooOldMoment = new Date(start.getTime() - 3600000); // час до полуночи МСК — уже позавчера

    const registeredYesterday = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET created_at=$1 WHERE id=$2", [yesterdayMoment, registeredYesterday.id]);

    const registeredEarlier = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET created_at=$1 WHERE id=$2", [tooOldMoment, registeredEarlier.id]);

    const activeYesterday = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET last_active_at=$1 WHERE user_id=$2", [yesterdayMoment, activeYesterday.id]);

    const certifiedYesterday = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE progress SET certificate_status='issued', certificate_issued_at=$1 WHERE user_id=$2", [yesterdayMoment, certifiedYesterday.id]);

    const admin = await createUser({ role: "super_admin" });
    const cookie = await loginAs(admin);
    const res = await request(app).get("/api/staff/daily-digest").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.stats.registered).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.active).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.certified).toBeGreaterThanOrEqual(1);
    expect(res.body.summary).toContain("Вчера");
    expect(res.body.date).toBe(start.toISOString().slice(0, 10));
  });

  test("куратор видит в дайджесте только свою зону ответственности", async () => {
    const { start, end } = mskYesterdayWindow();
    const yesterdayMoment = new Date(start.getTime() + 3600000);

    const curatorA = await createUser({ role: "curator" });
    const curatorB = await createUser({ role: "curator" });
    const own = await createUser({ role: "student", courseId: course.courseId });
    const stranger = await createUser({ role: "student", courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1, created_at=$2 WHERE id=$3", [curatorA.id, yesterdayMoment, own.id]);
    await pool.query("UPDATE users SET assigned_curator_id=$1, created_at=$2 WHERE id=$3", [curatorB.id, yesterdayMoment, stranger.id]);

    const cookie = await loginAs(curatorA);
    const res = await request(app).get("/api/staff/daily-digest").set("Cookie", cookie);
    // "own" однозначно посчитан, а "stranger" не должен попасть в счётчик этого куратора —
    // проверяем через прямой пересчёт по тому же scoped-запросу, что и сам дайджест
    // (с той же верхней границей окна, иначе врачи из других тестов с created_at=now() тоже подмешались бы).
    const scopedCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM users u WHERE u.role='student' AND u.created_at >= $1 AND u.created_at < $2
       AND (u.assigned_curator_id = $3 OR u.assigned_curator_id IS NULL)`,
      [start, end, curatorA.id]
    );
    expect(res.body.stats.registered).toBe(scopedCount.rows[0].cnt);
  });
});
