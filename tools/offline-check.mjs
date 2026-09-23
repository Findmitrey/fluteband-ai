// FluteBand AI — проверка офлайн-работы приложения (шаг 6: офлайн-кэш и установка PWA).
//
// Смысл: приложение для занятий музыкой должно работать там, где интернета нет.
// Проверяем это по-настоящему: один раз загружаем приложение (service worker кэширует оболочку),
// затем отключаем сеть средствами Chrome, перезагружаем страницу и проверяем, что:
//   1) оболочка поднялась из кэша (все файлы из service worker реально лежат в Cache Storage);
//   2) страницей управляет service worker, а не сеть;
//   3) сохранённая пьеса осталась в IndexedDB устройства;
//   4) минус из неё строится офлайн (гармония, аккомпанемент, транспорт);
//   5) встроенный синтез (без банка из сети) доступен.
//
// Запуск: node tools/offline-check.mjs [url]        (по умолчанию http://127.0.0.1:3030/index.html)
// Требуется запущенный dev-сервер: node tools/serve.mjs --port=3030

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:3030/index.html';
const PORT = Number(process.env.OFFLINE_CHECK_PORT || 9336);
const TIMEOUT_MS = Number(process.env.OFFLINE_TIMEOUT_MS || 120000);

/**
 * Список оболочки и имя кэша берём у того приложения, которое реально проверяем: у собранного пакета
 * (dist/) своё имя кэша, а не то, что лежит в исходниках. Если сервер ещё не ответил — читаем из app/.
 */
async function readShell() {
  const fromNetwork = await fetch(new URL('service-worker.js', PAGE_URL))
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  const source = fromNetwork || readFileSync(join(ROOT, 'app', 'service-worker.js'), 'utf8');
  return {
    source,
    shell: [...source.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean),
    cacheName: (source.match(/fluteband-shell-[\w-]+/) || ['fluteband-shell'])[0],
    from: fromNetwork ? 'сервер' : 'app/service-worker.js',
  };
}

// Каталог приложения. На бесплатном хостинге это может быть подкаталог
// (https://имя.github.io/fluteband/), поэтому путь в кэше считается от него, а не от корня сайта.
const APP_BASE = new URL('./', PAGE_URL).pathname;
// Заполняются в main() из того приложения, которое проверяем
let SHELL = [];
let CACHE_NAME = 'fluteband-shell';

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((c) => existsSync(c)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Не найден Chrome/Edge. Укажите путь в переменной CHROME_PATH.');
  process.exit(2);
}

// Профиль каждый раз новый: кэш должен наполняться с нуля, иначе проверка ничего не доказывает
const profile = join(tmpdir(), `fluteband-offline-${Date.now().toString(36)}`);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let tab = null;
let socket = null;
const results = [];

function record(name, ok, value) {
  results.push({ name, ok, value });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function waitForDevtools() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* ещё не поднялся */
    }
    await delay(250);
  }
  throw new Error('Chrome не открыл порт отладки');
}

function connect(url) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolveConnect(ws), { once: true });
    ws.addEventListener('error', (event) => reject(new Error(`WebSocket: ${event.message || 'ошибка'}`)), { once: true });
  });
}

function makeSender(ws) {
  let counter = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolveSend) => {
      const id = (counter += 1);
      pending.set(id, resolveSend);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

/** Выполнить выражение на странице и вернуть значение (промисы дожидаются) */
async function evaluate(send, expression) {
  const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const details = answer?.result?.exceptionDetails;
  if (details) throw new Error(details.exception?.description || details.text || 'ошибка на странице');
  return answer?.result?.result?.value;
}

async function main() {
  const shellInfo = await readShell();
  SHELL = shellInfo.shell;
  CACHE_NAME = shellInfo.cacheName;
  const version = await waitForDevtools();
  console.log(`Chrome: ${version.Browser}`);
  console.log(`Страница: ${PAGE_URL}`);
  console.log(`Оболочка: ${CACHE_NAME}, файлов в списке: ${SHELL.length} (источник: ${shellInfo.from})\n`);

  const ping = await fetch(PAGE_URL).catch(() => null);
  if (!ping || !ping.ok) {
    console.error(`Приложение не отвечает: ${PAGE_URL}\nЗапустите: node tools/serve.mjs --port=3030`);
    process.exitCode = 2;
    return;
  }

  const opened = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: 'PUT' });
  tab = await opened.json();
  socket = await connect(tab.webSocketDebuggerUrl);
  const send = makeSender(socket);
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  // ── Онлайн: ждём установку service worker и наполнение кэша ────────────────
  const ready = await evaluate(send, `(async () => {
    if (!('serviceWorker' in navigator)) return { ok: false, reason: 'нет serviceWorker' };
    const reg = await navigator.serviceWorker.ready;
    return { ok: true, scope: reg.scope };
  })()`);
  record('service worker зарегистрирован', !!ready?.ok, ready);

  const appOnline = await evaluate(send, `(() => ({
    view: document.querySelector('#app')?.dataset?.view || globalThis.__flutebandView || null,
    hasLibrary: !!document.querySelector('#view-library'),
    hasScan: !!document.querySelector('#view-scan'),
    hasPlayer: !!document.querySelector('#view-player'),
  }))()`);
  record('приложение поднялось онлайн', !!(appOnline?.hasLibrary && appOnline?.hasScan && appOnline?.hasPlayer), appOnline);

  // Кэш наполняется в фоне: ждём, пока в нём окажется вся оболочка.
  // OFFLINE_REQUIRE_FULL_SHELL=0 — режим «не требовать все файлы»: так проверяют хостинг, который отдаёт
  // часть адресов перенаправлениями (Netlify с «красивыми адресами»). Тогда важно, что приложение
  // открывается без сети, а не что в кэше ровно 40 адресов.
  const REQUIRE_FULL_SHELL = process.env.OFFLINE_REQUIRE_FULL_SHELL !== '0';
  let cached = null;
  const cacheDeadline = Date.now() + 60000;
  while (Date.now() < cacheDeadline) {
    cached = await evaluate(send, `(async () => {
      const names = await caches.keys();
      const cache = await caches.open(${JSON.stringify(CACHE_NAME)});
      const keys = await cache.keys();
      const paths = keys.map((r) => new URL(r.url).pathname.replace(${JSON.stringify(APP_BASE)}, ''));
      const shell = ${JSON.stringify(SHELL)};
      const missing = shell.filter((entry) => !paths.includes(entry) && !paths.includes(entry.replace(/^$/, '')));
      return { caches: names, count: keys.length, missing };
    })()`);
    if (cached && (cached.missing.length === 0 || !REQUIRE_FULL_SHELL)) break;
    await delay(500);
  }
  const cacheOk = REQUIRE_FULL_SHELL ? !!cached && cached.missing.length === 0 : (cached?.count || 0) > 20;
  const cacheName = REQUIRE_FULL_SHELL ? 'оболочка целиком легла в кэш' : 'оболочка легла в кэш (без требования всех 40 адресов)';
  record(cacheName, cacheOk, cached && {
    cache: CACHE_NAME,
    files: cached.count,
    missing: cached.missing,
  });

  // Пьеса в библиотеке устройства (IndexedDB). Это то, что должно пережить отключение сети.
  const saved = await evaluate(send, `(async () => {
    const { clearScores, saveScore, listScores } = await import('./js/storage.js');
    const { demoById } = await import('./js/demo.js');
    await clearScores();
    const score = { ...demoById('demo-ode-to-joy'), id: 'offline-check', title: 'Офлайн-проверка' };
    await saveScore(score);
    const all = await listScores();
    return { count: all.length, title: all[0]?.title || null };
  })()`);
  record('пьеса сохранена на устройстве (IndexedDB)', saved?.count === 1, saved);

  // ── Офлайн: сеть выключена средствами Chrome ───────────────────────────────
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  record('сеть отключена (эмуляция Chrome)', true, 'offline: true');

  const reloaded = await send('Page.reload', { ignoreCache: false });
  if (reloaded?.error) record('перезагрузка страницы', false, reloaded.error);
  await delay(2500);

  const booted = await evaluate(send, `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const app = document.querySelector('#app');
      const player = document.querySelector('#view-player');
      if (app && app.children.length > 0 && player) {
        return {
          booted: true,
          controlled: !!navigator.serviceWorker.controller,
          sections: ['library', 'scan', 'player'].filter((name) => !!document.querySelector('#view-' + name)),
          online: navigator.onLine,
          title: document.title,
        };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { booted: false, online: navigator.onLine, title: document.title };
  })()`);
  record('приложение открылось без сети', !!booted?.booted, booted);
  record('страницей управляет service worker', !!booted?.controlled, { controller: booted?.controlled, navigatorOnline: booted?.online });

  const offlineLibrary = await evaluate(send, `(async () => {
    const { listScores } = await import('./js/storage.js');
    const all = await listScores();
    return { count: all.length, titles: all.map((s) => s.title) };
  })()`);
  record('сохранённая пьеса доступна офлайн', offlineLibrary?.count === 1, offlineLibrary);

  const offlineMinus = await evaluate(send, `(async () => {
    const { listScores } = await import('./js/storage.js');
    const { generateAccompaniment } = await import('./js/accompaniment.js');
    const [score] = await listScores();
    const accompaniment = generateAccompaniment(score, { style: 'auto', instrumentId: 'flute', includeMelody: false });
    return {
      measures: score.measures.length,
      events: accompaniment.events.length,
      style: accompaniment.style,
      totalBeats: accompaniment.totalBeats,
      warnings: accompaniment.warnings?.length || 0,
    };
  })()`);
  record('минус строится офлайн', (offlineMinus?.events || 0) > 0, offlineMinus);

  const offlineSynth = await evaluate(send, `(async () => {
    const { PianoSynth } = await import('./js/synth.js');
    const { BANKS, describeBank } = await import('./js/sampler.js');
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const synth = new PianoSynth(ctx);
    // Одна нота встроенным синтезом: офлайн он не требует ни одного запроса в сеть
    synth.noteOn(60, ctx.currentTime, 0.5, 0.6);
    const tone = describeBank('tone');
    const samples = performance.getEntriesByType('resource').filter((entry) => entry.name.indexOf('/samples/') >= 0);
    const result = {
      ctxState: ctx.state,
      engine: synth.engine,
      engines: BANKS.map((bank) => bank.id),
      toneName: tone ? tone.name : null,
      requests: samples.length,
    };
    await ctx.close?.();
    return result;
  })()`);
  record('встроенный синтез играет офлайн (без сети)', offlineSynth?.engine === 'tone' && offlineSynth?.requests === 0, offlineSynth);

  const cacheOffline = await evaluate(send, `(async () => {
    const names = await caches.keys();
    const cache = await caches.open(${JSON.stringify(CACHE_NAME)});
    const keys = await cache.keys();
    const paths = keys.map((r) => new URL(r.url).pathname.replace(${JSON.stringify(APP_BASE)}, ''));
    return {
      caches: names,
      files: keys.length,
      // Главная страница могла лечь в кэш под адресом «/» или «index.html» — смотря как её отдаёт хостинг
      hasIndex: paths.includes('index.html') || paths.includes(''),
    };
  })()`);
  record('кэш оболочки на месте офлайн', !!cacheOffline?.hasIndex && (cacheOffline?.files || 0) > 20, cacheOffline);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтог: ${failed.length ? 'FAIL' : 'OK'} — прошло ${results.length - failed.length}, провалено ${failed.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

try {
  await main();
} catch (error) {
  console.error(`Ошибка проверки: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    socket?.close();
  } catch {
    /* уже закрыт */
  }
  if (tab?.id) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
    } catch {
      /* вкладка уже закрыта */
    }
  }
  chrome.kill();
  await delay(200);
  if (results.length === 0) console.error(`Отчёт не сформирован; таймаут ${TIMEOUT_MS} мс`);
}