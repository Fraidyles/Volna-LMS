const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const { authRequired } = require("../middleware/auth");
const { logAction } = require("../audit");
const { generateReferralCode, describeUserAgent } = require("../util");
const { verifyStaffInviteCode } = require("../staffInviteCode");
const fs = require("fs");
const path = require("path");

// Фото профиля: браузер сам ужимает снимок до 256×256 и присылает data URL
// (≈20–40 КБ), сервер лишь проверяет тип/размер и кладёт файл на диск.
const AVATAR_DIR = path.join(__dirname, "..", "..", "uploads", "avatars");
const AVATAR_MAX_BYTES = 300 * 1024;
const AVATAR_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
function avatarUrl(file){ return file ? "api/auth/avatar/" + file : null; }

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000
};
// Для clearCookie — те же флаги без maxAge (иначе Express предупреждает об устаревании).
const CLEAR_OPTS = { httpOnly: true, sameSite: "lax", secure: COOKIE_OPTS.secure };

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
  const { email: rawEmail, password, name, specializationIds, workplace, phone, ref, interestIds, staffInviteCode } = req.body || {};
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

  // Приглашение само по себе — это лишь резервирование email за ролью, без
  // подтверждения, что регистрируется именно приглашённый человек (почта нигде
  // не проверяется). Поэтому для роли сотрудника обязателен ещё и код, который
  // виден только в «Команда» у admin/super_admin и перевыпускается раз в сутки —
  // без него любой, кто узнает/угадает приглашённый email, получил бы чужую роль.
  if (role !== "student") {
    const codeOk = await verifyStaffInviteCode(staffInviteCode);
    if (!codeOk) {
      return res.status(403).json({
        error: "invalid_staff_code",
        message: "Для регистрации с ролью куратора/администратора нужен верный код — уточните его у пригласившего"
      });
    }
  }

  // Текущая специализация — из справочника (фиксированный список, можно несколько:
  // многие врачи практикуют сразу в нескольких направлениях), а не свободный текст —
  // от неё зависит, какие протоколы потом попадут врачу в «Ваши протоколы».
  let specializationRows = [];
  if (role === "student") {
    // Человек выбрал «Я сотрудник» и ввёл код, но на этот email нет приглашения
    // куратора/админа — объясняем прямо, а не требуем специализацию врача.
    if (staffInviteCode && String(staffInviteCode).trim() && (!Array.isArray(specializationIds) || !specializationIds.length)) {
      return res.status(403).json({
        error: "no_staff_invite",
        message: "На этот email нет приглашения куратора или администратора — попросите пригласившего отправить его или зарегистрируйтесь как врач"
      });
    }
    if (!Array.isArray(specializationIds) || !specializationIds.length) {
      return res.status(400).json({ error: "invalid_input", message: "Укажите текущую специализацию" });
    }
    const spec = await pool.query("SELECT id, name FROM specializations WHERE id = ANY($1::text[])", [specializationIds]);
    if (!spec.rowCount) return res.status(400).json({ error: "invalid_input", message: "Неизвестная специализация" });
    specializationRows = spec.rows;
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
    `INSERT INTO users (id, email, password_hash, name, role, workplace, phone, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, email, hash, name.trim(), role, workplace || null, phone || null, referralCode, referredBy]
  );
  for (const row of specializationRows) {
    await pool.query(
      "INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [id, row.id]
    );
  }

  // «Хочу развиваться в...» — необязательные, невалидные/чужие id просто отбрасываем,
  // а не роняем всю регистрацию из-за одного плохого значения в необязательном поле.
  let interestRows = [];
  if (role === "student" && Array.isArray(interestIds) && interestIds.length) {
    const valid = await pool.query("SELECT id, name FROM specializations WHERE id = ANY($1::text[])", [interestIds]);
    interestRows = valid.rows;
    for (const row of interestRows) {
      await pool.query(
        "INSERT INTO user_specialization_interests (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, row.id]
      );
    }
  }

  if (invite.rowCount) {
    await pool.query("DELETE FROM invites WHERE email=$1", [email]);
  }

  // Курсов теперь может быть несколько — по умолчанию записываем на самый старый
  // (флагманский демо-курс), детерминированно по created_at, а не LIMIT 1 без
  // порядка. Если форма регистрации когда-нибудь передаст конкретный courseId
  // (например, ссылка-приглашение на определённый курс) — записываем на него.
  if (role === "student") {
    const requestedCourseId = req.body && req.body.courseId;
    const course = requestedCourseId
      ? await pool.query("SELECT id FROM courses WHERE id=$1", [requestedCourseId])
      : await pool.query("SELECT id FROM courses ORDER BY created_at LIMIT 1");
    if (course.rowCount) {
      await pool.query(
        "INSERT INTO progress (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING",
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
    specializationIds: specializationRows.map((r) => r.id),
    interestIds: interestRows.map((r) => r.id),
    workplace: workplace || null, phone: phone || null,
    referral_code: referralCode, product: "longevity", payment_status: "unpaid"
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
  // Для «Мой профиль» → «Текущие сеансы» — не блокирует сам вход, если запись не удалась.
  pool.query(
    "INSERT INTO login_sessions (id, user_id, user_agent, ip) VALUES ($1,$2,$3,$4)",
    [crypto.randomUUID(), row.id, req.headers["user-agent"] || null, req.ip || null]
  ).catch(() => {});
  // Профиль целиком, а не только поля из JWT — иначе специализация/место работы/телефон
  // выглядели бы пустыми в модалке профиля сразу после входа, до первого GET /auth/me.
  const interests = await pool.query(
    "SELECT specialization_id FROM user_specialization_interests WHERE user_id=$1", [row.id]
  );
  const currentSpecs = await pool.query(
    "SELECT specialization_id FROM user_specializations WHERE user_id=$1", [row.id]
  );
  res.json({
    user: {
      id: row.id, email: row.email, name: row.name, role: row.role,
      specializationIds: currentSpecs.rows.map((r) => r.specialization_id),
      interestIds: interests.rows.map((r) => r.specialization_id),
      workplace: row.workplace, phone: row.phone,
      stream_id: row.stream_id, referral_code: row.referral_code, created_at: row.created_at,
      product: row.product, payment_status: row.payment_status
    }
  });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", COOKIE_OPTS);
  res.clearCookie("staff_token", CLEAR_OPTS);
  res.json({ ok: true });
});

// Выйти со всех устройств: увеличивает token_version, все выданные раньше токены (включая текущий) перестают приниматься.
router.post("/logout-everywhere", authRequired, async (req, res) => {
  await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id=$1", [req.user.id]);
  res.clearCookie("token", COOKIE_OPTS);
  await logAction(req.user, "auth.logout_everywhere", "user", req.user.id, req.user.name, {});
  res.json({ ok: true });
});

// Выход из просмотра «глазами врача»: возвращаем сотруднику его собственную сессию,
// сохранённую при входе в отдельной cookie. Если она уже недействительна — просто выходим.
router.post("/impersonate/stop", async (req, res) => {
  const staffToken = req.cookies && req.cookies.staff_token;
  res.clearCookie("staff_token", CLEAR_OPTS);
  let ok = false;
  if (staffToken) {
    try {
      const p = jwt.verify(staffToken, process.env.JWT_SECRET);
      const r = await pool.query("SELECT token_version FROM users WHERE id=$1", [p.id]);
      ok = !!r.rowCount && r.rows[0].token_version === p.tv && !p.imp;
    } catch (e) { ok = false; }
  }
  if (ok) res.cookie("token", staffToken, COOKIE_OPTS);
  else res.clearCookie("token", CLEAR_OPTS);
  res.json({ ok: true, restored: ok });
});

router.get("/me", authRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, name, role, workplace, phone, stream_id, referral_code, created_at, product, payment_status, avatar_file FROM users WHERE id=$1",
    [req.user.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  const interests = await pool.query(
    "SELECT specialization_id FROM user_specialization_interests WHERE user_id=$1", [req.user.id]
  );
  const currentSpecs = await pool.query(
    "SELECT specialization_id FROM user_specializations WHERE user_id=$1", [req.user.id]
  );
  const u = Object.assign({}, result.rows[0]);
  u.avatar_url = avatarUrl(u.avatar_file); delete u.avatar_file;
  res.json({ user: Object.assign(u, {
    specializationIds: currentSpecs.rows.map((r) => r.specialization_id),
    interestIds: interests.rows.map((r) => r.specialization_id),
    impersonator: req.user.imp ? { id: req.user.imp.id, name: req.user.imp.name } : null
  }) });
});

router.put("/me/avatar", authRequired, express.json({ limit: "600kb" }), async (req, res) => {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec((req.body && req.body.image) || "");
  if (!m) return res.status(400).json({ error: "invalid_input", message: "Нужна картинка JPG, PNG или WebP" });
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > AVATAR_MAX_BYTES) {
    return res.status(400).json({ error: "too_large", message: "Фото слишком большое" });
  }
  // Заявленный тип должен совпадать с содержимым — иначе под видом картинки
  // можно было бы положить на сервер произвольный файл.
  const sig = { "image/png": buf.slice(0, 4).toString("hex") === "89504e47",
    "image/jpeg": buf.slice(0, 3).toString("hex") === "ffd8ff",
    "image/webp": buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" };
  if (!sig[m[1]]) return res.status(400).json({ error: "invalid_input", message: "Файл не похож на картинку" });
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const file = req.user.id.replace(/[^A-Za-z0-9-]/g, "") + "-" + crypto.randomBytes(6).toString("hex") + "." + AVATAR_TYPES[m[1]];
  fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  const prev = await pool.query("SELECT avatar_file FROM users WHERE id=$1", [req.user.id]);
  await pool.query("UPDATE users SET avatar_file=$1 WHERE id=$2", [file, req.user.id]);
  const old = prev.rowCount && prev.rows[0].avatar_file;
  if (old && old !== file) fs.unlink(path.join(AVATAR_DIR, path.basename(old)), () => {});
  res.json({ ok: true, avatar_url: avatarUrl(file) });
});

router.delete("/me/avatar", authRequired, async (req, res) => {
  const prev = await pool.query("SELECT avatar_file FROM users WHERE id=$1", [req.user.id]);
  await pool.query("UPDATE users SET avatar_file=NULL WHERE id=$1", [req.user.id]);
  const old = prev.rowCount && prev.rows[0].avatar_file;
  if (old) fs.unlink(path.join(AVATAR_DIR, path.basename(old)), () => {});
  res.json({ ok: true });
});

// Фото отдаются только авторизованным (как и остальные данные платформы).
router.get("/avatar/:file", authRequired, (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^[A-Za-z0-9-]+\.(webp|jpg|png)$/.test(file)) return res.status(404).end();
  const full = path.join(AVATAR_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(full);
});

// «Мой профиль» → «Текущие сеансы»: с какого устройства, откуда (IP) и когда входили.
router.get("/sessions", authRequired, async (req, res) => {
  const result = await pool.query(
    "SELECT id, user_agent, ip, created_at FROM login_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json({
    sessions: result.rows.map((r) => ({
      id: r.id, ip: r.ip, createdAt: r.created_at, device: describeUserAgent(r.user_agent)
    }))
  });
});

// Самостоятельное редактирование своих же контактных данных — имя, телефон, место
// работы, а для врача ещё и специализации. Email и роль отсюда не меняются намеренно.
router.patch("/me", authRequired, async (req, res) => {
  const { name, phone, workplace, specializationIds, interestIds } = req.body || {};
  const sets = [];
  const values = [];
  if (typeof name === "string") {
    if (!name.trim()) return res.status(400).json({ error: "invalid_input", message: "Имя не может быть пустым" });
    sets.push(`name=$${sets.length + 1}`); values.push(name.trim());
  }
  if (typeof phone === "string") { sets.push(`phone=$${sets.length + 1}`); values.push(phone.trim() || null); }
  if (typeof workplace === "string") { sets.push(`workplace=$${sets.length + 1}`); values.push(workplace.trim() || null); }

  // specializationIds, в отличие от interestIds, не может стать пустым списком —
  // текущая специализация обязательна (как и на регистрации), просто теперь их может быть несколько.
  if (Array.isArray(specializationIds) && req.user.role === "student" && !specializationIds.length) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите текущую специализацию" });
  }
  if (!sets.length && !Array.isArray(interestIds) && !Array.isArray(specializationIds)) {
    return res.status(400).json({ error: "invalid_input" });
  }

  if (sets.length) {
    values.push(req.user.id);
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${values.length}`, values);
  }

  // Списки специализаций/интересов заменяются целиком — это то же самое, что
  // переотметить чекбоксы в форме заново, а не точечно добавлять/убирать.
  if (Array.isArray(specializationIds) && req.user.role === "student") {
    const valid = await pool.query("SELECT id FROM specializations WHERE id = ANY($1::text[])", [specializationIds]);
    if (!valid.rowCount) return res.status(400).json({ error: "invalid_input", message: "Неизвестная специализация" });
    await pool.query("DELETE FROM user_specializations WHERE user_id=$1", [req.user.id]);
    for (const row of valid.rows) {
      await pool.query(
        "INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [req.user.id, row.id]
      );
    }
  }
  if (Array.isArray(interestIds) && req.user.role === "student") {
    await pool.query("DELETE FROM user_specialization_interests WHERE user_id=$1", [req.user.id]);
    if (interestIds.length) {
      const valid = await pool.query("SELECT id FROM specializations WHERE id = ANY($1::text[])", [interestIds]);
      for (const row of valid.rows) {
        await pool.query(
          "INSERT INTO user_specialization_interests (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [req.user.id, row.id]
        );
      }
    }
  }

  const result = await pool.query(
    "SELECT id, email, name, role, workplace, phone, stream_id, referral_code, token_version, created_at, product, payment_status FROM users WHERE id=$1",
    [req.user.id]
  );
  const row = result.rows[0];
  const interests = await pool.query(
    "SELECT specialization_id FROM user_specialization_interests WHERE user_id=$1", [req.user.id]
  );
  const currentSpecs = await pool.query(
    "SELECT specialization_id FROM user_specializations WHERE user_id=$1", [req.user.id]
  );
  // Имя могло поменяться — перевыпускаем токен, чтобы во всех последующих действиях
  // (например, в журнале аудита) снова фигурировало актуальное имя, а не старое из JWT.
  const user = { id: row.id, email: row.email, name: row.name, role: row.role, tokenVersion: row.token_version };
  res.cookie("token", signToken(user), COOKIE_OPTS);
  res.json({ user: {
    id: row.id, email: row.email, name: row.name, role: row.role,
    specializationIds: currentSpecs.rows.map((r) => r.specialization_id),
    interestIds: interests.rows.map((r) => r.specialization_id),
    workplace: row.workplace, phone: row.phone, stream_id: row.stream_id, referral_code: row.referral_code,
    created_at: row.created_at, product: row.product, payment_status: row.payment_status
  } });
});

// Тот же лимитер, что и на /login: без него угнанная (например, через XSS) сессия без
// знания реального пароля позволяла бы подбирать currentPassword сколько угодно раз,
// чтобы задать новый пароль и вытеснить настоящего владельца из аккаунта.
router.post("/change-password", authRequired, authLimiter, async (req, res) => {
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
module.exports.COOKIE_OPTS = COOKIE_OPTS;
