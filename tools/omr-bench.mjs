// FluteBand AI — стенд проверки распознавания нот: эталон -> страница -> распознавание -> сравнение.
//
// Что делает по каждой пьесе:
//   1. гравирует эталонный MusicXML в SVG (verovio);
//   2. растеризует SVG в PNG (Chrome) — получается «печатная страница»;
//   3. распознаёт страницу выбранным движком (homr/oemer);
//   4. сравнивает результат с эталоном и считает точность нот, тональности, размера и тактов;
//   5. строит минус из распознанной пьесы (проверка, что тракт работает до конца).
//
// Запуск: node tools/omr-bench.mjs [--engine=homr] [--only=03-etude-eighths]
// Результат: .omr-bench/bench-results.json и отчёт docs/omr-benchmark.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from './find-chrome.mjs';
import { compareScores, loadScoreFile } from './omr-accuracy.mjs';
import { BENCH_PIECES } from './make-bench.mjs';
import { generateAccompaniment } from '../app/js/accompaniment.js';
import { validateScore } from '../app/js/score.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const FIXTURES = join(ROOT, 'server', 'fixtures', 'bench');
const WORK = join(ROOT, '.omr-bench', 'bench');
const CHROME = findChrome();

const engineArg = process.argv.find((a) => a.startsWith('--engine='));
const engine = engineArg ? engineArg.split('=')[1] : 'homr';
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const scale = scaleArg ? scaleArg.split('=')[1] : '50';
const crop = process.argv.includes('--crop');
const renderOnly = process.argv.includes('--render-only'); // только получить страницы (для стенда предобработки)
const labelArg = process.argv.find((a) => a.startsWith('--label='));
const label = labelArg ? labelArg.split('=')[1] : `${engine}-s${scale}-${crop ? 'crop' : 'full'}`;
const MIN_WINDOW_HEIGHT = 500; // Chrome отдаёт пустой снимок при слишком маленькой высоте окна

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: ROOT, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  return result;
}

function renderPage(piece) {
  const groundTruth = join(FIXTURES, `${piece.id}.musicxml`);
  const svg = join(WORK, `${piece.id}-${label}.svg`);
  const rendered = run('python', [
    join(ROOT, 'server', 'tools', 'render_svg.py'),
    groundTruth,
    svg,
    `--scale=${scale}`,
    `--full-page=${crop ? 0 : 1}`,
  ]);
  const info = JSON.parse((rendered.stdout || '{}').trim().split('\n').pop() || '{}');
  if (!info.ok) throw new Error(`гравировка не удалась: ${rendered.stderr?.slice(-300)}`);

  const png = join(WORK, `${piece.id}-${label}.png`);
  const width = info.width || 2100;
  const height = Math.max(info.height || 1200, MIN_WINDOW_HEIGHT);
  const chrome = run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-crash-reporter',
    '--no-first-run',
    `--user-data-dir=${join(WORK, 'chrome-profile')}`,
    `--screenshot=${png}`,
    `--window-size=${width},${height}`,
    '--default-background-color=FFFFFFFF',
    pathToFileURL(svg).href,
  ]);
  if (!existsSync(png)) throw new Error(`Chrome не создал страницу: ${chrome.stderr?.slice(-300)}`);
  return { svg, png, size: `${width}x${height}` };
}

function recognize(png, piece) {
  const out = join(WORK, `${piece.id}-${label}.musicxml`);
  const result = run('python', [
    join(ROOT, 'server', 'tools', 'recognize.py'),
    png,
    `--engine=${engine}`,
    `--out=${out}`,
  ]);
  const text = (result.stdout || '').trim();
  let info = {};
  try {
    info = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    info = { ok: false, error: text.slice(-300) || result.stderr?.slice(-300) || 'нет ответа' };
  }
  return { ...info, out };
}

function main() {
  if (!CHROME) {
    console.error('Не найден Chrome — нужен для получения «печатной страницы». Укажите CHROME_PATH.');
    process.exitCode = 2;
    return;
  }
  mkdirSync(WORK, { recursive: true });

  const pieces = BENCH_PIECES.filter((piece) => !only || piece.id === only);
  const rows = [];
  const failures = [];
  const pages = [];

  for (const piece of pieces) {
    process.stdout.write(`${piece.id.padEnd(22)} `);
    try {
      const page = renderPage(piece);
      if (renderOnly) {
        pages.push({ id: piece.id, title: piece.title, png: page.png, size: page.size });
        console.log(`страница ${page.size}`);
        continue;
      }
      const recognized = recognize(page.png, piece);
      if (!recognized.ok) {
        failures.push({ id: piece.id, stage: 'распознавание', error: recognized.error || recognized.detail });
        console.log(`ОШИБКА распознавания: ${recognized.error || recognized.detail}`);
        continue;
      }
      const groundTruth = loadScoreFile(join(FIXTURES, `${piece.id}.musicxml`));
      const score = loadScoreFile(recognized.out);
      const report = compareScores(groundTruth, score);
      const validation = validateScore(score);
      const accompaniment = generateAccompaniment(score, { style: 'auto', instrumentId: 'flute' });
      rows.push({
        id: piece.id,
        title: piece.title,
        page: page.size,
        elapsedMs: recognized.elapsedMs,
        musicxmlBytes: recognized.bytes,
        accuracy: report,
        accompaniment: { style: accompaniment.style, events: accompaniment.events.length },
        validationProblems: validation.problems.length,
        warnings: recognized.warnings || [],
      });
      console.log(`F1 ${(report.f1 * 100).toFixed(0)}% · нот ${report.matched}/${report.expectedNotes} · ${recognized.elapsedMs} мс · минус ${accompaniment.events.length} событий`);
    } catch (error) {
      failures.push({ id: piece.id, stage: 'конвейер', error: error.message });
      console.log(`ОШИБКА: ${error.message}`);
    }
  }

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

  if (renderOnly) {
    const manifest = join(WORK, `pages-${label}.json`);
    writeFileSync(manifest, `${JSON.stringify({ label, scale: Number(scale), crop, pages }, null, 2)}\n`, 'utf8');
    console.log(`\nСтраницы готовы: ${pages.length} (${manifest})`);
    return;
  }

  const summary = {
    engine,
    label,
    scale: Number(scale),
    crop,
    pieces: rows.length,
    failed: failures.length,
    notes: {
      expected: rows.reduce((sum, row) => sum + row.accuracy.expectedNotes, 0),
      matched: rows.reduce((sum, row) => sum + row.accuracy.matched, 0),
      spurious: rows.reduce((sum, row) => sum + row.accuracy.spurious.length, 0),
    },
    meanPrecision: Number(mean(rows.map((row) => row.accuracy.precision)).toFixed(3)),
    meanRecall: Number(mean(rows.map((row) => row.accuracy.recall)).toFixed(3)),
    meanF1: Number(mean(rows.map((row) => row.accuracy.f1)).toFixed(3)),
    meanDurationAccuracy: Number(mean(rows.map((row) => row.accuracy.durationAccuracy)).toFixed(3)),
    exactPieces: rows.filter((row) => row.accuracy.f1 === 1).length,
    keyAccuracy: rows.length ? Number((rows.filter((row) => row.accuracy.key.match).length / rows.length).toFixed(3)) : 0,
    meterAccuracy: rows.length ? Number((rows.filter((row) => row.accuracy.meter.match).length / rows.length).toFixed(3)) : 0,
    measureAccuracy: rows.length ? Number((rows.filter((row) => row.accuracy.measures.recognized === row.accuracy.measures.expected).length / rows.length).toFixed(3)) : 0,
    meanElapsedMs: Math.round(mean(rows.map((row) => row.elapsedMs))),
    rows,
    failures,
  };

  writeFileSync(join(ROOT, '.omr-bench', `bench-results-${label}.json`), JSON.stringify(summary, null, 2), 'utf8');
  writeReport(summary);

  console.log(`\nДвижок «${engine}»: пьес ${summary.pieces}, провалов ${summary.failed}`);
  console.log(`Ноты: совпало ${summary.notes.matched} из ${summary.notes.expected} (лишних ${summary.notes.spurious})`);
  console.log(`Средние: precision ${(summary.meanPrecision * 100).toFixed(1)}%, recall ${(summary.meanRecall * 100).toFixed(1)}%, F1 ${(summary.meanF1 * 100).toFixed(1)}%`);
  console.log(`Тональность ${(summary.keyAccuracy * 100).toFixed(0)}% · размер ${(summary.meterAccuracy * 100).toFixed(0)}% · такты ${(summary.measureAccuracy * 100).toFixed(0)}% · среднее время ${summary.meanElapsedMs} мс`);
  console.log('Отчёт: docs/omr-benchmark.md');
  if (failures.length) process.exitCode = 1;
}

function writeReport(summary) {
  const lines = [];
  lines.push('# Замер распознавания нот (стенд FluteBand AI)');
  lines.push('');
  lines.push('Отчёт создаётся автоматически командой `node tools/omr-bench.mjs` — цифры не вписываются руками.');
  lines.push('');
  lines.push(`**Движок:** \`${summary.engine}\` · **пьес:** ${summary.pieces} · **провалов:** ${summary.failed}`);
  lines.push('');
  lines.push('## Как измерено');
  lines.push('');
  lines.push('1. Эталонный MusicXML (мы знаем каждую ноту) гравируется в SVG (verovio) — это «печатный» оригинал.');
  lines.push('2. SVG растеризуется в PNG (Chrome) — получается страница, как из сборника.');
  lines.push('3. Страница распознаётся движком OMR.');
  lines.push('4. Результат сравнивается с эталоном: нота считается найденной, если совпали такт, высота и позиция в такте (допуск 0.3 доли).');
  lines.push('5. Из распознанной пьесы строится минус — проверяется, что тракт работает до конца.');
  lines.push('');
  lines.push('## Итоги');
  lines.push('');
  lines.push('| Показатель | Значение |');
  lines.push('|---|---|');
  lines.push(`| Ноты: найдено | ${summary.notes.matched} из ${summary.notes.expected} |`);
  lines.push(`| Лишние ноты | ${summary.notes.spurious} |`);
  lines.push(`| Точность нот (precision) | ${(summary.meanPrecision * 100).toFixed(1)}% |`);
  lines.push(`| Полнота нот (recall) | ${(summary.meanRecall * 100).toFixed(1)}% |`);
  lines.push(`| F1 | ${(summary.meanF1 * 100).toFixed(1)}% |`);
  lines.push(`| Верная длительность нот | ${(summary.meanDurationAccuracy * 100).toFixed(1)}% |`);
  lines.push(`| Пьесы без единой ошибки | ${summary.exactPieces} из ${summary.pieces} |`);
  lines.push(`| Верная тональность | ${(summary.keyAccuracy * 100).toFixed(0)}% |`);
  lines.push(`| Верный размер | ${(summary.meterAccuracy * 100).toFixed(0)}% |`);
  lines.push(`| Верное число тактов | ${(summary.measureAccuracy * 100).toFixed(0)}% |`);
  lines.push(`| Среднее время распознавания | ${summary.meanElapsedMs} мс |`);
  lines.push('');
  lines.push('## По пьесам');
  lines.push('');
  lines.push('| Пьеса | Размер | Ноты | F1 | Длительности | Тональность | Такты | Время | Минус |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of summary.rows) {
    const acc = row.accuracy;
    lines.push(`| ${row.title} | ${acc.meter.expected} | ${acc.matched}/${acc.expectedNotes} | ${(acc.f1 * 100).toFixed(0)}% | ${(acc.durationAccuracy * 100).toFixed(0)}% | ${acc.key.recognized}${acc.key.match ? '' : ` (вместо ${acc.key.expected})`} | ${acc.measures.recognized}/${acc.measures.expected} | ${row.elapsedMs} мс | ${row.accompaniment.events} событий, «${row.accompaniment.style}» |`);
  }
  if (summary.failures.length) {
    lines.push('');
    lines.push('## Провалы');
    lines.push('');
    for (const failure of summary.failures) lines.push(`- ${failure.id} (${failure.stage}): ${failure.error}`);
  }
  lines.push('');
  lines.push('## Выводы для приложения');
  lines.push('');
  lines.push(`- Ноты: ${summary.notes.matched} из ${summary.notes.expected} найдены верно; пьес без единой ошибки — ${summary.exactPieces} из ${summary.pieces}.`);
  lines.push(`- Длительности нот верны у ${(summary.meanDurationAccuracy * 100).toFixed(0)}% найденных нот: от них зависит, чем заполнен такт в минусе.`);
  lines.push(`- Тональность ${(summary.keyAccuracy * 100).toFixed(0)}%, размер ${(summary.meterAccuracy * 100).toFixed(0)}%, число тактов ${(summary.measureAccuracy * 100).toFixed(0)}% — остальное требуют проверки учеником (в приложении такие такты помечаются).`);
  lines.push(`- Скорость: в среднем ${summary.meanElapsedMs} мс на страницу (CPU, без GPU).`);
  lines.push('- Аккордовые обозначения движок не читает вовсе: гармонию строит наш модуль `harmony.js` по распознанным нотам, поэтому минус получается даже из «голой» мелодии.');
  lines.push('- В MusicXML обязателен `<clef>`: без него движок угадывает ключ и сдвигает все ноты по высоте (проверено: сдвиг на 10-11 полутонов).');
  lines.push('- Программы распознавания не пишут `<mode>`: лад нужно определять по нотам (модуль `inferKey`), иначе минор превращается в параллельный мажор.');
  lines.push('- Типовые ошибки движка на учебных страницах: лишний такт на переносе строки, путаница 6/8 и 3/8, пунктирные длительности в конце пьесы.');
  writeFileSync(join(ROOT, 'docs', 'omr-benchmark.md'), lines.join('\n') + '\n', 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}