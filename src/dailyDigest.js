const pool = require("./db");

// Простая русская плюрализация (1 врач / 2 врача / 5 врачей) — без библиотек,
// этого набора форм достаточно для дайджеста.
function ruPlural(n, one, few, many) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// МСК = UTC+3 круглый год (без перехода на летнее время с 2014-го) — считаем
// "вчера" как календарные сутки по московскому времени, а не по UTC сервера.
function mskYesterdayWindow() {
  const now = new Date();
  const mskShifted = new Date(now.getTime() + 3 * 3600000);
  const y = mskShifted.getUTCFullYear(), m = mskShifted.getUTCMonth(), d = mskShifted.getUTCDate();
  const mskMidnightTodayUtcMs = Date.UTC(y, m, d, 0, 0, 0) - 3 * 3600000;
  return {
    start: new Date(mskMidnightTodayUtcMs - 24 * 3600000),
    end: new Date(mskMidnightTodayUtcMs)
  };
}

// Детерминированный (не LLM) дайджест «что произошло вчера» — собирается по шаблону
// из реальных агрегатов, а не генерируется моделью: в приложении нет ключа/инфраструктуры
// для рантайм-вызова LLM, а цифры важнее художественного текста для куратора.
async function buildDailyDigest(actor) {
  const { start, end } = mskYesterdayWindow();
  const scopeClause = actor.role === "curator" ? "AND (u.assigned_curator_id = $3 OR u.assigned_curator_id IS NULL)" : "";
  const scopeParams = actor.role === "curator" ? [start, end, actor.id] : [start, end];

  const registered = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM users u WHERE u.role='student' AND u.created_at >= $1 AND u.created_at < $2 ${scopeClause}`,
    scopeParams
  );
  const active = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM users u JOIN progress p ON p.user_id=u.id
     WHERE u.role='student' AND p.last_active_at >= $1 AND p.last_active_at < $2 ${scopeClause}`,
    scopeParams
  );
  const certified = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM users u JOIN progress p ON p.user_id=u.id
     WHERE u.role='student' AND p.certificate_issued_at >= $1 AND p.certificate_issued_at < $2 ${scopeClause}`,
    scopeParams
  );
  const stats = {
    registered: registered.rows[0].cnt,
    active: active.rows[0].cnt,
    certified: certified.rows[0].cnt
  };

  const dateLabel = start.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  const lines = [];
  if (stats.registered) {
    lines.push(stats.registered + " " + ruPlural(stats.registered, "новый врач зарегистрировался", "новых врача зарегистрировались", "новых врачей зарегистрировалось"));
  }
  if (stats.active) {
    lines.push(stats.active + " " + ruPlural(stats.active, "врач занимался", "врача занимались", "врачей занимались") + " курсом");
  }
  if (stats.certified) {
    lines.push(ruPlural(stats.certified, "выдан", "выдано", "выдано") + " " + stats.certified + " " + ruPlural(stats.certified, "сертификат", "сертификата", "сертификатов"));
  }

  const summary = lines.length
    ? "Вчера, " + dateLabel + ": " + lines.join("; ") + "."
    : "Вчера, " + dateLabel + ", активности не зафиксировано.";

  return { date: start.toISOString().slice(0, 10), stats, summary };
}

module.exports = { buildDailyDigest, ruPlural, mskYesterdayWindow };
