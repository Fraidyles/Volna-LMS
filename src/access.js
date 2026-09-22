const pool = require("./db");

// Куратор видит и может управлять только теми врачами, что закреплены именно
// за ним, либо ещё ни за кем не закреплены (свежие регистрации) — не всеми
// подряд. Админы/супер-админы этим ограничением не связаны.
async function canManageStudent(actor, studentId) {
  // Явный список ролей, а не просто "не куратор" — вызывающий код сейчас всегда
  // проверяет role!=="student" перед вызовом, но эта функция не должна полагаться
  // на дисциплину всех будущих вызовов: врач не должен получить true в обход этой проверки.
  if (actor.role === "admin" || actor.role === "super_admin") return true;
  if (actor.role !== "curator") return false;
  const row = await pool.query("SELECT assigned_curator_id FROM users WHERE id=$1 AND role='student'", [studentId]);
  if (!row.rowCount) return false;
  const assignedTo = row.rows[0].assigned_curator_id;
  return assignedTo === null || assignedTo === actor.id;
}

// Express-миддлварь: 403 без утечки того, чей на самом деле этот врач.
function requireStudentScope(paramName) {
  paramName = paramName || "id";
  return async (req, res, next) => {
    const ok = await canManageStudent(req.user, req.params[paramName]);
    if (!ok) return res.status(403).json({ error: "forbidden", message: "Этот врач закреплён за другим куратором" });
    next();
  };
}

// Для массовых операций: молча оставляет только те id, которыми actor вправе управлять,
// вместо 403 на весь запрос из-за одного врача не в скоупе.
async function filterToScope(actor, studentIds) {
  if (actor.role !== "curator") return studentIds;
  const rows = await pool.query(
    "SELECT id FROM users WHERE id = ANY($1::text[]) AND role='student' AND (assigned_curator_id = $2 OR assigned_curator_id IS NULL)",
    [studentIds, actor.id]
  );
  const allowed = new Set(rows.rows.map((r) => r.id));
  return studentIds.filter((id) => allowed.has(id));
}

module.exports = { canManageStudent, requireStudentScope, filterToScope };
