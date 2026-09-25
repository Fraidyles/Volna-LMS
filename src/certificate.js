const path = require("path");
const PDFDocument = require("pdfkit");

// Пришлось перейти со стандартных PDF-шрифтов (Times/Helvetica) на встроенные TTF:
// у них нет кириллицы — имя врача и название курса на русском рендерились битыми
// символами. IBM Plex — та же гарнитура, что уже используется в вебе (см.
// public/index.html), с полной поддержкой кириллицы; шрифты лицензированы под
// SIL OFL (см. src/assets/fonts/*-OFL.txt), поэтому их можно свободно встраивать.
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const FONT_REGULAR = path.join(FONTS_DIR, "IBMPlexSerif-Regular.ttf");
const FONT_BOLD = path.join(FONTS_DIR, "IBMPlexSerif-Bold.ttf");
const FONT_ITALIC = path.join(FONTS_DIR, "IBMPlexSerif-Italic.ttf");
const FONT_SIGNATURE = path.join(FONTS_DIR, "NothingYouCouldDo-Regular.ttf");

// Палитра — та же, что в public/styles.css (светлая тема), а не тёмная тема
// интерфейса: печатный документ должен читаться на бумаге/при печати.
const INK = "#232019";
const MUTED = "#6B6459";
const PRIMARY = "#524FC9"; // --primary-dark светлой темы, чуть темнее для контраста на белом
const GOLD = "#C98A1B"; // --accent светлой темы
const GOLD_SOFT = "#E4C077";
const PAPER = "#FBF9F4";

// Иконка "doctor" из public/app.js (ICONS.doctor) — тот же viewBox 0..24,
// тот же stroke-стиль (без заливки, круглые концы/стыки), чтобы фирменный
// значок на сертификате совпадал с тем, что врач видит в самом приложении.
const DOCTOR_ICON_PATHS = [
  "M7 3.5v5a5 5 0 0 0 10 0v-5",
  "M17 8v2a5 5 0 0 1-10 0",
  "M12 15.5v3.5"
];
const DOCTOR_ICON_CIRCLES = [
  { cx: 19, cy: 5, r: 2 },
  { cx: 12, cy: 20.5, r: 1.3 }
];

function drawBrandMark(doc, x, y, size) {
  const r = size * 0.28;
  doc.roundedRect(x, y, size, size, r).fill(PRIMARY);
  doc.save();
  doc.translate(x + size * 0.14, y + size * 0.14);
  const scale = (size * 0.72) / 24;
  doc.scale(scale, scale);
  doc.lineWidth(1.75 / scale).lineCap("round").lineJoin("round");
  DOCTOR_ICON_PATHS.forEach((d) => { doc.path(d).stroke("white"); });
  DOCTOR_ICON_CIRCLES.forEach((c) => { doc.circle(c.cx, c.cy, c.r).stroke("white"); });
  doc.restore();
}

function drawCornerFlourish(doc, x, y, dx, dy, len) {
  doc.moveTo(x, y).lineTo(x + dx * len, y).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveTo(x, y).lineTo(x, y + dy * len).strokeColor(GOLD).lineWidth(1.5).stroke();
}

// ФИО врача не имеет предсказуемой длины (двойные фамилии, отчество и т.п.) — вместо
// фиксированного размера шрифта подбираем наибольший, при котором строка ещё
// помещается в одну строку: перенос на 2 строки съехал бы весь layout ниже (линия,
// "has successfully completed the course", название курса).
function fitSingleLineFontSize(doc, text, font, maxWidth, startSize, minSize) {
  doc.font(font);
  let size = startSize;
  while (size > minSize) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= maxWidth) break;
    size -= 1;
  }
  return size;
}

// То же самое для названия курса, но по высоте (курс может занимать 1-2 строки) —
// подбираем размер, при котором блок гарантированно не долезает до подписи снизу.
function fitBoxFontSize(doc, text, font, boxWidth, maxHeight, startSize, minSize) {
  doc.font(font);
  let size = startSize;
  while (size > minSize) {
    doc.fontSize(size);
    if (doc.heightOfString(text, { width: boxWidth, align: "center" }) <= maxHeight) break;
    size -= 1;
  }
  return size;
}

// Возвращает Buffer с готовым PDF (A4, альбомная ориентация). Рендерится на лету
// из уже сохранённых данных (имя, курс, номер, дата) — сам файл нигде не хранится,
// поэтому повторное скачивание всегда даёт идентичный результат без лишнего состояния.
function generateCertificatePdf({ studentName, courseTitle, certificateNumber, issuedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Serif", FONT_REGULAR);
    doc.registerFont("Serif-Bold", FONT_BOLD);
    doc.registerFont("Serif-Italic", FONT_ITALIC);
    doc.registerFont("Signature", FONT_SIGNATURE);

    const W = doc.page.width;
    const H = doc.page.height;
    const cx = W / 2;

    doc.rect(0, 0, W, H).fill(PAPER);

    // Двойная золотая рамка
    doc.rect(36, 36, W - 72, H - 72).lineWidth(2).strokeColor(GOLD).stroke();
    doc.rect(46, 46, W - 92, H - 92).lineWidth(0.75).strokeColor(GOLD_SOFT).stroke();

    // Декоративные уголки поверх внутренней рамки
    drawCornerFlourish(doc, 46, 46, 1, 1, 26);
    drawCornerFlourish(doc, W - 46, 46, -1, 1, 26);
    drawCornerFlourish(doc, 46, H - 46, 1, -1, 26);
    drawCornerFlourish(doc, W - 46, H - 46, -1, -1, 26);

    doc.fillColor(INK).font("Serif-Bold").fontSize(46)
      .text("CERTIFICATE", 0, 96, { width: W, align: "center", characterSpacing: 10 });

    doc.fillColor(MUTED).font("Serif").fontSize(15)
      .text("OF COMPLETION", 0, 156, { width: W, align: "center", characterSpacing: 6 });

    doc.fillColor(MUTED).font("Serif-Italic").fontSize(13)
      .text("This is to certify that", 0, 205, { width: W, align: "center" });

    const nameTop = 235;
    const nameFontSize = fitSingleLineFontSize(doc, studentName, "Serif-Bold", 640, 30, 16);
    doc.fillColor(PRIMARY).font("Serif-Bold").fontSize(nameFontSize)
      .text(studentName, 0, nameTop, { width: W, align: "center" });
    const nameHeight = doc.heightOfString(studentName, { width: W, align: "center" });

    const underlineY = nameTop + nameHeight + 16;
    doc.moveTo(cx - 180, underlineY).lineTo(cx + 180, underlineY).lineWidth(1).strokeColor(INK).stroke();
    doc.circle(cx - 180, underlineY, 2).fill(GOLD);
    doc.circle(cx + 180, underlineY, 2).fill(GOLD);

    const hasCompletedY = underlineY + 20;
    doc.fillColor(MUTED).font("Serif-Italic").fontSize(13)
      .text("has successfully completed the course", 0, hasCompletedY, { width: W, align: "center" });

    // Подпись и печать (левая колонка) — фиксированная позиция снизу; название курса
    // должно гарантированно поместиться над ней, поэтому его размер тоже подбираем.
    const sigY = H - 150;
    const courseTop = hasCompletedY + 24;
    const courseBoxWidth = 620;
    const courseFontSize = fitBoxFontSize(doc, courseTitle, "Serif-Bold", courseBoxWidth, sigY - 20 - courseTop, 17, 11);
    doc.fillColor(INK).font("Serif-Bold").fontSize(courseFontSize)
      .text(courseTitle, cx - courseBoxWidth / 2, courseTop, { width: courseBoxWidth, align: "center" });
    doc.fillColor(INK).font("Signature").fontSize(34).text("Ksenia Butova", 110, sigY);
    doc.moveTo(110, sigY + 42).lineTo(370, sigY + 42).lineWidth(0.75).strokeColor(INK).stroke();
    doc.fillColor(INK).font("Serif-Bold").fontSize(11).text("Dr. Ksenia Butova", 110, sigY + 48);
    doc.fillColor(MUTED).font("Serif").fontSize(9.5).text("Volna LLC, Founder", 110, sigY + 63);

    // Бренд-марка курса (правая колонка) — вместо исходного логотипа шаблона
    const markSize = 34;
    const markX = W - 264;
    const markTextX = markX + markSize + 10;
    const markTextWidth = (W - 60) - markTextX;
    drawBrandMark(doc, markX, sigY + 6, markSize);
    doc.fillColor(INK).font("Serif-Bold").fontSize(12)
      .text("Медицина Долголетия", markTextX, sigY + 8, { width: markTextWidth });
    doc.fillColor(MUTED).font("Serif").fontSize(9)
      .text("Программа непрерывного медицинского образования", markTextX, sigY + 24, { width: markTextWidth });

    const issuedStr = new Date(issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    doc.fillColor(MUTED).font("Serif").fontSize(9)
      .text(`Certificate No. ${certificateNumber}   ·   Issued: ${issuedStr}`, 0, H - 64, { width: W, align: "center" });

    doc.end();
  });
}

module.exports = { generateCertificatePdf };
