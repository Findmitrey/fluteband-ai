// FluteBand AI — генерация демонстрационной страницы нот для приложения.
//
// Зачем: камера работает только в защищённом контексте (localhost/HTTPS) и не всегда доступна,
// поэтому в приложении есть кнопка «Пример страницы». Она прогоняет через настоящее распознавание
// заранее отрисованную страницу «Оды к радости» — так можно проверить весь тракт без телефона.
//
// Запуск: node tools/make-demo-page.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from './find-chrome.mjs';
import { ODE_TO_JOY_MUSICXML } from '../app/js/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const WORK = join(ROOT, '.omr-bench');
const OUT = join(ROOT, 'app', 'demo', 'ode-page.png');
const SCALE = process.env.DEMO_SCALE || '55'; // мелкий масштаб движок распознавания читает неуверенно

const chrome = findChrome();
if (!chrome) {
  console.error('Не найден Chrome — нужен для растеризации страницы (переменная CHROME_PATH).');
  process.exit(2);
}

mkdirSync(WORK, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const source = join(WORK, 'demo-source.musicxml');
const svg = join(WORK, 'demo-source.svg');
writeFileSync(source, ODE_TO_JOY_MUSICXML, 'utf8');

const rendered = spawnSync('python', [
  join(ROOT, 'server', 'tools', 'render_svg.py'),
  source,
  svg,
  `--scale=${SCALE}`,
  '--full-page=0',
], { encoding: 'utf8', cwd: ROOT });
if (rendered.error) throw rendered.error;

const info = JSON.parse((rendered.stdout || '{}').trim().split('\n').pop() || '{}');
if (!info.ok) {
  console.error(`Гравировка не удалась: ${rendered.stderr?.slice(-400)}`);
  process.exit(1);
}

const width = info.width || 840;
const height = Math.max(info.height || 300, 500); // Chrome отдаёт пустой снимок при слишком низком окне
const shot = spawnSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-crash-reporter',
  '--no-first-run',
  `--user-data-dir=${join(WORK, 'chrome-profile-demo')}`,
  `--screenshot=${OUT}`,
  `--window-size=${width},${height}`,
  '--default-background-color=FFFFFFFF',
  pathToFileURL(svg).href,
], { encoding: 'utf8', cwd: ROOT, stdio: 'ignore' });
if (shot.error) throw shot.error;
if (!existsSync(OUT)) {
  console.error('Chrome не создал страницу');
  process.exit(1);
}

console.log(`Демо-страница: app/demo/ode-page.png (${width}×${height}, ${Math.round(existsSync(OUT) ? (await import('node:fs')).statSync(OUT).size / 1024 : 0)} КБ)`);
console.log('Пьеса на странице: «Ода к радости (фрагмент)», D-dur, 4/4, 4 такта — ожидаемый результат распознавания.');