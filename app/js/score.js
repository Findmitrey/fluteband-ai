// FluteBand AI — модель пьесы: создание, проверка, метрики.
import { measureLengthBeats, measureStarts, totalBeats, meterOf } from './timeline.js';
import { keyLabel, measureFilledBeats } from './harmony.js';
import { DEFAULT_METER } from './timeline.js';
import { DEFAULT_TEMPO } from './tempo.js';

export function createScore(input = {}) {
  const meter = input.meter || DEFAULT_METER;
  return {
    id: input.id || `score-${Math.random().toString(36).slice(2, 10)}`,
    title: input.title || 'Без названия',
    composer: input.composer || '',
    tempo: input.tempo || DEFAULT_TEMPO,
    tempoSource: input.tempoSource || 'по умолчанию',
    tempoTerm: input.tempoTerm || null,
    meter,
    key: input.key || { tonic: 'C', mode: 'major', fifths: 0 },
    measures: (input.measures || []).map((m, index) => ({
      index,
      number: m.number || String(index + 1),
      events: (m.events || []).map((e) => ({
        beat: e.beat || 0,
        dur: e.dur || 0.5,
        pitches: [...(e.pitches || [])].sort((a, b) => a - b),
        voice: e.voice || 'melody',
      })),
      harmony: (m.harmony || []).map((h) => ({ beat: h.beat || 0, dur: h.dur || 0, symbol: h.symbol, source: h.source || 'source' })),
      ...(m.lowConfidence ? { lowConfidence: true } : {}),
    })),
    source: input.source || { kind: 'manual' },
    warnings: input.warnings || [],
  };
}

/** Проверка целостности: длительности, пустые такты, границы аккордов */
export function validateScore(score) {
  const problems = [];
  if (!score) return { ok: false, problems: ['Пьеса не загружена'] };
  if (!score.measures?.length) problems.push('Нет ни одного такта');

  let eventCount = 0;
  let harmonyCount = 0;
  let lowConfidence = 0;
  let emptyMeasures = 0;
  let restMeasures = 0;

  (score.measures || []).forEach((m, i) => {
    const len = measureLengthBeats(score, m);
    const filled = measureFilledBeats(m);
    const number = m.number || String(i + 1);
    const hasHarmony = (m.harmony || []).some((h) => h.symbol);
    if (!m.events?.length && !hasHarmony) {
      // Такт-пауза (в режиме «только мелодия» флейта молчит, играет фортепиано) — это не ошибка
      if (m.rest) {
        restMeasures += 1;
      } else {
        emptyMeasures += 1;
        problems.push(`Такт ${number}: нет ни нот, ни аккордов`);
      }
    } else if (m.events?.length && Math.abs(filled - len) > 0.34) {
      problems.push(`Такт ${number}: сумма длительностей ${filled.toFixed(2)} ≠ ${len} долей`);
    }
    if (m.lowConfidence) lowConfidence += 1;
    for (const e of m.events || []) {
      eventCount += 1;
      if (!e.pitches?.length) problems.push(`Такт ${number}: событие без нот`);
      for (const p of e.pitches || []) {
        if (!Number.isFinite(p) || p < 12 || p > 108) problems.push(`Такт ${number}: подозрительная нота MIDI ${p}`);
      }
    }
    for (const h of m.harmony || []) {
      harmonyCount += 1;
      if (!h.symbol) problems.push(`Такт ${number}: пустой аккордовый символ`);
      if (h.beat < -1e-6 || h.beat > len + 1e-6) problems.push(`Такт ${number}: аккорд вне такта (доля ${h.beat})`);
    }
  });

  return {
    ok: problems.length === 0,
    problems,
    metrics: {
      measureCount: score.measures?.length || 0,
      eventCount,
      harmonyCount,
      lowConfidence,
      emptyMeasures,
      restMeasures,
      totalBeats: totalBeats(score),
      meter: meterOf(score, score.measures?.[0]),
      key: keyLabel(score.key),
      tempo: score.tempo,
    },
  };
}

export function scoreDurationSeconds(score, bpm = score?.tempo || DEFAULT_TEMPO) {
  return (totalBeats(score) * 60) / (bpm || DEFAULT_TEMPO);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function scoreSummary(score) {
  const v = validateScore(score);
  return {
    title: score?.title || 'Без названия',
    composer: score?.composer || '',
    key: keyLabel(score?.key),
    meter: v.metrics.meter ? `${v.metrics.meter.beats}/${v.metrics.meter.beatType}` : '—',
    tempo: score?.tempo,
    tempoSource: score?.tempoSource,
    measures: v.metrics.measureCount,
    duration: formatDuration(scoreDurationSeconds(score)),
    problems: v.problems.length,
    lowConfidence: v.metrics.lowConfidence,
  };
}

/** Разбить такт на «сегменты гармонии», покрывающие такт целиком (для UI и правки) */
export function harmonyGrid(score, measureIndex) {
  const measure = score?.measures?.[measureIndex];
  if (!measure) return [];
  const len = measureLengthBeats(score, measure);
  const sorted = [...(measure.harmony || [])].sort((a, b) => a.beat - b.beat);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1]?.beat ?? len;
    out.push({ beat: cur.beat, dur: Math.max(0.25, next - cur.beat), symbol: cur.symbol, source: cur.source });
  }
  if (!out.length) out.push({ beat: 0, dur: len, symbol: null, source: 'empty' });
  return out;
}

export { measureStarts, measureLengthBeats, totalBeats };