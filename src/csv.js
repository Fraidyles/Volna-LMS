// Простой CSV — без внешней библиотеки, формат достаточно предсказуемый
// (экспорт/импорт списков врачей, заявок, аудит-лога), чтобы не тащить
// зависимость ради десятка строк RFC4180-парсинга.

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// BOM в начале — иначе Excel на Windows открывает файл с кириллицей как кракозябры.
function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(","));
  return "﻿" + [header].concat(lines).join("\r\n");
}

// Разбирает CSV в массив массивов строк — поддерживает кавычки, экранирование
// кавычки внутри поля (""), запятые/переносы строк внутри кавычек.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      // пропускаем — перевод строки обработает \n
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

// [{"Имя":"...", "Email":"..."}, ...] по заголовку первой строки (не по позиции
// колонок) — устойчиво к перестановке столбцов пользователем в Excel.
function parseCsvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (row[i] || "").trim(); });
    return obj;
  });
}

module.exports = { csvEscape, toCsv, parseCsv, parseCsvToObjects };
