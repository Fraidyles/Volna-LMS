// Простой service worker: кэширует статическую оболочку приложения (HTML/CSS/JS),
// чтобы при повторном заходе интерфейс открывался мгновенно, а не ждал сеть.
// Данные (API-запросы) всегда идут в сеть — офлайн-режима для данных здесь нет,
// только быстрый повторный запуск самого интерфейса.

const CACHE_NAME = "lms-shell-v3";
// Относительные пути — резолвятся от собственного URL service worker'а (self.registration.scope),
// а не от корня домена: так кэш работает и при монтировании платформы в подпапку (например /lms/),
// не только при отдельном (под)домене.
const SHELL_FILES = ["./", "app.js", "styles.css", "manifest.json", "favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Путь к API относительно scope этого service worker'а — тоже не хардкодим "/api/",
// чтобы верно работать и в подпапке (scope тогда "/lms/", а API — "/lms/api/").
const API_PATH = new URL("api/", self.registration.scope).pathname;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API и любые не-GET запросы — всегда напрямую в сеть, никогда не кэшируем
  if (url.pathname.startsWith(API_PATH) || event.request.method !== "GET") {
    return;
  }

  // Оболочка приложения — "сеть, с откатом на кэш", чтобы обновления подхватывались,
  // но при плохой сети или мгновенном повторном открытии всё равно быстро отрисовалось.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
