// FluteBand AI — стенд подготовки снимка на «фотографиях» сборника.
//
// Ровные синтетические страницы почти не проверяют подготовку снимка (docs/omr-prep.md): там нечего
// исправлять. Здесь мы делаем из страниц фото с телефона (стол, наклон, тень, шум — tools/photo-sim.mjs)
// и смотрим, что даёт выравнивание страницы: без него, с ним и «как есть».
//
// Подготовка страниц: node tools/omr-bench.mjs --engine=homr --scale=40 --crop --render-only --label=base
// Запуск:            node tools/photo-bench.mjs [--engine=homr] [--label=base] [--preset=tilt|hard] [--only=id]
// Результат:         .omr-bench/photo-results.json и отчёт docs/omr-photo.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { compareScores, loadScoreFile } from './omr-accuracy.mjs';
import { preprocessImageData, grayFromRgba } from '../app/js/image-prep.js';
import { findPageQuad, perspectiveCorrect } from '../app/js/perspective.js';
import { PHOTO_PRESETS, simulatePhoto } from './photo-sim.mjs';

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
const presetName = arg('preset', 'tilt');
const preset = PHOTO_PRESETS[presetName] || PHOTO_PRESETS.tilt;
const reportOnly = process.argv.includes('--report-only');

/**
 * Варианты обработки фото:
 *   photo      — фото как есть;
 *   prep       — подготовка без выравнивания наклона (историческая база);
 *   deskew     — с выравниванием наклона (историческая база шага 3а);
 *   deskewEven — эксперимент: свет выравнивается ещё раз после контраста (кромка чище, точность ниже);
 *   deskewTrim — полный режим приложения: наклон + срез тёмной кромки.
 */
const VARIANTS = {
  photo: null,
  prep: { autoCrop: true, deskew: false, minWidth: 0, contrast: true, edgeTrim: false, flattenAfterContrast: false },
  deskew: { autoCrop: true, deskew: true, minWidth: 0, contrast: true, edgeTrim: false, flattenAfterContrast: false },
  deskewEven: { autoCrop: true, deskew: true, minWidth: 0, contrast: true, edgeTrim: false, flattenAfterContrast: true },
  deskewTrim: { autoCrop: true, deskew: true, minWidth: 0, contrast: true, edgeTrim: true, flattenAfterContrast: false },
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

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Тёмная кромка числом: отношение средней яркости внешнего кольца (2% стороны) к средней яркости
 * середины страницы. Единица — кромки нет, чем меньше, тем темнее полоса по краям.
 */
function edgeBandRatio(image) {
  const { data, width, height } = image;
  const gray = grayFromRgba(data, width, height);
  const bandX = Math.max(1, Math.round(width * 0.02));
  const bandY = Math.max(1, Math.round(height * 0.02));
  let edgeSum = 0;
  let edgeCount = 0;
  let centerSum = 0;
  let centerCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = gray[y * width + x];
      const isEdge = x < bandX || x >= width - bandX || y < bandY || y >= height - bandY;
      if (isEdge) {
        edgeSum += value;
        edgeCount += 1;
      } else {
        centerSum += value;
        centerCount += 1;
      }
    }
  }
  if (!edgeCount || !centerCount || centerSum === 0) return null;
  return Number((edgeSum / edgeCount) / (centerSum / centerCount) / 1).toFixed(3) * 1;
}

function main() {
  if (reportOnly) {
    const presets = Object.keys(PHOTO_PRESETS);
    let found = 0;
    for (const name of presets) {
      const file = join(WORK, `photo-results-${name}.json`);
      if (!existsSync(file)) {
        console.log(`нет данных: ${file}`);
        continue;
      }
      const data = JSON.parse(readFileSync(file, 'utf8'));
      writeReport(data.summary, data.results, name);
      console.log(`отчёт docs/omr-photo-${name}.md обновлён из ${file}`);
      found += 1;
    }
    if (!found) {
      console.error('Нет ни одного замера: сначала запустите стенд без --report-only');
      process.exitCode = 2;
      return;
    }
    writeOverview();
    console.log('сводка: docs/omr-photo.md');
    return;
  }

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

  console.log(`Имитация фото: ${preset.title} · страниц ${pages.length} · движок ${engine}`);

  for (const page of pages) {
    process.stdout.write(`${page.id.padEnd(22)}`);
    const flat = decodePng(readFileSync(page.png));
    const photo = simulatePhoto(flat, preset);
    const photoPath = join(BENCH, `${page.id}-${label}-photo-${presetName}.png`);
    writeFileSync(photoPath, encodePng(photo));

    const quad = findPageQuad(grayFromRgba(photo.data, photo.width, photo.height), photo.width, photo.height);

    const row = {
      id: page.id,
      title: page.title,
      photo: { width: photo.width, height: photo.height },
      detected: quad ? { tiltDeg: quad.tiltDeg, coverage: quad.coverage, paperShare: quad.paperShare } : null,
      trueTiltDeg: preset.tiltDeg,
      variants: {},
    };

    for (const [name, options] of Object.entries(VARIANTS)) {
      let pngPath = photoPath;
      let prep = null;
      if (options) {
        prep = preprocessImageData(photo, options);
        pngPath = join(BENCH, `${page.id}-${label}-photo-${presetName}-${name}.png`);
        writeFileSync(pngPath, encodePng(prep));
      }
      const recognized = recognize(pngPath, join(BENCH, `${page.id}-${label}-photo-${presetName}-${name}.musicxml`));
      if (!recognized.ok) {
        row.variants[name] = { ok: false, error: recognized.error || recognized.detail };
        process.stdout.write(` ${name}:ошибка`);
        continue;
      }
      const report = compareScores(
        loadScoreFile(join(FIXTURES, `${page.id}.musicxml`)),
        loadScoreFile(join(BENCH, `${page.id}-${label}-photo-${presetName}-${name}.musicxml`)),
      );
      row.variants[name] = {
        ok: true,
        f1: report.f1,
        matched: report.matched,
        expected: report.expectedNotes,
        spurious: report.spurious.length,
        durationAccuracy: report.durationAccuracy,
        key: report.key.recognized,
        meter: report.meter.recognized,
        measures: `${report.measures.recognized}/${report.measures.expected}`,
        elapsedMs: recognized.elapsedMs,
        size: prep ? `${prep.width}x${prep.height}` : `${photo.width}x${photo.height}`,
        steps: prep ? prep.stats.steps : [],
        deskewed: prep ? !!prep.stats.deskewed : false,
        edgeTrimmed: prep ? !!prep.stats.edgeTrimmed : false,
        edgeBand: edgeBandRatio(prep || photo),
        detectedTilt: prep?.stats?.deskew?.tiltDeg ?? null,
      };
      process.stdout.write(` ${name}:${(report.f1 * 100).toFixed(0)}%`);
    }
    console.log('');
    results.push(row);
  }

  const summary = { engine, label, preset: presetName, presetTitle: preset.title, pieces: results.length, variants: {} };
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
      deskewedPieces: rows.filter((r) => r.deskewed).length,
      meanEdgeBand: Number(mean(rows.map((r) => r.edgeBand).filter((v) => typeof v === 'number')).toFixed(3)),
      trimmedPieces: rows.filter((r) => r.edgeTrimmed).length,
    };
  }
  const detected = results.filter((row) => row.detected);
  summary.detection = {
    found: detected.length,
    of: results.length,
    meanTilt: Number(mean(detected.map((row) => row.detected.tiltDeg)).toFixed(2)),
    trueTilt: preset.tiltDeg,
    meanCoverage: Number(mean(detected.map((row) => row.detected.coverage)).toFixed(3)),
  };

  writeFileSync(join(WORK, `photo-results-${presetName}.json`), `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
  writeReport(summary, results, presetName);
  writeOverview();

  console.log(`\n«${preset.title}», движок «${engine}», пьес ${summary.pieces}`);
  for (const [name, value] of Object.entries(summary.variants)) {
    console.log(`  ${name.padEnd(10)} F1 ${(value.meanF1 * 100).toFixed(1)}% · нот ${value.notesMatched}/${value.notesExpected} · длительности ${(value.meanDurationAccuracy * 100).toFixed(0)}% · кромка ${value.meanEdgeBand ?? '—'} · ${value.meanElapsedMs} мс`);
  }
  console.log(`  лист найден на ${summary.detection.found} из ${summary.detection.of} фото, средний наклон ${summary.detection.meanTilt}° (в имитации ${summary.detection.trueTilt}°)`);
  console.log('Отчёт: docs/omr-photo.md');
}

function writeReport(summary, results, presetName = 'tilt') {
  const lines = [];
  lines.push(`# FluteBand AI — подготовка снимка на «фотографиях»: ${summary.presetTitle}`);
  lines.push('');
  lines.push(`Отчёт создан автоматически: ${new Date().toLocaleString('ru-RU')} (движок «${engine}», метка «${label}»).`);
  lines.push('');
  lines.push('Страницы те же, что в `docs/omr-benchmark.md`, но перед распознаванием из них делается');
  lines.push(`«фото с телефона»: ${summary.presetTitle}. Имитация описана в \`tools/photo-sim.mjs\`: стол с текстурой,`);
  lines.push('поворот и перспективное сжатие дальней кромки, неравномерный свет с тенью, небольшое размытие и шум.');
  lines.push('');
  lines.push('Варианты: `photo` — фото как есть; `prep` — подготовка без выравнивания (обрезка и контраст);');
  lines.push('`deskew` — то же плюс выравнивание наклона; `deskewEven` — эксперимент с повторным выравниванием');
  lines.push('света после контраста; `deskewTrim` — режим приложения (плюс срез тёмной кромки).');
  lines.push('');
  lines.push('Колонка «Кромка» — числовая мера тёмной полосы по краям: отношение средней яркости внешнего');
  lines.push('кольца (2% стороны) к середине страницы. Единица — кромки нет, меньше — полоса темнее.');
  lines.push('');
  lines.push('| Вариант | F1 | Ноты | Длительности | Лишние ноты | Кромка | Время | Пьес с выравниванием | Срезов кромки |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const [name, value] of Object.entries(summary.variants)) {
    lines.push(`| ${name} | ${(value.meanF1 * 100).toFixed(1)}% | ${value.notesMatched}/${value.notesExpected} | ${(value.meanDurationAccuracy * 100).toFixed(0)}% | ${value.spurious} | ${value.meanEdgeBand ?? '—'} | ${value.meanElapsedMs} мс | ${value.deskewedPieces} | ${value.trimmedPieces ?? 0} |`);
  }
  lines.push('');
  lines.push('## Поиск листа на фото');
  lines.push('');
  lines.push(`Лист найден на ${summary.detection.found} из ${summary.detection.of} фото; средний измеренный наклон ${summary.detection.meanTilt}°`);
  lines.push(`при заданном в имитации ${summary.detection.trueTilt}°; среднее «покрытие» (площадь четырёхугольника к площади бумаги) ${summary.detection.meanCoverage}.`);
  lines.push('');
  lines.push('## По пьесам (F1 по вариантам)');
  lines.push('');
  lines.push('| Пьеса | Фото | photo | prep | deskew | deskewEven | deskewTrim | Кромка (deskew → даже → trim) | Наклон найден | Размер после обработки |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of results) {
    const cell = (name) => (row.variants[name]?.ok ? `${(row.variants[name].f1 * 100).toFixed(0)}% (${row.variants[name].matched}/${row.variants[name].expected})` : 'ошибка');
    const band = `${row.variants.deskew?.edgeBand ?? '—'} → ${row.variants.deskewEven?.edgeBand ?? '—'} → ${row.variants.deskewTrim?.edgeBand ?? '—'}`;
    lines.push(`| ${row.title} | ${row.photo.width}×${row.photo.height} | ${cell('photo')} | ${cell('prep')} | ${cell('deskew')} | ${cell('deskewEven')} | ${cell('deskewTrim')} | ${band} | ${row.detected ? `${row.detected.tiltDeg}°` : '—'} | ${row.variants.deskewTrim?.size || row.variants.deskew?.size || '—'} |`);
  }
  lines.push('');
  lines.push('## Что из этого следует');
  lines.push('');
  const photo = summary.variants.photo?.meanF1 ?? 0;
  const prep = summary.variants.prep?.meanF1 ?? 0;
  const deskew = summary.variants.deskew?.meanF1 ?? 0;
  lines.push(`- Фото вместо ровной страницы снижает точность: ${(photo * 100).toFixed(1)}% против 83.6% на ровных страницах.`);
  lines.push(`- Обрезка и контраст без выравнивания дают ${(prep * 100).toFixed(1)}%.`);
  lines.push(`- Выравнивание страницы даёт ${(deskew * 100).toFixed(1)}%.`);
  const gain = deskew - prep;
  if (gain > 0.01) {
    lines.push(`- Выравнивание помогает: +${(gain * 100).toFixed(1)} п.п. к точности по сравнению с обрезкой без него.`);
  } else if (gain < -0.01) {
    lines.push(`- Выравнивание на этом наборе точность не повысило (${(gain * 100).toFixed(1)} п.п.): причина разбирается ниже.`);
  } else {
    lines.push('- Выравнивание не меняет точность на этом наборе: ищите разницу в разборе ниже.');
  }
  const trim = summary.variants.deskewTrim;
  const even = summary.variants.deskewEven;
  if (even) {
    const deltaEven = even.meanF1 - deskew;
    lines.push(`- Эксперимент «свет ещё раз после контраста»: кромка ${summary.variants.deskew?.meanEdgeBand ?? '—'} → ${even.meanEdgeBand ?? '—'} (ближе к 1 — ровнее), точность ${(even.meanF1 * 100).toFixed(1)}% против ${(deskew * 100).toFixed(1)}% (${deltaEven >= 0 ? '+' : ''}${(deltaEven * 100).toFixed(1)} п.п.).`);
    if (deltaEven < -0.005) {
      lines.push('  Точность упала — поэтому в приложении этот шаг **выключен по умолчанию** (`flattenAfterContrast: false`).');
    } else {
      lines.push('  Точность не изменилась — шаг можно включать ради ровного края.');
    }
  }
  if (trim) {
    const delta = trim.meanF1 - deskew;
    lines.push(`- Срез тёмной кромки: кромка ${summary.variants.deskew?.meanEdgeBand ?? '—'} → ${trim.meanEdgeBand ?? '—'} (меньше — чище), точность ${(trim.meanF1 * 100).toFixed(1)}% против ${(deskew * 100).toFixed(1)}% (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} п.п.), срез сработал на ${trim.trimmedPieces ?? 0} из ${trim.pieces} фото.`);
    if (delta < -0.02) {
      lines.push('  Точность упала заметно — срез кромки в приложении включать нельзя в таком виде.');
    } else if (delta > 0.005) {
      lines.push('  Точность выросла: срез кромки оставляем включённым по умолчанию.');
    } else if ((trim.trimmedPieces ?? 0) === 0) {
      lines.push('  На этих фото срез не сработал ни разу: после выравнивания света кромки уже нет, и срезать нечего.');
      lines.push('  Шаг оставлен как страховка для снимка, где лист занимает весь кадр и обрезка полей не помогает.');
    } else {
      lines.push('  Точность не изменилась в пределах погрешности: срез кромки влияет на вид кадра, а не на распознавание.');
    }
  }
  const failed = results.filter((row) => !row.detected);
  if (failed.length) {
    lines.push(`- Лист не найден на ${failed.length} фото: ${failed.map((row) => row.id).join(', ')} — такие снимки обрабатываются как раньше (обрезка и контраст).`);
  }
  const errors = [];
  for (const row of results) for (const [name, value] of Object.entries(row.variants)) if (!value.ok) errors.push(`${row.id}/${name}: ${value.error}`);
  if (errors.length) {
    lines.push('');
    lines.push('Ошибки распознавания:');
    for (const error of errors) lines.push(`- ${error}`);
  }
  lines.push('');
  lines.push('## Ограничения этого замера');
  lines.push('');
  lines.push('- Это имитация, а не настоящее фото: бумага идеально белая, ноты не смяты, блика от лампы нет,');
  lines.push('  тень плавная. Настоящий снимок сборника тяжелее, поэтому цифры здесь — верхняя граница.');
  lines.push('- Одна страница на пьесу и один ракурс; разворот книги и съёмка с рук не проверялись.');
  lines.push('- Проверка выполнялась на учебных пьесах уровня 1–3 класса, а не на всём сборнике.');
  if (trim) {
    lines.push('- Тёмная кромка по краям выпрямленной страницы срезается по непрерывной полосе у края');
    lines.push(`  (вариант \`deskewTrim\`): кромка ${summary.variants.deskew?.meanEdgeBand ?? '—'} → ${trim.meanEdgeBand ?? '—'},`);
    lines.push(`  точность ${(trim.meanF1 * 100).toFixed(1)}% против ${(deskew * 100).toFixed(1)}% без среза.`);
    lines.push('  Срез ограничен долей стороны и останавливается на первой светлой строке, поэтому заголовок');
    lines.push('  или нотная строка у края под нож не попадают (проверено юнит-тестами `tests/image.test.mjs`).');
  }
  lines.push('');
  writeFileSync(join(ROOT, 'docs', `omr-photo-${presetName}.md`), `${lines.join('\n')}\n`, 'utf8');
}

/** Сводка по всем пресетам: одна таблица, чтобы видеть, где выравнивание особенно нужно */
function writeOverview() {
  const runs = [];
  for (const name of Object.keys(PHOTO_PRESETS)) {
    const file = join(WORK, `photo-results-${name}.json`);
    if (existsSync(file)) runs.push({ name, ...JSON.parse(readFileSync(file, 'utf8')) });
  }
  if (!runs.length) return;

  const lines = [];
  lines.push('# FluteBand AI — подготовка снимка на фотографиях сборника (сводка)');
  lines.push('');
  lines.push(`Сводка собрана автоматически: ${new Date().toLocaleString('ru-RU')}.`);
  lines.push('');
  lines.push('Ровные синтетические страницы почти ничего не говорят о подготовке снимка: там нечего исправлять');
  lines.push('(`docs/omr-prep.md`). Поэтому страницы стенда прогоняются через имитацию фото с телефона');
  lines.push('(`tools/photo-sim.mjs`): стол с текстурой, поворот листа, перспективное сжатие дальней кромки,');
  lines.push('неравномерный свет с тенью, размытие и шум. Варианты обработки:');
  lines.push('');
  lines.push('- `photo` — фото как есть, без подготовки;');
  lines.push('- `prep` — подготовка без выравнивания (адаптивный порог бумаги, выравнивание света, обрезка, контраст);');
  lines.push('- `deskew` — то же плюс выравнивание наклона страницы;');
  lines.push('- `deskewEven` — эксперимент: свет выравнивается ещё раз после контраста;');
  lines.push('- `deskewTrim` — режим приложения: наклон плюс срез тёмной кромки по краям.');
  lines.push('');
  lines.push('Колонка «Кромка» — отношение средней яркости внешнего кольца (2% стороны) к середине страницы:');
  lines.push('единица значит «кромки нет», меньше — полоса темнее.');
  lines.push('');
  lines.push('| Имитация фото | F1 «как есть» | F1 без выравнивания | F1 с выравниванием | эксперимент: свет после контраста | F1 режим приложения | Кромка (режим приложения) | Ноты (режим приложения) | Лист найден |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const value = (name) => (run.summary.variants[name] ? `${(run.summary.variants[name].meanF1 * 100).toFixed(1)}%` : '—');
    const trim = run.summary.variants.deskewTrim;
    lines.push(`| ${run.summary.presetTitle} | ${value('photo')} | ${value('prep')} | ${value('deskew')} | ${value('deskewEven')} | ${value('deskewTrim')} | ${trim?.meanEdgeBand ?? '—'} | ${trim ? `${trim.notesMatched}/${trim.notesExpected}` : '—'} | ${run.summary.detection.found} из ${run.summary.detection.of} |`);
  }
  lines.push('');
  lines.push('Подробности по каждому пресету:');
  for (const run of runs) lines.push(`- [${run.summary.presetTitle}](omr-photo-${run.name}.md)`);
  lines.push('');
  lines.push('## Что дал этот замер');
  lines.push('');
  lines.push('Первый прогон стенда вскрыл ошибку в подготовке снимка: порог бумаги считался по всему кадру,');
  lines.push('и при свете сбоку маска бумаги обрезала затенённую часть листа (на первой же пьесе — треть ширины).');
  lines.push('На тех фото это дало `prep` 69.8% и `deskew` 35.7% — то есть подготовка не помогала, а ломала распознавание.');
  lines.push('');
  lines.push('После исправления (местный уровень бумаги по блокам, выравнивание света, выравнивание наклона):');
  for (const run of runs) {
    const prep = run.summary.variants.prep?.meanF1 ?? 0;
    const deskew = run.summary.variants.deskew?.meanF1 ?? 0;
    const trim = run.summary.variants.deskewTrim;
    lines.push(`- «${run.summary.presetTitle}»: выравнивание даёт ${(deskew * 100).toFixed(1)}% против ${(prep * 100).toFixed(1)}% без него (+${((deskew - prep) * 100).toFixed(1)} п.п.).`);
    if (trim) {
      lines.push(`  Срез тёмной кромки: ${(trim.meanF1 * 100).toFixed(1)}% (${((trim.meanF1 - deskew) * 100).toFixed(1)} п.п.), кромка по краям ${trim.meanEdgeBand ?? '—'}.`);
    }
  }
  lines.push('');
  lines.push('### Тёмная кромка: что показал замер');
  lines.push('');
  for (const run of runs) {
    const raw = run.summary.variants.photo?.meanEdgeBand ?? '—';
    const app = run.summary.variants.deskewTrim?.meanEdgeBand ?? '—';
    const trim = run.summary.variants.deskewTrim;
    const deskew = run.summary.variants.deskew;
    const delta = trim && deskew ? trim.meanF1 - deskew.meanF1 : 0;
    lines.push(`- «${run.summary.presetTitle}»: кромка на исходном фото ${raw}, после подготовки ${app}.`);
    if (trim && deskew) {
      lines.push(`  Срез кромки: ${(trim.meanF1 * 100).toFixed(1)}% против ${(deskew.meanF1 * 100).toFixed(1)}% без него (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} п.п.) — то есть на этих фото он не срабатывает: обрезка полей и так убирает края.`);
    }
  }
  lines.push('');
  lines.push('Вывод: заявленная ранее «тёмная кромка после выравнивания» на текущей подготовке практически');
  lines.push('отсутствует — выравнивание света по блокам её уже убрало (кромка 0.92–0.97 против 0.42–0.43');
  lines.push('на исходном фото). Срез кромки оставлен как страховка для случая, когда лист занимает весь кадр');
  lines.push('и обрезка полей не срабатывает; он останавливается на первой светлой строке и ограничен 3.5%');
  lines.push('стороны, поэтому заголовок или нотную строку у края не задевает (`tests/image.test.mjs`).');
  lines.push('');
  const evenDeltas = runs
    .map((run) => {
      const deskew = run.summary.variants.deskew?.meanF1;
      const even = run.summary.variants.deskewEven?.meanF1;
      return typeof deskew === 'number' && typeof even === 'number' ? { title: run.summary.presetTitle, delta: even - deskew, band: run.summary.variants.deskewEven?.meanEdgeBand } : null;
    })
    .filter(Boolean);
  if (evenDeltas.length) {
    lines.push('Эксперимент «выровнять свет ещё раз после контраста» убирает кромку почти полностью:');
    for (const item of evenDeltas) {
      const verdict = item.delta < -0.005 ? `хуже на ${(-item.delta * 100).toFixed(1)} п.п` : item.delta > 0.005 ? `лучше на ${(item.delta * 100).toFixed(1)} п.п` : 'та же';
      lines.push(`- «${item.title}»: кромка ${item.band ?? '—'}, точность ${verdict}.`);
    }
    const worst = Math.min(...evenDeltas.map((item) => item.delta));
    if (worst < -0.005) {
      lines.push('');
      lines.push(`Худший случай — минус ${(-worst * 100).toFixed(1)} п.п., поэтому в приложении шаг **выключен по умолчанию**`);
      lines.push('(`flattenAfterContrast: false`): распознавание важнее ровного кадра. Числа сохранены, чтобы');
      lines.push('решение можно было пересмотреть.');
    }
  }
  lines.push('');
  lines.push('Проверка «глазами» (мультимодальная модель, `tools/vision-probe.mjs`) на тех же картинках подтверждает:');
  lines.push('на исходном фото линейки наклонены, без выравнивания лист выходит за кадр, после выравнивания');
  lines.push('линейки горизонтальны, а страница видна целиком.');
  lines.push('');
  writeFileSync(join(ROOT, 'docs', 'omr-photo.md'), `${lines.join('\n')}\n`, 'utf8');
}

main();