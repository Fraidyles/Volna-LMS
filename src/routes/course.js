const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");
const { sanitizeLessonHtml } = require("../sanitize");
const { notify, notifyAllStudents } = require("../notifications");
const { requireStudentScope, filterToScope } = require("../access");
const { isChatMuted } = require("../chatMutes");

const router = express.Router();

const VIDEO_UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "lesson-videos");
fs.mkdirSync(VIDEO_UPLOAD_DIR, { recursive: true });
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIDEO_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!VIDEO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error("unsupported_file_type"));
    }
    cb(null, true);
  }
});

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
    "SELECT id, idx, title, duration, html, drip_days, video_url, video_timecodes, module_id FROM lessons WHERE course_id=$1 ORDER BY idx",
    [courseId]
  );
  const quiz = await pool.query(
    "SELECT id, idx, question, options FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL ORDER BY idx",
    [courseId]
  );
  // Поурочные тесты — без правильных ответов, сгруппированы по lesson_id, чтобы
  // фронтенду не пришлось делать отдельный запрос на каждый урок.
  const lessonQuizRows = await pool.query(
    "SELECT id, lesson_id, idx, question, options FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NOT NULL ORDER BY idx",
    [courseId]
  );
  const lessonQuizzes = {};
  lessonQuizRows.rows.forEach((q) => {
    if (!lessonQuizzes[q.lesson_id]) lessonQuizzes[q.lesson_id] = [];
    lessonQuizzes[q.lesson_id].push({ id: q.id, question: q.question, options: q.options });
  });
  // Тесты по модулям — та же идея, сгруппированы по module_id.
  const moduleQuizRows = await pool.query(
    "SELECT id, module_id, idx, question, options FROM quiz_questions WHERE course_id=$1 AND module_id IS NOT NULL ORDER BY idx",
    [courseId]
  );
  const moduleQuizzes = {};
  moduleQuizRows.rows.forEach((q) => {
    if (!moduleQuizzes[q.module_id]) moduleQuizzes[q.module_id] = [];
    moduleQuizzes[q.module_id].push({ id: q.id, question: q.question, options: q.options });
  });
  const modulesRows = await pool.query("SELECT id, idx, title FROM modules WHERE course_id=$1 ORDER BY idx", [courseId]);
  const moduleFeedbackGiven = await pool.query(
    `SELECT mf.module_id FROM module_feedback mf JOIN modules m ON m.id = mf.module_id
     WHERE mf.user_id=$1 AND m.course_id=$2`,
    [req.user.id, courseId]
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
      videoUrl: l.video_url, videoTimecodes: l.video_timecodes || [],
      quiz: lessonQuizzes[l.id] || [],
      moduleId: l.module_id,
      hiddenForMe: (hiddenFor[l.id] || []).indexOf(req.user.id) !== -1,
      dripLockedForMe: drip.locked,
      scheduledForMe: drip.scheduled,
      availableAt: drip.availableAt
    };
  });
  // Модуль с итоговым тестом (если у него вообще есть вопросы) и списком своих
  // уроков — фронтенд по нему решает, когда после урока показать гейт «тест + отзыв».
  const modulesOut = modulesRows.rows.map((m) => ({
    id: m.id, idx: m.idx, title: m.title,
    lessonIds: lessons.rows.filter((l) => l.module_id === m.id).map((l) => l.id),
    quiz: moduleQuizzes[m.id] || []
  }));

  const unread = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM messages WHERE student_id=$1 AND from_role='curator' AND created_at > COALESCE($2::timestamptz, '-infinity')",
    [req.user.id, pr.messages_read_at]
  );
  const curatorChatMuted = await isChatMuted(req.user.id, "curator", req.user.id);
  const bookmarks = await pool.query("SELECT lesson_id FROM student_bookmarks WHERE user_id=$1", [req.user.id]);

  res.json({
    course: course.rows[0],
    lessons: lessonsOut,
    modules: modulesOut,
    moduleFeedbackGiven: moduleFeedbackGiven.rows.map((r) => r.module_id),
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

  const questions = await pool.query("SELECT id, correct FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL", [pr.course_id]);

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

// «Ваши протоколы»: разблокируются по мере прохождения уроков (lesson_protocols),
// каждый урок может открыть несколько протоколов. Делим на «по вашей специализации»
// (есть гайд под основную специализацию ИЛИ любую из «хочу развиваться в...») и
// «дополнительные» — остальные протоколы из уже пройденных уроков, без фильтрации
// по релевантности (см. решение из обсуждения фичи — не прячем, а просто делим).
router.get("/protocols", authRequired, requireRole("student"), async (req, res) => {
  const progressRow = await pool.query("SELECT completed_lessons FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const completedLessons = progressRow.rows[0].completed_lessons || [];

  if (!completedLessons.length) return res.json({ forYou: [], additional: [] });

  const me = await pool.query("SELECT specialization_id FROM users WHERE id=$1", [req.user.id]);
  const interests = await pool.query(
    "SELECT specialization_id FROM user_specialization_interests WHERE user_id=$1", [req.user.id]
  );
  const relevantIds = new Set(interests.rows.map((r) => r.specialization_id));
  if (me.rows[0].specialization_id) relevantIds.add(me.rows[0].specialization_id);

  const protocolRows = await pool.query(
    `SELECT DISTINCT p.id, p.title, p.summary
     FROM protocols p JOIN lesson_protocols lp ON lp.protocol_id = p.id
     WHERE lp.lesson_id = ANY($1::text[])`,
    [completedLessons]
  );
  if (!protocolRows.rowCount) return res.json({ forYou: [], additional: [] });

  const ids = protocolRows.rows.map((p) => p.id);
  const guides = await pool.query(
    `SELECT pg.id, pg.protocol_id, pg.specialization_id, s.name AS specialization_name, pg.guide_html
     FROM protocol_guides pg JOIN specializations s ON s.id = pg.specialization_id
     WHERE pg.protocol_id = ANY($1::text[]) ORDER BY s.name`,
    [ids]
  );
  const guideIds = guides.rows.map((g) => g.id);
  const files = guideIds.length
    ? await pool.query(
        "SELECT * FROM protocol_guide_files WHERE guide_id = ANY($1::text[]) ORDER BY created_at",
        [guideIds]
      )
    : { rows: [] };
  const filesByGuide = {};
  files.rows.forEach((f) => {
    (filesByGuide[f.guide_id] = filesByGuide[f.guide_id] || []).push(f);
  });
  const guidesByProtocol = {};
  guides.rows.forEach((g) => {
    if (!guidesByProtocol[g.protocol_id]) guidesByProtocol[g.protocol_id] = [];
    guidesByProtocol[g.protocol_id].push({
      specializationId: g.specialization_id, specializationName: g.specialization_name, guideHtml: g.guide_html,
      files: (filesByGuide[g.id] || []).map((f) => ({
        id: f.id, originalName: f.original_name, mimeType: f.mime_type, sizeBytes: f.size_bytes,
        url: `/api/protocols/${g.protocol_id}/guides/${g.specialization_id}/files/${f.id}/download`
      }))
    });
  });

  const forYou = [];
  const additional = [];
  protocolRows.rows.forEach((p) => {
    const protoGuides = guidesByProtocol[p.id] || [];
    const out = { id: p.id, title: p.title, summary: p.summary, guides: protoGuides };
    const matches = protoGuides.some((g) => relevantIds.has(g.specializationId));
    (matches ? forYou : additional).push(out);
  });
  res.json({ forYou, additional });
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
    "SELECT id, idx, title, duration, html, drip_days, draft_title, draft_duration, draft_html, has_draft, video_url, video_timecodes, video_filename FROM lessons WHERE id=$1",
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
  // Загруженный файл видео удаляем с диска — если урок восстановят через откат,
  // видео придётся перезалить заново (тот же компромисс, что и с поурочным тестом ниже).
  if (l.video_filename) fs.unlink(path.join(VIDEO_UPLOAD_DIR, l.video_filename), () => {});
  // Поурочный тест урока (quiz_questions.lesson_id) при этом каскадно удаляется на
  // уровне БД и на восстановлении ниже не воскресает — это отдельно взятый компромисс
  // отката (best-effort), как и для других вложенных сущностей урока.
  await logAction(req.user, "content.lesson_deleted", "lesson", l.id, l.title, {
    before: {
      idx: l.idx, title: l.title, duration: l.duration, html: l.html, dripDays: l.drip_days,
      videoUrl: l.video_url, videoTimecodes: l.video_timecodes
    }
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
    "SELECT id, idx, question, options, correct FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL ORDER BY idx",
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
  const existing = await pool.query("SELECT id FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL", [course.rows[0].id]);
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

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL", [courseId]);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO quiz_questions (id, course_id, idx, question, options, correct) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, courseId, maxIdx.rows[0].m + 1, question.trim(), JSON.stringify(options), correctIdx]
  );
  await logAction(req.user, "content.quiz_created", "quiz_question", id, question.trim(), {}, true);
  res.json({ ok: true, id });
});

// Общий для итогового теста курса, поурочных тестов И тестов по модулям — удаляемый
// вопрос сам несёт признак (lesson_id/module_id), по нему и считаем "последний
// вопрос своей группы", а не всего курса.
router.delete("/quiz-admin/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT * FROM quiz_questions WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  const q = before.rows[0];

  const count = q.module_id
    ? await pool.query("SELECT COUNT(*)::int AS c FROM quiz_questions WHERE module_id=$1", [q.module_id])
    : q.lesson_id
    ? await pool.query("SELECT COUNT(*)::int AS c FROM quiz_questions WHERE lesson_id=$1", [q.lesson_id])
    : await pool.query("SELECT COUNT(*)::int AS c FROM quiz_questions WHERE course_id=$1 AND lesson_id IS NULL AND module_id IS NULL", [q.course_id]);
  if (count.rows[0].c <= 1) {
    return res.status(400).json({ error: "last_question", message: "Должен остаться хотя бы один вопрос" });
  }
  await pool.query("DELETE FROM quiz_questions WHERE id=$1", [req.params.id]);
  await logAction(req.user, "content.quiz_deleted", "quiz_question", q.id, q.question, {
    before: { idx: q.idx, question: q.question, options: q.options, correct: q.correct, lessonId: q.lesson_id, moduleId: q.module_id }
  }, true);
  res.json({ ok: true });
});

/* ---------- Поурочный «развлекательный» тест на запоминание материала ---------- */

// Полный список вопросов поурочного теста с правильными ответами — для админки.
router.get("/lessons/:id/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const lesson = await pool.query("SELECT id FROM lessons WHERE id=$1", [req.params.id]);
  if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });
  const quiz = await pool.query(
    "SELECT id, idx, question, options, correct FROM quiz_questions WHERE lesson_id=$1 ORDER BY idx",
    [req.params.id]
  );
  res.json({ quiz: quiz.rows });
});

router.post("/lessons/:id/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { question, options, correct } = req.body || {};
  if (!question || !question.trim() || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните вопрос и минимум 2 варианта ответа" });
  }
  const correctIdx = parseInt(correct, 10);
  if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= options.length) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите корректный правильный вариант" });
  }
  const lesson = await pool.query("SELECT id, course_id FROM lessons WHERE id=$1", [req.params.id]);
  if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM quiz_questions WHERE lesson_id=$1", [req.params.id]);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO quiz_questions (id, course_id, lesson_id, idx, question, options, correct) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, lesson.rows[0].course_id, req.params.id, maxIdx.rows[0].m + 1, question.trim(), JSON.stringify(options), correctIdx]
  );
  await logAction(req.user, "content.lesson_quiz_created", "quiz_question", id, question.trim(), { lessonId: req.params.id }, true);
  res.json({ ok: true, id });
});

// Тот же порядок деклараций, что и у /quiz-admin/reorder — "reorder" должен матчиться
// раньше общего PUT "/quiz-admin/:id" (для урочных вопросов это не нужно, свой префикс,
// но держим соглашение единообразным на будущее).
router.put("/lessons/:id/quiz-admin/reorder", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.orderedIds) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input" });
  const existing = await pool.query("SELECT id FROM quiz_questions WHERE lesson_id=$1", [req.params.id]);
  const existingIds = existing.rows.map((r) => r.id);
  if (ids.length !== existingIds.length || !existingIds.every((id) => ids.includes(id))) {
    return res.status(400).json({ error: "invalid_input", message: "Список должен содержать все вопросы ровно один раз" });
  }
  for (let i = 0; i < ids.length; i++) {
    await pool.query("UPDATE quiz_questions SET idx=$1 WHERE id=$2", [i, ids[i]]);
  }
  await logAction(req.user, "content.lesson_quiz_reordered", "lesson", req.params.id, null, { order: ids });
  res.json({ ok: true });
});

// Видео урока — url + главы с таймкодами. Отдельно от html (это остаётся
// "текстовым интро с картинками", как и было).
router.put("/lessons/:id/video", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { videoUrl, timecodes } = req.body || {};
  const list = Array.isArray(timecodes) ? timecodes : [];

  for (const tc of list) {
    if (typeof tc.time !== "number" || tc.time < 0 || !tc.title || !String(tc.title).trim()) {
      return res.status(400).json({ error: "invalid_input", message: "У каждой главы должны быть время (сек) и название" });
    }
  }
  // summary — из обычной textarea (не WYSIWYG), поэтому хранится как плоский текст,
  // а не HTML; переносы строк/спецсимволы безопасно превращаются в разметку на
  // выводе (см. renderPlainToProse на фронтенде), а не здесь при сохранении.
  const clean = list
    .map((tc) => ({
      id: tc.id || crypto.randomUUID(),
      time: Math.round(tc.time),
      title: String(tc.title).trim(),
      summary: String(tc.summary || "").trim()
    }))
    .sort((a, b) => a.time - b.time);

  const cleanUrl = videoUrl && videoUrl.trim() ? videoUrl.trim() : null;
  const before = await pool.query("SELECT video_url, video_filename FROM lessons WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  // Ссылка сменилась (или очищена) вручную — если раньше тут был загруженный файл,
  // это уже не он: убираем его с диска, иначе он бы остался висеть мусором навсегда.
  const urlChanged = before.rows[0].video_url !== cleanUrl;
  const keepFilename = !urlChanged && before.rows[0].video_filename;
  if (urlChanged && before.rows[0].video_filename) {
    fs.unlink(path.join(VIDEO_UPLOAD_DIR, before.rows[0].video_filename), () => {});
  }

  const result = await pool.query(
    "UPDATE lessons SET video_url=$1, video_timecodes=$2, video_filename=$3 WHERE id=$4 RETURNING id",
    [cleanUrl, JSON.stringify(clean), keepFilename || null, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "content.lesson_video_updated", "lesson", req.params.id, null, { chaptersCount: clean.length });
  res.json({ ok: true, videoUrl: cleanUrl, timecodes: clean });
});

// Загрузка видео файлом (вместо/вместе с ручной ссылкой) — файл ложится на диск
// приложения, а video_url становится ссылкой на свою же раздачу ниже. Заменяет
// прежний файл, если он был (не трогает video_timecodes — они относятся к самому
// уроку, а не к конкретному файлу).
router.post(
  "/lessons/:id/video-upload",
  authRequired,
  requireRole("admin", "super_admin"),
  (req, res, next) => {
    videoUpload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "file_too_large", message: "Файл больше 500 МБ" });
        }
        return res.status(400).json({ error: "upload_failed", message: err.message });
      }
      if (err) return res.status(400).json({ error: "unsupported_file_type", message: "Поддерживаются только .mp4, .webm, .mov, .m4v" });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "invalid_input", message: "Файл не передан" });
    const before = await pool.query("SELECT video_filename FROM lessons WHERE id=$1", [req.params.id]);
    if (!before.rowCount) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: "not_found" });
    }
    if (before.rows[0].video_filename) {
      fs.unlink(path.join(VIDEO_UPLOAD_DIR, before.rows[0].video_filename), () => {});
    }
    const videoUrl = `/api/course/lessons/${req.params.id}/video-file`;
    await pool.query("UPDATE lessons SET video_url=$1, video_filename=$2 WHERE id=$3", [videoUrl, req.file.filename, req.params.id]);
    await logAction(req.user, "content.lesson_video_updated", "lesson", req.params.id, null, { uploaded: true, originalName: req.file.originalname });
    res.json({ ok: true, videoUrl });
  }
);

// Отдача загруженного видео — доступна любому вошедшему (как и сам html урока,
// который уже сейчас уходит врачу независимо от блокировок, см. GET / выше).
// res.sendFile понимает заголовок Range сам — перемотка работает без доп. кода.
router.get("/lessons/:id/video-file", authRequired, async (req, res) => {
  const lesson = await pool.query("SELECT video_filename FROM lessons WHERE id=$1", [req.params.id]);
  if (!lesson.rowCount || !lesson.rows[0].video_filename) return res.status(404).json({ error: "not_found" });
  const filePath = path.join(VIDEO_UPLOAD_DIR, lesson.rows[0].video_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not_found" });
  res.sendFile(filePath);
});

// Поурочный тест — «развлекательный», не про допуск к сертификату: пройден урок,
// как только сдан этот тест (см. POST /lesson-done для уроков без теста вовсе).
// Атомарно объединяет подсчёт балла и пометку урока пройденным — иначе пришлось бы
// дважды дублировать логику стрика/очков между этим роутом и /lesson-done.
router.post("/lessons/:id/quiz-submit", authRequired, requireRole("student"), async (req, res) => {
  const answers = (req.body && req.body.answers) || {};
  const lessonId = req.params.id;

  const progressRow = await pool.query("SELECT * FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const pr = progressRow.rows[0];

  const lock = computeLocked(pr);
  if (lock.locked) return res.status(403).json({ error: "access_locked", message: "Доступ к курсу ограничен" });

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

  const questions = await pool.query("SELECT id, correct FROM quiz_questions WHERE lesson_id=$1", [lessonId]);
  if (!questions.rowCount) return res.status(404).json({ error: "no_quiz", message: "У этого урока нет теста" });

  let correctCount = 0;
  questions.rows.forEach((q) => { if (answers[q.id] === q.correct) correctCount++; });
  const score = Math.round((correctCount / questions.rowCount) * 100);

  const scores = pr.lesson_quiz_scores || {};
  scores[lessonId] = score;

  const list = pr.completed_lessons || [];
  if (!list.includes(lessonId)) list.push(lessonId);

  const streak = nextStreak(pr);
  await pool.query(
    `UPDATE progress SET lesson_quiz_scores=$1, completed_lessons=$2, last_active_at=now(),
     current_streak=$3, longest_streak=$4, last_streak_date=$5 WHERE user_id=$6`,
    [JSON.stringify(scores), JSON.stringify(list), streak.currentStreak, streak.longestStreak, streak.lastStreakDate, req.user.id]
  );
  const points = computePoints({ ...pr, completed_lessons: list, current_streak: streak.currentStreak });
  res.json({
    score, completedLessons: list,
    gamification: { currentStreak: streak.currentStreak, longestStreak: streak.longestStreak, points }
  });
});

/* ---------- Модули: группа уроков, после которой — итоговый тест по модулю и мини-опрос ---------- */

// Итоговый тест модуля — тот же принцип, что и поурочный (см. выше), но не
// привязан к конкретному уроку и не трогает completed_lessons: гейт после
// последнего урока модуля решает фронтенд сам, здесь только подсчёт балла.
router.post("/modules/:id/quiz-submit", authRequired, requireRole("student"), async (req, res) => {
  const answers = (req.body && req.body.answers) || {};

  const progressRow = await pool.query("SELECT * FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });
  const pr = progressRow.rows[0];

  const lock = computeLocked(pr);
  if (lock.locked) return res.status(403).json({ error: "access_locked", message: "Доступ к курсу ограничен" });

  const module = await pool.query("SELECT id FROM modules WHERE id=$1 AND course_id=$2", [req.params.id, pr.course_id]);
  if (!module.rowCount) return res.status(404).json({ error: "not_found" });

  const questions = await pool.query("SELECT id, correct FROM quiz_questions WHERE module_id=$1", [req.params.id]);
  if (!questions.rowCount) return res.status(404).json({ error: "no_quiz", message: "У этого модуля нет теста" });

  let correctCount = 0;
  questions.rows.forEach((q) => { if (answers[q.id] === q.correct) correctCount++; });
  const score = Math.round((correctCount / questions.rowCount) * 100);

  const scores = pr.module_quiz_scores || {};
  scores[req.params.id] = score;
  await pool.query(
    "UPDATE progress SET module_quiz_scores=$1, last_active_at=now() WHERE user_id=$2",
    [JSON.stringify(scores), req.user.id]
  );
  res.json({ ok: true, score });
});

// Мини-опрос по модулю — интерактивная оценка 1-5, комментарий по желанию.
// Повторное прохождение (ON CONFLICT) обновляет тот же отзыв, а не плодит новый —
// один врач высказывается по одному модулю один раз (последний ответ считается актуальным).
router.post("/modules/:id/feedback", authRequired, requireRole("student"), async (req, res) => {
  const { rating, comment } = req.body || {};
  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: "invalid_input", message: "Оценка должна быть от 1 до 5" });
  }
  const progressRow = await pool.query("SELECT course_id FROM progress WHERE user_id=$1", [req.user.id]);
  if (!progressRow.rowCount) return res.status(404).json({ error: "no_progress" });

  const module = await pool.query("SELECT id FROM modules WHERE id=$1 AND course_id=$2", [req.params.id, progressRow.rows[0].course_id]);
  if (!module.rowCount) return res.status(404).json({ error: "not_found" });

  const cleanComment = (comment || "").toString().trim() || null;
  await pool.query(
    `INSERT INTO module_feedback (id, module_id, user_id, rating, comment) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (module_id, user_id) DO UPDATE SET rating=$4, comment=$5, created_at=now()`,
    [crypto.randomUUID(), req.params.id, req.user.id, ratingNum, cleanComment]
  );
  res.json({ ok: true });
});

/* ---------- Модули: администрирование (только admin/super_admin) ---------- */

router.get("/modules", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.json({ modules: [], unassignedLessons: [] });
  const courseId = course.rows[0].id;

  const modules = await pool.query("SELECT id, idx, title FROM modules WHERE course_id=$1 ORDER BY idx", [courseId]);
  const lessons = await pool.query("SELECT id, idx, title, module_id FROM lessons WHERE course_id=$1 ORDER BY idx", [courseId]);
  const quizCounts = await pool.query(
    "SELECT module_id, COUNT(*)::int AS c FROM quiz_questions WHERE module_id IS NOT NULL AND course_id=$1 GROUP BY module_id",
    [courseId]
  );
  const feedbackStats = await pool.query(
    `SELECT mf.module_id, COUNT(*)::int AS c, AVG(mf.rating)::float AS avg
     FROM module_feedback mf JOIN modules m ON m.id = mf.module_id
     WHERE m.course_id=$1 GROUP BY mf.module_id`,
    [courseId]
  );
  const quizCountMap = {};
  quizCounts.rows.forEach((r) => { quizCountMap[r.module_id] = r.c; });
  const feedbackMap = {};
  feedbackStats.rows.forEach((r) => { feedbackMap[r.module_id] = { count: r.c, average: r.avg }; });

  res.json({
    modules: modules.rows.map((m) => ({
      id: m.id, idx: m.idx, title: m.title,
      lessonIds: lessons.rows.filter((l) => l.module_id === m.id).map((l) => l.id),
      quizCount: quizCountMap[m.id] || 0,
      feedback: feedbackMap[m.id] || { count: 0, average: null }
    })),
    allLessons: lessons.rows.map((l) => ({ id: l.id, title: l.title, moduleId: l.module_id }))
  });
});

router.post("/modules", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "invalid_input", message: "Укажите название модуля" });
  const course = await pool.query("SELECT id FROM courses LIMIT 1");
  if (!course.rowCount) return res.status(404).json({ error: "no_course" });
  const courseId = course.rows[0].id;

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM modules WHERE course_id=$1", [courseId]);
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO modules (id, course_id, idx, title) VALUES ($1,$2,$3,$4)", [id, courseId, maxIdx.rows[0].m + 1, title.trim()]);
  await logAction(req.user, "content.module_created", "module", id, title.trim(), {}, true);
  res.json({ ok: true, id, title: title.trim() });
});

router.put("/modules/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "invalid_input", message: "Укажите название модуля" });
  const before = await pool.query("SELECT title FROM modules WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("UPDATE modules SET title=$1 WHERE id=$2", [title.trim(), req.params.id]);
  await logAction(req.user, "content.module_updated", "module", req.params.id, title.trim(), { before: { title: before.rows[0].title } });
  res.json({ ok: true });
});

router.delete("/modules/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT title FROM modules WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  // Уроки модуля НЕ удаляются — просто отвязываются (lessons.module_id ON DELETE SET NULL),
  // тест модуля и отзывы уходят каскадом (FK ON DELETE CASCADE у соответствующих таблиц).
  await pool.query("DELETE FROM modules WHERE id=$1", [req.params.id]);
  await logAction(req.user, "content.module_deleted", "module", req.params.id, before.rows[0].title, {});
  res.json({ ok: true });
});

// Привязка/отвязка урока к модулю — moduleId:null убирает урок из любого модуля.
router.put("/lessons/:id/module", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const moduleId = (req.body && req.body.moduleId) || null;
  const lesson = await pool.query("SELECT id, course_id FROM lessons WHERE id=$1", [req.params.id]);
  if (!lesson.rowCount) return res.status(404).json({ error: "not_found" });
  if (moduleId) {
    const module = await pool.query("SELECT id FROM modules WHERE id=$1 AND course_id=$2", [moduleId, lesson.rows[0].course_id]);
    if (!module.rowCount) return res.status(404).json({ error: "not_found", message: "Модуль не найден" });
  }
  await pool.query("UPDATE lessons SET module_id=$1 WHERE id=$2", [moduleId, req.params.id]);
  await logAction(req.user, "content.lesson_module_assigned", "lesson", req.params.id, null, { moduleId });
  res.json({ ok: true, moduleId });
});

/* ---------- Итоговый тест модуля: администрирование ---------- */

router.get("/modules/:id/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const module = await pool.query("SELECT id FROM modules WHERE id=$1", [req.params.id]);
  if (!module.rowCount) return res.status(404).json({ error: "not_found" });
  const quiz = await pool.query(
    "SELECT id, idx, question, options, correct FROM quiz_questions WHERE module_id=$1 ORDER BY idx",
    [req.params.id]
  );
  res.json({ quiz: quiz.rows });
});

router.post("/modules/:id/quiz-admin", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { question, options, correct } = req.body || {};
  if (!question || !question.trim() || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "invalid_input", message: "Заполните вопрос и минимум 2 варианта ответа" });
  }
  const correctIdx = parseInt(correct, 10);
  if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= options.length) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите корректный правильный вариант" });
  }
  const module = await pool.query("SELECT id, course_id FROM modules WHERE id=$1", [req.params.id]);
  if (!module.rowCount) return res.status(404).json({ error: "not_found" });

  const maxIdx = await pool.query("SELECT COALESCE(MAX(idx), -1) AS m FROM quiz_questions WHERE module_id=$1", [req.params.id]);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO quiz_questions (id, course_id, module_id, idx, question, options, correct) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, module.rows[0].course_id, req.params.id, maxIdx.rows[0].m + 1, question.trim(), JSON.stringify(options), correctIdx]
  );
  await logAction(req.user, "content.module_quiz_created", "quiz_question", id, question.trim(), { moduleId: req.params.id }, true);
  res.json({ ok: true, id });
});

router.put("/modules/:id/quiz-admin/reorder", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const ids = (req.body && req.body.orderedIds) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "invalid_input" });
  const existing = await pool.query("SELECT id FROM quiz_questions WHERE module_id=$1", [req.params.id]);
  const existingIds = existing.rows.map((r) => r.id);
  if (ids.length !== existingIds.length || !existingIds.every((id) => ids.includes(id))) {
    return res.status(400).json({ error: "invalid_input", message: "Список должен содержать все вопросы ровно один раз" });
  }
  for (let i = 0; i < ids.length; i++) {
    await pool.query("UPDATE quiz_questions SET idx=$1 WHERE id=$2", [i, ids[i]]);
  }
  await logAction(req.user, "content.module_quiz_reordered", "module", req.params.id, null, { order: ids });
  res.json({ ok: true });
});

// Отзывы по модулю — читает только admin/super_admin (та же зона, что и остальной
// конструктор курса): список с именами врачей + средняя оценка.
router.get("/modules/:id/feedback", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const module = await pool.query("SELECT id FROM modules WHERE id=$1", [req.params.id]);
  if (!module.rowCount) return res.status(404).json({ error: "not_found" });
  const rows = await pool.query(
    `SELECT mf.rating, mf.comment, mf.created_at, u.name AS user_name
     FROM module_feedback mf JOIN users u ON u.id = mf.user_id
     WHERE mf.module_id=$1 ORDER BY mf.created_at DESC`,
    [req.params.id]
  );
  const average = rows.rowCount ? rows.rows.reduce((s, r) => s + r.rating, 0) / rows.rowCount : null;
  res.json({
    feedback: rows.rows.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: r.created_at, userName: r.user_name })),
    average, count: rows.rowCount
  });
});

module.exports = router;
