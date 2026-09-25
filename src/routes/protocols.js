const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const contentDisposition = require("content-disposition");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "protocol-guides");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Разрешаем только «документные» форматы — вложение к гайду это памятка/чек-лист,
// а не произвольный файл; заодно исключает случайную загрузку исполняемых файлов.
// EXT_TO_MIME — единственный источник истины для Content-Type при отдаче файла:
// req.file.mimetype — это просто заголовок, который прислал сам загрузивший, ему
// нельзя доверять (curator мог бы прислать безобидное на вид "file.png", но с
// Content-Type: text/html и HTML/JS внутри — при отдаче с таким же заголовком
// браузер выполнил бы это как HTML в origin приложения). Раз расширение и так
// уже проверяется белым списком ниже, безопасный MIME для него можно просто
// взять из этой статичной таблицы, а не с чужих слов.
const EXT_TO_MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_TO_MIME));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error("unsupported_file_type"));
    }
    cb(null, true);
  }
});

function fileToJson(f, protocolId, specializationId) {
  return {
    id: f.id,
    originalName: f.original_name,
    mimeType: f.mime_type,
    sizeBytes: f.size_bytes,
    url: `/api/protocols/${protocolId}/guides/${specializationId}/files/${f.id}/download`
  };
}

async function attachGuidesAndLessons(protocolRows) {
  if (!protocolRows.length) return [];
  const ids = protocolRows.map((p) => p.id);
  const guides = await pool.query(
    `SELECT pg.id, pg.protocol_id, pg.specialization_id, s.name AS specialization_name, pg.guide_html
     FROM protocol_guides pg JOIN specializations s ON s.id = pg.specialization_id
     WHERE pg.protocol_id = ANY($1::text[]) ORDER BY s.name`,
    [ids]
  );
  const links = await pool.query(
    "SELECT protocol_id, lesson_id FROM lesson_protocols WHERE protocol_id = ANY($1::text[])",
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
      files: (filesByGuide[g.id] || []).map((f) => fileToJson(f, g.protocol_id, g.specialization_id))
    });
  });
  const lessonsByProtocol = {};
  links.rows.forEach((l) => {
    if (!lessonsByProtocol[l.protocol_id]) lessonsByProtocol[l.protocol_id] = [];
    lessonsByProtocol[l.protocol_id].push(l.lesson_id);
  });
  return protocolRows.map((p) => ({
    id: p.id, title: p.title, summary: p.summary, createdBy: p.created_by, createdAt: p.created_at,
    guides: guidesByProtocol[p.id] || [],
    lessonIds: lessonsByProtocol[p.id] || []
  }));
}

// Список и правка текста гайда — доступны и куратору, и админу: куратор наполняет
// специализации приложениями к урокам, не имея прав создавать/удалять сами протоколы.
router.get("/", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const rows = await pool.query("SELECT * FROM protocols ORDER BY created_at DESC");
  res.json({ protocols: await attachGuidesAndLessons(rows.rows) });
});

router.post("/", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title, summary } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название протокола" });
  }
  const id = crypto.randomUUID();
  const cleanSummary = (summary || "").trim();
  await pool.query(
    "INSERT INTO protocols (id, title, summary, created_by) VALUES ($1,$2,$3,$4)",
    [id, title.trim(), cleanSummary, req.user.name]
  );
  await logAction(req.user, "protocol.create", "protocol", id, title.trim(), {});
  res.json({ id, title: title.trim(), summary: cleanSummary });
});

router.put("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const { title, summary } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Укажите название протокола" });
  }
  const result = await pool.query(
    "UPDATE protocols SET title=$1, summary=$2 WHERE id=$3 RETURNING id",
    [title.trim(), (summary || "").trim(), req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "protocol.update", "protocol", req.params.id, title.trim(), {});
  res.json({ ok: true });
});

router.delete("/:id", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const before = await pool.query("SELECT title FROM protocols WHERE id=$1", [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM protocols WHERE id=$1", [req.params.id]);
  await logAction(req.user, "protocol.delete", "protocol", req.params.id, before.rows[0].title, {});
  res.json({ ok: true });
});

// Находит (или создаёт пустой) гайд под специализацию — общий шаг перед правкой
// текста и перед прикреплением файла, оба пути должны попадать в одну и ту же строку.
async function findOrCreateGuide(protocolId, specializationId) {
  const existing = await pool.query(
    "SELECT id FROM protocol_guides WHERE protocol_id=$1 AND specialization_id=$2",
    [protocolId, specializationId]
  );
  if (existing.rowCount) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO protocol_guides (id, protocol_id, specialization_id, guide_html) VALUES ($1,$2,$3,'')",
    [id, protocolId, specializationId]
  );
  return id;
}

// Гайд применения протокола для конкретной специализации — своя версия текста
// на каждую специализацию (для кардиолога иначе, чем для дерматолога).
router.put("/:id/guides/:specializationId", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const { guideHtml } = req.body || {};
  if (!guideHtml || !guideHtml.trim()) {
    return res.status(400).json({ error: "invalid_input", message: "Текст гайда не может быть пустым" });
  }
  const protocol = await pool.query("SELECT id FROM protocols WHERE id=$1", [req.params.id]);
  if (!protocol.rowCount) return res.status(404).json({ error: "not_found" });
  const spec = await pool.query("SELECT id FROM specializations WHERE id=$1", [req.params.specializationId]);
  if (!spec.rowCount) return res.status(404).json({ error: "not_found", message: "Неизвестная специализация" });

  // Поле ввода на фронтенде — обычная textarea (не WYSIWYG), поэтому текст здесь
  // именно ПЛОСКИЙ (не HTML): хранится как есть, а переносы строк/HTML-спецсимволы
  // безопасно превращаются в разметку уже на выводе (см. renderPlainToProse на фронтенде).
  const clean = guideHtml.trim();
  await pool.query(
    `INSERT INTO protocol_guides (id, protocol_id, specialization_id, guide_html) VALUES ($1,$2,$3,$4)
     ON CONFLICT (protocol_id, specialization_id) DO UPDATE SET guide_html=$4`,
    [crypto.randomUUID(), req.params.id, req.params.specializationId, clean]
  );
  await logAction(req.user, "protocol.guide_update", "protocol", req.params.id, null, { specializationId: req.params.specializationId });
  res.json({ ok: true, guideHtml: clean });
});

router.delete("/:id/guides/:specializationId", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const guide = await pool.query(
    "SELECT id FROM protocol_guides WHERE protocol_id=$1 AND specialization_id=$2",
    [req.params.id, req.params.specializationId]
  );
  if (!guide.rowCount) return res.status(404).json({ error: "not_found" });
  const files = await pool.query("SELECT filename FROM protocol_guide_files WHERE guide_id=$1", [guide.rows[0].id]);
  await pool.query("DELETE FROM protocol_guides WHERE id=$1", [guide.rows[0].id]);
  files.rows.forEach((f) => fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {}));
  await logAction(req.user, "protocol.guide_delete", "protocol", req.params.id, null, { specializationId: req.params.specializationId });
  res.json({ ok: true });
});

// Файлы-вложения к гайду специализации — памятки/чек-листы, которые куратор или
// админ прикладывают отдельно от самого текста (текст можно оставить пустым).
router.post(
  "/:id/guides/:specializationId/files",
  authRequired,
  requireRole("curator", "admin", "super_admin"),
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "file_too_large", message: "Файл больше 15 МБ" });
        }
        return res.status(400).json({ error: "upload_failed", message: err.message });
      }
      if (err) return res.status(400).json({ error: "unsupported_file_type", message: "Недопустимый формат файла" });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "invalid_input", message: "Файл не передан" });
    const protocol = await pool.query("SELECT id FROM protocols WHERE id=$1", [req.params.id]);
    const spec = await pool.query("SELECT id FROM specializations WHERE id=$1", [req.params.specializationId]);
    if (!protocol.rowCount || !spec.rowCount) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: "not_found" });
    }

    const guideId = await findOrCreateGuide(req.params.id, req.params.specializationId);
    const fileId = crypto.randomUUID();
    const safeMimeType = EXT_TO_MIME[path.extname(req.file.originalname).toLowerCase()] || "application/octet-stream";
    await pool.query(
      `INSERT INTO protocol_guide_files (id, guide_id, filename, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [fileId, guideId, req.file.filename, req.file.originalname, safeMimeType, req.file.size, req.user.name]
    );
    await logAction(req.user, "protocol.guide_file_add", "protocol", req.params.id, req.file.originalname, {
      specializationId: req.params.specializationId
    });
    res.json({
      ok: true,
      file: fileToJson(
        { id: fileId, original_name: req.file.originalname, mime_type: safeMimeType, size_bytes: req.file.size },
        req.params.id,
        req.params.specializationId
      )
    });
  }
);

// Ссылка на файл — одна и та же и для просмотра, и для скачивания: отдаём
// inline (не attachment), поэтому PDF/картинка открываются прямо во вкладке
// браузера, а сохранить их себе — штатная кнопка «Скачать» в его просмотрщике.
// Доступно любому вошедшему пользователю (как и сам текст гайда — вложение
// не фильтруется по специализации врача, см. GET /course/protocols).
router.get("/:id/guides/:specializationId/files/:fileId/download", authRequired, async (req, res) => {
  const result = await pool.query(
    `SELECT f.filename, f.original_name FROM protocol_guide_files f
     JOIN protocol_guides g ON g.id = f.guide_id
     WHERE f.id=$1 AND g.protocol_id=$2 AND g.specialization_id=$3`,
    [req.params.fileId, req.params.id, req.params.specializationId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  const f = result.rows[0];
  const filePath = path.join(UPLOAD_DIR, f.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not_found" });
  // Content-Type всегда пересчитываем сами по расширению (см. EXT_TO_MIME) — не
  // берём f.mime_type из базы, чтобы обезвредить и старые записи, если в них
  // успел сохраниться "сырой" заголовок ещё до этого фикса.
  res.setHeader("Content-Disposition", contentDisposition(f.original_name, { type: "inline" }));
  res.setHeader("Content-Type", EXT_TO_MIME[path.extname(f.filename).toLowerCase()] || "application/octet-stream");
  res.sendFile(filePath);
});

router.delete("/:id/guides/:specializationId/files/:fileId", authRequired, requireRole("curator", "admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT f.id, f.filename, f.original_name FROM protocol_guide_files f
     JOIN protocol_guides g ON g.id = f.guide_id
     WHERE f.id=$1 AND g.protocol_id=$2 AND g.specialization_id=$3`,
    [req.params.fileId, req.params.id, req.params.specializationId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM protocol_guide_files WHERE id=$1", [result.rows[0].id]);
  fs.unlink(path.join(UPLOAD_DIR, result.rows[0].filename), () => {});
  await logAction(req.user, "protocol.guide_file_delete", "protocol", req.params.id, result.rows[0].original_name, {
    specializationId: req.params.specializationId
  });
  res.json({ ok: true });
});

// Какие уроки разблокируют этот протокол — заменяем список целиком (тот же
// паттерн, что и у видимости материалов: фронтенд шлёт полный набор чекбоксов).
router.put("/:id/lessons", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const lessonIds = (req.body && req.body.lessonIds) || [];
  if (!Array.isArray(lessonIds)) return res.status(400).json({ error: "invalid_input" });
  const protocol = await pool.query("SELECT id FROM protocols WHERE id=$1", [req.params.id]);
  if (!protocol.rowCount) return res.status(404).json({ error: "not_found" });

  const valid = lessonIds.length
    ? await pool.query("SELECT id FROM lessons WHERE id = ANY($1::text[])", [lessonIds])
    : { rows: [] };
  const validIds = valid.rows.map((r) => r.id);

  await pool.query("DELETE FROM lesson_protocols WHERE protocol_id=$1", [req.params.id]);
  for (const lessonId of validIds) {
    await pool.query(
      "INSERT INTO lesson_protocols (lesson_id, protocol_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [lessonId, req.params.id]
    );
  }
  await logAction(req.user, "protocol.lessons_update", "protocol", req.params.id, null, { lessonIds: validIds });
  res.json({ ok: true, lessonIds: validIds });
});

module.exports = router;
