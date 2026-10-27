/**
 * Service worker: makes the app shell available offline.
 *
 * Network first, cache as fallback, so deployments are picked up immediately
 * while the board still opens without a connection. API calls and the
 * WebSocket are never cached; queued edits live in the page (localStorage)
 * and are sent when the connection comes back.
 */
const CACHE_NAME = 'collab-kanban-v2';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/favicon.svg',
  '/shared/rank.js',
  '/js/theme.js',
  '/js/app.js',
  '/js/api.js',
  '/js/dnd.js',
  '/js/state.js',
  '/js/storage.js',
  '/js/sync.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/api-docs') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname === '/' ? '/' : request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/');
        return Response.error();
      }),
  );
});
