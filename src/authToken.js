const jwt = require("jsonwebtoken");

// Общее с middleware/auth.js: тот же секрет/формат payload, чтобы токен,
// подписанный отсюда, проходил ту же проверку authRequired. Вынесено из
// routes/auth.js, потому что staff.js (режим «зайти как врач») тоже должен
// подписывать токены, не создавая циклическую зависимость между роутами.
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

// imp — необязательный снимок {id, name, role} сотрудника, который сейчас
// смотрит платформу «как врач» (см. staff.js POST /students/:id/impersonate).
// authRequired копирует весь payload в req.user, так что req.user.imp
// доступен везде, где токен проверяется, без отдельного похода в базу.
function signToken(user) {
  const payload = { id: user.id, role: user.role, name: user.name, email: user.email, tv: user.tokenVersion || 0 };
  if (user.imp) payload.imp = user.imp;
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}

module.exports = { signToken, COOKIE_OPTS };
