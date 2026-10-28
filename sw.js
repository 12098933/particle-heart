const CACHE_NAME = "particle-heart-runtime-v4";
const RUNTIME_PATHS = [
  "/vision_bundle.mjs",
  "/hand_landmarker.task",
  "/wasm/"
];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isRuntimeRequest(url) {
  return url.origin === self.location.origin
    && RUNTIME_PATHS.some((path) => url.pathname.endsWith(path) || url.pathname.includes(path));
}

async function cacheFirst(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    event.waitUntil(
      cache.put(request, response.clone()).catch((error) => {
        console.warn("Runtime cache write failed.", error);
      })
    );
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!isRuntimeRequest(url)) return;
  event.respondWith(cacheFirst(event, event.request));
});
