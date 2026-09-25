const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

module.exports = async () => {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/lms_jest_test";

  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false });

  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8");
  await pool.query(schema);

  // Чистый лист перед каждым запуском тестов — тестовая база предназначена только для этого.
  await pool.query(`
    TRUNCATE TABLE audit_log, lesson_history, course_visibility, quiz_questions,
    lessons, progress, events, streams, invites, courses, users
    RESTART IDENTITY CASCADE
  `);

  await pool.end();
};
