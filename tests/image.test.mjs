// FluteBand AI — тесты предобработки снимка (шаг 3) и правки распознанных пьес.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  grayFromRgba,
  histogram,
  luminance,
  otsuThreshold,
  contrastBounds,
  stretchContrast,
  pageBounds,
  inkBounds,
  cropGray,
  resizeGray,
  grayToRgba,
  planPreprocess,
  preprocessImageData,
  edgeTrimBounds,
} from '../app/js/image-prep.js';

/** Синтетический «снимок сборника на столе»: тёмный стол, светлый лист, тёмные линейки стана. */
function syntheticPage({
  width = 200,
  height = 160,
  table = 120,
  paper = 215,
  inkValue = 55,
  page = { x: 30, y: 20, width: 140, height: 110 },
} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onPage = x >= page.x && x < page.x + page.width && y >= page.y && y < page.y + page.height;
      let value = table;
      if (onPage) {
        value = paper;
        // пять линеек стана с шагом 8 пикселей — «ноты» на странице
        const local = y - page.y;
        if (local >= 10 && local < 56 && local % 8 === 0) value = inkValue;
      }
      const p = (y * width + x) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

test('предобработка: яркость, серое, гистограмма', () => {
  assert.ok(Math.abs(luminance(255, 0, 0) - 76.245) < 0.01);
  const gray = grayFromRgba(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assert.deepEqual([...gray], [255, 0]);
  const hist = histogram(new Uint8ClampedArray([0, 0, 5, 255]));
  assert.equal(hist[0], 2);
  assert.equal(hist[5], 1);
  assert.equal(hist[255], 1);
});

test('предобработка: контраст бледного снимка растягивается, а порог Оцу разделяет печать и бумагу', () => {
  // Бледная печать: бумага 200, ноты 170 — без растяжения движку читать нечего
  const gray = new Uint8ClampedArray(1000);
  for (let i = 0; i < 1000; i += 1) gray[i] = i % 5 === 0 ? 170 : 200;
  const { low, high } = contrastBounds(gray);
  const stretched = stretchContrast(gray, low, high);
  assert.equal(Math.max(...stretched), 255, 'бумага должна стать белой');
  assert.ok(Math.min(...stretched) < 40, 'печать должна стать почти чёрной');

  const bold = new Uint8ClampedArray(1000);
  for (let i = 0; i < 1000; i += 1) bold[i] = i % 4 === 0 ? 40 : 230;
  const threshold = otsuThreshold(bold);
  // Порог Оцу может совпасть с уровнем печати: важно, что он отделяет её от бумаги
  const inkPixels = [...bold].filter((v) => v <= threshold).length;
  assert.equal(inkPixels, 250, `порог ${threshold} должен отделять 250 пикселей печати`);
});

test('предобработка: лист находится на тёмном столе, ноты — внутри листа', () => {
  const page = syntheticPage();
  const gray = grayFromRgba(page.data, page.width, page.height);

  const paper = pageBounds(gray, page.width, page.height);
  assert.ok(paper, 'лист должен быть найден');
  assert.ok(Math.abs(paper.x - 30) <= 2 && Math.abs(paper.y - 20) <= 2, `левый верхний угол листа: ${JSON.stringify(paper)}`);
  assert.ok(paper.width >= 138 && paper.height >= 108, `размер листа: ${JSON.stringify(paper)}`);

  const cropped = cropGray(gray, page.width, page.height, paper);
  const ink = inkBounds(cropped.gray, cropped.width, cropped.height);
  assert.ok(ink, 'ноты внутри листа должны быть найдены');
  // Линейки стана идут в листе с 16-го по 48-й пиксель — обрезка не должна их срезать
  assert.ok(ink.y <= 16 && ink.y + ink.height >= 49, `обрезка не должна срезать линейки: ${JSON.stringify(ink)}`);
  assert.ok(ink.height < cropped.height, 'пустые поля листа должны быть убраны');
});

test('предобработка: пустой лист не обрезается в ничто', () => {
  const gray = new Uint8ClampedArray(100 * 100).fill(255);
  assert.equal(inkBounds(gray, 100, 100), null, 'на пустом листе нечего обрезать');
  assert.equal(pageBounds(gray, 100, 100), null, 'весь кадр — лист, обрезать нечего');
});

test('предобработка: изменение размера и план обработки', () => {
  const gray = new Uint8ClampedArray([0, 128, 255, 64]);
  const bigger = resizeGray(gray, 2, 2, 4, 4);
  assert.equal(bigger.length, 16);
  assert.equal(bigger[0], 0);
  assert.equal(bigger[15], 64);
  assert.equal(resizeGray(gray, 2, 2, 2, 2), gray, 'без изменения размера возвращаем тот же массив');

  const plan = planPreprocess(800, 600, { minWidth: 1500, maxSide: 3000 });
  assert.equal(plan.width, 1500);
  assert.equal(plan.height, 1125);
  const limited = planPreprocess(4000, 3000, { minWidth: 1500, maxSide: 2000 });
  assert.equal(limited.width, 2000);
  assert.equal(limited.height, 1500);
});

test('предобработка: полный конвейер даёт чёрно-белую страницу нужного размера', () => {
  const page = syntheticPage();
  const result = preprocessImageData(page, { minWidth: 0, maxSide: 0 });
  assert.equal(result.data.length, result.width * result.height * 4);
  assert.equal(result.stats.cropped, true);
  assert.ok(result.width < page.width && result.height < page.height, 'страница стала компактнее');
  assert.ok(result.stats.after.brightRatio > 0.5, 'после растяжения контраста бумага преобладает');
  assert.ok(result.stats.after.inkRatio > 0.005, 'ноты должны остаться на странице');

  const binary = preprocessImageData(page, { minWidth: 0, maxSide: 0, binarize: true });
  assert.equal(binary.stats.binarized, true);
  const values = new Set();
  for (let i = 0; i < binary.data.length; i += 4) values.add(binary.data[i]);
  assert.deepEqual([...values].sort((a, b) => a - b), [0, 255], 'в чёрно-белом режиме только 0 и 255');

  const asRgba = grayToRgba(new Uint8ClampedArray([0, 255]));
  assert.deepEqual([...asRgba], [0, 0, 0, 255, 255, 255, 255, 255]);
});

test('предобработка: чистый лист без фона не обрезается, если не попросили явно', () => {
  // Страница занимает весь кадр: вокруг неё нет стола, значит границы трогать не нужно
  const width = 200;
  const height = 160;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 40; y < 60; y += 6) {
    for (let x = 20; x < 180; x += 1) {
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
  const page = { width, height, data };

  const safe = preprocessImageData(page, { minWidth: 0, maxSide: 0 });
  assert.equal(safe.stats.cropped, false, 'без фона на снимке границы не обрезаем');
  assert.equal(safe.width, width);
  assert.equal(safe.height, height);

  const trimmed = preprocessImageData(page, { minWidth: 0, maxSide: 0, trimMargins: true });
  assert.equal(trimmed.stats.cropped, true, 'явная обрезка полей должна работать');
  assert.ok(trimmed.height < height, 'поля вокруг нот убираются');
});

test('PNG: кодирование и декодирование не теряют пиксели', async () => {
  const { encodePng, decodePng } = await import('../tools/png.mjs');
  const width = 7;
  const height = 5;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 37) % 256;
    data[i * 4 + 1] = 255 - ((i * 11) % 256);
    data[i * 4 + 2] = i % 2 ? 0 : 200;
    data[i * 4 + 3] = 255;
  }
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual([...decoded.data], [...data]);
});

// --- правка распознанных пьес -------------------------------------------------

const omrScore = (measures, extra = {}) => ({
  id: 'omr-test',
  title: 'Распознанная пьеса',
  tempo: 100,
  meter: { beats: 4, beatType: 4 },
  key: { tonic: 'C', mode: 'major', fifths: 0 },
  measures,
  source: { kind: 'omr', engine: 'homr' },
  warnings: [],
  ...extra,
});

const note = (beat, dur, midi = 60) => ({ beat, dur, pitches: [midi], voice: 1 });

test('правка распознавания: пустые такты убираются, ноты не трогаются', async () => {
  const { dropEmptyMeasures, autoRepairScore } = await import('../app/js/score-fixes.js');
  const score = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [] }, // артефакт переноса строки
    { number: '3', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
  ]);
  const { score: fixed, removed } = dropEmptyMeasures(score);
  assert.deepEqual(removed, ['2']);
  assert.equal(fixed.measures.length, 2);
  assert.equal(fixed.measures[0].events.length, 4);

  const repaired = autoRepairScore(score);
  assert.equal(repaired.score.measures.length, 2);
  assert.equal(repaired.applied.length, 1);
  assert.ok(repaired.score.warnings.some((w) => w.includes('пустые такты')), 'правка должна быть видна в предупреждениях');
});

test('режим «только мелодия»: такты, где флейта молчит, остаются паузами', async () => {
  const { markRestMeasures, dropEmptyMeasures, autoRepairScore, suggestFixes } = await import('../app/js/score-fixes.js');
  // Страница из реального сборника: такты 9–13 — вступление фортепиано, у флейты там нот нет
  const score = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [] },
    { number: '3', events: [] },
    { number: '4', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
  ]);
  const rested = markRestMeasures(score);
  assert.deepEqual(rested.marked, ['2', '3']);
  assert.equal(rested.score.measures[1].rest, true);
  assert.equal(rested.score.measures.length, 4, 'такты должны остаться на своих местах');
  assert.equal(rested.score.measures[1].events.length, 0, 'фантомных нот добавлять нельзя');

  // Авто-правка паузы не выбрасывает — иначе минус сдвинется
  const repaired = autoRepairScore(rested.score);
  assert.equal(repaired.score.measures.length, 4);
  assert.equal(repaired.applied.length, 0);
  assert.deepEqual(dropEmptyMeasures(rested.score).removed, []);
  // И «убрать пустые такты» тоже не предлагается
  assert.equal(suggestFixes(rested.score).some((s) => s.id === 'drop-empty'), false);

  // Без пометки паузой тот же такт по-прежнему считается артефактом распознавания
  assert.deepEqual(dropEmptyMeasures(score).removed, ['2', '3']);
});

test('проверка модели: такт-пауза — не ошибка, но видна в метриках', async () => {
  const { validateScore } = await import('../app/js/score.js');
  const score = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [], rest: true },
  ]);
  const report = validateScore(score);
  assert.equal(report.ok, true, `не ожидалось замечаний: ${report.problems.join('; ')}`);
  assert.equal(report.metrics.restMeasures, 1);
  assert.equal(report.metrics.emptyMeasures, 0);

  const withArtifact = validateScore(omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [] },
  ]));
  assert.equal(withArtifact.ok, false);
  assert.equal(withArtifact.metrics.emptyMeasures, 1);
});

test('клиент распознавания: режим уходит в запрос, ответ разбирается', async () => {
  const { recognizeImageBlob } = await import('../app/js/recognition.js');
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), form: init?.body });
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        musicxml: '<score-partwise version="4.0"><part id="P1"/></score-partwise>',
        engine: 'homr',
        mode: 'melody',
        melody: { ok: true, systems: 4, melodyStaves: 4, extraStaves: 8 },
        elapsedMs: 9616,
        warnings: ['Распознана только мелодия (верхняя строка)'],
      }),
    };
  };
  try {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x20])], { type: 'image/jpeg' });
    const answer = await recognizeImageBlob(blob, { base: 'https://service.example.com', mode: 'melody' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://service.example.com/recognize');
    assert.equal(seen[0].form.get('mode'), 'melody');
    assert.equal(answer.ok, true);
    assert.equal(answer.mode, 'melody');
    assert.equal(answer.melody.systems, 4);
    assert.equal(answer.elapsedMs, 9616);

    // Полный режим — поле mode не отправляем: сервис по умолчанию читает всю страницу
    const full = await recognizeImageBlob(blob, { mode: 'full' });
    assert.equal(seen[1].form.get('mode'), null);
    assert.equal(full.mode, 'melody', 'режим берётся из ответа сервиса');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('правка распознавания: 3/8 превращается в 6/8 удвоением длительностей', async () => {
  const { suggestFixes, setMeter, rescaleDurations } = await import('../app/js/score-fixes.js');
  const score = omrScore(
    [
      { number: '1', events: [note(0, 0.75, 67), note(0.75, 0.75, 69)], meter: { beats: 3, beatType: 8 } },
      { number: '2', events: [note(0, 0.75, 71), note(0.75, 0.75, 72)], meter: { beats: 3, beatType: 8 } },
    ],
    { meter: { beats: 3, beatType: 8 } },
  );
  const suggestion = suggestFixes(score).find((s) => s.id === 'to-six-eight');
  assert.ok(suggestion, 'для размера 3/8 должна быть подсказка про 6/8');

  const fixed = suggestion.apply(score);
  assert.deepEqual(fixed.meter, { beats: 6, beatType: 8 });
  assert.equal(fixed.measures[0].events[0].dur, 1.5, 'длительности удваиваются');
  assert.equal(fixed.measures[0].events[1].beat, 1.5, 'позиции внутри такта тоже удваиваются');

  assert.deepEqual(setMeter(score, 6, 8).score.meter, { beats: 6, beatType: 8 });
  assert.equal(rescaleDurations(score, 1).score, score, 'коэффициент 1 ничего не меняет');
});

test('правка распознавания: подсказки не выдумываются там, где всё в порядке', async () => {
  const { suggestFixes } = await import('../app/js/score-fixes.js');
  const score = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
  ]);
  assert.deepEqual(suggestFixes(score), []);

  const withEmpty = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [] },
  ]);
  assert.deepEqual(suggestFixes(withEmpty).map((s) => s.id), ['drop-empty']);
});

test('правка распознавания: недописанный последний такт можно убрать', async () => {
  const { suggestFixes, dropTrailingPartialMeasures } = await import('../app/js/score-fixes.js');
  const score = omrScore([
    { number: '1', events: [note(0, 1), note(1, 1), note(2, 1), note(3, 1)] },
    { number: '2', events: [note(0, 1.5)] }, // 1.5 доли вместо 4 — ошибка распознавания
  ]);
  const suggestion = suggestFixes(score).find((s) => s.id === 'drop-trailing');
  assert.ok(suggestion);
  assert.equal(suggestion.apply(score).measures.length, 1);

  const single = omrScore([{ number: '1', events: [note(0, 1)] }]);
  assert.equal(dropTrailingPartialMeasures(single).score.measures.length, 1, 'единственный такт не убираем');
});

// ── Тёмная кромка после выравнивания (шаг 3а) ────────────────────────────────

/** Страница с тёмной полосой по краям: тень и граница листа после выравнивания. */
function pageWithShadow({ width = 400, height = 300, paper = 230, shadow = 90, band = { left: 6, right: 6, top: 4, bottom: 4 } } = {}) {
  const gray = new Uint8ClampedArray(width * height).fill(paper);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBand = x < band.left || x >= width - band.right || y < band.top || y >= height - band.bottom;
      if (inBand) gray[y * width + x] = shadow;
    }
  }
  return { gray, width, height };
}

test('тёмная кромка: срезается ровно полоса тени по краям', () => {
  const { gray, width, height } = pageWithShadow();
  const box = edgeTrimBounds(gray, width, height);
  assert.ok(box, 'кромка не найдена');
  assert.deepEqual(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 6, y: 4, width: width - 12, height: height - 8 },
  );
});

test('тёмная кромка: чистая страница не трогается', () => {
  const gray = new Uint8ClampedArray(400 * 300).fill(230);
  assert.equal(edgeTrimBounds(gray, 400, 300), null, 'на ровной бумаге срезать нечего');
  assert.equal(edgeTrimBounds(new Uint8ClampedArray(20 * 20).fill(200), 20, 20), null, 'слишком маленький кадр не трогаем');
});

test('тёмная кромка: заголовок у края не попадает под нож', () => {
  const { gray, width, height } = pageWithShadow({ band: { left: 5, right: 5, top: 0, bottom: 0 } });
  // Заголовок: три «толстые» строки текста через 6 px бумаги от края — типичная шапка сборника
  for (let y = 8; y < 11; y += 1) {
    for (let x = 120; x < 280; x += 1) gray[y * width + x] = 40;
  }
  const box = edgeTrimBounds(gray, width, height);
  assert.ok(box);
  assert.equal(box.x, 5, 'левая тень срезана');
  assert.equal(box.y, 0, 'строка заголовка не считается кромкой');
});

test('тёмная кромка: срез ограничен долей стороны', () => {
  const { gray, width, height } = pageWithShadow({ band: { left: 5, right: 5, top: 0, bottom: 0 } });
  // Верхняя половина страницы тёмная (например, тень от руки) — режем только разрешённую долю
  for (let y = 0; y < height / 2; y += 1) for (let x = 0; x < width; x += 1) gray[y * width + x] = 85;
  const box = edgeTrimBounds(gray, width, height, { maxPercent: 0.03 });
  assert.ok(box, 'кромка найдена');
  assert.equal(box.y, Math.round(height * 0.03), 'срез сверху равен пределу');
  assert.ok(box.height >= height * 0.6, 'страница не потеряла больше 40%');
});

test('предобработка: срез кромки включается и выключается', () => {
  const { gray, width, height } = pageWithShadow({ width: 200, height: 160, band: { left: 4, right: 4, top: 3, bottom: 3 } });
  const image = { data: grayToRgba(gray), width, height };
  const withTrim = preprocessImageData(image, { autoCrop: false, deskew: false, flatten: false, edgeTrim: true });
  const without = preprocessImageData(image, { autoCrop: false, deskew: false, flatten: false, edgeTrim: false });
  assert.equal(withTrim.stats.edgeTrimmed, true);
  assert.equal(without.stats.edgeTrimmed, false);
  assert.ok(
    withTrim.stats.steps.some((step) => step.startsWith('кромка срезана')),
    `нет шага среза кромки: ${withTrim.stats.steps.join(', ')}`,
  );
  assert.ok(withTrim.width < without.width && withTrim.height < without.height, 'кадр должен стать меньше');
  // Кромка срезана: у края больше нет тёмных пикселей.
  // Заодно проверяем страховку: на странице без тёмного контраст не растягивается (иначе бумага почернела бы).
  assert.ok(withTrim.stats.steps.includes('контраст не нужен (тёмного на странице нет)'), 'страховка контраста не сработала');
  const first = withTrim.data[0];
  assert.ok(first > 150, `левый верхний пиксель после среза тёмный: ${first}`);
});

test('предобработка: без тёмного на странице контраст не растягивается', () => {
  const gray = new Uint8ClampedArray(120 * 90).fill(228);
  const image = { data: grayToRgba(gray), width: 120, height: 90 };
  const result = preprocessImageData(image, { autoCrop: false, deskew: false, flatten: false, edgeTrim: false, contrast: true });
  assert.equal(result.stats.after.meanLuminance, 228, 'ровная бумага не должна почернеть');
});

test('предобработка: повторное выравнивание света не делается, если свет уже ровный', () => {
  // Ровная по свету страница с нотами: после первого выравнивания градиента нет, второй проход лишний.
  // Что он срабатывает там, где тень осталась, проверяет tests/photo.test.mjs на наклонном фото.
  const width = 240;
  const height = 160;
  const gray = new Uint8ClampedArray(width * height).fill(235);
  for (let y = 20; y < height - 20; y += 20) {
    for (let x = 20; x < width - 20; x += 1) gray[y * width + x] = 40;
  }
  const image = { data: grayToRgba(gray), width, height };
  const result = preprocessImageData(image, { autoCrop: false, deskew: false, flatten: true, edgeTrim: false, contrast: true });
  assert.equal(result.stats.flattenedAfterContrast, false, 'на ровном свете второй проход не нужен');
  assert.equal(
    result.stats.steps.some((step) => step.startsWith('свет выровнен после контраста')),
    false,
    `лишний шаг: ${result.stats.steps.join(', ')}`,
  );
  assert.ok(result.stats.after.darkRatio > 0.0005, 'ноты должны остаться тёмными');
});