// «Войти как врач» из карточки врача: сотрудник видит кабинет врача, но только
// смотрит; куратор — лишь своих врачей; возврат в свою сессию; запись в журнал.
const request = require("supertest");
const { app, pool, seedCourse, createUser, loginAs } = require("./helpers");

let course;
beforeAll(async () => { course = await seedCourse(); });
afterAll(async () => { await pool.end(); });

const api = (method, path, cookie, body) => {
  const r = request(app)[method](path).set("Cookie", cookie);
  return body ? r.send(body) : r;
};
// Cookie-«банка»: что сервер установил поверх того, что уже было.
const jar = (prev, setCookie) => {
  const m = {};
  (prev || []).concat(setCookie || []).forEach((c) => {
    const [kv] = c.split(";"); const i = kv.indexOf("=");
    const k = kv.slice(0, i), v = kv.slice(i + 1);
    if (v) m[k] = v; else delete m[k];
  });
  return Object.entries(m).map(([k, v]) => k + "=" + v);
};

async function impersonate(staffCookie, studentId) {
  const res = await api("post", `/api/staff/students/${studentId}/impersonate`, staffCookie);
  return { res, cookie: jar(staffCookie, res.headers["set-cookie"]) };
}

describe("Вход как врач", () => {
  test("админ видит кабинет врача, но ничего не может изменить", async () => {
    const st = await createUser({ courseId: course.courseId, name: "Врач Смотримый" });
    const adm = await loginAs(await createUser({ role: "admin", name: "Админ Проверяющий" }));
    const { res, cookie } = await impersonate(adm, st.id);
    expect(res.status).toBe(200);

    const me = await api("get", "/api/auth/me", cookie);
    expect(me.body.user.id).toBe(st.id);
    expect(me.body.user.impersonator.name).toBe("Админ Проверяющий");
    expect((await api("get", `/api/course/content/${course.courseId}`, cookie)).status).toBe(200);

    const put = await api("put", "/api/course/heartbeat", cookie);
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("read_only");
    const note = await api("put", `/api/course/lessons/${course.lessonIds[0]}/note`, cookie, { note: "чужая" });
    expect(note.status).toBe(403);

    // просмотр не делает врача «в сети»
    const pr = await pool.query("SELECT bool_or(is_online) AS on FROM progress WHERE user_id=$1", [st.id]);
    expect(pr.rows[0].on).toBeFalsy();

    const log = await pool.query("SELECT 1 FROM audit_log WHERE action='student.impersonate' AND target_id=$1", [st.id]);
    expect(log.rowCount).toBe(1);
  });

  test("«Вернуться в панель» возвращает сессию сотрудника", async () => {
    const st = await createUser({ courseId: course.courseId });
    const admUser = await createUser({ role: "admin" });
    const adm = await loginAs(admUser);
    const { cookie } = await impersonate(adm, st.id);
    const stop = await api("post", "/api/auth/impersonate/stop", cookie);
    expect(stop.body.restored).toBe(true);
    const back = jar(cookie, stop.headers["set-cookie"]);
    const me = await api("get", "/api/auth/me", back);
    expect(me.body.user.id).toBe(admUser.id);
    expect(me.body.user.impersonator).toBeNull();
    expect(back.some((c) => c.startsWith("staff_token="))).toBe(false);
  });

  test("куратор — только своих и незакреплённых врачей; врач — никого", async () => {
    const cur = await createUser({ role: "curator" });
    const other = await createUser({ role: "curator" });
    const mine = await createUser({ courseId: course.courseId });
    const foreign = await createUser({ courseId: course.courseId });
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [cur.id, mine.id]);
    await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2", [other.id, foreign.id]);
    const c = await loginAs(cur);
    expect((await impersonate(c, mine.id)).res.status).toBe(200);
    expect((await impersonate(c, foreign.id)).res.status).toBe(403);

    const doc = await loginAs(await createUser({ courseId: course.courseId }));
    expect((await impersonate(doc, mine.id)).res.status).toBe(403);
  });

  test("из режима просмотра нельзя войти ещё раз и нельзя попасть в панель сотрудника", async () => {
    const st = await createUser({ courseId: course.courseId });
    const st2 = await createUser({ courseId: course.courseId });
    const { cookie } = await impersonate(await loginAs(await createUser({ role: "admin" })), st.id);
    expect((await api("get", "/api/staff/students", cookie)).status).toBe(403);
    expect((await impersonate(cookie, st2.id)).res.status).toBe(403);
  });

  test("выход сотрудника со всех устройств гасит и просмотр", async () => {
    const st = await createUser({ courseId: course.courseId });
    const admUser = await createUser({ role: "admin" });
    const { cookie } = await impersonate(await loginAs(admUser), st.id);
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=$1", [admUser.id]);
    expect((await api("get", "/api/auth/me", cookie)).status).toBe(401);
  });
});
