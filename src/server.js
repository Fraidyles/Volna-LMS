require("dotenv").config();
// Каждый роут — async-функция без try/catch; без этого пакета отклонённый промис
// внутри обработчика не долетает до error-middleware ниже и валит весь процесс
// (Node с версии 15 завершает процесс на необработанном отклонении промиса).
require("express-async-errors");
const express = require("express");
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
const calendarRoutes = require("./routes/calendar");

const app = express();

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: ALLOWED.length ? ALLOWED : true,
    credentials: true
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/course", courseRoutes);
app.use("/api/messages", messageRoutes);
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

// Единая ошибка для необработанных сбоев — чтобы не ронять процесс и не светить стек в ответе
app.use((err, req, res, next) => {
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
