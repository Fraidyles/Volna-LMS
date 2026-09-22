const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { sanitizeLessonHtml } = require("../sanitize");
const { notify, notifyAllStudents } = require("../notifications");
const { requireStudentScope, filterToScope } = require("../access");
const { isChatMuted } = require("../chatMutes");

const router = express.Router();

function computeLocked(pr) {
  if (!pr) return { locked: false, reason: null };
  if (pr.access_blocked) return { locked: true, reason: "blocked" };
  if (pr.access_expires_at) {
    const today = new Date().toISOString().slice(0, 10);
    const exp = new Date(pr.access_expires_at).toISOString().slice(0, 10);
    if (exp < today) return { locked: true, reason: "expired" };
  }
  return { locked: false, reason: null };
}

// Дрип: урок открывается через drip_days дней после того, как ЭТОТ врач начал курс
// (progress.created_at), а не по общей календарной дате — у каждого свой отсчёт.
function computeDripLock(lesson, pr) {
  if (lesson.drip_days === null || lesson.drip_days === undefined) return { locked: false, availableAt: null };
  const availableAt = new Date(new Date(pr.created_at).getTime() + lesson.drip_days * 86400000);
  return { locked: new Date() < availableAt, availableAt: availableAt.toISOString() };
}

// Куратор мог вручную назначить дату открытия именно этому врачу — это переопределяет
// автоматический дрип полностью (а не комбинируется с ним), потому что куратор здесь
// явно вмешался в конкретный случай и знает лучше общего правила.
function computeLessonLock(lesson, pr, overrideUnlockAt) {
  if (overrideUnlockAt) {
    const at = new Date(overrideUnlockAt);
    return { locked: new Date() < at, availableAt: at.toISOString(), scheduled: true };
  }
  const drip = computeDripLock(lesson, pr);
  return Object.assign({ scheduled: false }, drip);
}

async function getHiddenForMap(courseId) {
  const row = await pool.query("SELECT hidden_for FROM course_visibility WHERE course_id=$1", [courseId]);
  return row.rowCount ? row.rows[0].hidden_for : {};
}

// Стрик считается по календарным дням (не по 24-часовым окнам): активность сегодня,
// если вчера тоже была активность — стрик растёт, если сегодня уже засчитан — не трогаем,
// иначе (пропуск дня и больше) начинаем заново с 1.
function nextStreak(pr) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const lastIso = pr.last_streak_date ? new Date(pr.last_streak_date).toISOString().slice(0, 10) : null;
  if (lastIso === todayIso) {
    return { currentStreak: pr.current_streak, longestStreak: pr.longest_streak, lastStreakDate: lastIso };
  }
  const yesterdayIso = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const currentStreak = lastIso === yesterdayIso ? pr.current_streak + 1 : 1;
  const longestStreak = Math.max(pr.longest_streak, currentStreak);
  return { currentStreak, longestStreak, lastStreakDate: todayIso };
}

// Очки считаются на лету из уже имеющихся данных прогресса, а не хранятся отдельно —
// это исключает рассинхронизацию между "истинным" прогрессом и накопленным счётом.
// Потолок в 1000 — не техническое ограничение, а бизнес-правило: 1000 очков
// обмениваются на скидку 25% на другое обучение в компании (см. renderMyProgressPage
// на фронтенде, там же и объяснение для врача). Без потолка стрик рос бы бесконечно
// (5 очков/день) и обесценивал бы "полную" отметку в 1000.
const MAX_POINTS = 1000;
function computePoints(pr) {
  const lessonsPoints = (pr.completed_lessons || []).length * 20;
  const quizPoints = pr.completed ? (pr.quiz_score || 0) : 0;
  const certPoints = pr.certificate_status === "issued" ? 100 : 0;
  const streakPoints = (pr.current_streak || 0) * 5;
  return Math.min(MAX_POINTS, lessonsPoints + quizPoints + certPoints + streakPoints);
}

// Курс с уроками (без правильных ответов теста) + текущий прогресс врача +
// какие блоки скрыты именно от него + заблокирован ли у него доступ.
// Курс определяется по progress.course_id ЭТОГО врача, а не "первым попавшимся" —
// важно уже сейчас, чтобы не превратиться в баг, когда курсов станет несколько.
router.get("/", authRequired, requireRole("student"), async (req, res) => {
  const progressRow = await pool.query("SELECT * FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const pr = progressRow.rows[0];

  // Открыл главную — значит точно "в сети"; дальше это поддерживает периодический
  // heartbeat с фронтенда, пока вкладка открыта (см. PUT /heartbeat и POST /offline ниже).
  pool.query("UPDATE progress SET last_seen_at=now(), is_online=true WHERE user_id=$1", [req.user.id]).catch(() => {});

  const course = await pool.query("SELECT id, title FROM courses WHERE id=$1", [pr.course_id]);
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const courseId = course.rows[0].id;

  const lessons = await pool.query(
    "SELECT id, idx, title, duration, html, drip_days FROM lessons WHERE course_id=$1 ORDER BY idx",
    [courseId]
  );
  const quiz = await pool.query(
    "SELECT id, idx, question, options FROM quiz_questions WHERE course_id=$1 ORDER BY idx",
    [courseId]
  );
  const hiddenFor = await getHiddenForMap(courseId);
  const overrides = await pool.query(
    "SELECT lesson_id, unlock_at FROM lesson_schedule_overrides WHERE student_id=$1",
    [req.user.id]
  );
  const overrideMap = {};
  overrides.rows.forEach((r) => { overrideMap[r.lesson_id] = r.unlock_at; });

  // Дополнительный (второй) слой санитизации прямо перед показом врачу — на случай,
  // если в базе оказался контент, сохранённый до включения санитайзера.
  const lessonsOut = lessons.rows.map((l) => {
    const drip = computeLessonLock(l, pr, overrideMap[l.id]);
    return {
      id: l.id, idx: l.idx, title: l.title, duration: l.duration, html: sanitizeLessonHtml(l.html),
      hiddenForMe: (hiddenFor[l.id] || []).indexOf(req.user.id) !== -1,
      dripLockedForMe: drip.locked,
      scheduledForMe: drip.scheduled,
      availableAt: drip.availableAt
    };
  });

  const unread = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM messages WHERE student_id=$1 AND from_role='curator' AND created_at > COALESCE($2::timestamptz, '-infinity')",
    [req.user.id, pr.messages_read_at]
  );
  const curatorChatMuted = await isChatMuted(req.user.id, "curator", req.user.id);
  const bookmarks = await pool.query("SELECT lesson_id FROM student_bookmarks WHERE user_id=$1", [req.user.id]);

  res.json({
    course: course.rows[0],
    lessons: lessonsOut,
    bookmarkedLessonIds: bookmarks.rows.map((r) => r.lesson_id),
    quiz: quiz.rows.map((q) => ({ id: q.id, question: q.question, options: q.options })),
    quizHiddenForMe: (hiddenFor.quiz || []).indexOf(req.user.id) !== -1,
    progress: pr,
    unreadMessages: curatorChatMuted ? 0 : unread.rows[0].cnt,
    curatorChatMuted: curatorChatMuted,
    locked: computeLocked(pr),
    gamification: {
      points: computePoints(pr),
      currentStreak: pr.current_streak,
      longestStreak: pr.longest_streak
    }
  });
});

router.post("/lesson-done", authRequired, requireRole("student"), async (req, res) => {
  const lessonId = req.body && req.body.lessonId;
  if (!lessonId) return res.status(400).json({ error: "invalid_input" });

  const progressRow = await pool.query("SELECT * FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const pr = progressRow.rows[0];

  const lock = computeLocked(pr);
  if (lock.locked) return res.status(403).json({ error: "access_locked", message: "Доступ к курсу ограничен" });

  // Урок обязательно должен принадлежать ИМЕННО курсу этого врача — иначе
  // (lessonRow.rowCount===0 для несуществующего/чужого id) проверка дрип-лока
  // ниже просто пропускалась бы, и любая произвольная строка в теле запроса
  // молча попадала бы в completed_lessons, раздувая счёт "N / total уроков"
  // и очки геймификации без реального прохождения урока.
  const lessonRow = await pool.query("SELECT drip_days FROM lessons WHERE id=$1 AND course_id=$2", [lessonId, pr.course_id]);
  if (!lessonRow.rowCount) return res.status(404).json({ error: "not_found", message: "Урок не найден в этом курсе" });

  const hiddenFor = await getHiddenForMap(pr.course_id);
  if ((hiddenFor[lessonId] || []).indexOf(req.user.id) !== -1) {
    return res.status(403).json({ error: "content_hidden", message: "Этот урок временно недоступен" });
  }

  const overrideRow = await pool.query(
    "SELECT unlock_at FROM lesson_schedule_overrides WHERE student_id=$1 AND lesson_id=$2",
    [req.user.id, lessonId]
  );
  const overrideUnlockAt = overrideRow.rowCount ? overrideRow.rows[0].unlock_at : null;
  if (computeLessonLock(lessonRow.rows[0], pr, overrideUnlockAt).locked) {
    return res.status(403).json({ error: "content_drip_locked", message: "Этот урок ещё не открылся" });
  }

  const list = pr.completed_lessons || [];
  if (!list.includes(lessonId)) list.push(lessonId);

  const streak = nextStreak(pr);
  await pool.query(
    `UPDATE progress SET completed_lessons=$1, last_active_at=now(),
     current_streak=$2, longest_streak=$3, last_streak_date=$4 WHERE user_id=$5`,
    [JSON.stringify(list), streak.currentStreak, streak.longestStreak, streak.lastStreakDate, req.user.id]
  );
  const points = computePoints({ ...pr, completed_lessons: list, current_streak: streak.currentStreak });
  res.json({ ok: true, completedLessons: list, gamification: { currentStreak: streak.currentStreak, longestStreak: streak.longestStreak, points } });
});

router.post("/quiz-submit", authRequired, requireRole("student"), async (req, res) => {
  const answers = (req.body && req.body.answers) || {};

  const progressRow = await pool.query("SELECT * FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const pr = progressRow.rows[0];

  const lock = computeLocked(pr);
  if (lock.locked) return res.status(403).json({ error: "access_locked", message: "Доступ к курсу ограничен" });

  const hiddenFor = await getHiddenForMap(pr.course_id);
  if ((hiddenFor.quiz || []).indexOf(req.user.id) !== -1) {
    return res.status(403).json({ error: "content_hidden", message: "Тест временно недоступен" });
  }

  const questions = await pool.query("SELECT id, correct FROM quiz_questions WHERE course_id=$1", [pr.course_id]);

  let correctCount = 0;
  questions.rows.forEach((q) => {
    if (answers[q.id] === q.correct) correctCount++;
  });
  const score = questions.rowCount ? Math.round((correctCount / questions.rowCount) * 100) : 0;
  const completed = score >= 60;
  const certificateStatus =
    completed && pr.certificate_status !== "issued" ? "pending" : pr.certificate_status;

  const streak = nextStreak(pr);
  await pool.query(
    `UPDATE progress SET quiz_answers=$1, quiz_score=$2, completed=$3, certificate_status=$4, last_active_at=now(),
     current_streak=$5, longest_streak=$6, last_streak_date=$7
     WHERE user_id=$8`,
    [JSON.stringify(answers), score, completed, certificateStatus,
      streak.currentStreak, streak.longestStreak, streak.lastStreakDate, req.user.id]
  );

  res.json({ score, completed, certificateStatus, gamification: { currentStreak: streak.currentStreak, longestStreak: streak.longestStreak } });
});

// Лёгкий пинг "я всё ещё здесь" — фронтенд дёргает это раз в 45с, пока у врача
// открыта любая вкладка приложения, независимо от того, что он там делает
// (читает материалы, пишет в чат — не обязательно проходит урок).
router.put("/heartbeat", authRequired, requireRole("student"), async (req, res) => {
  await pool.query("UPDATE progress SET last_seen_at=now(), is_online=true WHERE user_id=$1", [req.user.id]);
  res.json({ ok: true });
});

// Явный сигнал "закрыл вкладку" — как в Telegram/VK, статус "в сети" пропадает
// мгновенно, а не только когда истечёт тайм-аут хартбита. Шлётся через
// navigator.sendBeacon на pagehide (обычный fetch на выгрузке страницы браузер
// может просто оборвать, не отправив), поэтому тело запроса не читаем — важен
// сам факт запроса, а не его содержимое.
router.post("/offline", authRequired, requireRole("student"), async (req, res) => {
  await pool.query("UPDATE progress SET last_seen_at=now(), is_online=false WHERE user_id=$1", [req.user.id]);
  res.json({ ok: true });
});

// Врач сам закрывает карточку онбординг-чеклиста, не дожидаясь выполнения всех пунктов.
router.put("/onboarding-dismiss", authRequired, requireRole("student"), async (req, res) => {
  await pool.query("UPDATE progress SET onboarding_dismissed=true WHERE user_id=$1", [req.user.id]);
  res.json({ ok: true });
});

// «Мои материалы»: врач сохраняет урок к себе для быстрого доступа отдельно от
// последовательного прохождения курса — например, шпаргалку, к которой хочет
// вернуться позже, не пролистывая весь список уроков заново.
router.put("/lessons/:id/bookmark", authRequired, requireRole("student"), async (req, res) => {
  const bookmarked = !!(req.body && req.body.bookmarked);
  const lesson = await pool.query("SELECT id FROM lessons WHERE id=$1", [req.params.id]);
  if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });
  if (bookmarked) {
    await pool.query(
      "INSERT INTO student_bookmarks (user_id, lesson_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.user.id, req.params.id]
    );
  } else {
    await pool.query("DELETE FROM student_bookmarks WHERE user_id=$1 AND lesson_id=$2", [req.user.id, req.params.id]);
  }
  res.json({ ok: true, bookmarked });
});

// Личная заметка врача к уроку — видна только ему самому, хранится в progress.lesson_notes.
router.put("/lessons/:id/note", authRequired, requireRole("student"), async (req, res) => {
  const note = (req.body && typeof req.body.note === "string") ? req.body.note : "";
  const progressRow = await pool.query("SELECT lesson_notes FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const notes = progressRow.rows[0].lesson_notes || {};
  if (note.trim()) notes[req.params.id] = note.trim();
  else delete notes[req.params.id];
  await pool.query("UPDATE progress SET lesson_notes=$1 WHERE user_id=$2", [JSON.stringify(notes), req.user.id]);
  res.json({ ok: true });
});

router.post("/request-full-access", authRequired, requireRole("student"), async (req, res) => {
  await pool.query("UPDATE progress SET requested_full_access=true WHERE user_id=$1", [req.user.id]);
  res.json({ ok: true });
});

router.post(
  "/certificate/:studentId/issue",
  authRequired,
  requireRole("curator", "admin", "super_admin"),
  requireStudentScope("studentId"),
  async (req, res) => {
    const before = await pool.query(
      "SELECT certificate_status, certificate_issued_at, certificate_issued_by FROM progress WHERE user_id=$1",
      [req.params.studentId]
    );
    if (!before.rowCount) return res.status(404).json({ error: "not_found" });
    const result = await pool.query(
      `UPDATE progress SET certificate_status='issued', certificate_issued_at=now(), certificate_issued_by=$1
       WHERE user_id=$2 RETURNING user_id`,
      [req.user.name, req.params.studentId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "not_found" });
    const u = await pool.query("SELECT name FROM users WHERE id=$1", [req.params.studentId]);
    await logAction(req.user, "certificate.issue", "student", req.params.studentId, u.rows[0] && u.rows[0].name, {
      before: {
        certificateStatus: before.rows[0].certificate_status,
        certificateIssuedAt: before.rows[0].certificate_issued_at,
        certificateIssuedBy: before.rows[0].certificate_issued_by
      }
    }, true);
    await notify(req.params.studentId, "certificate_issued", "Сертификат готов", "Ваш сертификат о прохождении демо-курса выдан.");
    res.json({ ok: true });
  }
);

// Массовая выдача — тот же путь, что и у одиночной выдачи, просто в цикле по списку
// (каждая выдача логируется отдельной записью, чтобы откат остался точечным).
router.post("/certificate/bulk-issue", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.studentIds) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input" });
  const scopedIds = await filterToScope(req.user, ids);

  let issued = 0;
  for (const studentId of scopedIds) {
    const before = await pool.query(
      "SELECT certificate_status, certificate_issued_at, certificate_issued_by FROM progress WHERE user_id=$1",
      [studentId]
    );
    if (!before.rowCount) continue;
    const result = await pool.query(
      `UPDATE progress SET certificate_status='issued', certificate_issued_at=now(), certificate_issued_by=$1
       WHERE user_id=$2 RETURNING user_id`,
      [req.user.name, studentId]
    );
    if (!result.rowCount) continue;
    const u = await pool.query("SELECT name FROM users WHERE id=$1", [studentId]);
    await logAction(req.user, "certificate.issue", "student", studentId, u.rows[0] && u.rows[0].name, {
      before: {
        certificateStatus: before.rows[0].certificate_status,
        certificateIssuedAt: before.rows[0].certificate_issued_at,
        certificateIssuedBy: before.rows[0].certificate_issued_by
      }
    }, true);
    await notify(studentId, "certificate_issued", "Сертификат готов", "Ваш сертификат о прохождении демо-курса выдан.");
    issued++;
  }
  res.json({ ok: true, issued });
});

/* ---------- Видимость материалов по врачам ---------- */

router.get("/materials", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const course = await pool.query("SELECT id, title FROM courses LIMIT 1");
  if (!course.rowCount) return res.json({ lessons: [] });
  const lessons = await pool.query(
    "SELECT id, idx, title, has_draft, drip_days FROM lessons WHERE course_id=$1 ORDER BY idx",
    [course.rows[0].id]
  );
  res.json({ lessons: lessons.rows });
});

router.get("/visibility", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.json({ hiddenFor: {} });
  res.json({ hiddenFor: await getHiddenForMap(course.rows[0].id) });
});

router.put("/visibility/:targetId", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids)) return res.status(400).json({ error: "invalid_input" });

  // targetId — либо реальный id урока (тогда курс однозначно определяется по нему),
  // либо служебное значение "quiz" (тест общий на курс, урока нет) — тогда, как и
  // везде в остальном коде на один курс, берём единственный существующий курс.
  // Важно резолвить именно так, а не всегда через LIMIT 1: если курсов когда-нибудь
  // станет больше одного, LIMIT 1 без ORDER BY может вернуть не тот курс, которому
  // принадлежит urok, и видимость молча запишется не туда.
  let courseId;
  let targetTitle;
  if (req.params.targetId === "quiz") {
    const course = await pool.query("SELECT id FROM courses LIMIT 1");
    if (!course.rowCount) return res.status(404).json({ error: "no_course" });
    courseId = course.rows[0].id;
    targetTitle = "Итоговый тест";
  } else {
    const lesson = await pool.query("SELECT course_id, title FROM lessons WHERE id=$1", [req.params.targetId]);
    if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });
    courseId = lesson.rows[0].course_id;
    targetTitle = lesson.rows[0].title;
  }

  const map = await getHiddenForMap(courseId);
  const beforeIds = map[req.params.targetId] || [];
  map[req.params.targetId] = ids;

  await pool.query(
    `INSERT INTO course_visibility (course_id, hidden_for) VALUES ($1,$2)
     ON CONFLICT (course_id) DO UPDATE SET hidden_for=$2`,
    [courseId, JSON.stringify(map)]
  );
  await logAction(req.user, "content.visibility_change", "lesson", req.params.targetId, req.params.targetId,
    { hiddenCount: ids.length, before: { ids: beforeIds } }, true);

  // Уведомляем только тех, у кого материал именно ОТКРЫЛСЯ (был в скрытых, стал видимым) —
  // а не всех, кого затронуло изменение списка, иначе про каждое скрытие тоже прилетало бы уведомление.
  const justUnhidden = beforeIds.filter((id) => !ids.includes(id));
  for (const studentId of justUnhidden) {
    await notify(studentId, "content_unlocked", "Материал открыт", `Куратор снял ограничение доступа к материалу «${targetTitle}».`);
  }
  res.json({ ok: true });
});

/* ---------- Редактирование содержимого уроков: черновик → публикация, история версий (только администраторы) ---------- */

router.get("/lessons/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    "SELECT id, idx, title, duration, html, drip_days, draft_title, draft_duration, draft_html, has_draft FROM lessons WHERE id=$1",
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ lesson: result.rows[0] });
});

/* ---------- Конструктор курса: добавить/удалить/переставить урок (только администраторы) ---------- */

router.post("/lessons", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title, duration, html } = req.body || {};
  if (!title || !title.trim() || !html || !html.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните заголовок и содержимое урока" });
  }
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const courseId = course.rows[0].id;

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM lessons WHERE course_id=$1", [courseId]);
  const id = crypto.randomUUID();
  const clean = sanitizeLessonHtml(html);
  await pool.query(
    "INSERT INTO lessons (id, course_id, idx, title, duration, html) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, courseId, maxIdx.rows[0].m + 1, title.trim(), duration || "", clean]
  );
  await logAction(req.user, "content.lesson_created", "lesson", id, title.trim(), {}, true);
  await notifyAllStudents("new_lesson", "Новый урок", `Появился новый урок: «${title.trim()}».`);
  res.json({ ok: true, id });
});

router.delete("/lessons/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT * FROM lessons WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const l = before.rows[0];

  const count = await pool.query("SELECT COUNT(*)::int AS c FROM lessons WHERE course_id=$1", [l.course_id]);
  if (count.rows[0].c <= 1) {
    return res.status(400).json({ error: "last_lesson", message: "В курсе должен остаться хотя бы один урок" });
  }

  // Урок мог быть скрыт от кого-то персонально — снимаем эту запись, чтобы не копить мусор в JSON-карте.
  const hiddenMap = await getHiddenForMap(l.course_id);
  if (hiddenMap[l.id]) { delete hiddenMap[l.id]; await pool.query(
    "UPDATE course_visibility SET hidden_for=$1 WHERE course_id=$2", [JSON.stringify(hiddenMap), l.course_id]
  ); }

  await pool.query("DELETE FROM lessons WHERE id=$1", [req.params.id]);
  await logAction(req.user, "content.lesson_deleted", "lesson", l.id, l.title, {
    before: { idx: l.idx, title: l.title, duration: l.duration, html: l.html, dripDays: l.drip_days }
  }, true);
  res.json({ ok: true });
});

router.put("/lessons/reorder", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.orderedIds) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input" });
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const existing = await pool.query("SELECT id FROM lessons WHERE course_id=$1", [course.rows[0].id]);
  const existingIds = existing.rows.map((r) => r.id);
  if (ids.length !== existingIds.length || !existingIds.every((id) => ids.includes(id))) {
    return res.status(400).json({ error: "invalid_input", message: "Список должен содержать все уроки курса ровно один раз" });
  }
  for (let i = 0; i < ids.length; i++) {
    await pool.query("UPDATE lessons SET idx=$1 WHERE id=$2", [i, ids[i]]);
  }
  await logAction(req.user, "content.lessons_reordered", "course", course.rows[0].id, null, { order: ids });
  res.json({ ok: true });
});

// Дрип: через сколько дней после регистрации врача урок открывается сам (null — сразу).
router.put("/lessons/:id/drip", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const raw = req.body && req.body.dripDays;
  const dripDays = raw === null || raw === "" || raw === undefined ? null : parseInt(raw, 10);
  if (dripDays !== null && (isNaN(dripDays) || dripDays < 0)) {
    return res.status(400).json({ error: "invalid_input" });
  }
  const result = await pool.query("UPDATE lessons SET drip_days=$1 WHERE id=$2 RETURNING id", [dripDays, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, dripDays });
});

// Куратор назначает дату открытия урока конкретным врачам (или всем сразу в своём
// скоупе) — переопределяет автоматический дрип для них. studentIds:null означает
// "всем в скоупе актёра" (не буквально всем в базе — куратор не должен управлять
// чужими врачами даже через bulk-режим).
router.put("/lessons/:id/schedule", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const lessonId = req.params.id;
  const lesson = await pool.query("SELECT id FROM lessons WHERE id=$1", [lessonId]);
  if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });

  const unlockAt = req.body && req.body.unlockAt;
  let studentIds = req.body && req.body.studentIds;
  if (!Array.isArray(studentIds)) {
    const scopeClause = req.user.role === "curator" ? "AND (assigned_curator_id = $1 OR assigned_curator_id IS NULL)" : "";
    const scopeParams = req.user.role === "curator" ? [req.user.id] : [];
    const all = await pool.query(`SELECT id FROM users WHERE role='student' ${scopeClause}`, scopeParams);
    studentIds = all.rows.map((r) => r.id);
  } else {
    studentIds = await filterToScope(req.user, studentIds);
  }
  if (!studentIds.length) return res.json({ ok: true, updated: 0 });

  if (!unlockAt) {
    await pool.query(
      "DELETE FROM lesson_schedule_overrides WHERE lesson_id=$1 AND student_id = ANY($2::text[])",
      [lessonId, studentIds]
    );
    await logAction(req.user, "content.lesson_schedule_cleared", "lesson", lessonId, null, { studentIds });
    return res.json({ ok: true, updated: studentIds.length });
  }

  for (const studentId of studentIds) {
    await pool.query(
      `INSERT INTO lesson_schedule_overrides (id, student_id, lesson_id, unlock_at, set_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (student_id, lesson_id) DO UPDATE SET unlock_at=$4, set_by=$5`,
      [crypto.randomUUID(), studentId, lessonId, unlockAt, req.user.name]
    );
  }
  await logAction(req.user, "content.lesson_scheduled", "lesson", lessonId, null, { studentIds, unlockAt });
  res.json({ ok: true, updated: studentIds.length });
});

// Текущее расписание урока — по одному врачу на строку, чтобы куратор видел, кому
// когда откроется (и кто ещё идёт по обычному дрипу без переопределения).
router.get("/lessons/:id/schedule", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const scopeClause = req.user.role === "curator" ? "AND (u.assigned_curator_id = $1 OR u.assigned_curator_id IS NULL)" : "";
  const scopeParams = req.user.role === "curator" ? [req.user.id, req.params.id] : [req.params.id];
  const paramIdx = req.user.role === "curator" ? "$2" : "$1";
  const result = await pool.query(
    `SELECT u.id AS student_id, u.name, lso.unlock_at
     FROM users u LEFT JOIN lesson_schedule_overrides lso ON lso.student_id=u.id AND lso.lesson_id=${paramIdx}
     WHERE u.role='student' ${scopeClause}
     ORDER BY u.name`,
    scopeParams
  );
  res.json({ schedule: result.rows });
});

// Сохранить черновик — врачи его не видят, пока не будет опубликован
router.put("/lessons/:id/draft", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title, duration, html } = req.body || {};
  if (!title || !title.trim() || !html || !html.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните заголовок и содержимое урока" });
  }
  const clean = sanitizeLessonHtml(html);
  const result = await pool.query(
    "UPDATE lessons SET draft_title=$1, draft_duration=$2, draft_html=$3, has_draft=true WHERE id=$4 RETURNING id",
    [title.trim(), duration || "", clean, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "content.lesson_draft_saved", "lesson", req.params.id, title.trim(), {});
  res.json({ ok: true });
});

// Опубликовать черновик: текущая опубликованная версия сначала уходит в историю (можно откатить)
router.post("/lessons/:id/publish", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const current = await pool.query("SELECT * FROM lessons WHERE id=$1", [req.params.id]);
  if (!current.rowCount) return res.status(404).json({ error: "not_found" });
  const l = current.rows[0];
  if (!l.has_draft) return res.status(400).json({ error: "no_draft", message: "У этого урока нет несохранённого черновика" });

  await pool.query(
    "INSERT INTO lesson_history (id, lesson_id, title, duration, html, edited_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), l.id, l.title, l.duration, l.html, req.user.name]
  );
  await pool.query(
    `UPDATE lessons SET title=$1, duration=$2, html=$3, draft_title=NULL, draft_duration=NULL, draft_html=NULL, has_draft=false
     WHERE id=$4`,
    [l.draft_title, l.draft_duration, l.draft_html, l.id]
  );
  await logAction(req.user, "content.lesson_published", "lesson", l.id, l.draft_title,
    { before: { title: l.title, duration: l.duration, html: l.html } }, true);
  res.json({ ok: true });
});

router.get("/lessons/:id/history", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    "SELECT id, title, duration, edited_by, edited_at FROM lesson_history WHERE lesson_id=$1 ORDER BY edited_at DESC LIMIT 20",
    [req.params.id]
  );
  res.json({ history: result.rows });
});

// Восстановить прежнюю версию: текущая опубликованная версия перед этим тоже сохраняется в историю
router.post("/lessons/:id/restore/:historyId", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const histRow = await pool.query("SELECT * FROM lesson_history WHERE id=$1 AND lesson_id=$2", [req.params.historyId, req.params.id]);
  if (!histRow.rowCount) return res.status(404).json({ error: "not_found" });
  const h = histRow.rows[0];

  const current = await pool.query("SELECT * FROM lessons WHERE id=$1", [req.params.id]);
  if (!current.rowCount) return res.status(404).json({ error: "not_found" });
  const l = current.rows[0];

  await pool.query(
    "INSERT INTO lesson_history (id, lesson_id, title, duration, html, edited_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), l.id, l.title, l.duration, l.html, req.user.name]
  );
  await pool.query("UPDATE lessons SET title=$1, duration=$2, html=$3 WHERE id=$4", [h.title, h.duration, h.html, l.id]);
  await logAction(req.user, "content.lesson_restored", "lesson", l.id, h.title,
    { fromVersion: h.edited_at, before: { title: l.title, duration: l.duration, html: l.html } }, true);
  res.json({ ok: true });
});

// Полный список вопросов теста с правильными ответами — только для редактирования администратором
router.get("/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.json({ quiz: [] });
  const quiz = await pool.query(
    "SELECT id, idx, question, options, correct FROM quiz_questions WHERE course_id=$1 ORDER BY idx",
    [course.rows[0].id]
  );
  res.json({ quiz: quiz.rows });
});

// Роут reorder ДОЛЖЕН быть объявлен раньше "/quiz-admin/:id" — иначе Express матчит его
// первым попавшимся PUT "/quiz-admin/:id" (с id="reorder") и запрос никогда сюда не доходит.
router.put("/quiz-admin/reorder", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.orderedIds) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input" });
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const existing = await pool.query("SELECT id FROM quiz_questions WHERE course_id=$1", [course.rows[0].id]);
  const existingIds = existing.rows.map((r) => r.id);
  if (ids.length !== existingIds.length || !existingIds.every((id) => ids.includes(id))) {
    return res.status(400).json({ error: "invalid_input", message: "Список должен содержать все вопросы ровно один раз" });
  }
  for (let i = 0; i < ids.length; i++) {
    await pool.query("UPDATE quiz_questions SET idx=$1 WHERE id=$2", [i, ids[i]]);
  }
  await logAction(req.user, "content.quiz_reordered", "course", course.rows[0].id, null, { order: ids });
  res.json({ ok: true });
});

router.put("/quiz-admin/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { question, options, correct } = req.body || {};
  if (!question || !question.trim() || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните вопрос и минимум 2 варианта ответа" });
  }
  const correctIdx = parseInt(correct, 10);
  if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= options.length) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите корректный правильный вариант" });
  }
  const before = await pool.query("SELECT question, options, correct FROM quiz_questions WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const result = await pool.query(
    "UPDATE quiz_questions SET question=$1, options=$2, correct=$3 WHERE id=$4 RETURNING id",
    [question.trim(), JSON.stringify(options), correctIdx, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "content.quiz_edited", "quiz_question", req.params.id, question.trim(), {
    before: { question: before.rows[0].question, options: before.rows[0].options, correct: before.rows[0].correct }
  }, true);
  res.json({ ok: true });
});

router.post("/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { question, options, correct } = req.body || {};
  if (!question || !question.trim() || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните вопрос и минимум 2 варианта ответа" });
  }
  const correctIdx = parseInt(correct, 10);
  if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= options.length) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите корректный правильный вариант" });
  }
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const courseId = course.rows[0].id;

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM quiz_questions WHERE course_id=$1", [courseId]);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO quiz_questions (id, course_id, idx, question, options, correct) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, courseId, maxIdx.rows[0].m + 1, question.trim(), JSON.stringify(options), correctIdx]
  );
  await logAction(req.user, "content.quiz_created", "quiz_question", id, question.trim(), {}, true);
  res.json({ ok: true, id });
});

router.delete("/quiz-admin/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT * FROM quiz_questions WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const q = before.rows[0];

  const count = await pool.query("SELECT COUNT(*)::int AS c FROM quiz_questions WHERE course_id=$1", [q.course_id]);
  if (count.rows[0].c <= 1) {
    return res.status(400).json({ error: "last_question", message: "В тесте должен остаться хотя бы один вопрос" });
  }
  await pool.query("DELETE FROM quiz_questions WHERE id=$1", [req.params.id]);
  await logAction(req.user, "content.quiz_deleted", "quiz_question", q.id, q.question, {
    before: { idx: q.idx, question: q.question, options: q.options, correct: q.correct }
  }, true);
  res.json({ ok: true });
});

module.exports = router;
