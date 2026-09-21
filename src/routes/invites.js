const express = require("express");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

function normEmail(e) {
  return (e || "").trim().toLowerCase();
}

// Кто кому может назначать роль: главный администратор — админам и кураторам;
// администратор — только кураторам; куратор ролей не назначает (только врачей).
function canAssignRole(actingRole, targetRole) {
  if (actingRole === "super_admin") return targetRole === "admin" || targetRole === "curator";
  if (actingRole === "admin") return targetRole === "curator";
  return false;
}

router.post("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const role = req.body && req.body.role;

  if (!email || !email.includes("@") || !["student", "curator", "admin"].includes(role)) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите корректный email и роль" });
  }
  if (role !== "student" && !canAssignRole(req.user.role, role)) {
    return res.status(403).json({ error: "forbidden", message: "Недостаточно прав для этой роли" });
  }

  const existingUser = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
  if (existingUser.rowCount) {
    return res.status(409).json({ error: "already_registered", message: "Этот email уже зарегистрирован на платформе" });
  }

  await pool.query(
    `INSERT INTO invites (email, role, invited_by) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET role=$2, invited_by=$3, invited_at=now()`,
    [email, role, req.user.name]
  );
  await logAction(req.user, "invite.create", "invite", email, email, { role }, true);
  res.json({ ok: true });
});

// Массовое приглашение врачей — например, список с прошедшего вебинара, вставленный из Excel/CSV.
// Принимает готовый массив email (парсинг CSV/строк делает фронтенд).
router.post("/bulk", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const emailsRaw = (req.body && req.body.emails) || [];
  if (!Array.isArray(emailsRaw) || !emailsRaw.length) {
    return res.status(400).json({ error: "invalid_input", message: "Список email пуст" });
  }
  if (emailsRaw.length > 500) {
    return res.status(400).json({ error: "invalid_input", message: "Не больше 500 адресов за раз" });
  }

  const created = [];
  const skipped = [];
  for (const raw of emailsRaw) {
    const email = normEmail(raw);
    if (!email || !email.includes("@")) { skipped.push({ email: raw, reason: "некорректный email" }); continue; }
    const existingUser = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existingUser.rowCount) { skipped.push({ email, reason: "уже зарегистрирован" }); continue; }
    await pool.query(
      `INSERT INTO invites (email, role, invited_by) VALUES ($1,'student',$2)
       ON CONFLICT (email) DO UPDATE SET role='student', invited_by=$2, invited_at=now()`,
      [email, req.user.name]
    );
    created.push(email);
  }

  await logAction(req.user, "invite.bulk_create", "invite", null, null, { count: created.length, skipped: skipped.length, created }, created.length>0);
  res.json({ ok: true, created, skipped });
});

router.get("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query("SELECT email, role, invited_by, invited_at FROM invites ORDER BY invited_at DESC");
  res.json({ invites: result.rows });
});

router.delete("/:email", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const email = normEmail(req.params.email);
  const existing = await pool.query("SELECT role, invited_by FROM invites WHERE email=$1", [email]);
  if (!existing.rowCount) return res.status(404).json({ error: "not_found" });
  if (!canAssignRole(req.user.role, existing.rows[0].role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  await pool.query("DELETE FROM invites WHERE email=$1", [email]);
  await logAction(req.user, "invite.cancel", "invite", email, email,
    { role: existing.rows[0].role, before: { role: existing.rows[0].role, invitedBy: existing.rows[0].invited_by } }, true);
  res.json({ ok: true });
});

module.exports = router;
