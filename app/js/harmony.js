// FluteBand AI — тональность, диатоника, определение аккордов, достройка гармонии.
import { pitchClass, pitchClassName, STEP_SEMITONES } from './pitch.js';
import { parseChord, chordPitchClasses, renderChord } from './chords.js';

export const MAJOR_KEYS_BY_FIFTHS = {
  '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#',
};
export const MINOR_KEYS_BY_FIFTHS = {
  '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm',
  0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m',
};

/** Приводим квинтовый круг к диапазону -6..6 (энгармоническая замена) */
export function normalizeFifths(f) {
  let v = ((Math.round(f) % 12) + 12) % 12;
  if (v > 6) v -= 12;
  return v;
}

export function fifthsForTonic(tonic, mode = 'major') {
  const table = mode === 'minor' ? MINOR_KEYS_BY_FIFTHS : MAJOR_KEYS_BY_FIFTHS;
  const wanted = mode === 'minor' ? String(tonic).replace(/m$/, '') + 'm' : String(tonic);
  for (const [f, name] of Object.entries(table)) {
    if (name.toLowerCase() === wanted.toLowerCase()) return Number(f);
  }
  // неизвестный тоника: считаем по полутонам от C (мажор)
  const m = /^([A-Ga-g])([#b]{0,2})/.exec(String(tonic));
  if (!m) return 0;
  let alter = 0;
  for (const ch of m[2]) alter += ch === '#' ? 1 : -1;
  const pc = pitchClass(STEP_SEMITONES[m[1].toUpperCase()] + alter);
  const majorPcToFifths = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  return majorPcToFifths[pc] ?? 0;
}

export function tonicForFifths(fifths, mode = 'major') {
  const f = normalizeFifths(fifths);
  return (mode === 'minor' ? MINOR_KEYS_BY_FIFTHS : MAJOR_KEYS_BY_FIFTHS)[f] ?? 'C';
}

export function keyLabel(key) {
  if (!key) return '—';
  const mode = key.mode === 'minor' ? 'moll' : 'dur';
  return `${key.tonic} ${mode}`;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_TRIAD_QUALITIES = ['', 'm', 'm', '', '', 'm', 'dim'];
const MAJOR_SEVENTH_QUALITIES = ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const MINOR_TRIAD_QUALITIES = ['m', 'dim', '', 'm', 'm', '', ''];

/** Диатонические аккорды тональности (для достройки гармонии и распознавания) */
export function diatonicChords(key = { tonic: 'C', mode: 'major' }) {
  const mode = key.mode === 'minor' ? 'minor' : 'major';
  const scale = mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  const triads = mode === 'minor' ? MINOR_TRIAD_QUALITIES : MAJOR_TRIAD_QUALITIES;
  const sevenths = mode === 'minor' ? ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'] : MAJOR_SEVENTH_QUALITIES;
  const tonicName = String(key.tonic || 'C').replace(/m$/, '');
  const tonicPc = fifthsToTonicPc(tonicName);
  const flats = (key.fifths ?? 0) < 0;
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    const rootPc = pitchClass(tonicPc + scale[i]);
    out.push({ symbol: pitchClassName(rootPc, { flats }) + triads[i], degree: i + 1, seventh: false });
  }
  for (let i = 0; i < 7; i += 1) {
    const rootPc = pitchClass(tonicPc + scale[i]);
    out.push({ symbol: pitchClassName(rootPc, { flats }) + sevenths[i], degree: i + 1, seventh: true, dominant: i === 4 });
  }
  return out;
}

function fifthsToTonicPc(tonicName) {
  const m = /^([A-Ga-g])([#b]{0,2})/.exec(String(tonicName));
  if (!m) return 0;
  let alter = 0;
  for (const ch of m[2]) alter += ch === '#' ? 1 : -1;
  return pitchClass(STEP_SEMITONES[m[1].toUpperCase()] + alter);
}

/** Оценка соответствия набора ступеней кандидату-аккорду */
function scoreCandidate(inputPcs, candidateSymbol, bassPc) {
  const parsed = parseChord(candidateSymbol);
  const candPcs = chordPitchClasses(parsed);
  const inputSet = new Set(inputPcs);
  const candSet = new Set(candPcs);
  let common = 0;
  for (const pc of candSet) if (inputSet.has(pc)) common += 1;
  let extra = 0;
  for (const pc of inputSet) if (!candSet.has(pc)) extra += 1;
  const missing = candSet.size - common;
  let score = common * 2 - missing * 1.3 - extra * 0.7;
  if (bassPc != null) {
    if (bassPc === parsed.rootPc) score += 1.6;
    else if (candSet.has(bassPc)) score += 0.3;
  }
  if (inputSet.has(parsed.rootPc)) score += 0.6;
  const coverage = candSet.size ? common / candSet.size : 0;
  return { symbol: renderChord(parsed), score, coverage };
}

/**
 * Определить аккорд по набору ступеней (pitch class).
 * key задаёт словарь кандидатов; без key перебираем все корни.
 */
export function detectChord(pcs, { bassPc = null, key = null, allowSevenths = true } = {}) {
  const inputPcs = [...new Set((pcs || []).map(pitchClass))];
  if (!inputPcs.length) return { symbol: null, score: -Infinity, confidence: 0 };

  let candidates = [];
  if (key && key.tonic) {
    candidates = diatonicChords(key)
      .filter((c) => allowSevenths || !c.seventh)
      .map((c) => c.symbol);
    // плюс доминанта к тонике и параллельный мажор/минор — частые гости учебного репертуара
    const tonicPc = fifthsToTonicPc(String(key.tonic).replace(/m$/, ''));
    const flats = (key.fifths ?? 0) < 0;
    const domPc = pitchClass(tonicPc + 7);
    candidates.push(pitchClassName(domPc, { flats }) + '7');
  } else {
    for (let pc = 0; pc < 12; pc += 1) {
      const root = pitchClassName(pc);
      for (const q of ['', 'm', 'dim', '7', 'm7', 'maj7', 'm7b5', 'sus4']) {
        candidates.push(root + q);
      }
    }
  }

  let best = null;
  const seen = new Set();
  for (const cand of candidates) {
    const parsed = parseChord(cand);
    const rendered = renderChord(parsed);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    const r = scoreCandidate(inputPcs, cand, bassPc);
    if (!best || r.score > best.score) best = r;
  }
  if (!best) return { symbol: null, score: -Infinity, confidence: 0 };
  return { symbol: best.symbol, score: best.score, coverage: best.coverage, confidence: Math.max(0, Math.min(1, best.coverage)) };
}

/**
 * Достроить гармонию одного такта: вернуть сегменты, покрывающие весь такт.
 * measure: { events: [{beat, dur, pitches}], harmony: [{beat, dur, symbol}] }
 */
export function resolveHarmony(measure, { meter, key, previousSymbol = null, windowBeats = null } = {}) {
  const beats = meter?.beats ?? 4;
  const existing = (measure.harmony || [])
    .filter((h) => h && h.symbol)
    .map((h) => ({ beat: h.beat ?? 0, dur: h.dur ?? 0, symbol: h.symbol, source: h.source || 'source' }))
    .sort((a, b) => a.beat - b.beat);

  const segments = [];
  if (existing.length) {
    for (let i = 0; i < existing.length; i += 1) {
      const cur = existing[i];
      const nextBeat = i + 1 < existing.length ? Math.min(existing[i + 1].beat, beats) : beats;
      const end = cur.dur > 0 ? Math.min(cur.beat + cur.dur, nextBeat) : nextBeat;
      segments.push({ beat: cur.beat, dur: Math.max(0.25, end - cur.beat), symbol: cur.symbol, source: cur.source });
      if (end < nextBeat) segments.push({ beat: end, dur: nextBeat - end, symbol: cur.symbol, source: 'carry' });
    }
    if (segments.length && segments[segments.length - 1].beat + segments[segments.length - 1].dur < beats - 1e-6) {
      const last = segments[segments.length - 1];
      last.dur = beats - last.beat;
    }
    return segments;
  }

  // гармонии нет — выводим из нот
  const events = (measure.events || []).filter((e) => e.pitches && e.pitches.length);
  if (!events.length) {
    const symbol = previousSymbol || diatonicChords(key || { tonic: 'C', mode: 'major' })[0].symbol;
    return [{ beat: 0, dur: beats, symbol, source: 'fallback' }];
  }
  const step = windowBeats || Math.max(1, Math.round(beats / 2));
  let cursor = 0;
  const raw = [];
  while (cursor < beats - 1e-6) {
    const end = Math.min(beats, cursor + step);
    const inWindow = events.filter((e) => e.beat < end - 1e-6 && e.beat + e.dur > cursor + 1e-6);
    const pcs = [];
    let lowest = Infinity;
    for (const e of inWindow) {
      for (const p of e.pitches) {
        pcs.push(pitchClass(p));
        if (p < lowest) lowest = p;
      }
    }
    if (pcs.length) {
      const det = detectChord(pcs, { bassPc: lowest === Infinity ? null : pitchClass(lowest), key });
      raw.push({ beat: cursor, dur: end - cursor, symbol: det.symbol, confidence: det.confidence, source: 'inferred' });
    } else {
      raw.push({ beat: cursor, dur: end - cursor, symbol: previousSymbol || raw[raw.length - 1]?.symbol || null, source: 'fallback' });
    }
    cursor = end;
  }
  // склеиваем одинаковые подряд
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.symbol === seg.symbol) {
      last.dur += seg.dur;
      last.confidence = Math.min(last.confidence ?? 1, seg.confidence ?? 1);
    } else {
      merged.push({ ...seg });
    }
  }
  const first = merged.find((s) => s.symbol);
  return merged.map((s) => ({ ...s, symbol: s.symbol || first?.symbol || 'C' }));
}

export function harmonyAtBeat(segments, beat) {
  if (!segments || !segments.length) return null;
  for (const s of segments) {
    if (beat >= s.beat - 1e-6 && beat < s.beat + s.dur - 1e-6) return s;
  }
  return segments[segments.length - 1];
}

/** Суммарная длительность событий такта (в четвертных долях) */
export function measureFilledBeats(measure) {
  const events = measure.events || [];
  let max = 0;
  for (const e of events) max = Math.max(max, (e.beat || 0) + (e.dur || 0));
  return max;
}