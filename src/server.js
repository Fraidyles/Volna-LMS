require("dotenv").config();
// Каждый роут — async-функция без try/catch; без этого пакета отклонённый промис
// внутри обработчика не долетает до error-middleware ниже и валит весь процесс
// (Node с версии 15 завершает процесс на необработанном отклонении промиса).
require("express-async-errors");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const YAML = require("yamljs");
const swaggerUi = require("swagger-ui-express");

const authRoutes = require("./routes/auth");
const inviteRoutes = require("./routes/invites");
const staffRoutes = require("./routes/staff");
const courseRoutes = require("./routes/course");
const coursesRoutes = require("./routes/courses");
const notificationRoutes = require("./routes/notifications");
const specializationRoutes = require("./routes/specializations");
const protocolRoutes = require("./routes/protocols");
const calendarRoutes = require("./routes/calendar");

const app = express();

// Продакшен-схема из README всегда ставит Nginx перед этим процессом (см. «6. Домен
// и HTTPS»), поэтому доверяем ровно одному хопу X-Forwarded-For. Без этого Express
// берёт req.ip из TCP-соединения — то есть IP самого Nginx, один и тот же для всех
// пользователей, — и rate limiting (auth.js) считает попытки входа всех врачей как
// одного человека: несколько неудачных попыток одного пользователя блокируют вход
// всем остальным. Ставить больше 1 без реального второго прокси перед Nginx нельзя —
// это позволило бы обойти лимит подделкой заголовка X-Forwarded-For напрямую.
app.set("trust proxy", 1);

// Позволяет смонтировать платформу в подпапку существующего сайта (например
// https://корп-домен/lms/) вместо отдельного (под)домена — актуально, когда
// нет возможности завести новую DNS-запись, а на сервере уже крутится другой
// сайт на том же порту 80/443. Пусто по умолчанию — обычный запуск в корне
// домена (как описано в README) не меняется ни на йоту: без BASE_PATH весь
// код ниже регистрируется на `app` напрямую, 1:1 как раньше.
// Фронтенд (public/) все свои ссылки на себя и на API строит ОТНОСИТЕЛЬНО
// текущей страницы (см. index.html/app.js/manifest.json/sw.js) — благодаря
// этому ему сама переменная BASE_PATH не нужна, достаточно того, что сервер
// корректно домонтирует API/статику по этому префиксу.
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const mounted = BASE_PATH ? express.Router() : app;

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Базовые защитные заголовки (X-Content-Type-Options, X-Frame-Options, HSTS и т.п.).
// crossOriginEmbedderPolicy выключен намеренно: с ним require-corp браузер блокирует
// загрузку кросс-доменных ресурсов без явного CORP-заголовка от чужого сервера —
// а урок может содержать честный сторонний iframe (см. CSP frame-src ниже и
// src/sanitize.js, где домен iframe.src никак не ограничен).
mounted.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CSP настраиваем отдельным middleware (не через helmet({contentSecurityPolicy})
// сразу выше), чтобы явно исключить /api-docs — Swagger UI использует инлайновые
// скрипты/стили и per-route CSP через helmet не сможет тонко это разрешить, не
// ослабляя политику для всего остального приложения.
const cspMiddleware = helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    // Инлайновый <script> в index.html убран (перенесён в app.js) специально ради
    // возможности не разрешать 'unsafe-inline' здесь.
    scriptSrc: ["'self'"],
    // Разметка урока (см. src/sanitize.js) хранит цвет/отступы в style="..." прямо
    // на div/span — без 'unsafe-inline' весь оформленный контент курса перестал бы
    // применять эти стили.
    styleSrc: ["'self'", "'unsafe-inline'"],
    // Шрифты теперь свои, файлами (public/fonts/) — внешний fonts.gstatic.com
    // больше не нужен, 'self' достаточно.
    fontSrc: ["'self'"],
    // img/src урока тоже не ограничен по домену на бэкенде — картинки в уроке могут
    // лежать на любом внешнем хосте.
    imgSrc: ["'self'", "https:", "data:"],
    // Видео урока — либо загруженный файл (тот же origin), либо прямой внешний
    // URL на mp4 (см. поле "Ссылка на видео" в редакторе урока) — по той же логике,
    // что и imgSrc выше. Без явного mediaSrc CSP падает на defaultSrc:'self' и
    // молча блокирует воспроизведение любого стороннего видео по прямой ссылке.
    mediaSrc: ["'self'", "https:"],
    // iframe урока (see sanitize.js) не ограничен по домену — там встраивают видео
    // с разных площадок (GetCourse и т.п.), поэтому https: обязателен здесь.
    frameSrc: ["https:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"]
  }
});
mounted.use((req, res, next) => {
  if (req.path === "/api-docs" || req.path.startsWith("/api-docs/")) return next();
  cspMiddleware(req, res, next);
});

mounted.use(express.json());
mounted.use(cookieParser());
mounted.use(
  cors({
    // Небезопасно по умолчанию давать true (разрешить все источники), раз тут же
    // ниже стоит credentials:true (кука входа врача уходит вместе с запросом) —
    // при незаданном ALLOWED_ORIGINS (например, забыли на проде) это означало бы
    // "любой сторонний сайт может от имени залогиненного врача читать ответы API".
    // Фронтенд отдаётся тем же Express-приложением (см. express.static ниже) —
    // ему CORS не нужен вовсе (не кросс-ориджин), так что безопасный дефолт при
    // пустом списке — запретить всё стороннее, а не разрешить.
    origin: ALLOWED.length ? ALLOWED : false,
    credentials: true
  })
);

mounted.use("/api/auth", authRoutes);
mounted.use("/api/invites", inviteRoutes);
mounted.use("/api/staff", staffRoutes);
mounted.use("/api/course", courseRoutes);
mounted.use("/api/courses", coursesRoutes);
mounted.use("/api/notifications", notificationRoutes);
mounted.use("/api/specializations", specializationRoutes);
mounted.use("/api/protocols", protocolRoutes);
mounted.use("/api", calendarRoutes);

// Интерактивная документация API — удобно, когда фронтенд и бэкенд начнут жить отдельно
// друг от друга или появится мобильное приложение.
try {
  const openapiDoc = YAML.load(path.join(__dirname, "..", "docs", "openapi.yaml"));
  mounted.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDoc));
} catch (e) {
  console.error("Не удалось загрузить OpenAPI-документацию:", e.message);
}

mounted.get("/health", (req, res) => res.json({ ok: true }));

// Отдаём собранный фронтенд как статику того же сервера
mounted.use(express.static(path.join(__dirname, "..", "public")));

// Единая ошибка для необработанных сбоев — чтобы не ронять процесс и не светить стек в ответе.
// Ошибки самого body-parser (битый JSON, слишком большое тело) — это ошибка КЛИЕНТА,
// а не сервера: до этого места они тоже падали в общий 500 и засоряли лог реальных
// сбоев обычными опечатками в запросах, плюс сами клиенты получали неверный код ответа.
mounted.use((err, req, res, next) => {
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({ error: "payload_too_large", message: "Слишком большой запрос" });
  }
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
    return res.status(400).json({ error: "invalid_json", message: "Некорректный формат запроса" });
  }
  console.error("Необработанная ошибка:", err);
  res.status(500).json({ error: "internal_error", message: "Что-то пошло не так на сервере" });
});

if (BASE_PATH) {
  // Без хвостового слэша (например /lms) все относительные ссылки на фронтенде
  // (см. index.html/manifest.json/sw.js) резолвились бы на уровень выше —
  // редиректим на вариант со слэшем, прежде чем отдавать саму страницу.
  // Именно middleware с ручной проверкой req.path, а не app.get(BASE_PATH, ...):
  // у Express по умолчанию выключен strict routing, так что route-паттерн
  // "/lms" сам по себе матчит и "/lms/" — редирект зацикливался бы сам на себя.
  app.use((req, res, next) => {
    if (req.path === BASE_PATH) return res.redirect(301, BASE_PATH + "/");
    next();
  });
  app.use(BASE_PATH, mounted);
}

const PORT = process.env.PORT || 8790;
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log("LMS backend запущен на порту " + PORT);
    console.log("Документация API: http://localhost:" + PORT + "/api-docs");
  });
  // Node с v14.11 по умолчанию рвёт любой запрос, не завершившийся за 5 минут
  // (server.requestTimeout=300000 — защита от slow-loris). Для большинства
  // роутов это не заметно, но загрузка видео до 500 МБ (см. course.js,
  // /lessons/:id/video-upload) на не самом быстром аплинке легко занимает
  // дольше 5 минут — соединение обрывалось посреди загрузки без внятной
  // ошибки на фронте. Поднимаем до 30 минут — этого достаточно даже на
  // медленном канале и всё ещё ограничивает зависшие соединения.
  server.requestTimeout = 30 * 60 * 1000;
}

module.exports = app;
