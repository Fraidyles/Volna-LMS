const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { authRequired, requireRole } = require("../middleware/auth");
const { logAction } = require("../audit");

const router = express.Router();

async function attachGuidesAndLessons(protocolRows) {
  if (!protocolRows.length) return [];
  const ids = protocolRows.map((p) => p.id);
  const guides = await pool.query(
    `SELECT pg.protocol_id, pg.specialization_id, s.name AS specialization_name, pg.guide_html
     FROM protocol_guides pg JOIN specializations s ON s.id = pg.specialization_id
     WHERE pg.protocol_id = ANY($1::text[]) ORDER BY s.name`,
    [ids]
  );
  const links = await pool.query(
    "SELECT protocol_id, lesson_id FROM lesson_protocols WHERE protocol_id = ANY($1::text[])",
    [ids]
  );
  const guidesByProtocol = {};
  guides.rows.forEach((g) => {
    if (!guidesByProtocol[g.protocol_id]) guidesByProtocol[g.protocol_id] = [];
    guidesByProtocol[g.protocol_id].push({
      specializationId: g.specialization_id, specializationName: g.specialization_name, guideHtml: g.guide_html
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

router.get("/", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
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

// Гайд применения протокола для конкретной специализации — своя версия текста
// на каждую специализацию (для кардиолога иначе, чем для дерматолога).
router.put("/:id/guides/:specializationId", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
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

router.delete("/:id/guides/:specializationId", authRequired, requireRole("admin", "super_admin"), async (req, res) => {
  const result = await pool.query(
    "DELETE FROM protocol_guides WHERE protocol_id=$1 AND specialization_id=$2 RETURNING id",
    [req.params.id, req.params.specializationId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "not_found" });
  await logAction(req.user, "protocol.guide_delete", "protocol", req.params.id, null, { specializationId: req.params.specializationId });
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
