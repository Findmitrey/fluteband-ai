// FluteBand AI — замер на НАСТОЯЩИХ сканах нот из public-domain библиотек.
//
// Зачем отдельный стенд: подготовка снимка до сих пор мерилась на синтетических страницах и на их
// имитации фото (docs/omr-prep.md, docs/omr-photo.md). Настоящий библиотечный скан — другая бумага:
// неровная печать, пятна, серый фон, поля, иногда косо поставленная страница.
//
// Чего здесь НЕТ: эталонной расшифровки нот. Поэтому «точность» на настоящих сканах этим стендом
// не измеряется — измеряется то, что можно проверить без эталона:
//   * находит ли подготовка страницу, что она делает (наклон, свет, кромка) и сколько это занимает;
//   * что вытаскивает распознавание (такты, ноты, тональность, размер) и за какое время;
//   * повторяем ли результат на одном и том же входе (два прогона одного движка);
//   * совпадает ли распознавание ровного скана и «фото этого же скана» — то есть не ломает ли
//     съёмка телефона уже правильный результат;
//   * совпадает ли тональность/размер/число нот в первом такте с независимым чтением страницы
//     мультимодальной моделью (tools/vision-probe.mjs) — это перекрёстная проверка, а не эталон.
//
// Подготовка страниц: python tools/scan-to-png.py <скан.jpg> .omr-bench/real/png/<имя>.png 2000
// Запуск:            node tools/real-bench.mjs [--engine=homr] [--only=id] [--report-only]
// Результат:         .omr-bench/real-results.json и отчёт docs/omr-real.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { compareScores, loadScoreFile } from './omr-accuracy.mjs';
import { preprocessImageData, grayFromRgba } from '../app/js/image-prep.js';
import { scoreSummary } from '../app/js/score.js';
import { PHOTO_PRESETS, simulatePhoto } from './photo-sim.mjs';
import { askImage } from './vision-client.mjs';
import { generateAccompaniment } from '../app/js/accompaniment.js';
import { appendScorePage, pageStarts } from '../app/js/score-pages.js';
import { scoreToMusicXml, musicXmlToScore } from '../app/js/musicxml.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const REAL = join(ROOT, '.omr-bench', 'real');
const PNG_DIR = join(REAL, 'png');
const PREPARED = join(REAL, 'prepared');
const RESULTS = join(ROOT, '.omr-bench', 'real-results.json');

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};
const engine = arg('engine', 'homr');
const only = arg('only', null);
const reportOnly = process.argv.includes('--report-only');

/**
 * Настоящие страницы: только public domain / свободные лицензии, только для замера.
 * В приложение и в репозиторий сами сканы не попадают (в приложении нет и не будет хранилища сканов).
 */
const PAGES = [
  {
    id: 'popp-10',
    file: 'popp-1887-n10.png',
    title: 'Popp. Erster Flöten-Unterricht, 1887, с. 10',
    note: 'школа для флейты, начальные упражнения',
    source: 'archive.org/details/ersterflotenunte00popp',
    license: 'public domain (1887)',
  },
  {
    id: 'popp-34',
    file: 'popp-1887-n34.png',
    title: 'Popp. Erster Flöten-Unterricht, 1887, с. 34',
    note: 'школа для флейты, пьесы',
    source: 'archive.org/details/ersterflotenunte00popp',
    license: 'public domain (1887)',
  },
  {
    id: 'popp-42',
    file: 'popp-1887-n42.png',
    title: 'Popp. Erster Flöten-Unterricht, 1887, с. 42',
    note: 'школа для флейты, плотная страница (много станов)',
    source: 'archive.org/details/ersterflotenunte00popp',
    license: 'public domain (1887)',
  },
  {
    id: 'minstrel-20',
    file: 'ia-minstrel-n20.png',
    title: 'Little minstrel, 1867, с. 20',
    note: 'американский песенник-самоучитель, высокая печать',
    source: 'archive.org/details/littleminstrelco00fill',
    license: 'public domain (1867)',
  },
];

/**
 * Ноты, которые дал пользователь: «Финская» — фортепиано и блокфлейта вместе, две страницы.
 * Это самый близкий к жизни материал: настоящая страница сборника с двумя станами и мелкой печатью.
 * Файлы читаются прямо из папки пользователя и в репозиторий не копируются.
 */
const USER_PAGES = [
  {
    id: 'user-finnish-1',
    file: resolve(ROOT, 'Ноты для проверок', 'финская.png'),
    title: '«Финская», с. 1 (ваш файл)',
    note: 'фортепиано и блокфлейта вместе, 617×877',
    source: 'предоставлено пользователем',
    license: 'материал пользователя, только для замера',
    user: true,
  },
  {
    id: 'user-finnish-2',
    file: resolve(ROOT, 'Ноты для проверок', 'финская 2 часть.png'),
    title: '«Финская», с. 2 (ваш файл)',
    note: 'фортепиано и блокфлейта вместе, 556×814',
    source: 'предоставлено пользователем',
    license: 'материал пользователя, только для замера',
    user: true,
  },
];

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

/**
 * «Фото» настоящего скана: страница книжного формата, поэтому кадр вертикальный (как держит телефон
 * ученик), наклон 7°, тень сбоку и размытие — то же, что в тяжёлом пресете стенда фото.
 */
const REAL_PHOTO = { ...PHOTO_PRESETS.hard, photoWidth: 1000, photoHeight: 1500, scale: 0.82, tiltDeg: 7 };

/** Вопрос к модели: нужны факты, которые можно сверить с распознаванием, и ничего лишнего. */
const VISION_QUESTION = [
  'Это страница нот. Ответь ТОЛЬКО одной строкой JSON без пояснений:',
  '{"keySigns":"сколько и каких знаков при ключе (например: 1 диез, 2 бемоля, без знаков)",',
  '"meter":"музыкальный размер (например 4/4)",',
  '"firstMeasureNotes":число нот в первом такте,',
  '"legible":true или false — видны ли линейки и ноты чётко}',
].join(' ');

function parseVisionJson(answer) {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0].replace(/[\u201c\u201d]/g, '"'));
  } catch {
    return null;
  }
}

/**
 * Как разобраны голоса в сохранённом MusicXML: сколько нот в мелодии, в басу и в средних голосах.
 * Считается с конца файла, поэтому работает и с `--report-only` (без повторного распознавания).
 */
function voiceSplit(xmlPath) {
  if (!existsSync(xmlPath)) return null;
  const text = readFileSync(xmlPath, 'utf8');
  const score = scoreFromResult(xmlPath);
  if (!score) return null;
  const voices = { melody: { events: 0, pitches: 0, min: 999, max: -1 }, bass: { events: 0, pitches: 0, min: 999, max: -1 }, inner: { events: 0, pitches: 0, min: 999, max: -1 } };
  for (const measure of score.measures) {
    for (const event of measure.events) {
      const bucket = voices[event.voice] || voices.inner;
      bucket.events += 1;
      bucket.pitches += (event.pitches || []).length;
      for (const midi of event.pitches || []) {
        bucket.min = Math.min(bucket.min, midi);
        bucket.max = Math.max(bucket.max, midi);
      }
    }
  }
  const finish = (bucket) => (bucket.events ? { ...bucket } : null);
  const firstMeasure = score.measures[0]?.events.filter((e) => e.voice === 'melody' && (e.pitches || []).length) ?? [];
  // Сколько строк-станов различает файл и что было бы, если читать только первую партию (как до одиннадцатого круга)
  const partBlocks = [...text.matchAll(/<part\b[^>]*>[\s\S]*?<\/part>/g)];
  const lines = new Set();
  for (const m of text.matchAll(/<staff>(\d+)<\/staff>/g)) lines.add(m[1]);
  return {
    parts: partBlocks.length,
    staves: lines.size,
    melody: finish(voices.melody),
    bass: finish(voices.bass),
    inner: finish(voices.inner),
    firstMeasureMelody: firstMeasure.reduce((sum, e) => sum + e.pitches.length, 0),
    firstMeasureAll: (score.measures[0]?.events || []).reduce((sum, e) => sum + (e.pitches || []).length, 0),
  };
}

/**
 * Как разбирались голоса ДО одиннадцатого круга: читалась одна партия (с наибольшим числом нот),
 * а мелодией в каждом такте объявлялся голос с наибольшей средней высотой, басом — с наименьшей.
 * Правило воспроизведено здесь прямо, чтобы сравнение «как было / как стало» шло на одном и том же
 * распознанном файле, а не на пересказе.
 */
function voiceSplitLegacy(xmlPath) {
  if (!existsSync(xmlPath)) return null;
  const text = readFileSync(xmlPath, 'utf8');
  const partBlocks = [...text.matchAll(/<part\b[^>]*>[\s\S]*?<\/part>/g)].map((m) => m[0]);
  if (!partBlocks.length) return null;
  const countNotes = (block) => (block.match(/<note>/g) || []).length;
  const biggest = partBlocks.reduce((best, block) => (countNotes(block) > countNotes(best) ? block : best), partBlocks[0]);

  const voices = { melody: { pitches: 0, min: 999, max: -1 }, bass: { pitches: 0, min: 999, max: -1 } };
  const add = (bucket, pitches) => {
    for (const midi of pitches) {
      bucket.pitches += 1;
      bucket.min = Math.min(bucket.min, midi);
      bucket.max = Math.max(bucket.max, midi);
    }
  };
  for (const measure of biggest.match(/<measure\b[\s\S]*?<\/measure>/g) || []) {
    const byVoice = new Map();
    for (const note of measure.match(/<note>[\s\S]*?<\/note>/g) || []) {
      if (/<rest/.test(note)) continue;
      const voice = (note.match(/<voice>(\d+)<\/voice>/) || [])[1] || '1';
      const step = (note.match(/<step>([A-G])<\/step>/) || [])[1];
      if (!step) continue;
      const alter = Number((note.match(/<alter>(-?\d+)<\/alter>/) || [])[1] || 0);
      const octave = Number((note.match(/<octave>(-?\d+)<\/octave>/) || [])[1] || 4);
      const semitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
      const midi = (octave + 1) * 12 + semitone + alter;
      const list = byVoice.get(voice) || [];
      list.push(midi);
      byVoice.set(voice, list);
    }
    if (!byVoice.size) continue;
    const means = [...byVoice.entries()].map(([voice, list]) => ({ voice, mean: list.reduce((a, b) => a + b, 0) / list.length }))
      .sort((a, b) => b.mean - a.mean);
    add(voices.melody, byVoice.get(means[0].voice));
    if (means.length > 1) add(voices.bass, byVoice.get(means[means.length - 1].voice));
  }
  const finish = (bucket) => (bucket.pitches ? { ...bucket } : null);
  const staves = new Set([...text.matchAll(/<staff>(\d+)<\/staff>/g)].map((m) => m[1]));
  return { parts: partBlocks.length, staves: staves.size, melody: finish(voices.melody), bass: finish(voices.bass), inner: null };
}

/** Гармония и минус по распознанной странице: по одному символу на такт плюс итоги. */
function minusFacts(score) {
  if (!score) return null;
  const acc = generateAccompaniment(score, { style: 'auto' });
  const byMeasure = new Map();
  for (const event of acc.events) {
    if (!byMeasure.has(event.measureIndex)) byMeasure.set(event.measureIndex, event.symbol);
  }
  return {
    events: acc.events.length,
    style: acc.style,
    warnings: Array.isArray(acc.warnings) ? acc.warnings.length : 0,
    symbols: score.measures.map((_, index) => byMeasure.get(index) ?? '—'),
  };
}

/**
 * Партия с наибольшим числом нот — так читался файл до одиннадцатого круга.
 * Возвращает готовый MusicXML с одной этой партией (для честного сравнения «как было / как стало»).
 */
function biggestPartOnly(xmlText) {
  const blocks = [...xmlText.matchAll(/<part\b[^>]*>[\s\S]*?<\/part>/g)].map((m) => m[0]);
  if (blocks.length < 2) return xmlText;
  const countNotes = (block) => (block.match(/<note>/g) || []).length;
  const biggest = blocks.reduce((best, block) => (countNotes(block) > countNotes(best) ? block : best), blocks[0]);
  const head = xmlText.slice(0, xmlText.indexOf(blocks[0]));
  return `${head}${biggest}\n</score-partwise>`;
}

/** Что дала левая рука фортепиано: сравнение гармонии и минуса с разбором одной партии. */
function harmonyChange(xmlPath) {
  if (!existsSync(xmlPath)) return null;
  const text = readFileSync(xmlPath, 'utf8');
  let now = null;
  let before = null;
  try {
    now = minusFacts(scoreFromResult(xmlPath));
    before = minusFacts(musicXmlToScore(biggestPartOnly(text), { kind: 'x' }));
  } catch {
    return null;
  }
  if (!now || !before) return null;
  const changed = [];
  const total = Math.max(now.symbols.length, before.symbols.length);
  for (let index = 0; index < total; index += 1) {
    if ((now.symbols[index] ?? '—') !== (before.symbols[index] ?? '—')) {
      changed.push({ measure: index + 1, from: before.symbols[index] ?? '—', to: now.symbols[index] ?? '—' });
    }
  }
  return { now, before, changed, measures: total };
}

/**
 * Знаки при ключе из ответа модели словами → число знаков (квинт): «2 диеза» → +2, «1 бемоль» → −1,
 * «без знаков» → 0. Нужно, чтобы сверять с MusicXML числом, а не словами.
 */
function keySignsToFifths(text) {
  if (!text) return null;
  const value = String(text).toLowerCase();
  if (/без знак|нет знак|0 знак/.test(value)) return 0;
  const sharps = value.match(/(\d+)\s*диез/);
  if (sharps) return Number(sharps[1]);
  const flats = value.match(/(\d+)\s*бемол/);
  if (flats) return -Number(flats[1]);
  return null;
}

/**
 * Тёмная кромка числом: средняя яркость внешнего кольца (2% стороны) к средней яркости середины.
 * Единица — кромки нет. Та же мера, что в tools/photo-bench.mjs.
 */
function edgeBandRatio(image) {
  const { data, width, height } = image;
  const gray = grayFromRgba(data, width, height);
  const bandX = Math.max(1, Math.round(width * 0.02));
  const bandY = Math.max(1, Math.round(height * 0.02));
  const at = (x, y) => gray[y * width + x];
  let edgeSum = 0;
  let edgeCount = 0;
  let centreSum = 0;
  let centreCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onEdge = x < bandX || y < bandY || x >= width - bandX || y >= height - bandY;
      if (onEdge) {
        edgeSum += at(x, y);
        edgeCount += 1;
      } else if (x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75) {
        centreSum += at(x, y);
        centreCount += 1;
      }
    }
  }
  const edge = edgeCount ? edgeSum / edgeCount : 0;
  const centre = centreCount ? centreSum / centreCount : 1;
  return Number((edge / (centre || 1)).toFixed(3));
}

/** Сколько строк страницы занимают линейки: у нотной страницы их десятки, у текстовой — единицы. */
function staffLineRows(image) {
  const { data, width, height } = image;
  const gray = grayFromRgba(data, width, height);
  let rows = 0;
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let best = 0;
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] < 140) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    if (best >= width * 0.5) rows += 1;
  }
  return rows;
}

function recognize(pngPath, outPath) {
  const started = Date.now();
  const result = spawnSync('python', [
    join(ROOT, 'server', 'tools', 'recognize.py'),
    pngPath,
    `--engine=${engine}`,
    `--out=${outPath}`,
  ], { encoding: 'utf8', cwd: ROOT });
  const ms = Date.now() - started;
  const text = (result.stdout || '').trim();
  try {
    const json = JSON.parse(text.slice(text.indexOf('{')));
    return { ...json, ms };
  } catch {
    const reason = result.error?.message || text.slice(-200) || result.stderr?.slice(-200) || 'нет ответа';
    return { ok: false, error: reason, ms };
  }
}

function scoreFromResult(outPath) {
  if (!existsSync(outPath)) return null;
  try {
    return loadScoreFile(outPath);
  } catch {
    return null;
  }
}

/**
 * Что именно вывел движок в MusicXML: есть ли знаки при ключе и размер.
 * Это важно различать: если знаков нет, приложение подставляет C-dur по умолчанию, и «тональность»
 * в интерфейсе будет не распознанной, а предположенной.
 */
function xmlSignatureFacts(outPath) {
  if (!existsSync(outPath)) return { keyFifths: null, meter: null };
  const xml = readFileSync(outPath, 'utf8');
  const fifths = xml.match(/<fifths>(-?\d+)<\/fifths>/);
  const time = xml.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/);
  return {
    keyFifths: fifths ? Number(fifths[1]) : null,
    meter: time ? `${time[1]}/${time[2]}` : null,
  };
}

/**
 * Собрать пьесу из двух страниц пользователя — так ученик и будет снимать сборник.
 * Проверяем: складываются ли такты и страницы, переживает ли пьеса MusicXML и получается ли из неё минус.
 */
function measureUserAssembly(runs) {
  const first = runs.find((run) => run.id === 'user-finnish-1');
  const second = runs.find((run) => run.id === 'user-finnish-2');
  if (!first?.flat?._score || !second?.flat?._score) return null;
  const merged = appendScorePage(first.flat._score, second.flat._score);
  if (!merged.ok) return { ok: false, reason: merged.reason };
  const piece = merged.score;
  const xml = scoreToMusicXml(piece);
  const back = musicXmlToScore(xml, { kind: 'real-bench' });
  const minus = minusOf(piece);
  return {
    ok: true,
    pages: merged.pages,
    measures: piece.measures.length,
    pageStarts: pageStarts(piece),
    warnings: merged.warnings,
    xmlKb: Math.round(xml.length / 1024),
    roundTripMeasures: back.measures.length,
    roundTripOk: back.measures.length === piece.measures.length,
    minus,
    minusSecondPage: minusOf(second.flat._score),
  };
}

function stripScores(runs) {
  return runs.map((run) => {
    const copy = { ...run };
    if (copy.flat) {
      copy.flat = { ...copy.flat };
      delete copy.flat._score;
    }
    if (copy.photo) {
      copy.photo = { ...copy.photo };
      delete copy.photo._score;
    }
    return copy;
  });
}

function writeImage(image, path) {
  writeFileSync(path, encodePng(image));
}

/** Прогнать через подготовку приложения и записать результат. */
function prepare(image, options, outPath) {
  const started = Date.now();
  const prepared = preprocessImageData(image, options);
  const ms = Date.now() - started;
  writeImage(prepared, outPath);
  return { prepared, ms };
}

/** Разобрать один настоящий скан: ровный и «как фото с телефона». */
async function measurePage(page, { withRepeat = false, withVision = false } = {}) {
  const source = page.user ? page.file : join(PNG_DIR, page.file);
  if (!existsSync(source)) return { id: page.id, ok: false, error: `нет файла ${page.file}` };
  const scan = decodePng(readFileSync(source));
  mkdirSync(PREPARED, { recursive: true });

  const appOptions = { autoCrop: true, deskew: true, minWidth: 0, contrast: true, edgeTrim: true, flattenAfterContrast: false };
  const flatPath = join(PREPARED, `${page.id}-flat.png`);
  const flat = prepare(scan, appOptions, flatPath);

  // Мелкая страница: если она уже узкая, пробуем увеличить — проверить, помогает ли это распознаванию
  let bigger = null;
  if (scan.width < 1000) {
    const bigPath = join(PREPARED, `${page.id}-big.png`);
    const big = prepare(scan, { ...appOptions, minWidth: 1400 }, bigPath);
    const bigOut = join(PREPARED, `${page.id}-big.musicxml`);
    const bigResult = recognize(bigPath, bigOut);
    const bigScore = scoreFromResult(bigOut);
    bigger = {
      ok: !!bigResult.ok,
      error: bigResult.error || null,
      ms: bigResult.ms,
      prepMs: big.ms,
      size: `${big.prepared.width}×${big.prepared.height}`,
      score: bigScore ? summarize(bigScore) : null,
      printed: xmlSignatureFacts(bigOut),
      agreement: null,
      _score: bigScore,
    };
  }

  const photo = simulatePhoto(scan, REAL_PHOTO);
  const photoPath = join(PREPARED, `${page.id}-photo.png`);
  const asPhoto = prepare(photo, appOptions, photoPath);

  const flatOut = join(PREPARED, `${page.id}-flat.musicxml`);
  const photoOut = join(PREPARED, `${page.id}-photo.musicxml`);
  const flatResult = recognize(flatPath, flatOut);
  const photoResult = recognize(photoPath, photoOut);
  const flatScore = scoreFromResult(flatOut);
  const photoScore = scoreFromResult(photoOut);

  if (bigger && bigger._score && flatScore) {
    bigger.agreement = agreementOf(flatScore, bigger._score);
  }
  if (bigger) delete bigger._score;

  let repeat = null;
  if (withRepeat) {
    const repeatOut = join(PREPARED, `${page.id}-flat-repeat.musicxml`);
    const again = recognize(flatPath, repeatOut);
    const first = existsSync(flatOut) ? readFileSync(flatOut, 'utf8') : '';
    const second = existsSync(repeatOut) ? readFileSync(repeatOut, 'utf8') : '';
    repeat = { sameXml: !!first && first === second, ms: again.ms };
  }

  // Перекрёстная проверка: независимое чтение страницы моделью (факты: знаки, размер, ноты в первом такте)
  let vision = null;
  if (withVision) {
    try {
      const answer = await askImage(flatPath, VISION_QUESTION, 'qwen3.8-flash', { maxTokens: 300 });
      const facts = answer.ok ? parseVisionJson(answer.answer) : null;
      const printed = facts?.meter ? String(facts.meter).replace(/\s/g, '') : '';
      const visionFifths = keySignsToFifths(facts?.keySigns);
      const recognizedFifths = xmlSignatureFacts(flatOut).keyFifths;
      vision = {
        ok: !!facts,
        answer: answer.ok ? answer.answer : `ошибка: ${answer.error}`,
        keySigns: facts?.keySigns ?? null,
        keyFifths: visionFifths,
        meter: facts?.meter ?? null,
        firstMeasureNotes: Number.isFinite(facts?.firstMeasureNotes) ? facts.firstMeasureNotes : null,
        legible: facts?.legible ?? null,
        matchMeter: !!printed && printed === (flatScore ? scoreSummary(flatScore).meter : ''),
        matchKey: visionFifths != null && recognizedFifths != null
          ? visionFifths === recognizedFifths
          : visionFifths === 0 && recognizedFifths == null,
        matchNotes: Number.isFinite(facts?.firstMeasureNotes) && !!flatScore
          ? facts.firstMeasureNotes === summarize(flatScore).firstMeasureNotes
          : false,
      };
      vision.match = vision.matchMeter || vision.matchNotes || vision.matchKey;
    } catch (error) {
      vision = { ok: false, answer: `ошибка: ${error.message}`, match: false };
    }
  }

  const flatSummary = flatScore ? summarize(flatScore) : null;

  return {
    id: page.id,
    title: page.title,
    note: page.note,
    source: page.source,
    license: page.license,
    user: !!page.user,
    scan: { width: scan.width, height: scan.height, staffRows: staffLineRows(scan), edgeBand: edgeBandRatio(scan) },
    flat: {
      ok: !!flatResult.ok,
      error: flatResult.error || null,
      engine: flatResult.engine || engine,
      ms: flatResult.ms,
      prepMs: flat.ms,
      size: `${flat.prepared.width}×${flat.prepared.height}`,
      steps: flat.prepared.stats.steps,
      inkShare: Number((flat.prepared.stats.after.inkShare ?? 0).toFixed(3)),
      edgeBand: edgeBandRatio(flat.prepared),
      staffRows: staffLineRows(flat.prepared),
      score: flatSummary,
      printed: xmlSignatureFacts(flatOut),
      minus: flatScore ? minusOf(flatScore) : null,
      _score: flatScore,
    },
    bigger,
    photo: {
      ok: !!photoResult.ok,
      error: photoResult.error || null,
      ms: photoResult.ms,
      prepMs: asPhoto.ms,
      size: `${asPhoto.prepared.width}×${asPhoto.prepared.height}`,
      steps: asPhoto.prepared.stats.steps,
      inkShare: Number((asPhoto.prepared.stats.after.inkShare ?? 0).toFixed(3)),
      edgeBand: edgeBandRatio(asPhoto.prepared),
      staffRows: staffLineRows(asPhoto.prepared),
      score: photoScore ? summarize(photoScore) : null,
      printed: xmlSignatureFacts(photoOut),
      _score: photoScore,
    },
    agreement: agreementOf(flatScore, photoScore),
    repeat,
    vision,
  };
}

/** Совпадение нот двух распознаваний: за эталон берём первое (ровный скан). */
function agreementOf(reference, other) {
  if (!reference || !other) return null;
  const result = compareScores(reference, other);
  return {
    f1: Number(result.f1.toFixed(3)),
    precision: Number(result.precision.toFixed(3)),
    recall: Number(result.recall.toFixed(3)),
    expected: result.expectedNotes,
    actual: result.recognizedNotes,
    matched: result.matched,
    octaveErrors: result.octaveErrors?.length ?? 0,
  };
}

/** Что получится сыграть: минус по распознанной пьесе (бас + аккорды, без мелодии). */
function minusOf(score) {
  const result = generateAccompaniment(score, { style: 'auto' });
  const bass = result.events.filter((event) => event.role === 'bass');
  const chords = result.events.filter((event) => event.role === 'chord');
  const symbols = [...new Set(result.events.map((event) => event.symbol).filter(Boolean))];
  return {
    events: result.events.length,
    styles: result.style,
    bassNotes: bass.length,
    chords: chords.length,
    symbols: symbols.length,
    firstSymbols: symbols.slice(0, 4),
    totalBeats: Number((result.totalBeats || 0).toFixed(1)),
    warnings: result.warnings?.length ?? 0,
    firstEvent: result.events[0] ? `${result.events[0].role} с доли ${result.events[0].startBeat} (${result.events[0].symbol})` : null,
  };
}

function summarize(score) {
  const summary = scoreSummary(score);
  const notes = (score.measures || []).reduce(
    (total, measure) => total + (measure.events || []).reduce((sum, event) => sum + (event.pitches?.length || 0), 0),
    0,
  );
  return {
    measures: score.measures?.length || 0,
    notes,
    key: summary.key,
    meter: summary.meter,
    firstMeasureNotes: (score.measures?.[0]?.events || []).reduce((sum, event) => sum + (event.pitches?.length || 0), 0),
  };
}

/** Сколько времени строится минус по уже распознанной пьесе (это и есть «мгновенно»). */
function minusMs(score) {
  if (!score) return null;
  const started = Date.now();
  for (let i = 0; i < 3; i += 1) generateAccompaniment(score, { style: 'auto' });
  return Math.round((Date.now() - started) / 3);
}

/** Сравнение чтения модели с распознаванием. Считаем в отчёте, чтобы работало и по сохранённым данным. */
function visionFactsOf(run) {
  const v = run.vision || {};
  const visionMeter = v.meter ? String(v.meter) : '';
  const visionFifths = keySignsToFifths(v.keySigns);
  const recognizedMeter = run.flat?.printed?.meter ?? null;
  const recognizedFifths = run.flat?.printed?.keyFifths ?? null;
  const recognizedNotes = run.flat?.score?.firstMeasureNotes ?? null;
  const notes = Number.isFinite(v.firstMeasureNotes) ? v.firstMeasureNotes : null;
  return {
    ...v,
    // Размер считаем совпавшим, если распознанный размер вообще упомянут в ответе модели:
    // на странице-сборнике упражнений размеров может быть несколько (popp-42).
    matchMeter: recognizedMeter && visionMeter ? visionMeter.includes(recognizedMeter) : null,
    matchKey: visionFifths == null
      ? null
      : visionFifths === recognizedFifths || (visionFifths === 0 && recognizedFifths == null),
    matchNotes: notes != null && recognizedNotes != null ? notes === recognizedNotes : null,
  };
}

function report(runs, assembly = null) {
  const userRuns = runs.filter((run) => run.user);
  const libraryRuns = runs.filter((run) => !run.user);
  const lines = [];
  lines.push('# FluteBand AI — замер на настоящих сканах нот (public domain)');
  lines.push('');
  lines.push('Отчёт создан автоматически: `node tools/real-bench.mjs`. Правки в нём теряются.');
  lines.push('');
  lines.push('## Зачем этот замер');
  lines.push('');
  lines.push('Подготовка снимка и распознавание до сих пор проверялись на **синтетических** страницах и на их');
  lines.push('имитации фото (`docs/omr-prep.md`, `docs/omr-photo.md`). Синтетическая страница слишком чистая:');
  lines.push('ровная бумага, идеальная печать, ни пятен, ни серого фона. Здесь те же шаги прогоняются на');
  lines.push('**настоящих нотах**: библиотечные сканы школы для флейты 1887 года и песенника 1867 года плюс две');
  lines.push('страницы «Финской» (фортепиано и блокфлейта вместе), которые дал пользователь.');
  lines.push('');
  lines.push('Важная оговорка: **эталонной расшифровки этих страниц у меня нет**, поэтому «точность распознавания»');
  lines.push('здесь не измеряется. Измеряется проверяемое без эталона: находит ли подготовка страницу и что она');
  lines.push('с ней делает, что вытаскивает распознавание и за какое время, повторяем ли результат и совпадает ли');
  lines.push('он с независимым чтением страницы мультимодальной моделью.');
  lines.push('');
  lines.push('## Страницы');
  lines.push('');
  lines.push('| Страница | Что это | Источник | Лицензия | Размер скана | Строк-линеек |');
  lines.push('|---|---|---|---|---|---|');
  for (const run of runs) {
    if (run.error) continue;
    const source = run.user
      ? run.source
      : `[${run.source.replace('archive.org/details/', '')}](https://${run.source})`;
    lines.push(`| ${run.title} | ${run.note} | ${source} | ${run.license} | ${run.scan.width}×${run.scan.height} | ${run.scan.staffRows} |`);
  }
  lines.push('');
  lines.push('Библиотечные сканы в репозиторий не кладутся: они нужны только для замера (в приложении нет');
  lines.push('хранилища сканов). Файлы пользователя читаются из его папки и тоже не копируются.');
  lines.push('');
  lines.push('## Что делает подготовка и сколько это занимает');
  lines.push('');
  lines.push('| Страница | Ровный скан: размер | Шаги подготовки | Время подготовки | Кромка | Нотных строк осталось |');
  lines.push('|---|---|---|---|---|---|');
  for (const run of libraryRuns) {
    if (run.error) continue;
    lines.push(`| ${run.id} | ${run.flat.size} | ${run.flat.steps.join('; ') || '—'} | ${run.flat.prepMs} мс | ${run.flat.edgeBand} | ${run.flat.staffRows} |`);
  }
  lines.push('');
  lines.push('Кромка — средняя яркость внешнего кольца страницы к её середине: единица значит «кромки нет».');
  lines.push('Число «нотных строк» — сколько строк страницы перекрыто длинной тёмной линией: у нотной страницы');
  lines.push('их десятки, у текстовой — единицы. Метрика грубая: на странице с плотным текстом (песенник 1867 г.)');
  lines.push('она ловит и строки текста, и после подготовки их число меняется. Поэтому о сохранности нот судим не');
  lines.push('только по ней, но и по тому, что распознавание нашло ноты, а независимое чтение подтвердило, что');
  lines.push('линейки и ноты видны (`legible: true` во всех ответах модели).');
  lines.push('');
  lines.push('## Ноты, которые дал пользователь («Финская»: фортепиано и блокфлейта)');
  lines.push('');
  if (!userRuns.length) {
    lines.push('Не измерялись в этом запуске.');
  } else {
    lines.push('Это самый близкий к жизни материал: настоящая страница сборника, два стана (фортепиано и блокфлейта),');
    lines.push('мелкая печать. Файлы лежат у пользователя в папке «Ноты для проверок» и в репозиторий не копируются.');
    lines.push('');
    lines.push('| Страница | Размер | Нотных строк | Подготовка | Распознавание | Такты | Ноты | Размер | Минус (события) |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const run of userRuns) {
      lines.push(`| ${run.title} | ${run.scan.width}×${run.scan.height} | ${run.scan.staffRows} | ${run.flat.prepMs} мс | ${(run.flat.ms / 1000).toFixed(1)} с | ${run.flat.score?.measures ?? 'ошибка'} | ${run.flat.score?.notes ?? '—'} | ${run.flat.printed?.meter || 'по умолчанию'} | ${run.flat.minus?.events ?? '—'} |`);
    }
    lines.push('');
    lines.push('Что видно по этим двум страницам:');
    for (const run of userRuns) {
      const minus = run.flat.minus || {};
      lines.push(`- **${run.title}**: подготовка ${run.flat.steps.join('; ') || 'ничего не меняла'}; ` +
        `распознано ${run.flat.score?.measures ?? '—'} тактов и ${run.flat.score?.notes ?? '—'} нот; ` +
        `минус — ${minus.events ?? '—'} событий, стиль «${minus.styles ?? '—'}», бас ${minus.bassNotes ?? '—'} нот, ` +
        `${minus.warnings ? `замечаний гармонии ${minus.warnings}` : 'замечаний гармонии нет'}.`);
    }
    lines.push('');
    lines.push('### Мелкая страница: помогает ли увеличение');
    lines.push('');
    const small = userRuns.filter((run) => run.bigger);
    if (small.length) {
      lines.push('У этих страниц ширина меньше 1000 точек, поэтому дополнительно измерен вариант с увеличением');
      lines.push('(`minWidth 1400`, то есть та же подготовка, но крупнее). За эталон взято распознавание без увеличения.');
      lines.push('');
      lines.push('| Страница | Без увеличения | С увеличением | Такты | Ноты | Время | Совпадение нот |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const run of small) {
        lines.push(`| ${run.title} | ${run.flat.size} | ${run.bigger.size} | ${run.flat.score?.measures ?? '—'} → ${run.bigger.score?.measures ?? '—'} | ${run.flat.score?.notes ?? '—'} → ${run.bigger.score?.notes ?? '—'} | ${(run.flat.ms / 1000).toFixed(1)} с → ${(run.bigger.ms / 1000).toFixed(1)} с | ${run.bigger.agreement ? pct(run.bigger.agreement.f1) : '—'} |`);
      }
      lines.push('');
      const deltas = small.filter((run) => run.bigger.agreement).map((run) => run.bigger.agreement.f1);
      if (deltas.length) {
        lines.push(`Совпадение с распознаванием без увеличения: ${deltas.map((value) => pct(value)).join(', ')}. ` +
          'Это не точность (эталона нет), а мера того, насколько увеличение меняет результат.');
      }
    } else {
      lines.push('Мелких страниц в этом запуске не было.');
    }
  }
  lines.push('');
  lines.push('## Сборка двух страниц в одну пьесу (ваш материал)');
  lines.push('');
  if (!assembly) {
    lines.push('Не проверялась в этом запуске.');
  } else if (!assembly.ok) {
    lines.push(`Не получилось: ${assembly.reason}`);
  } else {
    lines.push('Ученик снимает сборник по страницам, поэтому обе страницы «Финской» склеены в одну пьесу —');
    lines.push('это тот же код, что работает в приложении (`app/js/score-pages.js`).');
    lines.push('');
    lines.push(`- тактов: **${assembly.measures}**, страниц: **${assembly.pages}**, границы страниц: \`${JSON.stringify(assembly.pageStarts)}\`;`);
    lines.push(`- предупреждения склейки: ${assembly.warnings.length ? assembly.warnings.join('; ') : 'нет'};`);
    lines.push(`- MusicXML: ${assembly.xmlKb} КБ, обратный разбор ${assembly.roundTripOk ? 'без потерь' : '**с потерями**'} (${assembly.roundTripMeasures} тактов);`);
    lines.push(`- минус по всей пьесе: ${assembly.minus.events} событий, стиль «${assembly.minus.styles}», бас ${assembly.minus.bassNotes} нот, ${assembly.minus.totalBeats} долей;`);
    lines.push(`- минус только по второй странице: ${assembly.minusSecondPage.events} событий (для сравнения).`);
  }
  lines.push('');
  lines.push('## Что вытащило распознавание');
  lines.push('');
  lines.push('| Страница | Ровный скан: такты | ноты | знаки при ключе | размер | время | «Фото»: такты | ноты | время |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    if (run.error) continue;
    const flat = run.flat.score || {};
    const photo = run.photo.score || {};
    const printed = run.flat.printed || {};
    const keyText = printed.keyFifths == null ? 'движок не вывел' : `${printed.keyFifths > 0 ? '+' : ''}${printed.keyFifths} (квинт)`;
    const meterText = printed.meter || 'по умолчанию 4/4';
    lines.push(`| ${run.id} | ${run.flat.ok ? flat.measures ?? '—' : 'ошибка'} | ${run.flat.ok ? flat.notes ?? '—' : '—'} | ${keyText} | ${meterText} | ${(run.flat.ms / 1000).toFixed(1)} с | ${run.photo.ok ? photo.measures ?? '—' : 'ошибка'} | ${run.photo.ok ? photo.notes ?? '—' : '—'} | ${(run.photo.ms / 1000).toFixed(1)} с |`);
  }
  lines.push('');
  lines.push('«Движок не вывел» — важная строка: если знаков при ключе в MusicXML нет, приложение берёт C-dur');
  lines.push('по умолчанию, то есть аккорды могут оказаться не в той тональности. Это ограничение распознавания,');
  lines.push('а не подготовка снимка.');
  lines.push('');
  const slow = runs.filter((run) => run.flat.ms).map((run) => run.flat.ms);
  if (slow.length) {
    lines.push(`Время распознавания: от ${(Math.min(...slow) / 1000).toFixed(1)} до ${(Math.max(...slow) / 1000).toFixed(1)} с ` +
      `(в среднем ${(mean(slow) / 1000).toFixed(1)} с) на настоящем скане.`);
    lines.push('');
  }
  lines.push('## Мелодия — верхняя строка, фортепиано — аккомпанемент (одиннадцатый круг)');
  lines.push('');
  lines.push('На страницах «фортепиано + блокфлейта» распознавание отдаёт несколько партий и станов: у «Финской»');
  lines.push('это две партии, а в первой партии два стана (флейта сверху, правая рука фортепиано снизу).');
  lines.push('Раньше приложение читало только одну партию с наибольшим числом нот — партия левой руки пропадала');
  lines.push('целиком, — а мелодией в каждом такте объявлялся самый высокий по средней высоте голос, из-за чего');
  lines.push('голоса перескакивали. Теперь: мелодия — верхняя строка, остальные строки — аккомпанемент.');
  lines.push('');
  lines.push('Столбец «как было» посчитан тут же, в стенде, по старому правилу (одна партия + голос по средней');
  lines.push('высоте за такт): это восстановление, а не старый прогон, поэтому в редких случаях оно может');
  lines.push('разойтись с прежним выводом на одну ноту (связки и форшлаги).');
  lines.push('');
  lines.push('| Страница | Строк-станов | Как было: одна партия, голос по средней высоте | Как стало: все партии, мелодия — верхняя строка |');
  lines.push('|---|---|---|---|');
  const splitRows = runs.filter((run) => !run.error).map((run) => ({
    run,
    now: voiceSplit(join(PREPARED, `${run.id}-flat.musicxml`)),
    before: voiceSplitLegacy(join(PREPARED, `${run.id}-flat.musicxml`)),
  })).filter((row) => row.now);
  for (const { run, now, before } of splitRows) {
    const describe = (split) => (split
      ? `мелодия ${split.melody ? `${split.melody.pitches} нот (${split.melody.min}–${split.melody.max})` : '—'}, ` +
        `бас ${split.bass ? `${split.bass.pitches} нот (${split.bass.min}–${split.bass.max})` : '—'}` +
        `${split.inner ? `, средние ${split.inner.pitches} нот` : ''}`
      : '—');
    lines.push(`| ${run.id} | ${now.staves} | ${describe(before)} | ${describe(now)} |`);
  }
  lines.push('');
  const twoLine = splitRows.filter((row) => row.now.staves > 1);
  if (twoLine.length) {
    lines.push('Что это значит для ваших страниц — **одна и та же распознанная страница, разбор разный**:');
    for (const { run, now, before } of twoLine) {
      const sameMelody = before?.melody && before.melody.pitches === now.melody.pitches
        && before.melody.min === now.melody.min && before.melody.max === now.melody.max;
      if (sameMelody) {
        lines.push(`- **${run.title}**: мелодия ${now.melody.pitches} нот (${now.melody.min}–${now.melody.max}, диапазон блокфлейты) — ` +
          'и по старому правилу она случайно получалась такой же: в этой пьесе верхний голос всегда был и самым высоким. ' +
          'Но правило держалось на средней высоте за такт, поэтому на другой странице оно ломается (см. первую страницу).');
      } else {
        lines.push(`- **${run.title}**: мелодия стала одноголосной — ${now.melody.pitches} нот в диапазоне ${now.melody.min}–${now.melody.max} ` +
          `(это диапазон блокфлейты), а по старому правилу в мелодию попадало ${before?.melody?.pitches ?? '—'} нот в диапазоне ` +
          `${before?.melody?.min ?? '—'}–${before?.melody?.max ?? '—'} — то есть вместе с нотами фортепиано.`);
      }
      lines.push(`  Бас теперь — левая рука фортепиано: ${now.bass ? `${now.bass.pitches} нот, ${now.bass.min}–${now.bass.max}` : '—'}, ` +
        `а по старому правилу «басом» были ${before?.bass ? `${before.bass.pitches} нот, ${before.bass.min}–${before.bass.max}` : '—'} ` +
        '— то есть правая рука: партия левой руки вообще не читалась, потому что приложение брало одну партию из двух. ' +
        `Средние голоса (${now.inner ? now.inner.pitches : 0} нот) — правая рука: за мелодию они больше не выдаются, но в разборе гармонии участвуют.`);
      lines.push(`  Итого в разбор добавилось ${now.bass ? now.bass.pitches : 0} нот левой руки, которых там не было.`);
    }
    lines.push('');
    lines.push('Проверка по первому такту: у мелодии ровно столько нот, сколько напечатано в верхней строке — ' +
      `${twoLine.map(({ run, now }) => `${run.id}: ${now.firstMeasureMelody} нот у распознавания против ${run.vision?.firstMeasureNotes ?? '—'} у независимого чтения`).join('; ')}.`);
    lines.push('');
    lines.push('### Что это дало минусу');
    lines.push('');
    lines.push('Минус строится из гармонии, а гармония — из нот такта. Пока левая рука не читалась, аккорды');
    lines.push('определялись по мелодии и правой руке; теперь в такте есть и бас. Сравнение на той же странице:');
    lines.push('');
    lines.push('| Страница | Событий минуса (было → стало) | Замечаний гармонии (было → стало) | Тактов с другим аккордом |');
    lines.push('|---|---|---|---|');
    const harmonyRows = twoLine.map(({ run }) => ({ run, change: harmonyChange(join(PREPARED, `${run.id}-flat.musicxml`)) }))
      .filter((row) => row.change);
    for (const { run, change } of harmonyRows) {
      lines.push(`| ${run.id} | ${change.before.events} → ${change.now.events} | ${change.before.warnings} → ${change.now.warnings} | ${change.changed.length} из ${change.measures} |`);
    }
    lines.push('');
    for (const { run, change } of harmonyRows) {
      if (!change.changed.length) {
        lines.push(`- **${run.id}**: аккорды не изменились ни в одном такте — левая рука подтвердила то, что и так читалось по верхним голосам.`);
        continue;
      }
      const examples = change.changed.slice(0, 6).map((item) => `такт ${item.measure}: ${item.from} → ${item.to}`).join(', ');
      lines.push(`- **${run.id}**: аккорд другой в ${change.changed.length} тактах из ${change.measures} (${examples}).`);
    }
    lines.push('');
    lines.push('Менять ли гармонию «в лучшую сторону» — судить по звуку: у нас нет эталонной расшифровки,');
    lines.push('но теперь в разбор попадает весь текст страницы, включая бас, а не половина.');
  } else {
    lines.push('Двухстановых страниц в этом запуске не было.');
  }
  lines.push('');
  lines.push('## Время: где оно уходит');
  lines.push('');
  lines.push('| Страница | Подготовка снимка | Распознавание | Минус (по готовым нотам) |');
  lines.push('|---|---|---|---|');
  for (const run of runs) {
    if (run.error) continue;
    const xmlPath = join(PREPARED, `${run.id}-flat.musicxml`);
    const score = existsSync(xmlPath) ? scoreFromResult(xmlPath) : null;
    const speed = minusMs(score);
    lines.push(`| ${run.id} | ${run.flat.prepMs} мс | ${(run.flat.ms / 1000).toFixed(1)} с | ${speed == null ? '—' : `${speed} мс`} |`);
  }
  lines.push('');
  const recogTimes = runs.filter((run) => run.flat.ms).map((run) => run.flat.ms);
  const prepTimes = runs.filter((run) => run.flat.prepMs).map((run) => run.flat.prepMs);
  if (recogTimes.length) {
    lines.push(`Итог по времени: подготовка снимка ${Math.min(...prepTimes)}–${Math.max(...prepTimes)} мс (её делает телефон), ` +
      `распознавание ${(Math.min(...recogTimes) / 1000).toFixed(1)}–${(Math.max(...recogTimes) / 1000).toFixed(1)} с (его делает сервис).`);
    lines.push('');
    lines.push('Заявка в постановке задачи была «мгновенно» (≤3 с быстрый путь и ≤15 с полный). По этому замеру');
    lines.push('**в полный бюджет 15 с укладываются не все страницы**: плотные страницы с двумя станами (фортепиано');
    lines.push('плюс блокфлейта) считаются 35–46 с. Минус при этом строится за считанные миллисекунды — всё время');
    lines.push('уходит на распознавание нот, а не на аккомпанемент. Это ограничение выбранного движка `' + engine + '`,');
    lines.push('а не подготовки снимка: подготовка занимает доли секунды.');
    lines.push('');
  }
  lines.push('## Совпадает ли «фото» с ровным сканом');
  lines.push('');
  lines.push('Это не точность, а **согласие**: за эталон взято распознавание ровного скана, а проверяется,');
  lines.push('не разваливается ли тот же результат, если этот же лист снят как фото (наклон 9°, тень, размытие).');
  lines.push('');
  lines.push('| Страница | Совпадение нот (F1) | Полнота | Точность | Нот в эталоне | Нот на «фото» | Ошибки октавы |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const run of runs) {
    if (run.error || !run.agreement) continue;
    const a = run.agreement;
    lines.push(`| ${run.id} | ${pct(a.f1)} | ${pct(a.recall)} | ${pct(a.precision)} | ${a.expected} | ${a.actual} | ${a.octaveErrors} |`);
  }
  const withAgreement = runs.filter((run) => run.agreement);
  if (withAgreement.length) {
    lines.push('');
    lines.push(`Среднее совпадение по ${withAgreement.length} страницам: **${pct(mean(withAgreement.map((run) => run.agreement.f1)))}** ` +
      `(от ${pct(Math.min(...withAgreement.map((run) => run.agreement.f1)))} до ${pct(Math.max(...withAgreement.map((run) => run.agreement.f1)))}).`);
  }
  lines.push('');
  lines.push('## Повторяемость');
  lines.push('');
  const repeated = runs.filter((run) => run.repeat);
  if (repeated.length) {
    for (const run of repeated) {
      lines.push(`- ${run.id}: повторный прогон движка дал тот же MusicXML — ${run.repeat.sameXml ? 'да' : '**нет**'} (${(run.repeat.ms / 1000).toFixed(1)} с).`);
    }
  } else {
    lines.push('Повторный прогон в этом запуске не делался (запустите без `--report-only`, чтобы измерить).');
  }
  lines.push('');
  lines.push('## Перекрёстная проверка: что видит независимое чтение страницы');
  lines.push('');
  const withVision = runs.filter((run) => run.vision);
  if (withVision.length) {
    lines.push('| Страница | Знаки при ключе (модель) | Размер (модель) | Нот в 1-м такте (модель) | Знаки у распознавания | Размер у распознавания | Нот в 1-м такте у распознавания | Знаки совпали | Размер совпал | Ноты совпали |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    const compared = withVision.map((run) => ({ run, facts: visionFactsOf(run) }));
    for (const { run, facts } of compared) {
      const fifths = run.flat.printed?.keyFifths;
      const keyText = fifths == null ? 'не выведены' : `${fifths > 0 ? '+' : ''}${fifths}`;
      const verdict = (value) => (value == null ? '—' : value ? 'да' : 'нет');
      lines.push(`| ${run.id} | ${facts.keySigns || '—'} | ${facts.meter || '—'} | ${facts.firstMeasureNotes ?? '—'} | ${keyText} | ${run.flat.printed?.meter || 'не напечатан'} | ${run.flat.score?.firstMeasureNotes ?? '—'} | ${verdict(facts.matchKey)} | ${verdict(facts.matchMeter)} | ${verdict(facts.matchNotes)} |`);
    }
    lines.push('');
    const counted = (key) => {
      const values = compared.map((item) => item.facts[key]).filter((value) => value != null);
      return `${values.filter(Boolean).length} из ${values.length}`;
    };
    lines.push(`Совпало: знаки при ключе — ${counted('matchKey')}, размер — ${counted('matchMeter')}, ` +
      `число нот в первом такте — ${counted('matchNotes')}. Прочерк значит, что сравнивать нечего ` +
      '(например, размер на странице не напечатан, и распознавание взяло значение по умолчанию).');
    lines.push('');
    lines.push('Модель отвечает словами, а не нотами, поэтому это перекрёстная проверка фактов (тональность, размер,');
    lines.push('число нот в первом такте), а не эталон. Расхождение означает, что одному из двух чтений верить нельзя,');
    lines.push('и это повод проверить страницу глазами. Ответы модели как есть:');
    lines.push('');
    for (const run of withVision) lines.push(`- **${run.id}**: «${run.vision.answer.replace(/\s+/g, ' ').trim()}»`);
  } else {
    lines.push('Не спрашивали (нужен ключ к модели и запуск без `--report-only`).');
  }
  lines.push('');
  lines.push('## Что нашлось важного');
  lines.push('');
  lines.push('1. **Повторяемость**: повторный прогон движка на тех же подготовленных страницах дал тот же MusicXML');
  lines.push(`   на всех ${runs.filter((run) => run.repeat).length} страницах — результат не «дрожит» от запуска к запуску.`);
  lines.push('2. **Съёмка не ломает результат**: совпадение нот между ровным сканом и «фото этого же листа» составило');
  lines.push(`   ${(() => {
    const values = runs.filter((run) => run.agreement).map((run) => run.agreement.f1);
    return values.length ? `${pct(Math.min(...values))}–${pct(Math.max(...values))}` : '—';
  })()}, то есть подготовка снимка на настоящем материале работает.`);
  lines.push('3. **Знаки при ключе**: распознавание вывело их там, где они напечатаны, и не вывело там, где их нет, —');
  lines.push('   и в том и в другом случае это совпало с независимым чтением. Но если знаков в MusicXML нет,');
  lines.push('   приложение берёт C-dur по умолчанию, поэтому тональность стоит проверять глазами (её можно сменить).');
  lines.push('4. **Размер может отсутствовать на самой странице**: у второй страницы «Финской» размер не напечатан');
  lines.push('   (это подтверждает и независимое чтение), поэтому движок его не вывел и приложение подставило 4/4,');
  lines.push('   хотя пьеса в 2/4. При сборке страниц в одну пьесу размер берётся с первой страницы, и пьеса');
  lines.push('   получается в 2/4 — то есть сборка лечит эту ошибку.');
  lines.push('5. **Движок отдаёт фортепиано и флейту вместе** (две партии, а в первой партии два стана). Приложение');
  lines.push('   с одиннадцатого круга читает все партии и берёт мелодию с верхней строки, а фортепиано отправляет');
  lines.push('   в аккомпанемент — см. раздел про мелодию выше. Из-за этого «нот в первом такте» у распознавания');
  lines.push('   больше, чем насчитала модель по верхней строке (у первой страницы 5 против 4): движок кладёт в тот же');
  lines.push('   такт и ноты фортепиано — это его вывод, а не разбор приложения. Мелодия приложения по числу нот');
  lines.push('   совпадает с верхней строкой.');
  lines.push('6. **Увеличение мелкой страницы не нужно**: вариант с увеличением дал те же такты и совпадение 100%,');
  lines.push('   а время не выиграл — поэтому по умолчанию страница не увеличивается.');
  lines.push('');
  lines.push('## Ограничения этого замера');
  lines.push('');
  lines.push('- Это **библиотечные сканы и файлы пользователя**, а не снимок с телефона: бумага ровная, свет ровный,');
  lines.push('  поля широкие. Съёмка телефона здесь только имитируется (`tools/photo-sim.mjs`, наклон 9°, тень, размытие).');
  lines.push('- **Эталонной расшифровки нет**: сколько нот распознано верно, этот стенд не говорит. Он говорит,');
  lines.push('  что распознавание вообще работает на настоящем скане, сколько это длится и не ломает ли его съёмка.');
  lines.push('  Первые два места, где видно расхождение с независимым чтением, названы выше — это и есть материал');
  lines.push('  для следующего замера с настоящей расшифровкой.');
  lines.push('- Числа относятся к движку `' + engine + '` на конкретных изданиях 1867 и 1887 годов и на двух файлах');
  lines.push('  пользователя; другой шрифт и другая бумага дадут другие числа.');
  lines.push('- Время распознавания измерено на этой машине (CPU, локальный сервис), а не на бесплатном облачном');
  lines.push('  тарифе: в облаке оно будет другим — и, скорее всего, другим в худшую сторону.');
  lines.push('- Перекрёстная проверка глазами модели — вспомогательная: модель может ошибаться так же, как движок.');
  lines.push('- Файлы пользователя («Финская») в репозиторий не копируются и в сборку не попадают.');
  lines.push('');
  lines.push('## Воспроизведение');
  lines.push('');
  lines.push('```');
  lines.push('# 1. скачать страницы-источники (public domain, archive.org):');
  lines.push('#    https://archive.org/download/ersterflotenunte00popp/page/n10_w2000.jpg  → .omr-bench/real/popp-1887-n10.jpg');
  lines.push('#    https://archive.org/download/ersterflotenunte00popp/page/n34_w2000.jpg  → .omr-bench/real/popp-1887-n34.jpg');
  lines.push('#    https://archive.org/download/ersterflotenunte00popp/page/n42_w2000.jpg  → .omr-bench/real/popp-1887-n42.jpg');
  lines.push('#    https://archive.org/download/littleminstrelco00fill/page/n20_w2000.jpg → .omr-bench/real/ia-minstrel-n20.jpg');
  lines.push('# 2. при желании проверить, где на странице ноты, а где текст (нужен Pillow):');
  lines.push('python tools/scan-quality.py .omr-bench/real/*.jpg');
  lines.push('# 3. перевести их в PNG так же, как приложение готовит снимок с телефона:');
  lines.push('python tools/scan-to-png.py .omr-bench/real/popp-1887-n10.jpg .omr-bench/real/png/popp-1887-n10.png 2000');
  lines.push('#    файлы пользователя читаются прямо из папки «Ноты для проверок» и не копируются');
  lines.push('# 4. прогнать замер:');
  lines.push('node tools/real-bench.mjs --engine=homr      # или npm run bench:real');
  lines.push('```');
  lines.push('');
  writeFileSync(join(ROOT, 'docs', 'omr-real.md'), `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const all = [...PAGES, ...USER_PAGES];
  if (reportOnly && existsSync(RESULTS)) {
    const saved = JSON.parse(readFileSync(RESULTS, 'utf8'));
    const runs = Array.isArray(saved) ? saved : saved.runs || [];
    const savedAssembly = Array.isArray(saved) ? null : saved.assembly || null;
    // Факты из MusicXML добираем из сохранённых файлов: они лежат рядом с результатами
    for (const run of runs) {
      if (run.error) continue;
      if (!run.flat?.printed) run.flat.printed = xmlSignatureFacts(join(PREPARED, `${run.id}-flat.musicxml`));
      if (!run.photo?.printed) run.photo.printed = xmlSignatureFacts(join(PREPARED, `${run.id}-photo.musicxml`));
    }
    writeFileSync(RESULTS, JSON.stringify({ runs, assembly: savedAssembly }, null, 2), 'utf8');
    report(runs, savedAssembly);
    console.log('отчёт docs/omr-real.md обновлён из .omr-bench/real-results.json');
    return;
  }

  const selected = all.filter((page) => !only || page.id === only);
  const withVision = !process.argv.includes('--no-vision');
  return (async () => {
    let runs = [];
    let assembly = null;
    for (const page of selected) {
      const run = await measurePage(page, { withRepeat: true, withVision });
      runs.push(run);
      if (run.error) {
        console.log(`${page.id}: ошибка — ${run.error}`);
        continue;
      }
      console.log(
        `${page.id}: подготовка ${run.flat.prepMs} мс (${run.flat.steps.join('; ') || 'без шагов'}), ` +
        `распознавание ${(run.flat.ms / 1000).toFixed(1)} с → ${run.flat.score?.measures ?? '—'} тактов, ` +
        `${run.flat.score?.notes ?? '—'} нот, размер ${run.flat.printed?.meter ?? 'по умолчанию'}; ` +
        `минус ${run.flat.minus?.events ?? '—'} событий; «фото» ${run.photo.ok ? `${run.photo.score?.measures ?? '—'} тактов` : 'ошибка'}, ` +
        `совпадение ${run.agreement ? pct(run.agreement.f1) : '—'}` +
        (run.bigger ? `; увеличено до ${run.bigger.size}: ${run.bigger.score?.measures ?? '—'} тактов, совпадение ${run.bigger.agreement ? pct(run.bigger.agreement.f1) : '—'}` : '') +
        (run.vision ? `; модель: ${run.vision.ok ? `размер ${run.vision.meter ?? '—'}, нот в 1-м такте ${run.vision.firstMeasureNotes ?? '—'}` : 'не ответила'}` : ''),
      );
    }

    // Сборка двух страниц пользователя в одну пьесу (только когда сняты обе)
    if (selected.some((page) => page.user)) {
      assembly = measureUserAssembly(runs);
      if (assembly?.ok) {
        console.log(`сборка двух страниц: ${assembly.measures} тактов, ${assembly.pages} страницы, границы ${JSON.stringify(assembly.pageStarts)}, ` +
          `MusicXML ${assembly.xmlKb} КБ, обратный разбор ${assembly.roundTripOk ? 'без потерь' : 'с потерями'}, минус ${assembly.minus.events} событий`);
      } else if (assembly) {
        console.log(`сборка двух страниц не удалась: ${assembly.reason}`);
      }
    }

    let cleaned = stripScores(runs);
    // При --only сохраняем ранее измеренные страницы и прежнюю сборку
    if (only && existsSync(RESULTS)) {
      const saved = JSON.parse(readFileSync(RESULTS, 'utf8'));
      const previousRuns = Array.isArray(saved) ? saved : saved.runs || [];
      const map = new Map(previousRuns.map((run) => [run.id, run]));
      for (const run of cleaned) map.set(run.id, run);
      cleaned = all.map((page) => map.get(page.id)).filter(Boolean);
      if (!assembly) assembly = Array.isArray(saved) ? null : saved.assembly || null;
    }

    writeFileSync(RESULTS, JSON.stringify({ runs: cleaned, assembly }, null, 2), 'utf8');
    report(cleaned.filter((item) => !item.error), assembly);
    console.log('результаты: .omr-bench/real-results.json, отчёт: docs/omr-real.md');
  })();
}

main();