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

// Лёгкий разбор User-Agent без внешних библиотек (ua-parser и т.п.) — для экрана
// «Текущие сеансы» достаточно грубого «ОС · браузер», а не точной версии сборки.
function describeUserAgent(ua) {
  if (!ua) return "Неизвестное устройство";
  var os = "Неизвестная ОС";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/iphone|ipad/i.test(ua)) os = "iOS";
  else if (/mac os x/i.test(ua)) os = "macOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/linux/i.test(ua)) os = "Linux";

  var browser = "Браузер";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = "Chrome";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";

  return os + " · " + browser;
}

module.exports = { generateReferralCode, generateTempPassword, describeUserAgent };
