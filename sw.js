/* Service worker för "Antonias dagbok <3"
 *
 * Strategi: cache-first med nätverks-fallback. Appen är helt statisk och all
 * användardata bor i IndexedDB (inte i cachen), så detta räcker för full
 * offline-funktion efter första laddningen.
 *
 * VIKTIGT: bumpa CACHE_NAME (t.ex. -v2, -v3 ...) varje gång du ändrar någon
 * av filerna nedan, annars fortsätter den gamla cachade versionen att serveras.
 */

const CACHE_NAME = "antonia-dagbok-v1";

// Filer som ska finnas tillgängliga offline.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Installera: lägg appens skal i cachen och aktivera direkt.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Aktivera: städa bort gamla cache-versioner.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Hämta: svara från cachen först, annars nätet (och spara svaret i cachen).
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Vi cachar bara GET-anrop.
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Spara en kopia av lyckade svar för framtida offline-bruk.
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Helt offline och inget i cachen: fall tillbaka på appens skal.
          if (request.mode === "navigate") return caches.match("./index.html");
        });
    })
  );
});
