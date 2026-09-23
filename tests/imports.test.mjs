// FluteBand AI — смоук-тест всего графа модулей (включая браузерный слой) и офлайн-оболочки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '..', 'app');

test('все модули ядра и браузерного слоя импортируются без DOM', async () => {
  const core = [
    'pitch', 'chords', 'harmony', 'transpose', 'tempo', 'timeline', 'accompaniment',
    'midi', 'wav', 'xml', 'musicxml', 'score', 'demo', 'fixtures', 'manual', 'ui-strings',
  ];
  for (const name of core) {
    const mod = await import(`../app/js/${name}.js`);
    assert.ok(Object.keys(mod).length > 0, `${name}.js не экспортирует ничего`);
  }

  const browser = ['storage', 'synth', 'transport', 'pianola', 'camera', 'recognition', 'wav-render', 'image-stats', 'perspective', 'image-prep', 'sampler', 'score-fixes', 'library-index', 'score-pages'];
  for (const name of browser) {
    const mod = await import(`../app/js/${name}.js`);
    assert.ok(Object.keys(mod).length > 0, `${name}.js не экспортирует ничего`);
  }

  const views = await Promise.all([
    import('../app/js/views/library.js'),
    import('../app/js/views/scan.js'),
    import('../app/js/views/player.js'),
  ]);
  assert.equal(typeof views[0].LibraryView, 'function');
  assert.equal(typeof views[1].ScanView, 'function');
  assert.equal(typeof views[2].PlayerView, 'function');

  const app = await import('../app/js/app.js');
  assert.equal(typeof app.FluteBandApp, 'function');
  assert.equal(typeof app.bootstrap, 'function');
});

test('ключевые API на месте и согласованы', async () => {
  const { PianoSynth, DEFAULT_SOUNDFONT_BASE } = await import('../app/js/synth.js');
  const { Transport } = await import('../app/js/transport.js');
  const { Pianola } = await import('../app/js/pianola.js');
  const { generateAccompaniment, STYLES } = await import('../app/js/accompaniment.js');
  const { INSTRUMENTS, getInstrument, accompanimentShift } = await import('../app/js/transpose.js');
  const { S, semitonesText, measuresText, plural } = await import('../app/js/ui-strings.js');

  assert.equal(typeof PianoSynth, 'function');
  assert.ok(DEFAULT_SOUNDFONT_BASE.startsWith('https://'));
  assert.equal(typeof Transport, 'function');
  assert.equal(typeof Pianola, 'function');
  assert.equal(typeof generateAccompaniment, 'function');

  // у каждого стиля из UI есть реализация рисунка
  const { patternSlots } = await import('../app/js/accompaniment.js');
  for (const style of STYLES) {
    if (style.id === 'auto') continue;
    assert.ok(patternSlots(style.id, 4).length > 0, `нет рисунка для стиля ${style.id}`);
  }

  // профили инструментов: флейта без сдвига, транспонирующие — со сдвигом
  assert.equal(getInstrument('flute').semitones, 0);
  assert.ok(INSTRUMENTS.every((i) => Number.isFinite(i.semitones)));
  assert.equal(accompanimentShift('clarinet-bb'), -2);

  // русские строки и склонения
  assert.equal(S.tabPlayer, 'Минус');
  assert.equal(plural(1, 'такт', 'такта', 'тактов'), 'такт');
  assert.equal(plural(3, 'такт', 'такта', 'тактов'), 'такта');
  assert.equal(plural(5, 'такт', 'такта', 'тактов'), 'тактов');
  assert.equal(plural(11, 'такт', 'такта', 'тактов'), 'тактов');
  assert.equal(plural(21, 'такт', 'такта', 'тактов'), 'такт');
  assert.equal(measuresText(3), '3 такта');
  assert.ok(semitonesText(-2).includes('2 полутона'));
});

test('офлайн-оболочка: все файлы из service worker существуют', async () => {
  const sw = await readFile(join(APP, 'service-worker.js'), 'utf8');
  const paths = [...sw.matchAll(/'\.\/([^']*)'/g)]
    .map((m) => m[1])
    .filter((p) => p && p !== '')
    .filter((p) => !p.includes('*'));
  assert.ok(paths.length >= 25, `слишком мало файлов в оболочке: ${paths.length}`);
  for (const relative of paths) {
    const full = join(APP, relative);
    const info = await stat(full).catch(() => null);
    assert.ok(info?.isFile(), `в офлайн-оболочке указан отсутствующий файл: ${relative}`);
  }
});

test('MusicXML: экспорт и разбор сходятся (round-trip)', async () => {
  const { musicXmlToScore, scoreToMusicXml } = await import('../app/js/musicxml.js');
  const { ODE_TO_JOY_MUSICXML } = await import('../app/js/fixtures.js');
  const source = musicXmlToScore(ODE_TO_JOY_MUSICXML);
  const xml = scoreToMusicXml(source);
  const back = musicXmlToScore(xml);
  const flatten = (score) =>
    score.measures
      .flatMap((m, i) => m.events.flatMap((e) => e.pitches.map((p) => `${i}:${e.beat}:${p}:${e.dur}`)))
      .join('|');
  assert.equal(flatten(back), flatten(source), 'ноты изменились при экспорте в MusicXML');
  assert.equal(back.key.tonic, source.key.tonic);
  assert.equal(back.meter.beats, source.meter.beats);
  assert.equal(back.meter.beatType, source.meter.beatType);
  assert.ok(xml.includes('<clef>'), 'экспорт обязан указывать ключ: без ключа распознавание ошибается в высоте');
});

test('MusicXML: при экспорте мелодия, средние голоса и бас не сливаются', async () => {
  const { scoreToMusicXml } = await import('../app/js/musicxml.js');
  const score = {
    title: 'Сборник',
    composer: '',
    tempo: 96,
    meter: { beats: 4, beatType: 4 },
    key: { tonic: 'D', mode: 'minor', fifths: -1 },
    measures: [{
      index: 0,
      number: '1',
      harmony: [],
      events: [
        { beat: 0, dur: 1, pitches: [74], voice: 'melody' },
        { beat: 1, dur: 1, pitches: [72], voice: 'melody' },
        { beat: 0, dur: 1, pitches: [65], voice: 'inner' },
        { beat: 1, dur: 1, pitches: [62], voice: 'inner' },
        { beat: 0, dur: 2, pitches: [38], voice: 'bass' },
      ],
    }],
  };
  const xml = scoreToMusicXml(score, { includeHarmony: false });
  const voicesUsed = [...xml.matchAll(/<voice>(\d+)<\/voice>/g)].map((m) => m[1]);
  assert.ok(voicesUsed.includes('1') && voicesUsed.includes('2') && voicesUsed.includes('3'),
    `голоса в экспорте: ${[...new Set(voicesUsed)].join(', ')}`);
  assert.equal(xml.match(/<backup>/g).length, 2, 'каждому следующему голосу нужен <backup>');
  const { musicXmlToScore } = await import('../app/js/musicxml.js');
  const back = musicXmlToScore(xml);
  const pitches = back.measures[0].events.map((e) => e.pitches[0]).sort((a, b) => a - b);
  assert.deepEqual(pitches, [38, 62, 65, 72, 74], 'ноты потерялись при экспорте');
});

test('MusicXML: тональность берётся по началу, лад доопределяется по нотам', async () => {
  const { musicXmlToScore, inferKey } = await import('../app/js/musicxml.js');
  const note = (step, octave, alter = 0) =>
    `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>1</duration><type>quarter</type></note>`;
  const score = (measuresXml) =>
    `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list><part id="P1">${measuresXml}</part></score-partwise>`;
  const attributes = (fifths, mode) =>
    `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths>${mode ? `<mode>${mode}</mode>` : ''}</key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`;

  // Многие движки распознавания не пишут <mode>: без доопределения ля минор стал бы до мажором
  const minor = musicXmlToScore(score(`<measure number="1">${attributes(0)}${note('A', 4)}${note('C', 5)}${note('E', 5)}${note('A', 4)}</measure>`));
  assert.equal(minor.key.tonic, 'A');
  assert.equal(minor.key.mode, 'minor');
  assert.ok(minor.warnings.some((w) => w.includes('минор')), 'нет предупреждения о доопределённом ладе');

  const major = musicXmlToScore(score(`<measure number="1">${attributes(2)}${note('D', 4)}${note('F', 5, 1)}${note('A', 4)}${note('D', 4)}</measure>`));
  assert.equal(major.key.tonic, 'D');
  assert.equal(major.key.mode, 'major');

  // Смена ключевых знаков в середине (частая ошибка распознавания) не переписывает тональность пьесы
  const changed = musicXmlToScore(score(
    `<measure number="1">${attributes(2, 'major')}${note('D', 4)}${note('F', 5, 1)}${note('A', 4)}${note('D', 4)}</measure>`
    + `<measure number="2"><attributes><key><fifths>1</fifths></key></attributes>${note('D', 4)}${note('F', 5, 1)}${note('A', 4)}${note('D', 4)}</measure>`,
  ));
  assert.equal(changed.key.tonic, 'D');
  assert.ok(changed.warnings.some((w) => w.includes('смена тональности')));

  // Размер 3/8 в учебном репертуаре — почти всегда неверно прочитанный 6/8
  const compound = musicXmlToScore(score(`<measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>8</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${note('G', 4)}${note('B', 4)}${note('G', 4)}</measure>`));
  assert.ok(compound.warnings.some((w) => w.includes('6/8')));

  assert.equal(inferKey([{ events: [{ pitches: [69, 72, 76, 69] }] }], 0).mode, 'minor');
  assert.equal(inferKey([{ events: [{ pitches: [62, 66, 69, 62] }] }], 2).mode, 'major');
});

test('загрузка файлов: фото уходит на распознавание, MusicXML разбирается сразу', async () => {
  const { isImageFile, isMusicXmlFile, isCompressedScore, scoreFromUploadedFile } = await import('../app/js/recognition.js');
  const { ODE_TO_JOY_MUSICXML } = await import('../app/js/fixtures.js');

  const file = (name, type = '') => ({ name, type, text: async () => ODE_TO_JOY_MUSICXML });

  assert.equal(isImageFile(file('page.jpg', 'image/jpeg')), true);
  assert.equal(isImageFile(file('IMG_1234.HEIC', '')), true, 'iPhone отдаёт HEIC без типа');
  assert.equal(isImageFile(file('score.musicxml', '')), false);
  assert.equal(isMusicXmlFile(file('score.musicxml', '')), true);
  assert.equal(isMusicXmlFile(file('score.xml', 'text/xml')), true);
  assert.equal(isCompressedScore(file('score.mxl', '')), true);

  const loaded = await scoreFromUploadedFile(file('Моя пьеса.musicxml'));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.score.title, 'Моя пьеса', 'название берётся из имени файла');
  assert.ok(loaded.score.measures.length > 0);

  const zip = await scoreFromUploadedFile({ name: 'score.mxl', type: '', text: async () => '' });
  assert.equal(zip.ok, false);
  assert.match(zip.error, /архив/);

  const wrong = await scoreFromUploadedFile({ name: 'notes.pdf', type: 'application/pdf', text: async () => '' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /MusicXML/);
});

test('адрес сервиса распознавания: рядом с приложением или внешний', async () => {
  const { normalizeApiBase, apiEndpoint, DEFAULT_ENDPOINT, checkServer } = await import('../app/js/recognition.js');

  // Пусто — сервис рядом с приложением: работает и локальный запуск, и прокси dev-сервера
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase(null), '');
  assert.equal(normalizeApiBase('   '), '');
  assert.equal(apiEndpoint('/recognize', ''), DEFAULT_ENDPOINT);
  assert.equal(apiEndpoint('/health', ''), '/api/health');
  assert.equal(apiEndpoint('recognize', ''), '/api/recognize', 'путь можно писать без слэша');

  // Внешний адрес — приложение на статическом хостинге, сервис отдельно
  assert.equal(normalizeApiBase('https://omr.example.com/'), 'https://omr.example.com');
  assert.equal(apiEndpoint('/recognize', 'https://omr.example.com/'), 'https://omr.example.com/recognize');
  assert.equal(apiEndpoint('/health', 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/health');
  assert.equal(apiEndpoint('/recognize', 'http://127.0.0.1:8000/api'), 'http://127.0.0.1:8000/api/recognize');
  assert.equal(normalizeApiBase('omr.example.com'), 'https://omr.example.com', 'без схемы подставляем https');
  assert.equal(normalizeApiBase('omr.example.com/api'), 'https://omr.example.com/api');

  // Живой сервис не обязателен: проверка связи на несуществующем адресе возвращает понятную ошибку
  const dead = await checkServer('http://127.0.0.1:9', { timeoutMs: 1500 });
  assert.equal(dead.ok, false);
  assert.ok(dead.error || dead.status, 'нет ни ошибки, ни кода ответа');
});

test('адрес сервиса считается от каталога приложения, а не от корня сайта', async () => {
  const { apiEndpoint } = await import('../app/js/recognition.js');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    // Так приложение лежит в подкаталоге на GitHub Pages: путь от корня увёл бы запрос в чужой сайт
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://student.github.io/fluteband/index.html' },
      configurable: true,
    });
    assert.equal(apiEndpoint('/recognize'), 'https://student.github.io/fluteband/api/recognize');
    assert.equal(apiEndpoint('/health', 'https://omr.example.com'), 'https://omr.example.com/health',
      'внешний адрес важнее расположения приложения');

    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://127.0.0.1:3030/index.html' },
      configurable: true,
    });
    assert.equal(apiEndpoint('/recognize'), 'http://127.0.0.1:3030/api/recognize',
      'в корне сайта получается тот же адрес, что и раньше');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
    else delete globalThis.location;
  }
});

test('файлы приложения, обязательные для запуска, на месте', async () => {
  const required = ['index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'js/app.js'];
  for (const relative of required) {
    const info = await stat(join(APP, relative)).catch(() => null);
    assert.ok(info?.isFile(), `нет файла ${relative}`);
  }
  const html = await readFile(join(APP, 'index.html'), 'utf8');
  assert.ok(html.includes('js/app.js'), 'index.html не подключает app.js');
  assert.ok(html.includes('manifest.webmanifest'), 'index.html не подключает манифест PWA');
  assert.ok(html.includes('id="view-player"'), 'нет контейнера экрана «Минус»');

  const manifest = JSON.parse(await readFile(join(APP, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'ru');
  assert.ok(manifest.icons.length > 0);
});

test('офлайн-оболочка перечисляет только существующие файлы', async () => {
  const source = await readFile(join(APP, 'service-worker.js'), 'utf8');
  const listed = [...source.matchAll(/'(\.\/[^']*)'/g)].map((match) => match[1]);
  assert.ok(listed.length > 20, `в оболочке всего ${listed.length} записей`);

  for (const entry of listed) {
    if (entry === './') continue;
    const relative = entry.replace(/^\.\//, '');
    const info = await stat(join(APP, relative)).catch(() => null);
    assert.ok(info?.isFile(), `в офлайн-оболочке указан несуществующий файл ${entry}`);
  }

  // Модули, без которых приложение не заработает, обязаны быть в оболочке
  for (const name of ['js/perspective.js', 'js/image-stats.js', 'js/image-prep.js', 'js/sampler.js', 'js/synth.js', 'js/wav-render.js', 'js/storage.js', 'js/score-pages.js', 'js/library-index.js']) {
    assert.ok(listed.includes(`./${name}`), `${name} не попал в офлайн-оболочку`);
  }

  // И наоборот: каждый модуль app/js, который импортируется из views/app, должен быть в оболочке
  const modules = (await readdir(join(APP, 'js'))).filter((file) => file.endsWith('.js'));
  for (const file of modules) {
    assert.ok(listed.includes(`./js/${file}`) || file === 'views', `${file} не попал в офлайн-оболочку`);
  }
  for (const view of await readdir(join(APP, 'js', 'views'))) {
    assert.ok(listed.includes(`./js/views/${view}`), `js/views/${view} не попал в офлайн-оболочку`);
  }

  // Версия кэша должна меняться вместе с составом оболочки: ищем имя вида fluteband-shell-vN
  const version = source.match(/fluteband-shell-v(\d+)/);
  assert.ok(version, 'не найдена версия кэша оболочки');
  assert.ok(Number(version[1]) >= 5, `версия кэша ${version[1]} — модули выравнивания не попадут на устройство`);
});

test('офлайн-оболочка кэшируется по одному файлу, а не одним списком', async () => {
  const raw = await readFile(join(APP, 'service-worker.js'), 'utf8');
  const source = raw.replace(/^\s*\/\/.*$/gm, ''); // пояснения в комментариях не считаем за код
  // cache.addAll отменяет установку кэша целиком, если хоть один адрес отдан перенаправлением
  // (так делает Netlify с «красивыми адресами»: /index.html → /). Поэтому кэшируем поштучно.
  assert.ok(!/cache\.addAll/.test(source), 'вернулся cache.addAll — один перенаправлённый адрес сломает офлайн');
  assert.ok(/await cache\.put\(url, response\)/.test(source), 'файлы оболочки не кладутся в кэш по одному');
  assert.ok(/catch\(async \(\) => \{/.test(source), 'нет запасного варианта для адреса страницы');
  assert.ok(/caches\.match\('\.\/'\)/.test(source), 'запасной вариант не пробует адрес «./»');
});

test('настройки Netlify описывают сборку, папку публикации и заголовки', async () => {
  const config = await readFile(resolve(here, '..', 'netlify.toml'), 'utf8');
  assert.ok(/command = "npm run build:static"/.test(config), 'в netlify.toml не задана команда сборки');
  assert.ok(/publish = "dist"/.test(config), 'в netlify.toml не задана папка публикации');
  assert.ok(/pretty_urls = false/.test(config),
    '«красивые адреса» включены: /index.html станет «/», а это стартовый адрес PWA');
  assert.ok(/\/service-worker\.js[\s\S]*no-cache/.test(config), 'service worker отдаётся с кэшем — обновления не доедут');
  assert.ok(/application\/manifest\+json/.test(config), 'у манифеста не задан тип application/manifest+json');
  assert.ok(/NODE_VERSION = "20"/.test(config), 'версия Node не закреплена — сборка зависит от площадки');
  // Пример прокси распознавания должен оставаться в файле закомментированным: в нём предупреждение
  // про предел 26 секунд у прокси-запросов Netlify
  assert.ok(/# \[\[redirects\]\][\s\S]*status = 200/.test(config), 'пропал закомментированный пример прокси распознавания');
  assert.ok(/26 секунд/.test(config), 'пропало предупреждение про предел 26 секунд у прокси-запросов');
});

test('сборка пакета добавляет заголовки хостинга', async () => {
  const source = await readFile(resolve(here, '..', 'tools', 'build-static.mjs'), 'utf8');
  assert.ok(source.includes("join(OUT, '_headers')"), 'сборка не кладёт _headers в пакет');
  assert.ok(source.includes("join(OUT, '.nojekyll')"), 'сборка не кладёт .nojekyll в пакет');
  // Служебные файлы хостинга не должны входить в хеш содержимого оболочки
  assert.ok(/_headers', '\.nojekyll'/.test(source), 'служебные файлы учитываются в хеше имени кэша');
});

// --- Сервис распознавания в бесплатном Gradio-пространстве -------------------------------
// У Hugging Face бесплатными остались только Gradio-пространства (Docker требует платный план),
// поэтому сервис собирается вторым пакетом: наш FastAPI монтируется внутрь Gradio-приложения.

const SPACE = resolve(here, '..', 'server', 'gradio-space');
const HOMR_MODELS = resolve(here, '..', 'server', 'deps', 'homr');

test('Gradio-пространство: зависимости и шапка описывают бесплатный тариф', async () => {
  const requirements = await readFile(join(SPACE, 'requirements.txt'), 'utf8');
  assert.ok(/^gradio>=5/m.test(requirements), 'requirements.txt не ставит gradio — пространство не соберётся');
  assert.ok(/^homr==0\.6\.2$/m.test(requirements), 'движок homr не закреплён за набором моделей (0.6.2 ждёт модели 331, 0.7.0 — 396)');
  assert.ok(/^fastapi/m.test(requirements), 'requirements.txt не ставит fastapi');
  assert.ok(/^python-multipart/m.test(requirements), 'requirements.txt не ставит python-multipart: не принять фото');
  assert.ok(/^uvicorn/m.test(requirements), 'requirements.txt не ставит uvicorn');

  const packages = await readFile(join(SPACE, 'packages.txt'), 'utf8');
  for (const lib of ['libgl1', 'libglib2.0-0', 'libxcb1']) {
    assert.ok(new RegExp(`^${lib}$`, 'm').test(packages), `packages.txt не ставит ${lib}: OpenCV не заработает`);
  }
  // Hugging Face ставит этот файл командой «xargs -r -a packages.txt apt-get install -y»: каждое слово
  // становится именем пакета. Пояснение на русском превратилось в пакеты «#», «FluteBand», «AI» и уронило
  // настоящую сборку пространства («Unable to locate package #»), поэтому здесь только имена пакетов.
  for (const [index, line] of packages.split('\n').entries()) {
    const text = line.trim();
    if (!text) continue;
    assert.ok(/^[a-z0-9][a-z0-9+._-]*$/.test(text),
      `packages.txt, строка ${index + 1}: «${text}» — не имя пакета; пояснения тут запрещены (файл читает xargs)`);
  }
  // Локальная проверка обязана ставить те же пакеты из того же файла, иначе она такую ошибку не поймает
  const dockerTest = await readFile(join(SPACE, 'Dockerfile.test'), 'utf8');
  assert.ok(/xargs -r -a packages\.txt apt-get install/.test(dockerTest),
    'Dockerfile.test не читает packages.txt: ошибки в этом файле пройдут мимо локальной проверки');

  const packer = await readFile(resolve(here, '..', 'tools', 'pack-space-gradio.mjs'), 'utf8');
  assert.ok(/^sdk: gradio$/m.test(packer), 'пакет собирается не как Gradio-пространство');
  assert.ok(!/^\s*sdk: docker$/m.test(packer), 'пакет собирается как Docker-пространство — это платный план');
  assert.ok(/^app_file: app\.py$/m.test(packer), 'в шапке пространства не указан app_file');
  assert.ok(/^app_port: \$\{PORT\}$/m.test(packer), 'в шапке пространства не указан app_port');
  assert.ok(/models\/\*\.onnx filter=lfs/.test(packer), 'модели не уезжают через git-lfs: Hugging Face не примет файлы >10 МБ');
});

test('Gradio-пространство: пакет собирается и проходит собственную проверку', async (t) => {
  const modelDir = join(HOMR_MODELS, 'segmentation');
  const hasModels = await stat(join(modelDir, 'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx'))
    .then(() => true).catch(() => false);
  if (!hasModels) {
    // Модели движка лежат в server/deps (он не в репозитории): на чистом клоне их сначала надо скачать
    // командой «python -c "from homr.main import main; main()" --init --gpu no»
    t.skip('нет процессорного набора моделей движка (server/deps/homr) — сборку проверять не на чем');
    return;
  }

  const out = join(resolve(here, '..'), '.omr-work', 'space-gradio-test');
  const { execFileSync } = await import('node:child_process');
  const stdout = execFileSync(process.execPath, [resolve(here, '..', 'tools', 'pack-space-gradio.mjs'), `--out=${out}`], {
    encoding: 'utf8',
  });
  assert.ok(/Готово: /.test(stdout), 'сборщик не сообщил об успехе');

  const files = [];
  const walk = async (dir, base = dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else files.push(full.slice(base.length + 1).split('\\').join('/'));
    }
  };
  await walk(out);

  for (const needed of ['app.py', 'requirements.txt', 'packages.txt', 'README.md', '.gitattributes', 'Dockerfile.test']) {
    assert.ok(files.includes(needed), `в пакете нет ${needed}`);
  }
  for (const module of ['service/main.py', 'service/engines.py', 'service/melody.py']) {
    assert.ok(files.includes(module), `в пакете нет ${module}`);
  }
  assert.ok(files.some((file) => file.startsWith('examples/')), 'в пакете нет примера страницы для вкладки App');
  assert.ok(!files.includes('Dockerfile'), 'в пакет попал Dockerfile: Hugging Face примет его за Docker-пространство');
  assert.ok(!files.some((file) => file.startsWith('service/deps/')), 'в пакет попали локальные пакеты server/deps');

  // Модели: ровно набор той версии движка, что закреплена в requirements.txt. На Python 3.10 (базовый
  // образ Gradio-пространства) pip ставит homr 0.6.2, и он ждёт модели 331; 0.7.0 ждёт 396 — замерено
  // запуском обеих версий: с набором не той версии движок скачивает своё прямо во время запроса.
  const models = files.filter((file) => file.startsWith('models/'));
  const kinds = models
    .map((file) => {
      const name = file.split('/')[1];
      for (const kind of ['segnet', 'encoder', 'decoder']) {
        if (name.startsWith(`${kind}_`)) return kind;
      }
      return name;
    })
    .sort();
  assert.deepEqual(kinds, ['decoder', 'encoder', 'segnet'], `неожиданный набор моделей в пакете: ${models.join(', ')}`);
  assert.ok(!models.some((file) => file.includes('_fp16')), 'в пакете лежит набор fp16, а пространство работает на процессоре');
  assert.ok(models.every((file) => !file.includes('_396')), 'в пакете набор моделей 396 (homr 0.7.0), а закреплён движок 0.6.2 с моделями 331');
  assert.ok(models.some((file) => file.includes('encoder_pytorch_model_331')), 'в пакете нет энкодера 331 — движок скачает его сам');
  const packedRequirements = await readFile(join(out, 'requirements.txt'), 'utf8');
  assert.ok(/^homr==0\.6\.2$/m.test(packedRequirements), 'версия движка в пакете не закреплена за набором моделей');

  const readme = await readFile(join(out, 'README.md'), 'utf8');
  assert.ok(/^sdk: gradio$/m.test(readme), 'шапка пакета не Gradio');
  assert.ok(/^app_file: app\.py$/m.test(readme), 'шапка пакета не указывает app.py');
  assert.ok(/^app_port: 7860$/m.test(readme), 'шапка пакета не указывает порт 7860');
  assert.ok(/git-lfs/.test(readme), 'в описании пространства не сказано, как уезжают модели');

  const attributes = await readFile(join(out, '.gitattributes'), 'utf8');
  assert.ok(/^models\/\*\.onnx filter=lfs/m.test(attributes), 'нет правила git-lfs для моделей');

  const { rm } = await import('node:fs/promises');
  await rm(out, { recursive: true, force: true });
});

test('Gradio-пространство: набор моделей сверяется с версией движка, распознавания идут очередью', async () => {
  const app = await readFile(join(SPACE, 'app.py'), 'utf8');
  assert.ok(/mount_gradio_app\(api, demo, path="\/"\)/.test(app), 'FastAPI не смонтирован в Gradio: маршруты сервиса пропадут');
  assert.ok(/uvicorn\.run\(app, host="0\.0\.0\.0"/.test(app), 'сервис слушает не 0.0.0.0 — в облаке он будет недоступен');
  assert.ok(/models\/\*\.onnx|MODELS\.glob/.test(app), 'app.py не раскладывает модели из репозитория в пакет движка');
  // Набор моделей задаётся соответствием «версия движка + файлы в models/», а не переменной окружения:
  // у homr 0.6.2 (Python 3.10) флага --gpu нет вовсе, поэтому ключ FLUTEBAND_HOMR_GPU=no тут был бы
  // пустой надеждой. Вместо него — сверка с тем, что движок ищет на самом деле.
  assert.ok(!/FLUTEBAND_HOMR_GPU=", "no|FLUTEBAND_HOMR_GPU", "no"/.test(app), 'app.py снова «фиксирует» набор моделей ключом, которого движок не понимает');
  assert.ok(/def check_models\(/.test(app), 'app.py не сверяет набор моделей с тем, что ждёт версия движка');
  assert.ok(/MODELS_CHECK\["missing"\]/.test(app), 'расхождение моделей не попадает в журнал пространства');
  assert.ok(/segnet_path_onnx/.test(app) && /default_config\.filepaths/.test(app), 'сверка не спрашивает у движка, какие файлы он ждёт');
  // Прогрев — только чтение моделей с диска: полное пробное распознавание заняло бы очередь и
  // задержало первый запрос ученика (измерено: 53 с против 28 с)
  assert.ok(/def warmup\(\)/.test(app) && /warmup\(\)\n    uvicorn\.run/.test(app), 'модели не прогреваются до старта сервиса');
  assert.ok(!/Thread\(target=warmup/.test(app), 'прогрев снова запускает распознавание: он задержит первый запрос');
  assert.ok(/recognize-\{int\(time\.time\(\)/.test(app), 'результат страницы Gradio пишется под одним именем — запросы затрут друг друга');

  const engines = await readFile(resolve(here, '..', 'server', 'engines.py'), 'utf8');
  assert.ok(/^import threading$/m.test(engines), 'в движках нет threading — нечем выстроить очередь');
  assert.ok(/_RECOGNIZE_LOCK = threading\.Lock\(\)/.test(engines), 'нет очереди распознавания');
  assert.ok(/with _RECOGNIZE_LOCK:/.test(engines), 'распознавание не берёт очередь');
  // Флаг --gpu есть только у homr 0.7.0+: спрашиваем у движка и передаём флаг лишь тогда, когда он его знает
  assert.ok(/def _gpu_flag_supported\(\)/.test(engines), 'движок не проверяет, знает ли установленный homr флаг --gpu');
  assert.ok(/from homr\.main import GpuSupport/.test(engines), 'проверка флага не спрашивает сам движок');
  assert.ok(/_gpu_flag_supported\(\)/.test(engines) && /command \+= \["--gpu", requested_gpu\]/.test(engines), 'выбор набора моделей не доходит до homr');
  assert.ok(/unsupported_gpu_modes/.test(engines), 'если ключ не применён, об этом не сообщается в предупреждениях');

  const pkg = JSON.parse(await readFile(resolve(here, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['pack:space:gradio'], 'в package.json нет команды сборки Gradio-пакета');
  assert.ok(pkg.scripts['pack:space'], 'пропала команда сборки Docker-пакета');

  const ignore = await readFile(resolve(here, '..', '.gitignore'), 'utf8');
  assert.ok(/^dist-space-gradio\/$/m.test(ignore), 'собранный Gradio-пакет не исключён из репозитория');
  assert.ok(/^server\/deps-gradio\/$/m.test(ignore), 'локальный gradio не исключён из репозитория');
});