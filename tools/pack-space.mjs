// FluteBand AI — сборка пакета сервиса распознавания для бесплатного облака (Hugging Face Spaces, Docker).
//
// Сервис — это Python + ONNX-движок homr, на статическом хостинге он жить не может, поэтому у него
// отдельная площадка. Spaces ждёт в репозитории `Dockerfile` и `README.md` с YAML-шапкой (sdk: docker,
// app_port: 7860) — этот шаг их и собирает в папку `dist-space/`, готовую к загрузке.
//
// Запуск: node tools/pack-space.mjs [--out=dist-space]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const SERVER = join(ROOT, 'server');

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const OUT = resolve(ROOT, arg('out', 'dist-space'));

// В облако не едет ничего лишнего: локальные пакеты движка (1 ГБ) ставит сам образ, кэши — тоже
const SKIP = new Set(['deps', '__pycache__', '.pytest_cache', '.omr-work', 'cache', 'node_modules', '.venv']);

function copyFiltered(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyFiltered(source, target);
    else cpSync(source, target);
  }
}

if (!existsSync(join(SERVER, 'main.py')) || !existsSync(join(SERVER, 'Dockerfile'))) {
  console.error('Не найдены server/main.py или server/Dockerfile — собирать нечего.');
  process.exit(2);
}

const dockerfile = readFileSync(join(SERVER, 'Dockerfile'), 'utf8');
const exposed = Number((dockerfile.match(/EXPOSE\s+(\d+)/) || [])[1] || 0);
const port = Number((dockerfile.match(/PORT=(\d+)/) || [])[1] || exposed);
const installsEngine = /pip install[^\n]*homr/.test(dockerfile);
// Модели лучше скачать на сборке (homr --init): иначе первый запрос ученика ждёт загрузки, а на
// бесплатном тарифе это заметная задержка после каждого пробуждения контейнера
const downloadsModels = /homr\.main import main[^\n]*--init/.test(dockerfile);
const runsAsUser = /^USER\s+\w+/m.test(dockerfile);

rmSync(OUT, { recursive: true, force: true });
copyFiltered(SERVER, OUT);

const FRONT_MATTER = `---
title: FluteBand AI — распознавание нот
emoji: 🎼
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: ${port}
pinned: false
license: mit
---

# FluteBand AI — сервис распознавания нот

Превращает фото страницы с нотами в **MusicXML**, из которого приложение FluteBand AI строит минус.

Сервис бесплатный и с открытым кодом. Движок распознавания — [homr](https://github.com/liebharc/homr) (ONNX, CPU).
Первый запрос после запуска дольше обычного: движок скачивает модели в кэш контейнера.

Проверка живости: \`GET /health\`, список движков: \`GET /engines\`, распознавание: \`POST /recognize\`
(multipart, поле \`image\`).

Приложение подключается к сервису по адресу вида \`https://имя-пространства.hf.space\`
(на экране «Сканировать» есть поле «Адрес сервиса распознавания»).
`;
writeFileSync(join(OUT, 'README.md'), FRONT_MATTER);

const DOCKERIGNORE = `deps/
__pycache__/
*.pyc
.omr-work/
cache/
.pytest_cache/
tests/
`;
writeFileSync(join(OUT, '.dockerignore'), DOCKERIGNORE);

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

const files = walk(OUT);
const total = files.reduce((sum, file) => sum + statSync(join(OUT, file)).size, 0);
const problems = [];
if (!files.includes('main.py')) problems.push('нет main.py');
if (!files.includes('Dockerfile')) problems.push('нет Dockerfile');
if (!files.some((file) => file === 'requirements.txt')) problems.push('нет requirements.txt');
if (!installsEngine) problems.push('образ не ставит движок homr — сервис умел бы только заглушку');
if (!downloadsModels) problems.push('модели не скачиваются на сборке (homr --init) — первый запрос ученика будет ждать загрузки');
if (!runsAsUser) problems.push('контейнер запускается от root — бесплатные тарифы этого не любят');
if (!port) problems.push('в Dockerfile не найден порт (EXPOSE/PORT)');
if (files.some((file) => file.startsWith('deps/'))) problems.push('в пакет попали локальные пакеты server/deps (1 ГБ)');

if (problems.length) {
  console.error('Пакет сервиса собран неверно:');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log(`Готово: ${relative(ROOT, OUT).split('\\').join('/')} — ${files.length} файлов, ${(total / 1024).toFixed(0)} КБ`);
console.log(`Порт контейнера: ${port} (совпадает с app_port в README.md)`);
console.log('Движок homr ставится в образ, контейнер работает не от root.');
console.log('\nКак выложить (подробно — docs/05-publikaciya.md):');
console.log('  1) huggingface.co → New Space → SDK: Docker → Free CPU (2 vCPU, 16 ГБ)');
console.log('  2) скопировать содержимое папки в репозиторий пространства (git clone … && copy && git push)');
console.log('  3) дождаться сборки образа, открыть https://<пространство>.hf.space/health');
console.log('  4) в приложении на экране «Сканировать» вписать адрес сервиса и нажать «Проверить»');
console.log('\nПроверить образ локально (как на бесплатном тарифе — 2 ядра):');
console.log(`  docker build -t fluteband-omr ${relative(ROOT, OUT).split('\\').join('/')}`);
console.log('  docker run --rm -p 7860:7860 --cpus=2 --memory=4g fluteband-omr');