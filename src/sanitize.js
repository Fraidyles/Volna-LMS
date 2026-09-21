const xss = require("xss");

// Урок может содержать текст, форматирование и iframe с видео (GetCourse и т.п.) —
// поэтому iframe разрешён, но только с безопасными атрибутами; скрипты и обработчики
// событий вырезаются всегда. Библиотека xss (js-xss) — чистый CommonJS без DOM-зависимостей,
// не конфликтует ни с продакшеном, ни с тестовым окружением.
const ALLOWED = {
  p: [], h3: [], h4: [], h5: [], b: [], strong: [], i: [], em: [], u: [], br: [], hr: [],
  ul: [], ol: [], li: [], blockquote: [], code: [], pre: [],
  table: [], thead: [], tbody: [], tr: [], th: [], td: [],
  a: ["href", "title", "target", "rel", "class"],
  img: ["src", "alt", "title", "class", "width", "height"],
  div: ["class", "style"],
  span: ["class", "style"],
  iframe: ["src", "width", "height", "allow", "allowfullscreen", "frameborder", "class"]
};

const myXss = new xss.FilterXSS({
  whiteList: ALLOWED,
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
  css: false
});

function sanitizeLessonHtml(html) {
  if (!html) return "";
  return myXss.process(html);
}

module.exports = { sanitizeLessonHtml };
