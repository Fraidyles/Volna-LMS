require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./db");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Миграция выполнена — таблицы созданы (или уже существовали).");
  await pool.end();
})().catch((e) => {
  console.error("Ошибка миграции:", e);
  process.exit(1);
});
