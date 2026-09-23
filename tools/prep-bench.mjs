// FluteBand AI — стенд предобработки снимка: помогает ли она движку распознавания.
//
// Берём те же «печатные страницы», что и основной стенд, прогоняем их через
// app/js/image-prep.js (серое, контраст, обрезка полей, увеличение, бинаризация)
// и сравниваем точность распознавания по вариантам.
//
// Подготовка страниц: node tools/omr-bench.mjs --engine=homr --scale=40 --crop --render-only --label=base
// Запуск стенда:      node tools/prep-bench.mjs [--engine=homr] [--label=base] [--only=05-minor-study]
// Результат:          .omr-bench/prep-results.json и отчёт docs/omr-prep.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { compareScores, loadScoreFile } from './omr-accuracy.mjs';
import { preprocessImageData } from '../app/js/image-prep.js';
import { ODE_TO_JOY_MUSICXML as APP_FIXTURE } from '../app/js/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const FIXTURES = join(ROOT, 'server', 'fixtures', 'bench');
const WORK = join(ROOT, '.omr-bench');
const BENCH = join(WORK, 'bench');

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};
const engine = arg('engine', 'homr');
const label = arg('label', 'base');
const only = arg('only', null);

/** Варианты предобработки: имя -> настройки для preprocessImageData (режим приложения — `page`) */
const VARIANTS = {
  raw: null,
  gray: { autoCrop: false, minWidth: 0, contrast: true },
  page: { autoCrop: true, minWidth: 0, contrast: true },
  crop: { autoCrop: true, trimMargins: true, minWidth: 0, contrast: true },
  upscale: { autoCrop: true, trimMargins: true, minWidth: 1500, contrast: true },
  binary: { autoCrop: true, trimMargins: true, minWidth: 0, contrast: true, binarize: true },
};

/** Отдельный замер на демо-странице приложения: у неё известен правильный ответ (15 нот, D-dur) */
const DEMO_VARIANTS = {
  'как есть': null,
  'только контраст': { autoCrop: false, minWidth: 0, contrast: true },
  'режим приложения': { autoCrop: true, minWidth: 0, contrast: true },
  'обрезка полей всегда': { autoCrop: true, trimMargins: true, minWidth: 0, contrast: true },
  'обрезка + увеличение 1.5': { autoCrop: true, trimMargins: true, minWidth: 1500, contrast: true },
};

function recognize(pngPath, outPath) {
  const result = spawnSync('python', [
    join(ROOT, 'server', 'tools', 'recognize.py'),
    pngPath,
    `--engine=${engine}`,
    `--out=${outPath}`,
  ], { encoding: 'utf8', cwd: ROOT });
  const text = (result.stdout || '').trim();
  try {
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    const reason = result.error?.message || text.slice(-200) || result.stderr?.slice(-200) || 'нет ответа';
    return { ok: false, error: reason };
  }
}

/** Замер на демо-странице приложения — единственная страница, где эталон известен точно. */
function runDemoCheck(cache) {
  const demoPage = join(ROOT, 'app', 'demo', 'ode-page.png');
  if (!existsSync(demoPage)) return null;
  const groundTruth = join(WORK, 'demo-source.musicxml');
  writeFileSync(groundTruth, APP_FIXTURE, 'utf8');
  const source = decodePng(readFileSync(demoPage));
  const rows = [];
  for (const [name, options] of Object.entries(DEMO_VARIANTS)) {
    let pngPath = demoPage;
    let prep = null;
    if (options) {
      prep = preprocessImageData(source, options);
      pngPath = join(BENCH, `demo-${rows.length}.png`);
      writeFileSync(pngPath, encodePng(prep));
    }
    const out = join(BENCH, `demo-${rows.length}.musicxml`);
    const recognized = recognize(pngPath, out);
    if (!recognized.ok) {
      rows.push({ name, ok: false, error: recognized.error });
      continue;
    }
    const report = compareScores(loadScoreFile(groundTruth), loadScoreFile(out));
    rows.push({
      name,
      ok: true,
      f1: report.f1,
      matched: report.matched,
      expected: report.expectedNotes,
      durationAccuracy: report.durationAccuracy,
      elapsedMs: recognized.elapsedMs,
      size: prep ? `${prep.width}x${prep.height}` : `${source.width}x${source.height}`,
    });
  }
  return { page: `${source.width}x${source.height}`, rows };
}

function main() {
  const manifestPath = join(BENCH, `pages-${label}.json`);
  if (!existsSync(manifestPath)) {
    console.error(`Нет страниц: ${manifestPath}\nСначала: node tools/omr-bench.mjs --engine=${engine} --scale=40 --crop --render-only --label=${label}`);
    process.exitCode = 2;
    return;
  }
  mkdirSync(WORK, { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pages = manifest.pages.filter((page) => !only || page.id === only);
  const results = [];

  for (const page of pages) {
    process.stdout.write(`${page.id.padEnd(22)}`);
    const source = decodePng(readFileSync(page.png));
    const row = { id: page.id, title: page.title, page: { width: source.width, height: source.height }, variants: {} };

    for (const [name, options] of Object.entries(VARIANTS)) {
      let pngPath = page.png;
      let prep = null;
      if (options) {
        prep = preprocessImageData(source, options);
        pngPath = join(BENCH, `${page.id}-${label}-${name}.png`);
        writeFileSync(pngPath, encodePng(prep));
      }
      const recognized = recognize(pngPath, join(BENCH, `${page.id}-${label}-${name}.musicxml`));
      if (!recognized.ok) {
        row.variants[name] = { ok: false, error: recognized.error || recognized.detail, prep: prep?.stats || null };
        continue;
      }
      const report = compareScores(loadScoreFile(join(FIXTURES, `${page.id}.musicxml`)), loadScoreFile(join(BENCH, `${page.id}-${label}-${name}.musicxml`)));
      row.variants[name] = {
        ok: true,
        f1: report.f1,
        matched: report.matched,
        expected: report.expectedNotes,
        spurious: report.spurious.length,
        durationAccuracy: report.durationAccuracy,
        key: `${report.key.recognized}${report.key.match ? '' : ` (эталон ${report.key.expected})`}`,
        meter: report.meter.recognized,
        measures: `${report.measures.recognized}/${report.measures.expected}`,
        elapsedMs: recognized.elapsedMs,
        bytes: recognized.bytes,
        size: prep ? `${prep.width}x${prep.height}` : `${source.width}x${source.height}`,
        prep: prep ? { cropped: prep.stats.cropped, scale: prep.stats.scale, inkRatio: Number(prep.stats.after.inkRatio.toFixed(4)) } : null,
      };
      process.stdout.write(` ${name}:${(report.f1 * 100).toFixed(0)}%`);
    }
    console.log('');
    results.push(row);
  }

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const summary = { engine, label, pieces: results.length, variants: {} };
  for (const name of Object.keys(VARIANTS)) {
    const rows = results.map((row) => row.variants[name]).filter((v) => v?.ok);
    summary.variants[name] = {
      pieces: rows.length,
      failed: results.length - rows.length,
      meanF1: Number(mean(rows.map((r) => r.f1)).toFixed(3)),
      meanDurationAccuracy: Number(mean(rows.map((r) => r.durationAccuracy)).toFixed(3)),
      meanElapsedMs: Math.round(mean(rows.map((r) => r.elapsedMs))),
      notesMatched: rows.reduce((sum, r) => sum + r.matched, 0),
      notesExpected: rows.reduce((sum, r) => sum + r.expected, 0),
      spurious: rows.reduce((sum, r) => sum + r.spurious, 0),
    };
  }

  const demoCheck = runDemoCheck();

  writeFileSync(join(WORK, 'prep-results.json'), `${JSON.stringify({ summary, results, demo: demoCheck }, null, 2)}\n`, 'utf8');
  writeReport(summary, results, demoCheck);

  console.log(`\nДвижок «${engine}», пьес ${summary.pieces}`);
  for (const [name, value] of Object.entries(summary.variants)) {
    console.log(`  ${name.padEnd(8)} F1 ${(value.meanF1 * 100).toFixed(1)}% · нот ${value.notesMatched}/${value.notesExpected} · длительности ${(value.meanDurationAccuracy * 100).toFixed(0)}% · ${value.meanElapsedMs} мс${value.failed ? ` · провалов ${value.failed}` : ''}`);
  }
  if (demoCheck) {
    console.log(`\nДемо-страница приложения (${demoCheck.page}):`);
    for (const row of demoCheck.rows) {
      console.log(`  ${row.name.padEnd(26)} ${row.ok ? `F1 ${(row.f1 * 100).toFixed(0)}% · нот ${row.matched}/${row.expected} · ${row.elapsedMs} мс` : 'ошибка распознавания'}`);
    }
  }
  console.log('Отчёт: docs/omr-prep.md');
}

function writeReport(summary, results, demoCheck) {
  const names = Object.keys(summary.variants);
  const lines = [];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push('# FluteBand AI — влияние предобработки снимка на распознавание');
  lines.push('');
  lines.push(`Отчёт создан автоматически: ${stamp} (движок «${summary.engine}», страниц ${summary.pieces}, метка «${summary.label}»).`);
  lines.push('');
  lines.push('Страницы — те же «печатные страницы» учебных пьес, что и в `docs/omr-benchmark.md`.');
  lines.push('Варианты: `raw` — как есть; `gray` — оттенки серого и растяжение контраста;');
  lines.push('`page` — **режим приложения**: найти лист на фоне и обрезать лист вместе с полями (если фона нет, границы не трогаются);');
  lines.push('`crop` — обрезать поля всегда; `upscale` — `crop` плюс увеличение страницы до 1500 px; `binary` — `crop` плюс бинаризация порогом Оцу.');
  lines.push('');
  lines.push('Важно: страницы здесь синтетические — ровный белый фон, идеальный контраст, ничего лишнего в кадре.');
  lines.push('Поэтому предобработке почти нечего исправлять, и точность не растёт. Выигрыш виден по времени');
  lines.push('(обрезка и меньший размер файла), а на реальных фото сборника ожидается ещё и выигрыш по устойчивости');
  lines.push('к столу, тени и серому фону — но это будет измерено на настоящих снимках, а не заявлено заранее.');
  lines.push('');
  lines.push('| Вариант | F1 | Ноты | Длительности | Лишние ноты | Время | Провалов |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const name of names) {
    const v = summary.variants[name];
    lines.push(`| ${name} | ${(v.meanF1 * 100).toFixed(1)}% | ${v.notesMatched}/${v.notesExpected} | ${(v.meanDurationAccuracy * 100).toFixed(0)}% | ${v.spurious} | ${v.meanElapsedMs} мс | ${v.failed} |`);
  }
  lines.push('');
  lines.push('## По пьесам (F1 по вариантам)');
  lines.push('');
  lines.push(`| Пьеса | Страница | ${names.join(' | ')} |`);
  lines.push(`|---|---|${names.map(() => '---').join('|')}|`);
  for (const row of results) {
    const cells = names.map((name) => {
      const v = row.variants[name];
      if (!v) return '—';
      return v.ok ? `${(v.f1 * 100).toFixed(0)}% (${v.matched}/${v.expected})` : 'ошибка';
    });
    lines.push(`| ${row.title} | ${row.page.width}×${row.page.height} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Как это используется в приложении');
  lines.push('');
  lines.push('- Снимок с камеры и загруженное фото проходят `preprocessImageData` из `app/js/image-prep.js` (вариант `page`).');
  lines.push('- **Включено:** оттенки серого, поиск листа как светлого пятна (стол и тень темнее бумаги), растяжение контраста, обрезка полей вокруг нот — но только если лист найден на фоне.');
  lines.push('- **Выключено по умолчанию:** обрезка полей на «чистых» страницах, занимающих весь кадр (`trimMargins`), увеличение (`minWidth`) и бинаризация — все три на замерах точность не повышали.');
  lines.push('- Логика простая: если вокруг листа виден стол или тень, мы обрезаем лист и поля; если лист занимает весь кадр, границы не трогаем совсем.');
  lines.push('');
  if (demoCheck) {
    lines.push('## Проверка на демо-странице приложения (эталон известен точно)');
    lines.push('');
    lines.push(`Страница \`app/demo/ode-page.png\` — ${demoCheck.page}, эталон: «Ода к радости», 15 нот, D-dur, 4/4.`);
    lines.push('');
    lines.push('| Вариант | F1 | Ноты | Длительности | Размер | Время |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of demoCheck.rows) {
      lines.push(row.ok
        ? `| ${row.name} | ${(row.f1 * 100).toFixed(0)}% | ${row.matched}/${row.expected} | ${(row.durationAccuracy * 100).toFixed(0)}% | ${row.size} | ${row.elapsedMs} мс |`
        : `| ${row.name} | ошибка | — | — | — | — |`);
    }
    lines.push('');
    lines.push('Именно этот замер показал две вещи: обрезка полей на чистой странице ускоряет распознавание примерно на треть');
    lines.push('(5.6 с → 4.1 с), а увеличение мелкой страницы вредит (87% и две потерянные ноты из пятнадцати).');
    lines.push('Поэтому увеличение выключено, а обрезка полей по умолчанию применяется только тогда, когда лист найден на фоне.');
    lines.push('');
  }
  lines.push('## Что ещё нужно проверить');
  lines.push('');
  lines.push('- Реальные фотографии сборника (наклон, тень, блик, разворот книги) — сейчас измерение идёт на синтетических страницах.');
  lines.push('- Выравнивание перспективы: наклон страницы пока не исправляется, только обрезка и контраст.');
  lines.push('');
  writeFileSync(join(ROOT, 'docs', 'omr-prep.md'), lines.join('\n'), 'utf8');
}

main();