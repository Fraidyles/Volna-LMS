const crypto = require("crypto");

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex"); // 8 символов, например "a1b2c3d4"
}

function generateTempPassword() {
  // Отсекаем небуквенно-цифровые символы base64 (+/=) — иногда их выпадает
  // столько, что после этого остаётся меньше 10 символов; докручиваем, пока
  // не наберётся ровно 10.
  var out = "";
  while (out.length < 10) {
    out += crypto.randomBytes(8).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  }
  return out.slice(0, 10);
}

module.exports = { generateReferralCode, generateTempPassword };
