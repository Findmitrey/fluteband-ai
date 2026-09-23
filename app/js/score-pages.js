// FluteBand AI — сборка одной пьесы из нескольких снятых страниц.
//
// Ученик снимает сборник по страницам, а пьеса должна получиться одна: этот модуль приклеивает
// следующую распознанную страницу к уже собранной пьесе и честно предупреждает о расхождениях
// (размер, тональность, темп). Модуль без DOM — проверяется юнит-тестами.

import { meterOf } from './timeline.js';
import { keyLabel } from './harmony.js';

export const DEFAULT_MAX_PAGES = 12;

/** Сколько страниц уже собрано в пьесе. */
export function pageCount(score) {
  if (!score) return 0;
  if (Number.isFinite(score.pages) && score.pages > 0) return score.pages;
  return score.measures?.length ? 1 : 0;
}

/** Где начинается каждая страница: [0, 4, 8] — значит страницы по 4 такта. */
export function pageStarts(score) {
  const starts = Array.isArray(score?.pageStarts) && score.pageStarts.length ? score.pageStarts : null;
  if (starts) return starts;
  return score?.measures?.length ? [0] : [];
}

/** Номер страницы для такта — для подписи в интерфейсе. */
export function pageOfMeasure(score, measureIndex) {
  const starts = pageStarts(score);
  let page = 1;
  for (let i = 0; i < starts.length; i += 1) if (measureIndex >= starts[i]) page = i + 1;
  return page;
}

function meterText(meter) {
  return meter ? `${meter.beats}/${meter.beatType}` : '—';
}

function sameMeter(a, b) {
  return !!a && !!b && a.beats === b.beats && a.beatType === b.beatType;
}

function sameKey(a, b) {
  if (!a || !b) return true;
  return a.tonic === b.tonic && a.mode === b.mode;
}

/** Расхождения между уже собранной пьесой и новой страницей — то, о чём честно предупреждаем. */
function pageWarnings(base, next) {
  const warnings = [];
  const baseMeter = meterOf(base, base.measures[0]);
  const nextMeter = meterOf(next, next.measures[0]);
  if (!sameMeter(baseMeter, nextMeter)) {
    warnings.push(`размер на новой странице другой: ${meterText(nextMeter)} вместо ${meterText(baseMeter)} — оставили прежний`);
  }
  if (!sameKey(base.key, next.key)) {
    warnings.push(`тональность на новой странице другая: ${keyLabel(next.key)} вместо ${keyLabel(base.key)} — оставили прежнюю`);
  }
  if (Number.isFinite(next.tempo) && Number.isFinite(base.tempo) && Math.abs(next.tempo - base.tempo) > 1) {
    warnings.push(`темп на новой странице другой: ${next.tempo} вместо ${base.tempo} — оставили прежний`);
  }
  return warnings;
}

/**
 * Такты пьесы, разложенные по страницам: `[[такт1..4], [такт5..8]]`.
 * Границы берём из `pageStarts`, а если их нет — считаем пьесу одной страницей.
 */
export function pageSlices(score) {
  const measures = score?.measures || [];
  if (!measures.length) return [];
  const raw = pageStarts(score);
  const starts = [...new Set(raw.filter((value) => Number.isFinite(value) && value >= 0 && value < measures.length))].sort((a, b) => a - b);
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) => measures.slice(start, index + 1 < starts.length ? starts[index + 1] : measures.length));
}

/**
 * Собрать пьесу из страниц заново: такты нумеруются подряд, границы страниц пересчитываются.
 * Используется вставкой и перестановкой страниц — чтобы нумерация не «поехала».
 */
export function rebuildScore(base, slices, { warnings = [] } = {}) {
  const measures = [];
  for (const slice of slices) {
    for (const measure of slice) {
      measures.push({ ...measure, index: measures.length, number: String(measures.length + 1) });
    }
  }
  const starts = [];
  let position = 0;
  for (const slice of slices) {
    starts.push(position);
    position += slice.length;
  }
  const sources = base.pageSources || [];
  return {
    ...base,
    measures,
    pages: slices.length,
    pageStarts: starts,
    warnings: [...new Set([...(base.warnings || []), ...warnings])],
    pageSources: slices.map((_, index) => sources[index] || `страница ${index + 1}`),
  };
}

/**
 * Вставить страницу `next` в пьесу `base` в позицию `at` (0 — перед первой страницей,
 * `pageCount(base)` или `null` — в конец). Исходная пьеса не меняется.
 */
export function insertScorePage(base, next, { at = null, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const nextSlices = pageSlices(next);
  if (!nextSlices.length) {
    return { ok: false, reason: 'на этой странице не нашлось нот', score: base, warnings: [], addedMeasures: 0, pages: pageCount(base) };
  }
  if (!base?.measures?.length) {
    return {
      ok: true,
      score: { ...next, pages: nextSlices.length, pageStarts: pageStarts(next) },
      warnings: [],
      addedMeasures: next.measures.length,
      pages: nextSlices.length,
      at: 0,
      first: true,
    };
  }

  const slices = pageSlices(base);
  const pages = slices.length + nextSlices.length;
  if (pages > maxPages) {
    return {
      ok: false,
      reason: `больше ${maxPages} страниц в одну пьесу не собираем`,
      score: base,
      warnings: [],
      addedMeasures: 0,
      pages: slices.length,
    };
  }

  const position = at == null ? slices.length : Math.max(0, Math.min(slices.length, Math.round(at)));
  const warnings = pageWarnings(base, next);
  const merged = rebuildScore(base, [...slices.slice(0, position), ...nextSlices, ...slices.slice(position)], { warnings });

  return { ok: true, score: merged, warnings, addedMeasures: next.measures.length, pages, at: position };
}

/**
 * Приклеить страницу в конец — частный случай вставки.
 * Возвращает { ok, score, warnings, addedMeasures, pages } — исходная пьеса не меняется.
 */
export function appendScorePage(base, next, options = {}) {
  return insertScorePage(base, next, { ...options, at: null });
}

/**
 * Переставить страницы местами: `from` → `to`. Нужна, когда страницы сняли не в том порядке.
 * Такты перенумеровываются, границы страниц пересчитываются, исходная пьеса не меняется.
 */
export function moveScorePage(score, { from, to }) {
  const slices = pageSlices(score);
  if (slices.length < 2) {
    return { ok: false, reason: 'в пьесе всего одна страница', score, pages: slices.length };
  }
  const bad = (value) => !Number.isInteger(value) || value < 0 || value >= slices.length;
  if (bad(from) || bad(to)) {
    return { ok: false, reason: `нет такой страницы (в пьесе ${slices.length})`, score, pages: slices.length };
  }
  if (from === to) return { ok: true, moved: false, score, pages: slices.length, from, to };

  const order = slices.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const rebuilt = rebuildScore(score, order);
  return { ok: true, moved: true, score: rebuilt, pages: order.length, from, to, measures: rebuilt.measures.length };
}

/** Убрать страницу из пьесы (например, случайно сняли чужую). */
export function removeScorePage(score, { at }) {
  const slices = pageSlices(score);
  if (slices.length < 2) {
    return { ok: false, reason: 'в пьесе всего одна страница — удалять нечего', score, pages: slices.length };
  }
  if (!Number.isInteger(at) || at < 0 || at >= slices.length) {
    return { ok: false, reason: `нет такой страницы (в пьесе ${slices.length})`, score, pages: slices.length };
  }
  const order = slices.slice();
  const [removed] = order.splice(at, 1);
  const rebuilt = rebuildScore(score, order);
  return { ok: true, score: rebuilt, pages: order.length, removedMeasures: removed.length, measures: rebuilt.measures.length };
}

/** Короткая подпись о страницах: «3 страницы, 12 тактов». */
export function pagesText(score) {
  const pages = pageCount(score);
  if (pages <= 1) return null;
  return `${pages} стр.`;
}