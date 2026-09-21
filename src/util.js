const crypto = require("crypto");

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex"); // 8 символов, например "a1b2c3d4"
}

function generateTempPassword() {
  return crypto.randomBytes(7).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

module.exports = { generateReferralCode, generateTempPassword };
