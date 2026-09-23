// FluteBand AI — браузерный самоконтроль через Chrome DevTools Protocol.
// Запускает headless Chrome, открывает app/diagnostics.html и ждёт реального результата
// (в отличие от --virtual-time-budget, который не дожидается настоящего рендера звука).
//
// Запуск:  node tools/selfcheck.mjs [url]
// Переменные: CHROME_PATH, SELFCHECK_PORT, SELFTEST_TIMEOUT_MS

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PAGE_URL = process.argv[2] || 'http://127.0.0.1:3030/diagnostics.html';
const PORT = Number(process.env.SELFCHECK_PORT || 9333);
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS || 180000);

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => existsSync(c)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Не найден Chrome/Edge. Укажите путь в переменной CHROME_PATH.');
  process.exit(2);
}

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
    // Профиль каждый раз новый: иначе service worker отдаёт закэшированную старую оболочку
    `--user-data-dir=${join(tmpdir(), `fluteband-cdp-${Date.now().toString(36)}`)}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let tab = null;
let socket = null;

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
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
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
    new Promise((resolve) => {
      const id = (counter += 1);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
  const version = await waitForDevtools();
  console.log(`Chrome: ${version.Browser}`);

  const opened = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: 'PUT' });
  tab = await opened.json();
  socket = await connect(tab.webSocketDebuggerUrl);
  const send = makeSender(socket);
  await send('Runtime.enable');

  const deadline = Date.now() + TIMEOUT_MS;
  let payload = null;
  while (Date.now() < deadline) {
    const evaluated = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.title, text: document.querySelector('#result')?.textContent || '' })`,
      returnByValue: true,
      awaitPromise: false,
    });
    const raw = evaluated?.result?.result?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.title.includes('SELFCHECK: OK') || parsed.title.includes('SELFCHECK: FAIL')) {
        payload = parsed;
        break;
      }
    }
    await delay(400);
  }

  if (!payload) {
    console.error('Самоконтроль не завершился за отведённое время');
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(payload.text);
  } catch {
    console.log(payload.text);
    console.error('Не удалось разобрать результат самоконтроля');
    process.exitCode = 1;
    return;
  }

  console.log(`\nИтог: ${data.verdict} — прошло ${data.passed}, провалено ${data.failed}`);
  console.log(`Защищённый контекст: ${data.secureContext}`);
  for (const item of data.results) {
    const mark = item.ok ? 'OK  ' : 'FAIL';
    const critical = item.critical ? '' : ' (не критично)';
    const detail = item.ok ? JSON.stringify(item.value) : item.error;
    console.log(`${mark} ${item.name}${critical}: ${detail}`);
  }
  process.exitCode = data.verdict === 'OK' ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(`Ошибка самоконтроля: ${error.message}`);
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
}