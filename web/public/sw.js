// Pimu service worker: caches the app shell only. Never touches /api/*.
const CACHE = 'pimu-shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest'])))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (e.request.mode === 'navigate') {
    // Network first so a deploy is picked up; cached shell when offline.
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone()
          caches.open(CACHE).then((c) => c.put('/', copy))
          return r
        })
        .catch(() => caches.match('/')),
    )
    return
  }
  // Hashed assets and icons: cache first.
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          if (r.ok) {
            const copy = r.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy))
          }
          return r
        }),
    ),
  )
})
