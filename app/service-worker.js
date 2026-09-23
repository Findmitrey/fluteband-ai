// FluteBand AI — service worker: офлайн-оболочка (сами пьесы лежат в IndexedDB).

const CACHE = 'fluteband-shell-v6';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon.svg',
  './demo/ode-page.png',
  './js/app.js',
  './js/pitch.js',
  './js/chords.js',
  './js/harmony.js',
  './js/transpose.js',
  './js/tempo.js',
  './js/timeline.js',
  './js/accompaniment.js',
  './js/midi.js',
  './js/wav.js',
  './js/wav-render.js',
  './js/xml.js',
  './js/musicxml.js',
  './js/score.js',
  './js/score-pages.js',
  './js/library-index.js',
  './js/demo.js',
  './js/fixtures.js',
  './js/manual.js',
  './js/ui-strings.js',
  './js/storage.js',
  './js/synth.js',
  './js/sampler.js',
  './js/transport.js',
  './js/pianola.js',
  './js/camera.js',
  './js/image-stats.js',
  './js/perspective.js',
  './js/image-prep.js',
  './js/score-fixes.js',
  './js/recognition.js',
  './js/views/library.js',
  './js/views/scan.js',
  './js/views/player.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        // Кэшируем файлы по одному, а не одним списком (cache.addAll): если хостинг отдаёт один из
        // адресов перенаправлением или ошибкой (так бывает, например, с «красивыми адресами» Netlify,
        // где /index.html превращается в /), весь список раньше отменялся целиком и офлайн не работал.
        await Promise.all(SHELL.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* этот адрес не попал в кэш — остальные попадут */
          }
        }));
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // банк звуков и внешние ресурсы — из сети
  if (url.pathname.includes('/api/')) return;      // распознавание — всегда в сеть

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // обновляем кэш в фоне, но отвечаем сразу
        fetch(request)
          .then((fresh) => fresh.ok && caches.open(CACHE).then((cache) => cache.put(request, fresh.clone())))
          .catch(() => undefined);
        return cached;
      }
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => {
          // Запасной вариант для перехода по адресу страницы: в кэше может лежать только один из двух
          // адресов («./» или «./index.html») — смотря как хостинг отдаёт главную страницу
          // (Netlify с «красивыми адресами» отдаёт её как «/»).
          const fallback = (await caches.match('./index.html')) || (await caches.match('./'));
          return fallback || new Response('Офлайн', { status: 503 });
        });
    }),
  );
});