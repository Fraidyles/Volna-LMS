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
const messageRoutes = require("./routes/messages");
const streamMessageRoutes = require("./routes/stream-messages");
const notificationRoutes = require("./routes/notifications");
const chatMuteRoutes = require("./routes/chat-mutes");
const chatTemplateRoutes = require("./routes/chat-templates");
const specializationRoutes = require("./routes/specializations");
const protocolRoutes = require("./routes/protocols");
const calendarRoutes = require("./routes/calendar");

const app = express();

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Базовые защитные заголовки (X-Content-Type-Options, X-Frame-Options, HSTS и т.п.).
// crossOriginEmbedderPolicy выключен намеренно: с ним require-corp браузер блокирует
// загрузку кросс-доменных ресурсов без явного CORP-заголовка от чужого сервера —
// а урок может содержать честный сторонний iframe (см. CSP frame-src ниже и
// src/sanitize.js, где домен iframe.src никак не ограничен).
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

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
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    // img/src урока тоже не ограничен по домену на бэкенде — картинки в уроке могут
    // лежать на любом внешнем хосте.
    imgSrc: ["'self'", "https:", "data:"],
    // iframe урока (see sanitize.js) не ограничен по домену — там встраивают видео
    // с разных площадок (GetCourse и т.п.), поэтому https: обязателен здесь.
    frameSrc: ["https:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"]
  }
});
app.use((req, res, next) => {
  if (req.path === "/api-docs" || req.path.startsWith("/api-docs/")) return next();
  cspMiddleware(req, res, next);
});

app.use(express.json());
app.use(cookieParser());
app.use(
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

app.use("/api/auth", authRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/course", courseRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/stream-messages", streamMessageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/chat-mutes", chatMuteRoutes);
app.use("/api/chat-templates", chatTemplateRoutes);
app.use("/api/specializations", specializationRoutes);
app.use("/api/protocols", protocolRoutes);
app.use("/api", calendarRoutes);

// Интерактивная документация API — удобно, когда фронтенд и бэкенд начнут жить отдельно
// друг от друга или появится мобильное приложение.
try {
  const openapiDoc = YAML.load(path.join(__dirname, "..", "docs", "openapi.yaml"));
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDoc));
} catch (e) {
  console.error("Не удалось загрузить OpenAPI-документацию:", e.message);
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Отдаём собранный фронтенд как статику того же сервера
app.use(express.static(path.join(__dirname, "..", "public")));

// Единая ошибка для необработанных сбоев — чтобы не ронять процесс и не светить стек в ответе.
// Ошибки самого body-parser (битый JSON, слишком большое тело) — это ошибка КЛИЕНТА,
// а не сервера: до этого места они тоже падали в общий 500 и засоряли лог реальных
// сбоев обычными опечатками в запросах, плюс сами клиенты получали неверный код ответа.
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({ error: "payload_too_large", message: "Слишком большой запрос" });
  }
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
    return res.status(400).json({ error: "invalid_json", message: "Некорректный формат запроса" });
  }
  console.error("Необработанная ошибка:", err);
  res.status(500).json({ error: "internal_error", message: "Что-то пошло не так на сервере" });
});

const PORT = process.env.PORT || 8790;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("LMS backend запущен на порту " + PORT);
    console.log("Документация API: http://localhost:" + PORT + "/api-docs");
  });
}

module.exports = app;
