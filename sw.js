// Avafon V1.02 Service Worker – generiert von scripts/build.mjs
const VERSION = "V1.02";
const CACHE = "romyfon-v1.02";
const MEDIA_PREFIX = "romyfon-media-";
const SHELL = [
  "./",
  "./index.html",
  "./side.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./shared/styles.css",
  "./shared/js/app.js",
  "./shared/js/api.js",
  "./shared/js/config.js",
  "./shared/js/signaling.js",
  "./shared/js/webrtc.js",
  "./shared/js/audio.js",
  "./shared/sounds/ringtone.m4a",
  "./shared/sounds/keepalive.m4a",
  "./shared/fonts/Nunito-Variable.ttf"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("romyfon-") && k !== CACHE && !k.startsWith(MEDIA_PREFIX)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Netz zuerst für HTML/JS/CSS (Updates kommen sofort an), Cache als Fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error("offline");
    }
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
    const extra = data.data || {};
    await self.registration.showNotification(data.title || "Avafon", {
      body: data.body || "Ava ruft an",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "anruf",
      renotify: true,
      requireInteraction: true,
      lang: "de",
      data: extra,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const scope = self.registration.scope;
  const target = data.incoming ? scope + "?incoming=" + encodeURIComponent(data.incoming) : scope;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if ((client.url || "").startsWith(scope) && "focus" in client) {
        // Nicht neu laden (das würde die Verbindung kappen): fokussieren und
        // der Seite Bescheid geben; der Worker spielt den Anruf erneut zu.
        let focused = client;
        try { focused = (await client.focus()) || client; } catch { /* ignore */ }
        try { focused.postMessage({ type: "incoming", data }); } catch { /* ignore */ }
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
