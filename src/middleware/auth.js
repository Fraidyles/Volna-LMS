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

  // Вход «глазами врача» из карточки врача (POST /staff/students/:id/impersonate):
  // сотрудник видит кабинет ровно как врач, но только смотрит. Токен действует,
  // пока действует сессия самого сотрудника и он всё ещё сотрудник, — разжалование
  // или «выйти со всех устройств» у сотрудника гасит и этот просмотр.
  if (payload.imp) {
    try {
      const staff = await pool.query("SELECT token_version, role FROM users WHERE id=$1", [payload.imp.id]);
      if (!staff.rowCount || staff.rows[0].token_version !== payload.imp.tv ||
          !["curator", "admin", "super_admin"].includes(staff.rows[0].role)) {
        return res.status(401).json({ error: "session_revoked", message: "Сессия больше не действительна, войдите заново" });
      }
    } catch (e) {
      return res.status(500).json({ error: "internal_error" });
    }
    const path = (req.originalUrl || "").split("?")[0];
    const readOnly = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (readOnly && !/\/auth\/(impersonate\/stop|logout)$/.test(path)) {
      return res.status(403).json({ error: "read_only", message: "Вы смотрите кабинет глазами врача — изменения от его имени недоступны" });
    }
  }
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
