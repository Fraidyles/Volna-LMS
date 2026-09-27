const crypto = require("crypto");
const pool = require("./db");

/**
 * Каждый обработчик получает (logRow) — строку из audit_log — и сам решает,
 * как вернуть состояние к тому, что было в details.before. Бросает Error с понятным
 * сообщением, если откат невозможен (например, данных недостаточно).
 */
function requireBefore(log) {
  if (!log.details || !log.details.before) {
    throw new Error("Недостаточно данных для отката (действие записано до включения этой возможности)");
  }
  return log.details.before;
}

const HANDLERS = {
  "access.set_expiry": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE progress SET access_expires_at=$1 WHERE user_id=$2", [b.accessExpiresAt, log.target_id]);
  },
  "access.extend": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE progress SET access_expires_at=$1 WHERE user_id=$2", [b.accessExpiresAt, log.target_id]);
  },
  "access.block": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE progress SET access_blocked=$1 WHERE user_id=$2", [b.accessBlocked, log.target_id]);
  },
  "access.unblock": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE progress SET access_blocked=$1 WHERE user_id=$2", [b.accessBlocked, log.target_id]);
  },
  "certificate.issue": async (log) => {
    const b = requireBefore(log);
    const courseId = log.details && log.details.courseId;
    if (!courseId) throw new Error("Недостаточно данных для отката (курс не записан в действии)");
    await pool.query(
      "UPDATE progress SET certificate_status=$1, certificate_issued_at=$2, certificate_issued_by=$3 WHERE user_id=$4 AND course_id=$5",
      [b.certificateStatus, b.certificateIssuedAt, b.certificateIssuedBy, log.target_id, courseId]
    );
  },
  "content.visibility_change": async (log) => {
    const b = requireBefore(log);
    // Для "quiz" (итоговый тест курса, без урока) курс не вывести ни из чего, кроме
    // записанного в самом действии details.courseId — см. PUT /course/visibility/:targetId.
    let courseId;
    if (log.target_id === "quiz") {
      courseId = log.details && log.details.courseId;
      if (!courseId) throw new Error("Недостаточно данных для отката (курс не записан в действии)");
    } else {
      const lesson = await pool.query("SELECT course_id FROM lessons WHERE id=$1", [log.target_id]);
      if (!lesson.rowCount) throw new Error("Урок не найден");
      courseId = lesson.rows[0].course_id;
    }
    const row = await pool.query("SELECT hidden_for FROM course_visibility WHERE course_id=$1", [courseId]);
    const map = row.rowCount ? row.rows[0].hidden_for : {};
    map[log.target_id] = b.ids || [];
    await pool.query(
      `INSERT INTO course_visibility (course_id, hidden_for) VALUES ($1,$2)
       ON CONFLICT (course_id) DO UPDATE SET hidden_for=$2`,
      [courseId, JSON.stringify(map)]
    );
  },
  "content.lesson_published": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE lessons SET title=$1, duration=$2, html=$3 WHERE id=$4", [b.title, b.duration, b.html, log.target_id]);
  },
  "content.lesson_restored": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE lessons SET title=$1, duration=$2, html=$3 WHERE id=$4", [b.title, b.duration, b.html, log.target_id]);
  },
  "content.quiz_edited": async (log) => {
    const b = requireBefore(log);
    await pool.query(
      "UPDATE quiz_questions SET question=$1, options=$2, correct=$3, qtype=$4, payload=$5 WHERE id=$6",
      [b.question, JSON.stringify(b.options), b.correct, b.qtype || "single", JSON.stringify(b.payload || {}), log.target_id]
    );
  },
  "staff.role_change": async (log) => {
    const b = requireBefore(log);
    await pool.query("UPDATE users SET role=$1 WHERE id=$2", [b.role, log.target_id]);
  },
  "student.profile_update": async (log) => {
    const b = requireBefore(log);
    await pool.query(
      "UPDATE users SET name=$1, phone=$2, workplace=$3 WHERE id=$4",
      [b.name, b.phone, b.workplace, log.target_id]
    );
    await pool.query("DELETE FROM user_specializations WHERE user_id=$1", [log.target_id]);
    for (const specId of b.specializationIds || []) {
      await pool.query(
        "INSERT INTO user_specializations (user_id, specialization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [log.target_id, specId]
      );
    }
  },
  "content.lesson_created": async (log) => {
    await pool.query("DELETE FROM lessons WHERE id=$1", [log.target_id]);
  },
  "content.lesson_deleted": async (log) => {
    const b = requireBefore(log);
    if (!b.courseId) throw new Error("Недостаточно данных для отката (курс не записан в действии)");
    await pool.query(
      "INSERT INTO lessons (id, course_id, idx, title, duration, html, drip_days, video_url, video_timecodes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [log.target_id, b.courseId, b.idx, b.title, b.duration, b.html, b.dripDays,
        b.videoUrl || null, JSON.stringify(b.videoTimecodes || [])]
    );
  },
  "content.quiz_created": async (log) => {
    await pool.query("DELETE FROM quiz_questions WHERE id=$1", [log.target_id]);
  },
  // Общий обработчик для итогового теста курса, поурочного И теста по модулю (см.
  // общий DELETE /quiz-admin/:id в routes/course.js) — details.before.lessonId/moduleId
  // различает, куда восстанавливать: без них вопрос молча "переехал" бы в итоговый тест курса.
  "content.quiz_deleted": async (log) => {
    const b = requireBefore(log);
    if (!b.courseId) throw new Error("Недостаточно данных для отката (курс не записан в действии)");
    await pool.query(
      "INSERT INTO quiz_questions (id, course_id, lesson_id, module_id, idx, question, options, correct, qtype, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [log.target_id, b.courseId, b.lessonId || null, b.moduleId || null, b.idx, b.question, JSON.stringify(b.options), b.correct,
        b.qtype || "single", JSON.stringify(b.payload || {})]
    );
  },
  "content.lesson_quiz_created": async (log) => {
    await pool.query("DELETE FROM quiz_questions WHERE id=$1", [log.target_id]);
  },
  "content.module_quiz_created": async (log) => {
    await pool.query("DELETE FROM quiz_questions WHERE id=$1", [log.target_id]);
  },
  "content.module_created": async (log) => {
    await pool.query("DELETE FROM modules WHERE id=$1", [log.target_id]);
  },
  "course.enroll": async (log) => {
    const courseId = log.details && log.details.courseId;
    if (!courseId) throw new Error("Недостаточно данных для отката (курс не записан в действии)");
    await pool.query("DELETE FROM progress WHERE user_id=$1 AND course_id=$2", [log.target_id, courseId]);
  },
  "invite.create": async (log) => {
    await pool.query("DELETE FROM invites WHERE email=$1", [log.target_id]);
  },
  "invite.cancel": async (log) => {
    const b = requireBefore(log);
    await pool.query(
      `INSERT INTO invites (email, role, invited_by) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET role=$2, invited_by=$3, invited_at=now()`,
      [log.target_id, b.role, b.invitedBy]
    );
  },
  "invite.bulk_create": async (log) => {
    const emails = (log.details && log.details.created) || [];
    if (emails.length) {
      await pool.query("DELETE FROM invites WHERE email = ANY($1::text[])", [emails]);
    }
  },
  "stream.create": async (log) => {
    await pool.query("DELETE FROM streams WHERE id=$1", [log.target_id]);
  },
  "stream.delete": async (log) => {
    const b = requireBefore(log);
    await pool.query(
      "INSERT INTO streams (id, name, start_date, created_by) VALUES ($1,$2,$3,$4)",
      [log.target_id, b.name, b.startDate, b.createdBy]
    );
  },
  "event.create": async (log) => {
    const ids = (log.details && log.details.createdIds) || [log.target_id];
    await pool.query("DELETE FROM events WHERE id = ANY($1::text[])", [ids]);
  },
  "event.delete": async (log) => {
    const b = requireBefore(log);
    await pool.query(
      `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by, recurrence_group_id, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [log.target_id, b.title, b.eventDate, b.eventTime, b.durationMin, b.speaker, b.streamId, b.joinUrl, b.description, b.createdBy, b.recurrenceGroupId, b.recurrence]
    );
  },
  "event.delete_series": async (log) => {
    const rows = (log.details && log.details.before) || [];
    for (const b of rows) {
      await pool.query(
        `INSERT INTO events (id, title, event_date, event_time, duration_min, speaker, stream_id, join_url, description, created_by, recurrence_group_id, recurrence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [b.id, b.title, b.eventDate, b.eventTime, b.durationMin, b.speaker, b.streamId, b.joinUrl, b.description, b.createdBy, b.recurrenceGroupId, b.recurrence]
      );
    }
  }
};

async function revertLogEntry(logRow) {
  if (logRow.reverted_at) throw new Error("Это действие уже было откачено ранее");
  if (!logRow.revertible) throw new Error("Это действие нельзя откатить автоматически");
  const handler = HANDLERS[logRow.action];
  if (!handler) throw new Error("Для этого типа действия откат не реализован");
  if (!logRow.details) logRow.details = {};
  await handler(logRow);
}

module.exports = { revertLogEntry, REVERTIBLE_ACTIONS: Object.keys(HANDLERS) };
