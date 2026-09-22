const jwt = require("jsonwebtoken");
const pool = require("../db");

async function authRequired(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: "not_authenticated", message: "Нужно войти в систему" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: "invalid_token", message: "Сессия истекла, войдите заново" });
  }

  // Проверяем token_version в базе — так пароль/сброс пароля мгновенно отзывает
  // все ранее выданные токены этого пользователя, даже если их 30-дневный срок ещё не истёк.
  // Роль же в req.user всегда берём СВЕЖУЮ из базы, а не из JWT: иначе смена роли
  // сотрудника (staff.js PATCH /team/:id/role) не отзывает токен — role в payload
  // была бы "заморожена" на момент входа, и разжалованный админ сохранял бы admin-доступ
  // по старой cookie вплоть до истечения токена (до 30 дней) или явного перелогина.
  let liveRole;
  try {
    const result = await pool.query("SELECT token_version, role FROM users WHERE id=$1", [payload.id]);
    if (!result.rowCount || result.rows[0].token_version !== payload.tv) {
      return res.status(401).json({ error: "session_revoked", message: "Сессия больше не действительна, войдите заново" });
    }
    liveRole = result.rows[0].role;
  } catch (e) {
    return res.status(500).json({ error: "internal_error" });
  }

  req.user = Object.assign({}, payload, { role: liveRole });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden", message: "Недостаточно прав" });
    }
    next();
  };
}

module.exports = { authRequired, requireRole };
