// FluteBand AI — проверка собранного пакета так, как он будет лежать на бесплатном хостинге.
//
// Смысл: GitHub Pages отдаёт проект по адресу вида https://имя.github.io/fluteband/, то есть приложение
// живёт в **подкаталоге**, а не в корне сайта. Здесь пакет `dist/` поднимается именно так и проверяется:
//   1) все файлы офлайн-оболочки отдаются по своим адресам (200, а не 404);
//   2) манифест и service worker указывают относительные пути и не уезжают в чужой корень;
//   3) приложение реально запускается из подкаталога, service worker встаёт с областью подкаталога,
//      оболочка ложится в кэш, и страница открывается **с выключенной сетью** (это проверяет
//      tools/offline-check.mjs, запускаясь на тот же адрес — то есть на подкаталог).
//
// Запуск: node tools/build-static.mjs && node tools/static-check.mjs
//         node tools/static-check.mjs --prefix=/fluteband/ --port=3080

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const DIST = join(ROOT, 'dist');

const arg = (name, fallback = null) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
// Каталог, в котором лежит пакет: «/fluteband/» для GitHub Pages или «/» для Netlify и Cloudflare Pages
const prefixArg = arg('prefix', '/fluteband/').replace(/^\/+|\/+$/g, '');
const PREFIX = prefixArg ? `/${prefixArg}/` : '/';
// 0 — занять любой свободный порт (иначе проверка падает, если порт занят другим приложением)
const PORT = Number(arg('port', process.env.STATIC_CHECK_PORT || 0));
// Порт отладки Chrome для вложенной офлайн-проверки: у неё свой диапазон, чтобы не мешать основным проверкам
const CDP_PORT = Number(process.env.STATIC_CHECK_CDP_PORT || 9338);
// Режим Netlify: главная страница отдаётся как «/», а /index.html уходит перенаправлением на «/».
// Так ведёт себя хостинг с включёнными «красивыми адресами» — проверяем, что офлайн всё равно собирается.
const PRETTY_URLS = process.argv.includes('--pretty-urls');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('Нет собранного пакета. Сначала: node tools/build-static.mjs');
  process.exit(2);
}

const shell = (() => {
  const source = readFileSync(join(DIST, 'service-worker.js'), 'utf8');
  return [...source.matchAll(/'\.\/([^']*)'/g)].map((match) => match[1]).filter(Boolean);
})();

const results = [];
const record = (name, ok, value) => {
  results.push({ name, ok, value });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
};

/** Статический сервер как у хостинга: пакет лежит в подкаталоге, всё остальное — 404. */
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (!path.startsWith(PREFIX)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — вне каталога приложения');
    return;
  }
  const relative = path.slice(PREFIX.length);

  // «Красивые адреса» Netlify: /index.html → 301 на каталог, а каталог уже отдаёт index.html
  // (проверяем именно исходный путь: иначе корень «/» тоже уходил бы в перенаправление и получалась петля)
  if (PRETTY_URLS && relative === 'index.html') {
    res.writeHead(301, { location: PREFIX });
    res.end();
    return;
  }

  const target = normalize(join(DIST, relative || 'index.html'));
  if (!target.startsWith(DIST) || !existsSync(target) || statSync(target).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — не найдено');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(readFileSync(target));
});

await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
const HTTP_PORT = server.address().port;
const BASE = `http://127.0.0.1:${HTTP_PORT}${PREFIX}`;
console.log(`Пакет dist/ поднят как на хостинге: ${BASE}`);
if (PRETTY_URLS) console.log('Режим Netlify: «красивые адреса» включены — /index.html уходит перенаправлением на «/»');
console.log('');

try {
  // 1. Все файлы офлайн-оболочки должны отдаваться по своим адресам
  const broken = [];
  for (const entry of shell) {
    const url = entry === '' ? BASE : `${BASE}${entry}`;
    const res = await fetch(url, { redirect: 'follow' }).catch(() => null);
    if (!res || !res.ok) broken.push(`${entry || 'index.html'} → ${res ? res.status : 'нет ответа'}`);
  }
  record(`файлы офлайн-оболочки отдаются (${shell.length} адресов)`, broken.length === 0, broken.length ? broken : 'все 200');

  // В режиме Netlify дополнительно смотрим, что именно делает хостинг с адресом главной страницы:
  // перенаправление — не ошибка, но из-за него файл может не лечь в кэш (это проверит офлайн-прогон)
  if (PRETTY_URLS) {
    const direct = await fetch(`${BASE}index.html`, { redirect: 'manual' });
    record('главная страница отдаётся перенаправлением (как Netlify)', direct.status === 301, {
      status: direct.status,
      location: direct.headers.get('location'),
    });
  }

  // 2. Чужой корень сайта не должен обслуживать приложение (иначе относительные пути ничего не доказывают).
  // В режиме Netlify приложение живёт в корне — там эта проверка не имеет смысла.
  if (PREFIX !== '/') {
    const outside = await fetch(`http://127.0.0.1:${HTTP_PORT}/index.html`);
    record('корень сайта — чужой (404), приложение живёт в подкаталоге', outside.status === 404, { status: outside.status });
  }

  // 3. Манифест: пути относительные, иначе установка PWA уедет в корень сайта
  const manifestRes = await fetch(`${BASE}manifest.webmanifest`);
  const manifest = await manifestRes.json();
  const manifestOk = manifest.start_url?.startsWith('./') && manifest.scope?.startsWith('./')
    && (manifest.icons || []).every((icon) => icon.src?.startsWith('./'));
  record('манифест: start_url, scope и значки относительные', manifestOk, {
    type: manifestRes.headers.get('content-type'),
    start_url: manifest.start_url,
    scope: manifest.scope,
  });

  // 4. Service worker регистрируется относительным путём
  const appSource = readFileSync(join(DIST, 'js', 'app.js'), 'utf8');
  record('service worker регистрируется относительным путём', appSource.includes("register('./service-worker.js')"), 'app.js');

  // 5. Настоящая браузерная проверка: запуск из подкаталога + офлайн из кэша.
  // Запускаем асинхронно: синхронный запуск заблокировал бы цикл событий, и вложенная проверка
  // не смогла бы получить страницу у нашего же сервера (он живёт в этом процессе).
  console.log('\nБраузерная проверка (запуск из подкаталога, затем сеть выключена):');
  const offlineCode = await new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'offline-check.mjs'), `${BASE}index.html`], {
      stdio: 'inherit',
      env: {
        ...process.env,
        OFFLINE_CHECK_PORT: String(CDP_PORT),
        // В режиме «красивых адресов» адрес главной страницы отдаётся перенаправлением, поэтому
        // требовать в кэше все 40 адресов нельзя: важно, что приложение открывается без сети.
        OFFLINE_REQUIRE_FULL_SHELL: PRETTY_URLS ? '0' : '1',
      },
    });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
  record('приложение работает из подкаталога и офлайн', offlineCode === 0, { код: offlineCode });
} finally {
  server.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\nИтог: ${failed.length ? 'FAIL' : 'OK'} — проверок ${results.length}, провалено ${failed.length}`);
if (!failed.length) {
  console.log('Пакет dist/ готов к выкладке: Cloudflare Pages (корень) или GitHub Pages (подкаталог).');
  console.log('Инструкция: docs/05-publikaciya.md');
}
process.exitCode = failed.length ? 1 : 0;