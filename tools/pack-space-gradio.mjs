// FluteBand AI — сборка пакета сервиса распознавания для бесплатного Gradio-пространства Hugging Face.
//
// Зачем второй пакет. Docker-пространства на Hugging Face требуют платного плана (PRO), бесплатным
// остался только Gradio (до двух пространств на личный аккаунт, железо ZeroGPU). Наш сервис считает на
// процессоре, поэтому мы берём Gradio-пространство и монтируем в него свой FastAPI — маршруты
// /health, /engines и /recognize остаются теми же, что и в Docker-варианте (tools/pack-space.mjs).
//
// Что попадает в пакет:
//   app.py            — входная точка пространства (модели, FastAPI + страница Gradio, uvicorn)
//   requirements.txt  — зависимости (ставит Hugging Face при сборке)
//   packages.txt      — системные библиотеки для OpenCV (apt)
//   README.md         — шапка пространства: sdk: gradio, app_file, app_port
//   .gitattributes    — модели 142 МБ уезжают через git-lfs
//   service/          — наш код сервиса (main.py, engines.py, melody.py, fixtures/)
//   models/           — 3 файла ONNX движка homr (иначе они скачиваются после каждого пробуждения)
//   examples/         — маленькая демо-страница для вкладки App и прогрева движка
//
// Запуск: node tools/pack-space-gradio.mjs [--out=dist-space-gradio]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const SERVER = join(ROOT, 'server');
const TEMPLATE = join(SERVER, 'gradio-space');
const HOMR = join(SERVER, 'deps', 'homr');

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const OUT = resolve(ROOT, arg('out', 'dist-space-gradio'));
const PORT = 7860;

// В облако не едет ничего лишнего: локальные пакеты движка ставит само пространство
const SKIP = new Set(['deps', 'deps-gradio', 'gradio-space', '__pycache__', '.pytest_cache', '.omr-work', 'cache', 'node_modules', '.venv']);

// Из сервиса в Gradio-пакет идут только рабочие модули и эталонная страница для заглушки.
// Dockerfile и requirements.txt в пакете не нужны: их роль выполняют корневые файлы шаблона.
const SERVICE_MODULES = ['main.py', 'engines.py', 'melody.py'];

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

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

if (!existsSync(join(TEMPLATE, 'app.py')) || !existsSync(join(SERVER, 'main.py'))) {
  console.error('Не найдены server/gradio-space/app.py или server/main.py — собирать нечего.');
  process.exit(2);
}

rmSync(OUT, { recursive: true, force: true });

// 1. Наш код сервиса — в подкаталог service/, чтобы app.py остался единственным «входным» файлом
mkdirSync(join(OUT, 'service'), { recursive: true });
for (const module of SERVICE_MODULES) {
  if (!existsSync(join(SERVER, module))) {
    console.error(`Не найден server/${module} — сервис будет неполным.`);
    process.exit(2);
  }
  cpSync(join(SERVER, module), join(OUT, 'service', module));
}
copyFiltered(join(SERVER, 'fixtures'), join(OUT, 'service', 'fixtures'));

// 2. Шаблон пространства: app.py, requirements.txt, packages.txt + Dockerfile.test для локальной
// проверки (Hugging Face читает только файл с именем ровно `Dockerfile`, поэтому .test ему не мешает)
for (const file of ['app.py', 'requirements.txt', 'packages.txt', 'Dockerfile.test']) {
  cpSync(join(TEMPLATE, file), join(OUT, file));
}

// 3. Модели движка. homr ищет их рядом с собой, а на бесплатном тарифе диск непостоянный: без файлов
// в репозитории модели скачивались бы во время запроса (и, если запросов два, они бы мешали друг другу —
// это проверено на контейнере). Набор моделей зависит от ВЕРСИИ движка, а версия — от версии Python:
// в базовом образе Gradio-пространства Python 3.10, pip ставит там homr 0.6.2, и он ждёт модели 331
// (0.7.0 на Python 3.11 ждёт 396 — замерено запуском обеих версий). Версия закреплена в requirements.txt
// шаблона, поэтому здесь кладём ровно её набор: segnet 308 + encoder/decoder 331, без fp16 (видеокарты нет).
const MODEL_PREFIXES = ['segnet_308', 'encoder_pytorch_model_331', 'decoder_pytorch_model_331'];
const modelFiles = [];
for (const [folder, prefix] of [['segmentation', 'segnet_'], ['transformer', 'encoder_'], ['transformer', 'decoder_']]) {
  const dir = join(HOMR, folder);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.onnx') || entry.includes('_fp16')) continue;
    if (!entry.startsWith(prefix)) continue;
    if (!MODEL_PREFIXES.some((wanted) => entry.startsWith(wanted))) continue;
    mkdirSync(join(OUT, 'models'), { recursive: true });
    cpSync(join(dir, entry), join(OUT, 'models', entry));
    modelFiles.push(entry);
  }
}

// 4. Пример страницы для вкладки App и прогрева движка
const example = join(ROOT, 'app', 'demo', 'ode-page.png');
if (existsSync(example)) {
  mkdirSync(join(OUT, 'examples'), { recursive: true });
  cpSync(example, join(OUT, 'examples', basename(example)));
}

// 5. Шапка пространства. sdk: gradio — единственный бесплатный вариант; app_file указывает на app.py.
// Версию SDK намеренно не фиксируем: Hugging Face возьмёт свою текущую (у нас локально проверена
// gradio 6.28), а requirements.txt требует просто gradio>=5.
const modelBytes = modelFiles.reduce((sum, file) => sum + statSync(join(OUT, 'models', file)).size, 0);
const README = `---
title: FluteBand AI — распознавание нот
emoji: 🎼
colorFrom: indigo
colorTo: blue
sdk: gradio
app_file: app.py
app_port: ${PORT}
pinned: false
license: mit
---

# FluteBand AI — сервис распознавания нот

Превращает фото страницы с нотами в **MusicXML**, из которого приложение FluteBand AI строит минус.

Сервис бесплатный и с открытым кодом. Движок распознавания — [homr](https://github.com/liebharc/homr)
(ONNX, считает на процессоре, видеокарта не нужна). Пространство создано с SDK **Gradio**, потому что
у Hugging Face бесплатными остались только Gradio-пространства; наш FastAPI смонтирован внутрь
Gradio-приложения, поэтому REST-контракт такой же, как у Docker-варианта:

* \`GET /health\` — живость сервиса и список движков;
* \`GET /engines\` — какие движки доступны;
* \`POST /recognize\` — распознавание: \`multipart/form-data\`, поле \`image\`, необязательные поля
  \`engine\` и \`mode\` (\`full\` — вся страница, \`melody\` — только мелодический стан, в разы быстрее).

На вкладке **App** есть простая страница проверки: загрузите фото и получите MusicXML.

Модели движка (3 файла ONNX, ${(modelBytes / 1024 / 1024).toFixed(0)} МБ) лежат в этом репозитории через git-lfs, и это
принципиально: на бесплатном тарифе диск непостоянный, а скачивание моделей во время запроса ломало
распознавание, если рядом шёл второй запрос. Набор моделей соответствует версии движка, закреплённой
в \`requirements.txt\` (здесь Python 3.10, поэтому движок homr 0.6.2 и его модели 331), и при старте
пространство сверяет набор с тем, что движок ищет, — расхождение видно в журнале. Поэтому в облаке
не скачивается ничего. Первый запрос после «сна» всё равно дольше обычного — поднимаются модели и
сессии ONNX.

Приложение подключается к сервису по адресу вида \`https://имя-пространства.hf.space\`
(на экране «Сканировать» есть поле «Адрес сервиса распознавания»).
`;
writeFileSync(join(OUT, 'README.md'), README);

// 6. git-lfs: без него Hugging Face не примет файлы больше 10 МБ
const GITATTRIBUTES = `# Модели движка больше 10 МБ — Hugging Face принимает такие файлы только через git-lfs
models/*.onnx filter=lfs diff=lfs merge=lfs -text
`;
writeFileSync(join(OUT, '.gitattributes'), GITATTRIBUTES);

const files = walk(OUT);
const total = files.reduce((sum, file) => sum + statSync(join(OUT, file)).size, 0);
const requirements = readFileSync(join(OUT, 'requirements.txt'), 'utf8');
const packages = readFileSync(join(OUT, 'packages.txt'), 'utf8');
const appSource = readFileSync(join(OUT, 'app.py'), 'utf8');

const problems = [];
if (!files.includes('app.py')) problems.push('нет app.py — входной точки пространства');
if (!files.includes('service/main.py')) problems.push('нет service/main.py — сервиса распознавания');
if (!files.includes('service/engines.py')) problems.push('нет service/engines.py — движков');
if (!/^sdk:\s*gradio$/m.test(README)) problems.push('в README.md не указан sdk: gradio');
if (!/^app_file:\s*app\.py$/m.test(README)) problems.push('в README.md не указан app_file: app.py');
if (!new RegExp(`^app_port:\\s*${PORT}$`, 'm').test(README)) problems.push(`в README.md не указан app_port: ${PORT}`);
if (!/mount_gradio_app/.test(appSource)) problems.push('app.py не монтирует Gradio в наш FastAPI');
if (/\blocalhost\b|127\.0\.0\.1/.test(appSource)) problems.push('app.py слушает localhost — в облаке нужен 0.0.0.0');
if (!/homr/.test(requirements)) problems.push('requirements.txt не ставит движок homr');
// Версия движка определяет, какие файлы моделей он ищет (0.6.2 → 331, 0.7.0 → 396). Незакреплённая
// версия означала бы, что после обновления homr пространство начнёт скачивать свои модели в запросе.
if (!/^homr==/m.test(requirements)) problems.push('версия движка homr не закреплена — набор моделей может разъехаться с движком');
if (modelFiles.some((file) => file.includes('_396'))) problems.push('в пакет попал набор моделей 396 (это homr 0.7.0), а закреплён движок 0.6.2 — ему нужны модели 331');
if (!modelFiles.some((file) => file.startsWith('encoder_pytorch_model_331'))) problems.push('нет энкодера 331 — движок 0.6.2 его не найдёт и скачает сам');
if (!modelFiles.some((file) => file.startsWith('decoder_pytorch_model_331'))) problems.push('нет декодера 331 — движок 0.6.2 его не найдёт и скачает сам');
if (!/gradio/.test(requirements)) problems.push('requirements.txt не ставит gradio');
if (!/fastapi/.test(requirements)) problems.push('requirements.txt не ставит fastapi');
if (!/libgl1/.test(packages)) problems.push('packages.txt не ставит libgl1 (OpenCV не заработает)');
// ВАЖНО: Hugging Face ставит эти пакеты командой «xargs -r -a packages.txt apt-get install -y» — каждое
// слово в файле становится именем пакета. Пояснительный комментарий здесь превращается в пакеты «#»,
// «FluteBand», «AI»…, и сборка пространства падает с «Unable to locate package #» (проверено настоящей
// сборкой). Поэтому в packages.txt допустимы только имена пакетов — по одному в строке, без пояснений.
for (const [index, line] of packages.split('\n').entries()) {
  const text = line.trim();
  if (!text) continue;
  if (!/^[a-z0-9][a-z0-9+._-]*$/.test(text)) {
    problems.push(`packages.txt, строка ${index + 1}: «${text}» — это не имя пакета (пояснения здесь запрещены: файл читает xargs)`);
  }
}
if (!/^\s*models\/\*\.onnx\s+filter=lfs/m.test(GITATTRIBUTES)) problems.push('нет правила git-lfs для моделей');
if (modelFiles.length !== 3) problems.push(`моделей в пакете ${modelFiles.length}, ожидалось 3 (segnet, encoder, decoder)`);
if (modelFiles.some((file) => file.includes('_fp16'))) problems.push('в пакет попал набор fp16 — пространство работает на процессоре и берёт fp32');
if (!modelFiles.some((file) => file.startsWith('segnet_'))) problems.push('нет модели разбора станов (segnet)');
if (!modelFiles.some((file) => file.startsWith('encoder_'))) problems.push('нет энкодера трансформера');
if (!modelFiles.some((file) => file.startsWith('decoder_'))) problems.push('нет декодера трансформера');
if (!/def check_models\(/.test(appSource)) problems.push('app.py не сверяет набор моделей с тем, что ждёт версия движка');
// Серверный рендеринг: при GRADIO_SSR_MODE=true (его включает Hugging Face) mount_gradio_app сам поднимает
// Node-сервер, а тот по умолчанию занимает порт 7860 (gradio/node_server.py: INITIAL_PORT_VALUE=7860) —
// нашему uvicorn порт не достаётся, пространство падает с «address already in use» и уходит в перезапуск.
if (!/ssr_mode=False/.test(appSource)) problems.push('app.py монтирует страницу Gradio с серверным рендерингом: Gradio займёт порт 7860 и сервис не запустится');
// Железо: сервис процессорный, поэтому пространству подходит CPU basic (бесплатный, без видеокарты).
// Среда ZeroGPU отказывается запускать пространство без функции с @spaces.GPU среди обработчиков страницы
// («No @spaces.GPU function detected during startup»). Пометка устроена так (spaces/zero/decorator.py):
// на ZeroGPU декоратор ставит обёртке атрибут `zerogpu`, и среда видит его в `blocks.fns[*].fn` — проверено
// в образе с SPACES_ZERO_GPU=true. Поэтому помечен обработчик вкладки «Состояние сервиса», а распознавание
// нет: оно считает на процессоре, и телефонный путь /recognize видеокарту не трогает. Импорт защищён, а на
// процессорном железе пометка становится пустой — иначе сервис упал бы там, где пакета `spaces` нет.
if (!/@spaces\.GPU/.test(appSource)) problems.push('в app.py нет пометки @spaces.GPU для обработчика страницы: среда ZeroGPU не запустит пространство');
if (!/fn=service_state/.test(appSource)) problems.push('помеченная функция не отдана Gradio: среда ищет пометку в blocks.fns[*].fn, а не в модуле');
if (!/class _SpacesOnCpu/.test(appSource) || !/return task if task is not None else/.test(appSource)) problems.push('нет замены пакета spaces для процессорного железа: пометка @spaces.GPU уронит сервис без пакета');
if (!/except Exception:[\s\S]{0,300}ZERO_GPU = False/.test(appSource)) problems.push('импорт spaces не защищён: на процессорном железе сервис упадёт');
if (!/ZERO_GPU/.test(appSource)) problems.push('app.py не сообщает в журнал, на каком железе он работает');
if (/@spaces\.GPU\s*\ndef recognize_from_ui/.test(appSource)) problems.push('распознавание помечено @spaces.GPU: оно считает на процессоре и не должно занимать видеокарту');

// Локальная проверка должна повторять условия облака, иначе она пропускает целые классы ошибок
const dockerTestSource = readFileSync(join(OUT, 'Dockerfile.test'), 'utf8');
if (!/python:3\.10\.13-slim/.test(dockerTestSource)) problems.push('Dockerfile.test собран не на Python 3.10.13: на другой версии ставится другой homr и другой набор моделей');
if (!/GRADIO_SSR_MODE=true/.test(dockerTestSource)) problems.push('Dockerfile.test не включает серверный рендеринг: ошибку с занятым портом 7860 он не поймает');
if (!/apt-get install -y nodejs/.test(dockerTestSource)) problems.push('Dockerfile.test не ставит Node 20, без него серверный рендеринг не воспроизведётся');
if (!/pip install --no-cache-dir spaces/.test(dockerTestSource)) problems.push('Dockerfile.test не ставит пакет spaces: проверка не повторит среду ZeroGPU');
if (files.some((file) => file.startsWith('service/deps/'))) problems.push('в пакет попали локальные пакеты server/deps (1 ГБ)');
if (files.some((file) => file === 'Dockerfile')) problems.push('в Gradio-пакет попал Dockerfile — он бы сбил Hugging Face с толку');
if (!files.includes('Dockerfile.test')) problems.push('нет Dockerfile.test — нечем проверить пакет локально');

if (problems.length) {
  console.error('Пакет Gradio-пространства собран неверно:');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log(`Готово: ${relative(ROOT, OUT).split('\\').join('/')} — ${files.length} файлов, ${(total / 1024 / 1024).toFixed(1)} МБ`);
console.log(`Модели движка в пакете: ${modelFiles.length} файла, ${(modelBytes / 1024 / 1024).toFixed(1)} МБ (набор fp32 для процессора, уезжают через git-lfs)`);
console.log(`Порт пространства: ${PORT} (совпадает с app_port в README.md)`);
console.log('\nКак выложить (подробно — docs/05-publikaciya.md):');
console.log('  1) huggingface.co → New Space → SDK: Gradio → шаблон Blank → Public → Create');
console.log('     (Storage Bucket не нужен: сервис ничего не хранит, модели лежат в репозитории)');
console.log('  2) git clone https://huggingface.co/spaces/<логин>/<пространство> space && cd space');
console.log('     git lfs install      # один раз на машине, git-lfs 3.7 уже установлен');
console.log(`     скопировать сюда содержимое ${relative(ROOT, OUT).split('\\').join('/')} && git add -A && git commit -m "FluteBand AI: сервис распознавания" && git push`);
console.log('  3) дождаться сборки, открыть https://<пространство>.hf.space/health');
console.log('  4) в приложении на экране «Сканировать» вписать адрес сервиса и нажать «Проверить»');
console.log('\nПроверить пакет локально (как на бесплатном тарифе — 2 ядра):');
console.log(`  docker build -f ${relative(ROOT, OUT).split('\\').join('/')}/Dockerfile.test -t fluteband-gradio ${relative(ROOT, OUT).split('\\').join('/')}`);
console.log('  docker run --rm -p 7860:7860 --cpus=2 --memory=4g fluteband-gradio');
console.log('  curl http://127.0.0.1:7860/health');