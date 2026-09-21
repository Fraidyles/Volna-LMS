process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_do_not_use_in_production";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/lms_jest_test";
process.env.PGSSL = process.env.PGSSL || "false";
process.env.ALLOWED_ORIGINS = "http://localhost:8790";
