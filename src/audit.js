const crypto = require("crypto");
const pool = require("./db");

/**
 * Записывает действие персонала в журнал (для комплаенса и возможного отката).
 * details.before — снимок состояния ДО изменения (если действие обратимо) — по нему
 * работает revert.js. Логирование никогда не бросает исключение наружу — оно не должно
 * ронять основной запрос.
 *
 * @param {boolean} revertible — можно ли для этого действия предложить «Откатить» в журнале
 */
async function logAction(actor, action, targetType, targetId, targetName, details, revertible) {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_name, actor_role, action, target_type, target_id, target_name, details, revertible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        crypto.randomUUID(),
        actor ? actor.id : null,
        actor ? actor.name : "система",
        actor ? actor.role : null,
        action,
        targetType || null,
        targetId || null,
        targetName || null,
        JSON.stringify(details || {}),
        !!revertible
      ]
    );
  } catch (e) {
    console.error("Не удалось записать в журнал действий:", e.message);
  }
}

module.exports = { logAction };
