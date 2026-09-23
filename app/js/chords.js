// FluteBand AI — аккордовые символы: разбор, построение, отображение.
import { STEP_SEMITONES, pitchClass, pitchClassName } from './pitch.js';

export const QUALITY_INTERVALS = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  aug7: [0, 4, 8, 10],
  '7sus4': [0, 5, 7, 10],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  '7b9': [0, 4, 7, 10, 13],
  '7#9': [0, 4, 7, 10, 15],
  '7b5': [0, 4, 6, 10],
  '7#5': [0, 4, 8, 10],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
  maj13: [0, 4, 7, 11, 14, 21],
};

// Как писать качество обратно в символ
export const QUALITY_SUFFIX = {
  '': '', maj: '', m: 'm', dim: 'dim', aug: 'aug', '5': '5', '6': '6', m6: 'm6',
  '7': '7', maj7: 'maj7', m7: 'm7', m7b5: 'm7b5', dim7: 'dim7', aug7: 'aug7',
  '7sus4': '7sus4', sus4: 'sus4', sus2: 'sus2', add9: 'add9', madd9: 'madd9',
  '7b9': '7b9', '7#9': '7#9', '7b5': '7b5', '7#5': '7#5', '9': '9', maj9: 'maj9',
  m9: 'm9', '11': '11', m11: 'm11', '13': '13', maj13: 'maj13',
};

const ALIASES = new Map(Object.entries({
  '': '', maj: '', M: '', major: '', ma: '', 'Δ': '',
  m: 'm', min: 'm', mi: 'm', '-': 'm',
  '7': '7', dom7: '7', dom: '7',
  maj7: 'maj7', M7: 'maj7', ma7: 'maj7', 'Δ7': 'maj7', major7: 'maj7',
  m7: 'm7', min7: 'm7', mi7: 'm7', '-7': 'm7',
  dim: 'dim', o: 'dim', '°': 'dim', minb5: 'm7b5',
  dim7: 'dim7', o7: 'dim7', '°7': 'dim7',
  m7b5: 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', min7b5: 'm7b5', halfdim: 'm7b5',
  aug: 'aug', '+': 'aug', '+5': 'aug',
  aug7: 'aug7', '+7': 'aug7', '7#5': '7#5',
  '6': '6', maj6: '6', M6: '6',
  m6: 'm6', min6: 'm6',
  sus: 'sus4', sus4: 'sus4', '4': 'sus4',
  sus2: 'sus2', '2': 'sus2',
  '7sus4': '7sus4', '7sus': '7sus4',
  add9: 'add9', '2add9': 'add9', madd9: 'madd9',
  '9': '9', maj9: 'maj9', M9: 'maj9', m9: 'm9', min9: 'm9',
  '11': '11', m11: 'm11', '13': '13', maj13: 'maj13',
  '5': '5', power: '5',
  '7b9': '7b9', '7#9': '7#9', '7b5': '7b5',
}));

const ROOT_RE = /^([A-Ga-g])([#b]{0,2})/;

/** Разбор аккордового символа: "F#m7/A" -> структура */
export function parseChord(symbol) {
  const raw = String(symbol ?? '').trim();
  if (!raw) return { raw, valid: false, symbol: '', rootPc: null, quality: '', intervals: [], bassPc: null, warning: 'пустой символ' };

  const [main, bassPart] = raw.split('/');
  const rootMatch = ROOT_RE.exec(main || '');
  if (!rootMatch) {
    return { raw, valid: false, symbol: raw, rootPc: null, quality: '', intervals: [], bassPc: null, warning: `не разобран корень: ${raw}` };
  }
  const rootStep = rootMatch[1].toUpperCase();
  let rootAlter = 0;
  for (const ch of rootMatch[2]) rootAlter += ch === '#' ? 1 : -1;
  const rootPc = pitchClass(STEP_SEMITONES[rootStep] + rootAlter);
  const qualityRaw = (main || '').slice(rootMatch[0].length).replace(/[()\s]/g, '');

  let quality = ALIASES.get(qualityRaw);
  let warning = null;
  if (quality === undefined) {
    // мягкая деградация: не теряем аккорд целиком
    quality = /^(m(?!aj)|min|-)/i.test(qualityRaw) ? 'm' : '';
    warning = `неизвестное качество «${qualityRaw}», используем «${quality || 'мажор'}»`;
  }

  let bassPc = null;
  if (bassPart) {
    const bm = ROOT_RE.exec(bassPart.trim());
    if (bm) {
      let alter = 0;
      for (const ch of bm[2]) alter += ch === '#' ? 1 : -1;
      bassPc = pitchClass(STEP_SEMITONES[bm[1].toUpperCase()] + alter);
    }
  }

  const flats = raw.includes('b');
  return {
    raw,
    valid: !warning,
    warning,
    rootPc,
    rootName: pitchClassName(rootPc, { flats }),
    quality,
    intervals: QUALITY_INTERVALS[quality] || QUALITY_INTERVALS[''],
    bassPc,
    bassName: bassPc == null ? null : pitchClassName(bassPc, { flats }),
  };
}

export function renderChord(parsed) {
  const suffix = QUALITY_SUFFIX[parsed.quality] ?? parsed.quality ?? '';
  return `${parsed.rootName}${suffix}${parsed.bassName ? '/' + parsed.bassName : ''}`;
}

/** Ноты аккорда в заданной октаве (MIDI). octave: 3 => C3..B3 как основа */
export function chordPitches(symbol, { octave = 3, transpose = 0, maxNotes = 4 } = {}) {
  const parsed = typeof symbol === 'string' ? parseChord(symbol) : symbol;
  if (parsed.rootPc == null) return [];
  const base = (octave + 1) * 12 + parsed.rootPc + Math.round(transpose);
  let intervals = parsed.intervals;
  if (intervals.length > maxNotes) {
    // приоритет: основной тон, терция/сус, септима, затем остальное без квинты
    const keep = intervals.filter((i) => i % 12 !== 7 || intervals.length <= 3);
    intervals = keep.length >= 3 ? keep : intervals.filter((i) => i % 12 !== 7);
    intervals = intervals.slice(0, maxNotes);
  }
  return intervals.map((i) => base + i);
}

export function chordPitchClasses(symbol) {
  const parsed = typeof symbol === 'string' ? parseChord(symbol) : symbol;
  return [...new Set(parsed.intervals.map((i) => pitchClass(parsed.rootPc + i)))];
}

/** Басовая нота для аккомпанемента: учитывает слэш-аккорд */
export function bassPitch(symbol, { octave = 2, transpose = 0 } = {}) {
  const parsed = typeof symbol === 'string' ? parseChord(symbol) : symbol;
  if (parsed.rootPc == null) return null;
  const pc = parsed.bassPc == null ? parsed.rootPc : parsed.bassPc;
  let midi = (octave + 1) * 12 + pc + Math.round(transpose);
  // держим бас в удобной зоне C2..B2
  while (midi > (octave + 2) * 12 - 1) midi -= 12;
  return midi;
}

export function isChordSymbolLike(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 12) return false;
  return ROOT_RE.test(t) && ALIASES.has(t.replace(ROOT_RE, '').replace(/\/.*$/, ''));
}