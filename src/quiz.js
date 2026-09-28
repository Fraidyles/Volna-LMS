// Типы вопросов тестов (итоговый тест курса, тест урока, тест модуля) — всё, что
// зависит от типа, собрано здесь: проверка ввода куратора, «безопасный» вид для
// врача (без правильных ответов) и подсчёт балла.
//
//   single — один верный вариант (options + correct), как было с самого начала;
//   multi  — несколько верных (payload.correct — индексы), частичный балл;
//   order  — расставить по порядку (options — шаги в верном порядке);
//   number — число с допуском (payload.min/max, unit);
//   match  — сопоставление (options — левая колонка, payload.right — пары к ним);
//   case   — клинический случай: payload.scenario + шаги payload.steps
//            (каждый шаг — single / multi / number), балл — среднее по шагам.
//
// Порядок шагов и правую колонку сопоставления врач получает перемешанными и
// с непрозрачными метками (token), а не индексами: иначе верный ответ читался бы
// прямо из данных страницы.
const crypto = require("crypto");

const TYPES = ["single", "multi", "order", "number", "match", "case"];
const STEP_TYPES = ["single", "multi", "number"];

function token(qid, i) {
  return crypto.createHash("sha1").update(String(qid) + ":" + i).digest("hex").slice(0, 10);
}

// Детерминированное перемешивание (одно и то же при каждой загрузке страницы) и
// никогда не совпадающее с верным порядком — иначе вопрос «на порядок» решён сам собой.
function shuffledIdx(qid, n, salt) {
  const idx = Array.from({ length: n }, (_, i) => i);
  let seed = parseInt(crypto.createHash("sha1").update(String(qid) + (salt || "")).digest("hex").slice(0, 8), 16) || 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  if (n > 1 && idx.every((v, i) => v === i)) idx.push(idx.shift());
  return idx;
}

function parseNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(",", ".").replace(/\s+/g, ""));
  return Number.isFinite(n) ? n : null;
}

const cleanList = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x == null ? "" : x).trim()) : []);

/* ---------- Проверка того, что прислал куратор ---------- */

function validateStep(s, n) {
  const where = "Шаг " + n + ": ";
  const type = STEP_TYPES.includes(s && s.type) ? s.type : "single";
  const question = String((s && s.question) || "").trim();
  if (!question) return { error: where + "заполните вопрос" };
  if (type === "number") {
    const r = numberRange(s);
    if (r.error) return { error: where + r.error };
    return { step: Object.assign({ type, question }, r.value) };
  }
  const options = cleanList(s.options);
  if (options.length < 2 || options.some((o) => !o)) return { error: where + "минимум 2 заполненных варианта" };
  if (type === "single") {
    const c = parseInt(s.correct, 10);
    if (!(c >= 0 && c < options.length)) return { error: where + "отметьте верный вариант" };
    return { step: { type, question, options, correct: c } };
  }
  const cs = [...new Set((Array.isArray(s.correct) ? s.correct : []).map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x < options.length))].sort((a, b) => a - b);
  if (!cs.length) return { error: where + "отметьте хотя бы один верный вариант" };
  return { step: { type, question, options, correct: cs } };
}

function numberRange(b) {
  const answer = parseNum(b.answer);
  if (answer === null) return { error: "укажите правильное число" };
  const tol = b.tolerance === "" || b.tolerance == null ? 0 : parseNum(b.tolerance);
  if (tol === null || tol < 0) return { error: "допуск должен быть числом не меньше 0" };
  const unit = String(b.unit || "").trim().slice(0, 30);
  // Округление убирает хвосты двоичной арифметики (66,7 − 0,1 = 66,6000000000001),
  // которые иначе видны врачу в разборе: «засчитывается 66,6–66,8».
  const r9 = (x) => Math.round(x * 1e9) / 1e9;
  return { value: { answer, tolerance: tol, min: r9(answer - tol), max: r9(answer + tol), unit } };
}

// Возвращает поля для INSERT/UPDATE: { qtype, question, options, correct, payload }.
function validateQuestion(body) {
  body = body || {};
  const qtype = TYPES.includes(body.type) ? body.type : "single";
  const question = String(body.question || "").trim();
  if (!question) return { error: "Заполните текст вопроса" };
  const options = cleanList(body.options);
  const out = { qtype, question, options, correct: 0, payload: {} };

  if (qtype === "single") {
    if (options.length < 2 || options.some((o) => !o)) return { error: "Заполните вопрос и минимум 2 варианта ответа" };
    const c = parseInt(body.correct, 10);
    if (isNaN(c) || c < 0 || c >= options.length) return { error: "Укажите корректный правильный вариант" };
    out.correct = c;
  } else if (qtype === "multi") {
    if (options.length < 2 || options.some((o) => !o)) return { error: "Заполните минимум 2 варианта ответа" };
    const cs = [...new Set((Array.isArray(body.correct) ? body.correct : []).map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x < options.length))].sort((a, b) => a - b);
    if (!cs.length) return { error: "Отметьте хотя бы один верный вариант" };
    out.correct = cs[0]; out.payload = { correct: cs };
  } else if (qtype === "order") {
    if (options.length < 3 || options.some((o) => !o)) return { error: "Для порядка нужно минимум 3 заполненных шага" };
  } else if (qtype === "number") {
    const r = numberRange(body);
    if (r.error) return { error: r.error.charAt(0).toUpperCase() + r.error.slice(1) };
    out.options = []; out.payload = r.value;
  } else if (qtype === "match") {
    const right = cleanList(body.right);
    if (options.length < 2 || options.length !== right.length || options.some((o) => !o) || right.some((o) => !o)) {
      return { error: "Заполните минимум 2 пары целиком" };
    }
    if (new Set(right).size !== right.length) return { error: "Варианты в правой колонке не должны повторяться" };
    out.payload = { right };
  } else if (qtype === "case") {
    const scenario = String(body.scenario || "").trim();
    if (!scenario) return { error: "Опишите клинический случай" };
    const rawSteps = Array.isArray(body.steps) ? body.steps : [];
    if (rawSteps.length < 1) return { error: "Добавьте хотя бы один шаг" };
    const steps = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const v = validateStep(rawSteps[i], i + 1);
      if (v.error) return { error: v.error };
      steps.push(v.step);
    }
    out.options = []; out.payload = { scenario, steps };
  }
  return out;
}

/* ---------- Что видит врач (без правильных ответов) ---------- */

function publicStep(s) {
  if (s.type === "number") return { type: "number", question: s.question, unit: s.unit || "" };
  return { type: s.type, question: s.question, options: s.options };
}

function publicQuestion(row) {
  const type = row.qtype || "single";
  const p = row.payload || {};
  const base = { id: row.id, type, question: row.question };
  if (type === "single" || type === "multi") return Object.assign(base, { options: row.options });
  if (type === "order") {
    return Object.assign(base, { items: shuffledIdx(row.id, row.options.length).map((i) => ({ token: token(row.id, i), text: row.options[i] })) });
  }
  if (type === "number") return Object.assign(base, { unit: p.unit || "" });
  if (type === "match") {
    return Object.assign(base, {
      left: row.options,
      right: shuffledIdx(row.id, (p.right || []).length, "r").map((i) => ({ token: token(row.id, "r" + i), text: p.right[i] }))
    });
  }
  if (type === "case") return Object.assign(base, { scenario: p.scenario || "", steps: (p.steps || []).map(publicStep) });
  return Object.assign(base, { options: row.options });
}

/* ---------- Подсчёт балла ---------- */

function gradeChoice(type, options, correct, answer) {
  if (type === "single") {
    const chosen = Number.isInteger(answer) ? answer : null;
    return { score: chosen === correct ? 1 : 0, chosen, correct };
  }
  const cs = Array.isArray(correct) ? correct : [];
  const chosen = [...new Set((Array.isArray(answer) ? answer : []).filter((x) => Number.isInteger(x) && x >= 0 && x < options.length))].sort((a, b) => a - b);
  const hits = chosen.filter((x) => cs.includes(x)).length, wrong = chosen.length - hits;
  return { score: cs.length ? Math.max(0, (hits - wrong) / cs.length) : 0, chosen, correct: cs };
}

function gradeNumber(range, answer) {
  const chosen = parseNum(answer);
  const ok = chosen !== null && chosen >= range.min - 1e-9 && chosen <= range.max + 1e-9;
  return { score: ok ? 1 : 0, chosen, correct: { answer: range.answer, min: range.min, max: range.max, unit: range.unit || "" } };
}

// Возвращает { score: 0..1, chosen, correct } — chosen/correct в том же виде, что
// и данные вопроса у врача (индексы / метки), чтобы разбор можно было показать.
function gradeQuestion(row, answer) {
  const type = row.qtype || "single";
  const p = row.payload || {};
  if (type === "single") return gradeChoice("single", row.options, row.correct, answer);
  if (type === "multi") return gradeChoice("multi", row.options, p.correct || [], answer);
  if (type === "number") return gradeNumber(p, answer);
  if (type === "order") {
    const correct = row.options.map((_, i) => token(row.id, i));
    const chosen = Array.isArray(answer) ? answer.map(String) : [];
    const right = correct.filter((t, i) => chosen[i] === t).length;
    return { score: correct.length ? right / correct.length : 0, chosen, correct };
  }
  if (type === "match") {
    const correct = {};
    (p.right || []).forEach((_, i) => { correct[i] = token(row.id, "r" + i); });
    const chosen = {};
    if (answer && typeof answer === "object" && !Array.isArray(answer)) Object.keys(answer).forEach((k) => { chosen[k] = String(answer[k]); });
    const n = row.options.length;
    const right = Object.keys(correct).filter((k) => chosen[k] === correct[k]).length;
    return { score: n ? right / n : 0, chosen, correct };
  }
  if (type === "case") {
    const steps = p.steps || [];
    const ans = Array.isArray(answer) ? answer : [];
    const results = steps.map((s, i) => (s.type === "number" ? gradeNumber(s, ans[i]) : gradeChoice(s.type, s.options, s.correct, ans[i])));
    const score = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
    return { score, steps: results };
  }
  return gradeChoice("single", row.options, row.correct, answer);
}

// Общий подсчёт по набору вопросов: итоговый процент, число полностью верных и
// разбор по каждому вопросу.
function gradeAll(rows, answers) {
  answers = answers || {};
  const review = rows.map((q) => Object.assign({ id: q.id, type: q.qtype || "single" }, gradeQuestion(q, answers[q.id])));
  const sum = review.reduce((a, r) => a + r.score, 0);
  const score = rows.length ? Math.round((sum / rows.length) * 100) : 0;
  const correctCount = review.filter((r) => r.score >= 0.999).length;
  const results = {};
  review.forEach((r) => { results[r.id] = Math.round(r.score * 100) / 100; });
  return { score, correctCount, total: rows.length, review, results };
}

module.exports = { TYPES, validateQuestion, publicQuestion, gradeQuestion, gradeAll, token };
