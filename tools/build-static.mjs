// FluteBand AI — сборка статического пакета приложения для бесплатного хостинга.
//
// Собирает папку `dist/` из `app/` — ровно то, что выкладывается на Cloudflare Pages или GitHub Pages,
// и проверяет три вещи, которые ломают выкладку:
//   1) список офлайн-оболочки в service-worker.js совпадает с файлами на диске (иначе офлайн отвалится);
//   2) нигде нет путей от корня сайта (`/js/app.js`): приложение должно работать в подкаталоге
//      (например, https://имя.github.io/fluteband/), где корень сайта — чужой;
//   3) `dist/` содержит все файлы и не тянет ничего из репозитория помимо `app/`.
//
// Запуск: node tools/build-static.mjs [--out=dist] [--site=https://имя.github.io/fluteband/]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const APP = join(ROOT, 'app');

const arg = (name, fallback = null) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};

const OUT = resolve(ROOT, arg('out', 'dist'));
const SITE = arg('site', null);

/** Список офлайн-оболочки прямо из service worker — он и есть перечень нужных для офлайна файлов. */
function shellFiles() {
  const source = readFileSync(join(APP, 'service-worker.js'), 'utf8');
  const block = source.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('в service-worker.js не найден список SHELL');
  return [...block[1].matchAll(/'\.\/([^']*)'/g)].map((match) => match[1]).filter(Boolean);
}

/** Все файлы папки (относительные пути). */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/**
 * Пути от корня сайта. Приложение ставится в подкаталог, поэтому `src="/js/app.js"` уедет в чужой корень.
 * Ищем только то, что реально используется для загрузки: атрибуты src/href, импорты, fetch и адреса в CSS.
 */
function absolutePaths(files) {
  const findings = [];
  const patterns = [
    { re: /\b(?:src|href)\s*=\s*["']\/(?!\/)/g, what: 'атрибут src/href' },
    { re: /\bfrom\s+["']\/(?!\/)/g, what: 'импорт' },
    { re: /\bimport\s*\(\s*["']\/(?!\/)/g, what: 'динамический импорт' },
    { re: /\bfetch\s*\(\s*["'`]\/(?!\/)/g, what: 'fetch' },
    { re: /url\(\s*["']?\/(?!\/)/g, what: 'url() в CSS' },
  ];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!['.html', '.js', '.css', '.webmanifest'].includes(ext)) continue;
    const text = readFileSync(join(APP, file), 'utf8');
    for (const { re, what } of patterns) {
      re.lastIndex = 0;
      let match = re.exec(text);
      while (match) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${file}:${line} — ${what}: ${text.slice(match.index, match.index + 60).split('\n')[0].trim()}`);
        match = re.exec(text);
      }
    }
  }
  return findings;
}

const problems = [];
const files = walk(APP);

const shell = shellFiles();
const missingShell = shell.filter((item) => !existsSync(join(APP, item)));
if (missingShell.length) problems.push(`в офлайн-оболочке указаны отсутствующие файлы: ${missingShell.join(', ')}`);

// Сам service worker в свой список не входит (его кэширует браузер), страницы самоконтроля — тоже:
// им офлайн не нужен.
const notRequiringCache = (file) => file === 'service-worker.js' || file.startsWith('diagnostics');
const orphans = files.filter((file) => file.endsWith('.js') && !shell.includes(file) && !notRequiringCache(file));
if (orphans.length) {
  problems.push(`модули есть в app/, но их нет в офлайн-оболочке (офлайн их не получит): ${orphans.join(', ')}`);
}

const absolute = absolutePaths(files);
if (absolute.length) problems.push(`пути от корня сайта (сломаются в подкаталоге):\n    ${absolute.join('\n    ')}`);

if (problems.length) {
  console.error('Сборка остановлена:');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(APP, OUT, { recursive: true });
// GitHub Pages (Jekyll) иначе выбрасывает файлы и папки, начинающиеся с подчёркивания
writeFileSync(join(OUT, '.nojekyll'), '');

// Заголовки для хостингов, которые читают их из папки публикации (Netlify, Cloudflare Pages).
// Нужны в первую очередь при выкладке готовой папки, когда netlify.toml не используется.
writeFileSync(join(OUT, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '',
  '/service-worker.js',
  '  Cache-Control: no-cache, no-store, must-revalidate',
  '',
  '/manifest.webmanifest',
  '  Content-Type: application/manifest+json; charset=utf-8',
  '',
].join('\n'));

// Имя кэша офлайн-оболочки привязываем к содержимому пакета: после выпуска новой версии браузер
// не отдаёт ученику старую оболочку из кэша. При том же содержимом имя не меняется.
const buildFiles = new Set(['service-worker.js', '_headers', '.nojekyll']); // служебные файлы хостинга
const shellBytes = walk(OUT)
  .filter((file) => !buildFiles.has(file))
  .sort()
  .map((file) => `${file}:${createHash('sha256').update(readFileSync(join(OUT, file))).digest('hex')}`)
  .join('\n');
const cacheName = `fluteband-shell-${createHash('sha256').update(shellBytes).digest('hex').slice(0, 10)}`;
const workerPath = join(OUT, 'service-worker.js');
const workerSource = readFileSync(workerPath, 'utf8');
const renamed = workerSource.replace(/const CACHE = '[^']*';/, `const CACHE = '${cacheName}';`);
if (renamed === workerSource) {
  console.error('Не удалось обновить имя кэша в service-worker.js — проверьте строку «const CACHE».');
  process.exit(1);
}
writeFileSync(workerPath, renamed);

const built = walk(OUT);
const total = built.reduce((sum, file) => sum + statSync(join(OUT, file)).size, 0);
const biggest = built
  .map((file) => ({ file, size: statSync(join(OUT, file)).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 5);

console.log(`Готово: ${relative(ROOT, OUT).split('\\').join('/')} — ${built.length} файлов, ${(total / 1024 / 1024).toFixed(2)} МБ`);
console.log(`Офлайн-оболочка: ${shell.length} записей, все файлы на месте, кэш «${cacheName}»`);
console.log('Самые крупные файлы:');
for (const item of biggest) console.log(`  ${(item.size / 1024).toFixed(0)} КБ — ${item.file}`);
console.log(`Путей от корня сайта: не найдено (приложение работает и в подкаталоге)`);
if (SITE) {
  const base = SITE.replace(/\/+$/, '');
  console.log('\nПроверить перед выкладкой:');
  console.log(`  node tools/static-check.mjs --prefix=${new URL(base).pathname.replace(/\/$/, '')}/`);
  console.log(`  после выкладки: ${base}/index.html`);
} else {
  console.log('\nДальше:');
  console.log('  node tools/static-check.mjs            # проверить пакет как на хостинге в подкаталоге');
  console.log('  npm run check:offline                  # проверить офлайн-оболочку (нужен dev-сервер)');
}
console.log('\nКуда выкладывать: docs/05-publikaciya.md (Cloudflare Pages или GitHub Pages, бесплатно).');