// FluteBand AI — отрисовать минус демо-пьесы двумя инструментами и сохранить WAV для прослушивания.
// Нужен, потому что качество звука нельзя измерить тестом: файлы сравнивает человек на слух.
//
// Запуск: node tools/render-demo-wav.mjs [url]
// Переменные: CHROME_PATH, RENDER_PORT, RENDER_BANK (royal|compact), APP_FIXTURE (ode|two-voice)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:3030/index.html';
const PORT = Number(process.env.RENDER_PORT || 9334);
const BANK = process.env.RENDER_BANK || 'royal';
const FIXTURE = process.env.APP_FIXTURE || 'ODE_TO_JOY_MUSICXML';
const OUT_DIR = join(ROOT, 'artifacts');

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((path) => existsSync(path)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Не найден Chrome. Укажите путь в переменной CHROME_PATH.');
  process.exit(2);
}

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(tmpdir(), `fluteband-render-${Date.now().toString(36)}`)}`,
  'about:blank',
], { stdio: 'ignore' });

let socket = null;
let tab = null;

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
    ws.addEventListener('error', () => reject(new Error('WebSocket недоступен')), { once: true });
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
  return (method, params = {}) => new Promise((resolve) => {
    const id = (counter += 1);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Скрипт выполняется в браузере: там есть и банк, и Web Audio.
 *  Файлы сохраняются штатным скачиванием приложения, чтобы не гонять мегабайты через отладчик. */
function pageScript() {
  return `(async () => {
    const { ${FIXTURE}: xml } = await import('./js/fixtures.js');
    const { musicXmlToScore } = await import('./js/musicxml.js');
    const { generateAccompaniment } = await import('./js/accompaniment.js');
    const { PianoSynth } = await import('./js/synth.js');
    const { renderEvents, downloadBlob } = await import('./js/wav-render.js');
    const { encodeWav, analyzeChannels, bandEnergy } = await import('./js/wav.js');

    const score = musicXmlToScore(xml, { kind: 'demo', engine: 'эталон' });
    const accompaniment = generateAccompaniment(score, {
      style: 'auto', instrumentId: 'flute', includeMelody: false, tempo: score.tempo, dynamics: 0.8,
    });

    const ctx = new AudioContext();
    const synth = new PianoSynth(ctx, { volume: 0.9 });
    let missing = 0;
    const bank = await synth.loadBank(${JSON.stringify(BANK)}, {
      getBytes: async (note) => {
        const res = await fetch(note.url);
        if (!res.ok) { missing += 1; throw new Error('HTTP ' + res.status); }
        return res.arrayBuffer();
      },
    });

    const options = { events: accompaniment.events, tempo: score.tempo, totalBeats: accompaniment.totalBeats, volume: 0.9 };
    const sampled = await renderEvents({ ...options, buffers: synth.getBuffers(), bankId: ${JSON.stringify(BANK)}, synth });
    const tone = await renderEvents(options);

    const save = (rendered, name) => {
      const bytes = encodeWav(rendered.channels, rendered.sampleRate);
      downloadBlob(new Blob([bytes], { type: 'audio/wav' }), name);
      return {
        name,
        bytes: bytes.length,
        metrics: analyzeChannels(rendered.channels),
        bands: bandEnergy(rendered.channels, rendered.sampleRate),
        engine: rendered.engineName,
        samples: rendered.samples || 0,
        seconds: rendered.seconds,
      };
    };

    const savedSampled = save(sampled, 'minus-${BANK}.wav');
    const savedTone = save(tone, 'minus-synth.wav');

    return JSON.stringify({
      title: score.title,
      tempo: score.tempo,
      meter: score.meter.beats + '/' + score.meter.beatType,
      events: accompaniment.events.length,
      totalBeats: accompaniment.totalBeats,
      bank: { ...bank, missing },
      files: [savedSampled, savedTone],
    });
  })()`;
}

async function main() {
  const version = await waitForDevtools();
  console.log(`Chrome: ${version.Browser}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const opened = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: 'PUT' });
  tab = await opened.json();
  socket = await connect(tab.webSocketDebuggerUrl);
  const send = makeSender(socket);
  await send('Runtime.enable');
  // Разрешаем странице сохранять файлы прямо в папку artifacts
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR, eventsEnabled: true });

  // Ждём загрузку модулей приложения
  for (let i = 0; i < 30; i += 1) {
    const ready = await send('Runtime.evaluate', {
      expression: `document.readyState === 'complete' && !!document.querySelector('#app')`,
      returnByValue: true,
    });
    if (ready?.result?.result?.value) break;
    await delay(300);
  }

  console.log(`Банк: ${BANK}, пьеса: ${FIXTURE}`);
  const evaluated = await send('Runtime.evaluate', {
    expression: pageScript(),
    returnByValue: true,
    awaitPromise: true,
    timeout: 600000,
  });

  const raw = evaluated?.result?.result?.value;
  if (!raw || typeof raw !== 'string') {
    const details = evaluated?.result?.exceptionDetails;
    const description = details?.exception?.description || details?.text || JSON.stringify(evaluated).slice(0, 800);
    throw new Error(`Не удалось отрисовать звук: ${description}`);
  }
  const data = JSON.parse(raw);

  // Ждём, пока браузер допишет файлы на диск
  const written = [];
  for (const file of data.files) {
    const path = join(OUT_DIR, file.name);
    const deadline = Date.now() + 60000;
    let size = 0;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        size = statSync(path).size;
        if (size >= file.bytes) break;
      }
      await delay(300);
    }
    written.push({ ...file, path, size });
  }

  console.log(`\nПьеса: ${data.title} · ${data.meter} · ♩=${data.tempo} · событий ${data.events} · ${data.totalBeats} долей`);
  console.log(`Банк: ${data.bank.title || data.bank.bank} — нот ${data.bank.notes}, пропущено ${data.bank.missing}`);
  for (const file of written) {
    const ok = file.size >= file.bytes ? '' : ' (файл не дописан!)';
    console.log(
      `  ${file.name}: ${(file.size / 1024).toFixed(0)} КБ · ${file.engine}`
      + `${file.samples ? ` (${file.samples} сэмплов)` : ''} · пик ${file.metrics.peak} · RMS ${file.metrics.rms}`
      + ` · ${file.metrics.nonSilentRatio * 100}% не тишина · ${file.seconds} с${ok}`,
    );
    console.log(
      `    полосы: низ ${(file.bands.low * 100).toFixed(0)}% · середина ${(file.bands.mid * 100).toFixed(0)}%`
      + ` · верх ${(file.bands.high * 100).toFixed(0)}% · яркость ≈ ${file.bands.centroidHz} Гц`,
    );
  }
  console.log(`Файлы для прослушивания: ${OUT_DIR}`);
  if (written.some((file) => file.size < file.bytes)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`Ошибка отрисовки: ${error.message}`);
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