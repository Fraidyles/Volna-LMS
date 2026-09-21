const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
});

pool.on("error", (err) => {
  console.error("Неожиданная ошибка соединения с базой:", err);
});

module.exports = pool;
