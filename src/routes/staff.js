const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { revertLogEntry } = require("../revert");
const { generateTempPassword } = require("../util");
const { notify } = require("../notifications");
const { canManageStudent, requireStudentScope, filterToScope } = require("../access");

const router = express.Router();

function canAssignRole(actingRole, targetRole) {
  if (actingRole === "super_admin") return targetRole === "admin" || targetRole === "curator";
  if (actingRole === "admin") return targetRole === "curator";
  return false;
}

const STUDENT_FIELDS = `
  u.id, u.name, u.email, u.phone, u.specialization, u.workplace, u.created_at, u.stream_id,
  u.product, u.payment_status, u.assigned_curator_id, u.referral_code,
  p.completed_lessons, p.quiz_score, p.completed, p.certificate_status,
  p.certificate_issued_at, p.certificate_issued_by, p.requested_full_access,
  p.access_expires_at, p.access_blocked
`;

router.get("/team", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, role, created_at FROM users WHERE role IN ('admin','curator') ORDER BY created_at`
  );
  res.json({ staff: result.rows });
});

router.get("/directory", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, role FROM users WHERE role IN ('admin','curator','super_admin') ORDER BY name`
  );
  res.json({ staff: result.rows });
});

// Смена роли уже существующему сотруднику (без удаления и повторного приглашения).
// Доступ к обеим ролям — текущей и новой — проверяется той же логикой, что и назначение
// при приглашении: администратор не может трогать другого администратора, только куратора.
router.patch("/team/:id/role", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const newRole = req.body && req.body.role;
  if (!["curator", "admin"].includes(newRole)) return res.status(400).json({ error: "invalid_input" });

  const target = await pool.query("SELECT role, name FROM users WHERE id=$1", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: "not_found" });
  const currentRole = target.rows[0].role;

  if (!canAssignRole(req.user.role, currentRole) || !canAssignRole(req.user.role, newRole)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (currentRole === newRole) return res.json({ ok: true, role: newRole });

  await pool.query("UPDATE users SET role=$1 WHERE id=$2", [newRole, req.params.id]);
  await logAction(req.user, "staff.role_change", "user", req.params.id, target.rows[0].name,
    { newRole, before: { role: currentRole } }, true);
  res.json({ ok: true, role: newRole });
});

router.delete("/team/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const target = await pool.query("SELECT role, name FROM users WHERE id=$1", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: "not_found" });
  if (!canAssignRole(req.user.role, target.rows[0].role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  await logAction(req.user, "staff.remove", "user", req.params.id, target.rows[0].name, { role: target.rows[0].role });
  res.json({ ok: true });
});

router.get("/students", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  // Куратор видит только "своих" врачей + ещё никому не назначенных — не весь список.
  const scopeClause = req.user.role === "curator" ? "AND (u.assigned_curator_id = $1 OR u.assigned_curator_id IS NULL)" : "";
  const params = req.user.role === "curator" ? [req.user.id] : [];
  const result = await pool.query(
    `SELECT ${STUDENT_FIELDS} FROM users u LEFT JOIN progress p ON p.user_id = u.id
     WHERE u.role = 'student' ${scopeClause} ORDER BY u.created_at DESC`,
    params
  );
  res.json({ students: result.rows });
});

router.get("/students/:id", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const result = await pool.query(
    `SELECT ${STUDENT_FIELDS}, p.quiz_answers FROM users u LEFT JOIN progress p ON p.user_id = u.id
     WHERE u.id = $1 AND u.role = 'student'`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ student: result.rows[0] });
});

router.patch("/students/:id/access", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const expiresAt = (req.body && req.body.expiresAt) || null;
  const before = await pool.query("SELECT access_expires_at FROM progress WHERE user_id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const result = await pool.query(
    "UPDATE progress SET access_expires_at=$1 WHERE user_id=$2 RETURNING user_id",
    [expiresAt, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  const u = await pool.query("SELECT name FROM users WHERE id=$1", [req.params.id]);
  await logAction(req.user, "access.set_expiry", "student", req.params.id, u.rows[0] && u.rows[0].name,
    { expiresAt, before: { accessExpiresAt: before.rows[0].access_expires_at } }, true);
  res.json({ ok: true, expiresAt });
});

router.post("/students/:id/access/extend", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const days = parseInt(req.body && req.body.days, 10) || 0;
  const current = await pool.query("SELECT access_expires_at FROM progress WHERE user_id=$1", [req.params.id]);
  if (!current.rowCount) return res.status(404).json({ error: "not_found" });
  const beforeValue = current.rows[0].access_expires_at;

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let base = today;
  if (beforeValue) {
    const existing = new Date(beforeValue);
    if (existing > today) base = existing;
  }
  base = new Date(base.getTime());
  base.setUTCDate(base.getUTCDate() + days);
  const iso = base.toISOString().slice(0, 10);

  await pool.query("UPDATE progress SET access_expires_at=$1 WHERE user_id=$2", [iso, req.params.id]);
  const u = await pool.query("SELECT name FROM users WHERE id=$1", [req.params.id]);
  await logAction(req.user, "access.extend", "student", req.params.id, u.rows[0] && u.rows[0].name,
    { days, newExpiresAt: iso, before: { accessExpiresAt: beforeValue } }, true);
  res.json({ ok: true, expiresAt: iso });
});

router.patch("/students/:id/access/block", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const blocked = !!(req.body && req.body.blocked);
  const before = await pool.query("SELECT access_blocked FROM progress WHERE user_id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const result = await pool.query(
    "UPDATE progress SET access_blocked=$1 WHERE user_id=$2 RETURNING user_id",
    [blocked, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  const u = await pool.query("SELECT name FROM users WHERE id=$1", [req.params.id]);
  await logAction(req.user, blocked ? "access.block" : "access.unblock", "student", req.params.id, u.rows[0] && u.rows[0].name,
    { before: { accessBlocked: before.rows[0].access_blocked } }, true);
  if (!blocked) {
    await notify(req.params.id, "access_unblocked", "Доступ восстановлен", "Куратор снял ограничение доступа к курсу — можно продолжать обучение.");
  }
  res.json({ ok: true, blocked });
});

router.patch("/students/:id/stream", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const streamId = (req.body && req.body.streamId) || null;
  const result = await pool.query(
    "UPDATE users SET stream_id=$1 WHERE id=$2 AND role='student' RETURNING id",
    [streamId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post("/students/bulk-stream", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { ids, streamId } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input", message: "Не выбраны врачи" });
  // Куратор массово трогает только тех врачей, что и так в его скоупе — остальных
  // id из списка молча пропускаем, а не 403-им весь запрос целиком.
  const scopedIds = await filterToScope(req.user, ids);
  if (!scopedIds.length) return res.json({ ok: true, updated: 0 });
  await pool.query(
    "UPDATE users SET stream_id=$1 WHERE id = ANY($2::text[]) AND role='student'",
    [streamId || null, scopedIds]
  );
  res.json({ ok: true, updated: scopedIds.length });
});

const PRODUCT_VALUES = ["longevity", "peptide", "personal_brand"];
const PAYMENT_VALUES = ["unpaid", "partial", "paid"];

router.patch("/students/:id/product", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const product = req.body && req.body.product;
  if (PRODUCT_VALUES.indexOf(product) === -1) return res.status(400).json({ error: "invalid_input" });
  await pool.query("UPDATE users SET product=$1 WHERE id=$2 AND role='student'", [product, req.params.id]);
  res.json({ ok: true });
});

router.patch("/students/:id/payment", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const paymentStatus = req.body && req.body.paymentStatus;
  if (PAYMENT_VALUES.indexOf(paymentStatus) === -1) return res.status(400).json({ error: "invalid_input" });
  await pool.query("UPDATE users SET payment_status=$1 WHERE id=$2 AND role='student'", [paymentStatus, req.params.id]);
  res.json({ ok: true });
});

router.patch("/students/:id/curator", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const curatorId = (req.body && req.body.curatorId) || null;
  await pool.query("UPDATE users SET assigned_curator_id=$1 WHERE id=$2 AND role='student'", [curatorId, req.params.id]);
  res.json({ ok: true });
});

// Персонал правит контактные данные врача (например, тот сам не может/не успел
// это сделать) — имя, телефон, место работы, специализация.
router.patch("/students/:id/profile", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const { name, phone, workplace, specialization } = req.body || {};
  const sets = [];
  const values = [];
  if (typeof name === "string") {
    if (!name.trim()) return res.status(400).json({ error: "invalid_input", message: "Имя не может быть пустым" });
    sets.push(`name=$${sets.length + 1}`); values.push(name.trim());
  }
  if (typeof phone === "string") { sets.push(`phone=$${sets.length + 1}`); values.push(phone.trim() || null); }
  if (typeof workplace === "string") { sets.push(`workplace=$${sets.length + 1}`); values.push(workplace.trim() || null); }
  if (typeof specialization === "string") { sets.push(`specialization=$${sets.length + 1}`); values.push(specialization.trim() || null); }
  if (!sets.length) return res.status(400).json({ error: "invalid_input" });

  const before = await pool.query("SELECT name, phone, workplace, specialization FROM users WHERE id=$1 AND role='student'", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });

  values.push(req.params.id);
  const result = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${values.length} AND role='student' RETURNING id`, values);
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });

  await logAction(req.user, "student.profile_update", "student", req.params.id, name ? name.trim() : before.rows[0].name,
    { before: before.rows[0] }, true);
  res.json({ ok: true });
});

router.post("/students/bulk-field", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { ids, field, value } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input", message: "Не выбраны врачи" });
  const scopedIds = await filterToScope(req.user, ids);
  if (!scopedIds.length) return res.json({ ok: true, updated: 0 });
  if (field === "product") {
    if (PRODUCT_VALUES.indexOf(value) === -1) return res.status(400).json({ error: "invalid_input" });
    await pool.query("UPDATE users SET product=$1 WHERE id = ANY($2::text[]) AND role='student'", [value, scopedIds]);
  } else if (field === "payment_status") {
    if (PAYMENT_VALUES.indexOf(value) === -1) return res.status(400).json({ error: "invalid_input" });
    await pool.query("UPDATE users SET payment_status=$1 WHERE id = ANY($2::text[]) AND role='student'", [value, scopedIds]);
  } else {
    return res.status(400).json({ error: "invalid_field" });
  }
  res.json({ ok: true, updated: scopedIds.length });
});

/* ---------- Приватные заметки персонала о враче (врач их никогда не видит) ---------- */

router.get("/students/:id/notes", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const result = await pool.query(
    "SELECT id, author_name, body, created_at FROM student_notes WHERE student_id=$1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ notes: result.rows });
});

router.post("/students/:id/notes", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const body = req.body && req.body.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "invalid_input" });
  const target = await pool.query("SELECT id FROM users WHERE id=$1 AND role='student'", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: "not_found" });
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO student_notes (id, student_id, author_id, author_name, body) VALUES ($1,$2,$3,$4,$5)",
    [id, req.params.id, req.user.id, req.user.name, body.trim()]
  );
  res.json({ ok: true, id });
});

/* ---------- Сброс пароля (пока нет email-рассылки — куратор/админ передаёт временный пароль лично) ---------- */

router.post("/students/:id/reset-password", authRequired, requireRole("curator", "admin", "super_admin"), requireStudentScope(), async (req, res) => {
  const target = await pool.query("SELECT id, name FROM users WHERE id=$1 AND role='student'", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: "not_found" });

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  // token_version++ — отзывает все ранее выданные токены этого врача (на случай, если старый пароль/устройство скомпрометированы)
  await pool.query("UPDATE users SET password_hash=$1, token_version = token_version + 1 WHERE id=$2", [hash, req.params.id]);
  await logAction(req.user, "password.reset_by_staff", "student", req.params.id, target.rows[0].name, {});
  res.json({ ok: true, tempPassword });
});

router.post("/team/:id/reset-password", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const target = await pool.query("SELECT role, name FROM users WHERE id=$1", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: "not_found" });
  if (!canAssignRole(req.user.role, target.rows[0].role)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  await pool.query("UPDATE users SET password_hash=$1, token_version = token_version + 1 WHERE id=$2", [hash, req.params.id]);
  await logAction(req.user, "password.reset_by_staff", "staff", req.params.id, target.rows[0].name, { role: target.rows[0].role });
  res.json({ ok: true, tempPassword });
});

/* ---------- Журнал действий персонала ---------- */

router.get("/audit-log", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  const result = await pool.query(
    `SELECT id, actor_name, actor_role, action, target_type, target_id, target_name, details, revertible, reverted_at, reverted_by, created_at
     FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ log: result.rows });
});

// Откат конкретного действия — доступно только главному администратору.
router.post("/audit-log/:id/revert", authRequired, requireRole("super_admin"), async (req, res) => {
  const row = await pool.query("SELECT * FROM audit_log WHERE id=$1", [req.params.id]);
  if (!row.rowCount) return res.status(404).json({ error: "not_found" });
  const logRow = row.rows[0];

  try {
    await revertLogEntry(logRow);
  } catch (e) {
    return res.status(400).json({ error: "revert_failed", message: e.message });
  }

  await pool.query("UPDATE audit_log SET reverted_at=now(), reverted_by=$1 WHERE id=$2", [req.user.name, req.params.id]);
  await logAction(
    req.user, "audit.revert", logRow.target_type, logRow.target_id, logRow.target_name,
    { revertedLogId: logRow.id, revertedAction: logRow.action }, false
  );
  res.json({ ok: true });
});

/* ---------- Просмотр курса глазами врача (без создания тестового аккаунта) ---------- */

router.get("/course-preview", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const course = await pool.query("SELECT id, title FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const lessons = await pool.query(
    "SELECT id, idx, title, duration, html FROM lessons WHERE course_id=$1 ORDER BY idx",
    [course.rows[0].id]
  );
  const quiz = await pool.query(
    "SELECT id, idx, question, options FROM quiz_questions WHERE course_id=$1 ORDER BY idx",
    [course.rows[0].id]
  );
  res.json({
    course: course.rows[0],
    lessons: lessons.rows.map((l) => Object.assign({}, l, { hiddenForMe: false })),
    quiz: quiz.rows.map((q) => ({ id: q.id, question: q.question, options: q.options })),
    quizHiddenForMe: false,
    progress: { completed_lessons: [], quiz_score: null, completed: false, certificate_status: "none", requested_full_access: false },
    locked: { locked: false, reason: null }
  });
});

module.exports = router;
