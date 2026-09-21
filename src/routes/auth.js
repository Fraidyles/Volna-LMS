const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");
const { logAction } = require("../audit");
const { generateReferralCode } = require("../util");

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

// Не больше 8 попыток входа/регистрации за 5 минут с одного IP — защита от подбора пароля.
// Считаем только неудачные попытки, чтобы обычный человек, вошедший с первого раза, лимит не тратил.
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "too_many_attempts", message: "Слишком много попыток. Попробуйте снова через несколько минут." }
});

function normEmail(e) {
  return (e || "").trim().toLowerCase();
}
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

router.post("/register", authLimiter, async (req, res) => {
  const { email: rawEmail, password, name, specialization, workplace, phone, ref } = req.body || {};
  const email = normEmail(rawEmail);

  if (!email || !email.includes("@") || !password || password.length < 6 || !name || !name.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите имя, корректный email и пароль от 6 символов" });
  }

  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: "email_taken", message: "Этот email уже зарегистрирован — войдите вместо регистрации" });
  }

  const invite = await pool.query("SELECT role, invited_by FROM invites WHERE email=$1", [email]);
  const role = invite.rowCount ? invite.rows[0].role : "student";

  if (role === "student" && !specialization) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите специализацию" });
  }

  let referredBy = null;
  if (ref) {
    const referrer = await pool.query("SELECT id FROM users WHERE referral_code=$1", [String(ref).trim()]);
    if (referrer.rowCount) referredBy = referrer.rows[0].id;
  }

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  const referralCode = generateReferralCode();

  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, specialization, workplace, phone, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, email, hash, name.trim(), role, specialization || null, workplace || null, phone || null, referralCode, referredBy]
  );

  if (invite.rowCount) {
    await pool.query("DELETE FROM invites WHERE email=$1", [email]);
  }

  if (role === "student") {
    const course = await pool.query("SELECT id FROM courses LIMIT 1");
    if (course.rowCount) {
      await pool.query(
        "INSERT INTO progress (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING",
        [id, course.rows[0].id]
      );
    }
  }

  const user = { id, email, name: name.trim(), role, tokenVersion: 0 };
  res.cookie("token", signToken(user), COOKIE_OPTS);
  await logAction(user, "auth.register", "user", id, name.trim(), { role, viaInvite: !!invite.rowCount, referredBy });
  // Профиль отдаём целиком (не только поля из JWT) — иначе только что заполненные
  // специализация/место работы/телефон выглядели бы пустыми на экране до перезахода.
  const profileOut = {
    id, email, name: name.trim(), role,
    specialization: specialization || null, workplace: workplace || null, phone: phone || null,
    referral_code: referralCode
  };
  res.json({ user: profileOut, invitedBy: invite.rowCount ? invite.rows[0].invited_by : null });
});

router.post("/login", authLimiter, async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = (req.body && req.body.password) || "";
  if (!email || !password) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите email и пароль" });
  }

  const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  if (!result.rowCount) {
    return res.status(401).json({ error: "invalid_credentials", message: "Неверный email или пароль" });
  }

  const row = result.rows[0];
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_credentials", message: "Неверный email или пароль" });
  }

  const user = { id: row.id, email: row.email, name: row.name, role: row.role, tokenVersion: row.token_version };
  res.cookie("token", signToken(user), COOKIE_OPTS);
  // Профиль целиком, а не только поля из JWT — иначе специализация/место работы/телефон
  // выглядели бы пустыми в модалке профиля сразу после входа, до первого GET /auth/me.
  res.json({
    user: {
      id: row.id, email: row.email, name: row.name, role: row.role,
      specialization: row.specialization, workplace: row.workplace, phone: row.phone,
      stream_id: row.stream_id, referral_code: row.referral_code, created_at: row.created_at
    }
  });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", COOKIE_OPTS);
  res.json({ ok: true });
});

// Выйти со всех устройств: увеличивает token_version, все выданные раньше токены (включая текущий) перестают приниматься.
router.post("/logout-everywhere", authRequired, async (req, res) => {
  await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=$1", [req.user.id]);
  res.clearCookie("token", COOKIE_OPTS);
  await logAction(req.user, "auth.logout_everywhere", "user", req.user.id, req.user.name, {});
  res.json({ ok: true });
});

router.get("/me", authRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, name, role, specialization, workplace, phone, stream_id, referral_code, created_at FROM users WHERE id=$1",
    [req.user.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ user: result.rows[0] });
});

// Самостоятельное редактирование своих же контактных данных — имя, телефон, место
// работы, а для врача ещё и специализация. Email и роль отсюда не меняются намеренно.
router.patch("/me", authRequired, async (req, res) => {
  const { name, phone, workplace, specialization } = req.body || {};
  const sets = [];
  const values = [];
  if (typeof name === "string") {
    if (!name.trim()) return res.status(400).json({ error: "invalid_input", message: "Имя не может быть пустым" });
    sets.push(`name=$${sets.length + 1}`); values.push(name.trim());
  }
  if (typeof phone === "string") { sets.push(`phone=$${sets.length + 1}`); values.push(phone.trim() || null); }
  if (typeof workplace === "string") { sets.push(`workplace=$${sets.length + 1}`); values.push(workplace.trim() || null); }
  if (typeof specialization === "string" && req.user.role === "student") {
    sets.push(`specialization=$${sets.length + 1}`); values.push(specialization.trim() || null);
  }
  if (!sets.length) return res.status(400).json({ error: "invalid_input" });

  values.push(req.user.id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${values.length}`, values);

  const result = await pool.query(
    "SELECT id, email, name, role, specialization, workplace, phone, stream_id, referral_code, token_version, created_at FROM users WHERE id=$1",
    [req.user.id]
  );
  const row = result.rows[0];
  // Имя могло поменяться — перевыпускаем токен, чтобы во всех последующих действиях
  // (например, в журнале аудита) снова фигурировало актуальное имя, а не старое из JWT.
  const user = { id: row.id, email: row.email, name: row.name, role: row.role, tokenVersion: row.token_version };
  res.cookie("token", signToken(user), COOKIE_OPTS);
  res.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role, specialization: row.specialization, workplace: row.workplace, phone: row.phone, stream_id: row.stream_id, referral_code: row.referral_code, created_at: row.created_at } });
});

router.post("/change-password", authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите текущий пароль и новый (от 6 символов)" });
  }
  const result = await pool.query("SELECT password_hash, email, role, name, token_version FROM users WHERE id=$1", [req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });

  const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials", message: "Текущий пароль указан неверно" });

  const hash = await bcrypt.hash(newPassword, 10);
  const newVersion = result.rows[0].token_version + 1;
  await pool.query("UPDATE users SET password_hash=$1, token_version=$2 WHERE id=$3", [hash, newVersion, req.user.id]);

  // Отзываем все старые сессии, но текущую сразу обновляем новым токеном — человека не разлогинивает.
  const user = { id: req.user.id, email: result.rows[0].email, name: result.rows[0].name, role: result.rows[0].role, tokenVersion: newVersion };
  res.cookie("token", signToken(user), COOKIE_OPTS);
  await logAction(req.user, "auth.change_password", "user", req.user.id, req.user.name, {});
  res.json({ ok: true });
});

module.exports = router;
