// FluteBand AI — исправление типовых ошибок распознавания (шаг 3 дорожной карты).
//
// Стенд (docs/omr-benchmark.md) показал три повторяющиеся ошибки движка на учебных страницах:
//   1) лишний (пустой или почти пустой) такт на переносе строки;
//   2) 6/8 прочитан как 3/8 — все длительности вдвое короче, такт не заполняется;
//   3) «висящая» пунктирная длительность в конце пьесы.
// Здесь — чистые функции правки партитуры, которые можно проверить юнит-тестами и вызвать из экрана.

import { measureLengthBeats } from './score.js';
import { measureFilledBeats } from './harmony.js';

/** Копия пьесы с новыми тактами (остальные поля сохраняем как есть). */
function withMeasures(score, measures, extra = {}) {
  return { ...score, ...extra, measures };
}

/** Убрать такты, в которых нет ни нот, ни аккордов (движок часто добавляет их на переносе строки). */
export function dropEmptyMeasures(score) {
  const kept = [];
  const removed = [];
  (score.measures || []).forEach((measure, index) => {
    const hasNotes = (measure.events || []).length > 0;
    const hasHarmony = (measure.harmony || []).some((h) => h.symbol);
    // Такт-пауза помечен осознанно (см. markRestMeasures) — его убирать нельзя, иначе сдвинется минус
    if (!hasNotes && !hasHarmony && !measure.rest) removed.push(measure.number || String(index + 1));
    else kept.push(measure);
  });
  if (!removed.length) return { score, removed };
  return { score: withMeasures(score, kept), removed };
}

/**
 * Пометить пустые такты как паузы (`rest: true`) — их нельзя выбрасывать.
 *
 * Зачем. В режиме «только мелодия» сервис вырезает аккомпанирующие станы, поэтому такты, где флейта
 * молчит (в это время играет фортепиано), приходят без нот. Это не артефакт распознавания: если такие
 * такты убрать, минус сдвинется и ученик услышит аккомпанемент не с той доли. Поэтому такт остаётся
 * на своём месте, но помечается паузой — проверка модели и авто-правка его не трогают.
 */
export function markRestMeasures(score) {
  const marked = [];
  const measures = (score.measures || []).map((measure, index) => {
    const hasNotes = (measure.events || []).length > 0;
    const hasHarmony = (measure.harmony || []).some((h) => h.symbol);
    if (hasNotes || hasHarmony || measure.rest) return measure;
    marked.push(measure.number || String(index + 1));
    return { ...measure, rest: true };
  });
  if (!marked.length) return { score, marked };
  return { score: withMeasures(score, measures), marked };
}

/** Убрать конкретный такт по его позиции (нумерация с нуля) — для кнопки «убрать лишний такт». */
export function dropMeasureAt(score, index) {
  const measures = (score.measures || []).filter((_, i) => i !== index);
  return { score: withMeasures(score, measures), removed: score.measures?.[index]?.number || String(index + 1) };
}

/**
 * Умножить все длительности и позиции на коэффициент (используется для исправления 3/8 → 6/8,
 * где движок записал всё вдвое короче).
 */
export function rescaleDurations(score, factor) {
  const scale = Number(factor) || 1;
  if (scale === 1) return { score, factor: 1 };
  const measures = (score.measures || []).map((measure) => ({
    ...measure,
    events: (measure.events || []).map((event) => ({
      ...event,
      beat: Number((event.beat * scale).toFixed(6)),
      dur: Number((event.dur * scale).toFixed(6)),
    })),
    harmony: (measure.harmony || []).map((item) => ({
      ...item,
      beat: Number((item.beat * scale).toFixed(6)),
      dur: item.dur == null ? item.dur : Number((item.dur * scale).toFixed(6)),
    })),
  }));
  return { score: withMeasures(score, measures), factor: scale };
}

/** Сменить размер пьесы (метка долей, по которой считается длина такта и рисунок минуса). */
export function setMeter(score, beats, beatType) {
  const meter = { beats: Number(beats), beatType: Number(beatType) };
  const measures = (score.measures || []).map((measure) => (measure.meter ? { ...measure, meter } : measure));
  return { score: withMeasures(score, measures, { meter }), meter };
}

/** Убрать такты, которые выходят за границу (например, случайные «хвосты» после конца пьесы). */
export function dropTrailingPartialMeasures(score) {
  const measures = [...(score.measures || [])];
  const removed = [];
  while (measures.length > 1) {
    const last = measures[measures.length - 1];
    const filled = measureFilledBeats(last);
    const expected = measureLengthBeats(score, last);
    if (filled > 0.01 && filled >= expected * 0.5) break;
    removed.push(last.number || String(measures.length));
    measures.pop();
  }
  if (!removed.length) return { score, removed };
  return { score: withMeasures(score, measures), removed };
}

/**
 * Что можно предложить исправить в распознанной пьесе.
 * Возвращает список подсказок с готовыми действиями — экран рисует по ним кнопки.
 */
export function suggestFixes(score) {
  const suggestions = [];
  if (!score?.measures?.length) return suggestions;
  const meter = score.meter || score.measures[0]?.meter || { beats: 4, beatType: 4 };
  const length = measureLengthBeats(score, score.measures[0]);

  const emptyIndices = [];
  const shortIndices = [];
  (score.measures || []).forEach((measure, index) => {
    const hasNotes = (measure.events || []).length > 0;
    const hasHarmony = (measure.harmony || []).some((h) => h.symbol);
    if (!hasNotes && !hasHarmony && !measure.rest) emptyIndices.push(index);
    else if (hasNotes && Math.abs(measureFilledBeats(measure) - length) > 0.34) shortIndices.push(index);
  });

  if (emptyIndices.length) {
    suggestions.push({
      id: 'drop-empty',
      label: `Убрать пустые такты (${emptyIndices.length})`,
      hint: 'Движок добавляет пустой такт на переносе строки — нот в нём нет',
      apply: (target) => dropEmptyMeasures(target).score,
    });
  }

  // 6/8, прочитанный как 3/8: такты не заполняются, все длительности вдвое короче
  if (meter.beatType === 8 && meter.beats === 3) {
    suggestions.push({
      id: 'to-six-eight',
      label: 'Это 6/8: сменить размер и удвоить длительности',
      hint: 'Размер 3/8 в учебных пьесах почти не встречается, а движок часто путает его с 6/8',
      apply: (target) => rescaleDurations(setMeter(target, 6, 8).score, 2).score,
    });
  }

  // Короткие такты в конце пьесы (недописанный такт распознавания) — предложить убрать
  const trailing = shortIndices.filter((index) => index >= score.measures.length - 1);
  if (trailing.length) {
    suggestions.push({
      id: 'drop-trailing',
      label: 'Убрать недописанный такт в конце',
      hint: 'В последнем такте меньше долей, чем в размере — обычно это ошибка распознавания',
      apply: (target) => dropTrailingPartialMeasures(target).score,
    });
  }

  // Каждый подозрительный такт можно убрать точечно
  for (const index of shortIndices.filter((i) => !trailing.includes(i)).slice(0, 3)) {
    const measure = score.measures[index];
    suggestions.push({
      id: `drop-${index}`,
      label: `Убрать такт ${measure.number || index + 1} (не заполнен)`,
      hint: 'Если этот такт — артефакт переноса строки, его лучше убрать; если это ваши ноты, оставьте',
      apply: (target) => dropMeasureAt(target, index).score,
    });
  }

  return suggestions;
}

/** Автоматическая безопасная правка после распознавания: только то, что не портит музыку. */
export function autoRepairScore(score) {
  if (!score?.measures?.length) return { score, applied: [] };
  const applied = [];
  let current = score;
  const cleaned = dropEmptyMeasures(current);
  if (cleaned.removed.length) {
    applied.push(`убрано пустых тактов: ${cleaned.removed.length}`);
    current = { ...cleaned.score, warnings: [...new Set([...(current.warnings || []), `Автоматически убраны пустые такты (${cleaned.removed.join(', ')})`])] };
  }
  return { score: current, applied };
}