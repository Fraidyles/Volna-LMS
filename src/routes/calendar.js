const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

/* ---------- Потоки ---------- */

router.get("/streams", authRequired, async (req, res) => {
  const result = await pool.query("SELECT id, name, start_date, telegram_url, created_by, created_at FROM streams ORDER BY start_date NULLS LAST, created_at");
  res.json({ streams: result.rows });
});

router.post("/streams", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { name, startDate, telegramUrl } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "invalid_input", message: "Укажите название потока" });
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO streams (id, name, start_date, telegram_url, created_by) VALUES ($1,$2,$3,$4,$5)",
    [id, name.trim(), startDate || null, (telegramUrl && telegramUrl.trim()) || null, req.user.name]
  );
  await logAction(req.user, "stream.create", "stream", id, name.trim(), { startDate }, true);
  res.json({ ok: true, id });
});

// Ссылка на Telegram-группу потока часто заводится позже создания самого потока
// (группу ещё нужно создать в Telegram) — отдельная ручка, а не только при создании.
router.patch("/streams/:id", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { telegramUrl } = req.body || {};
  const before = await pool.query("SELECT name, telegram_url FROM streams WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const clean = (telegramUrl && telegramUrl.trim()) || null;
  await pool.query("UPDATE streams SET telegram_url=$1 WHERE id=$2", [clean, req.params.id]);
  await logAction(req.user, "stream.update_telegram", "stream", req.params.id, before.rows[0].name, {
    before: { telegramUrl: before.rows[0].telegram_url }
  });
  res.json({ ok: true, telegramUrl: clean });
});

router.delete("/streams/:id", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const s = await pool.query("SELECT name, start_date, telegram_url, created_by FROM streams WHERE id=$1", [req.params.id]);
  if (!s.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM streams WHERE id=$1", [req.params.id]);
  await logAction(req.user, "stream.delete", "stream", req.params.id, s.rows[0].name, {
    before: { name: s.rows[0].name, startDate: s.rows[0].start_date, telegramUrl: s.rows[0].telegram_url, createdBy: s.rows[0].created_by }
  }, true);
  res.json({ ok: true });
});

/* ---------- Прямые эфиры ---------- */

// Врач видит общие эфиры (без потока) и эфиры своего потока — не все подряд:
// раньше фильтр по потоку был только на фронтенде, а сам API отдавал join_url
// и остальные детали чужих потоковых эфиров любому авторизованному врачу.
// Персонал управляет календарём целиком, поэтому видит всё без ограничений.
router.get("/events", authRequired, async (req, res) => {
  const isStaff = req.user.role === "curator" || req.user.role === "admin" || req.user.role === "super_admin";
  let scopeClause = "";
  let params = [];
  if (!isStaff) {
    const me = await pool.query("SELECT stream_id FROM users WHERE id=$1", [req.user.id]);
    const mySid = me.rowCount ? me.rows[0].stream_id : null;
    scopeClause = "WHERE stream_id IS NULL OR stream_id = $1";
    params = [mySid];
  }
  const result = await pool.query(`
    SELECT id, title, to_char(event_date,'YYYY-MM-DD') AS event_date, event_time, duration_min, speaker,
           stream_id, join_url, description, created_by, recurrence_group_id, recurrence
    FROM events ${scopeClause} ORDER BY event_date, event_time
  `, params);
  res.json({ events: result.rows });
});

// Повтор: если recurrence === "weekly" и указана recurrenceUntil, создаётся серия
// событий раз в неделю (максимум 26 повторов — полгода — чтобы не наплодить лишнего по ошибке).
router.post("/events", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { title, date, time, duration, speaker, streamId, joinUrl, description, recurrence, recurrenceUntil } = req.body || {};
  if (!title || !date || !time) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните тему, дату и время" });
  }

  const durationMin = parseInt(duration, 10) || 60;
  const isWeekly = recurrence === "weekly" && recurrenceUntil;
  const groupId = isWeekly ? crypto.randomUUID() : null;

  const dates = [date];
  if (isWeekly) {
    let cursor = new Date(date + "T00:00:00Z");
    const until = new Date(recurrenceUntil + "T00:00:00Z");
    let guard = 0;
    while (guard < 26) {
      cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (cursor > until) break;
      dates.push(cursor.toISOString().slice(0, 10));
      guard++;
    }
  }

  const createdIds = [];
  for (const d of dates) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by, recurrence_group_id, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, title.trim(), d, time, durationMin, speaker || null, streamId || null, joinUrl || null, description || null, req.user.name, groupId, isWeekly ? "weekly" : null]
    );
    createdIds.push(id);
  }

  await logAction(req.user, "event.create", "event", createdIds[0], title.trim(), { count: createdIds.length, recurring: isWeekly, createdIds }, true);
  res.json({ ok: true, id: createdIds[0], created: createdIds.length });
});

// ?series=true — удалить всю серию повторов, а не только это событие
router.delete("/events/:id", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const ev = await pool.query(`
    SELECT id, title, to_char(event_date,'YYYY-MM-DD') AS event_date, event_time, duration_min, speaker,
           stream_id, join_url, description, created_by, recurrence_group_id, recurrence
    FROM events WHERE id=$1
  `, [req.params.id]);
  if (!ev.rowCount) return res.status(404).json({ error: "not_found" });
  const row = ev.rows[0];

  function snapshot(r) {
    return {
      id: r.id, title: r.title, eventDate: r.event_date, eventTime: r.event_time, durationMin: r.duration_min,
      speaker: r.speaker, streamId: r.stream_id, joinUrl: r.join_url, description: r.description,
      createdBy: r.created_by, recurrenceGroupId: r.recurrence_group_id, recurrence: r.recurrence
    };
  }

  if (req.query.series === "true" && row.recurrence_group_id) {
    const all = await pool.query(`
      SELECT id, title, to_char(event_date,'YYYY-MM-DD') AS event_date, event_time, duration_min, speaker,
             stream_id, join_url, description, created_by, recurrence_group_id, recurrence
      FROM events WHERE recurrence_group_id=$1
    `, [row.recurrence_group_id]);
    const snapshots = all.rows.map(snapshot);
    const result = await pool.query("DELETE FROM events WHERE recurrence_group_id=$1 RETURNING id", [row.recurrence_group_id]);
    await logAction(req.user, "event.delete_series", "event", req.params.id, row.title, { count: result.rowCount, before: snapshots }, true);
    return res.json({ ok: true, deleted: result.rowCount });
  }

  await pool.query("DELETE FROM events WHERE id=$1", [req.params.id]);
  await logAction(req.user, "event.delete", "event", req.params.id, row.title, { before: snapshot(row) }, true);
  res.json({ ok: true, deleted: 1 });
});

module.exports = router;
