// Глоссарий: проверка термина, который прислал куратор/админ, и поиск его
// упоминаний в тексте уроков (та же логика, что подсветка на фронтенде —
// public/app.js, glMatchers: целым словом, аббревиатуры — с учётом регистра).
const TONES = ["ok", "warn", "bad"];
const ICONS = ["check", "clipboard", "search", "calendar", "users", "doctor", "task", "star", "book", "eye", "chartbar", "bell"];

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const rows = (arr, n, max) => (Array.isArray(arr) ? arr : [])
  .map((r) => (Array.isArray(r) ? r : []).slice(0, n).map((x) => str(x, max)))
  .filter((r) => r.some((x) => x));

function validateTerm(b) {
  b = b || {};
  const title = str(b.title, 120);
  if (!title) return { error: "Укажите название термина" };
  const aliases = [...new Set((Array.isArray(b.aliases) ? b.aliases : String(b.aliases || "").split(/\n|,/))
    .map((a) => str(a, 80)).filter(Boolean))].slice(0, 20);
  if (!aliases.length) return { error: "Добавьте хотя бы одно написание — по нему термин ищется в тексте урока" };
  const src = b.body || {};
  const key = src.key && str(src.key.text, 300) ? {
    label: str(src.key.label, 60), text: str(src.key.text, 300),
    // пустое деление (добавили и не заполнили) не сохраняем — цвет по умолчанию не в счёт
    scale: rows(src.key.scale, 3, 120).filter((r) => r[0] || r[1]).slice(0, 5).map((r) => [r[0], r[1] || "", TONES.includes(r[2]) ? r[2] : "ok"])
  } : null;
  const meaning = src.meaning && (str(src.meaning.text, 1500) || rows(src.meaning.stats, 2, 120).length) ? {
    text: str(src.meaning.text, 1500), stats: rows(src.meaning.stats, 2, 120).slice(0, 4)
  } : null;
  const actions = rows(src.actions, 3, 200).filter((r) => r[1]).slice(0, 8).map((r) => [ICONS.includes(r[0]) ? r[0] : "check", r[1], r[2] || ""]);
  const more = rows(src.more, 2, 2000).filter((r) => r[0] && r[1]).slice(0, 10);
  return { value: {
    title, category: str(b.category, 60), lead: str(b.lead, 600), aliases,
    lessonId: b.lessonId ? String(b.lessonId) : null,
    body: { key, meaning, actions, more }
  } };
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matchers(aliases) {
  return (aliases || []).slice().sort((a, b) => b.length - a.length).map((a) => {
    const caps = a.length <= 5 && a === a.toUpperCase() && /[A-ZА-ЯЁ]/.test(a);
    return new RegExp("(^|[^A-Za-zА-Яа-яЁё0-9])(" + esc(a) + ")(?![A-Za-zА-Яа-яЁё0-9])", caps ? "" : "i");
  });
}
// lessons: [{ id, html }] → id уроков, где встречается хотя бы одно написание.
function lessonsWith(aliases, lessons) {
  const ms = matchers(aliases);
  return lessons.filter((l) => {
    const text = String(l.html || "").replace(/<[^>]+>/g, " ");
    return ms.some((re) => re.test(text));
  }).map((l) => l.id);
}

module.exports = { validateTerm, lessonsWith, TONES, ICONS };
