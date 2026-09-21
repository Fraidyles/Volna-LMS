module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/env-setup.js"],
  globalSetup: "<rootDir>/tests/globalSetup.js",
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  testTimeout: 15000
};
