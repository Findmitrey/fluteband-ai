// FluteBand AI — транспонирование, профили инструментов, подготовка концертного строя.
import { pitchClass, pitchClassName, STEP_SEMITONES, spellMidi } from './pitch.js';
import { parseChord, renderChord } from './chords.js';
import { normalizeFifths, tonicForFifths, fifthsForTonic } from './harmony.js';

/**
 * writtenToSounding: на сколько полутонов опускается ЗВУЧАЩИЙ строй относительно написанного.
 * Пример: кларнет B♭, написанная до-мажорная пьеса звучит в B♭-мажоре => -2.
 */
export const INSTRUMENTS = [
  { id: 'flute', name: 'Флейта', ru: 'Флейта (C)', semitones: 0, family: 'woodwind' },
  { id: 'recorder', name: 'Блокфлейта', ru: 'Блокфлейта (C)', semitones: 0, family: 'woodwind' },
  { id: 'oboe', name: 'Гобой', ru: 'Гобой (C)', semitones: 0, family: 'woodwind' },
  { id: 'violin', name: 'Скрипка', ru: 'Скрипка (C)', semitones: 0, family: 'strings' },
  { id: 'piano', name: 'Фортепиано', ru: 'Фортепиано / концертный строй (C)', semitones: 0, family: 'keyboard' },
  { id: 'clarinet-bb', name: 'Кларнет B♭', ru: 'Кларнет B♭', semitones: -2, family: 'woodwind' },
  { id: 'trumpet-bb', name: 'Труба B♭', ru: 'Труба B♭', semitones: -2, family: 'brass' },
  { id: 'sax-soprano', name: 'Саксофон-сопрано B♭', ru: 'Саксофон-сопрано B♭', semitones: -2, family: 'woodwind' },
  { id: 'sax-alto', name: 'Саксофон-альт E♭', ru: 'Саксофон-альт E♭', semitones: -9, family: 'woodwind' },
  { id: 'sax-tenor', name: 'Саксофон-тенор B♭', ru: 'Саксофон-тенор B♭', semitones: -14, family: 'woodwind' },
  { id: 'sax-baritone', name: 'Саксофон-баритон E♭', ru: 'Саксофон-баритон E♭', semitones: -21, family: 'woodwind' },
  { id: 'horn-f', name: 'Валторна F', ru: 'Валторна F', semitones: -7, family: 'brass' },
];

export function getInstrument(id) {
  return INSTRUMENTS.find((i) => i.id === id) || INSTRUMENTS[0];
}

/** Интервал (в полутонах), на который нужно сдвинуть МИНУС, чтобы он совпал со звучанием инструмента */
export function accompanimentShift(instrumentId) {
  return getInstrument(instrumentId).semitones;
}

export function transposeKey(key, semitones) {
  const s = Math.round(semitones);
  const mode = key?.mode === 'minor' ? 'minor' : 'major';
  const fifths = normalizeFifths((key?.fifths ?? fifthsForTonic(key?.tonic || 'C', mode)) + 7 * (s % 12));
  const tonic = tonicForFifths(fifths, mode);
  return { tonic: mode === 'minor' ? tonic.replace(/m$/, '') : tonic, mode, fifths };
}

export function transposeChordSymbol(symbol, semitones, fifths = 0) {
  const parsed = parseChord(symbol);
  if (parsed.rootPc == null) return symbol;
  const s = Math.round(semitones);
  const flats = fifths < 0;
  const rootName = pitchClassName(parsed.rootPc + s, { flats });
  const bassName = parsed.bassPc == null ? null : pitchClassName(parsed.bassPc + s, { flats });
  const shifted = { ...parsed, rootName, bassName, rootPc: pitchClass(parsed.rootPc + s), bassPc: parsed.bassPc == null ? null : pitchClass(parsed.bassPc + s) };
  return renderChord(shifted);
}

/**
 * Транспонировать пьесу целиком: ноты, аккордовые символы, тональность.
 * semitones: + вверх, - вниз.
 */
export function transposeScore(score, semitones, { respell = true } = {}) {
  const s = Math.round(semitones);
  if (!s) return score;
  const newKey = transposeKey(score.key || { tonic: 'C', mode: 'major', fifths: 0 }, s);
  return {
    ...score,
    key: newKey,
    measures: (score.measures || []).map((m) => ({
      ...m,
      events: (m.events || []).map((e) => ({ ...e, pitches: (e.pitches || []).map((p) => p + s) })),
      harmony: (m.harmony || []).map((h) => (h.symbol ? { ...h, symbol: transposeChordSymbol(h.symbol, s, newKey.fifths) } : h)),
    })),
    transposition: { semitones: s, from: score.key, to: newKey, respell },
  };
}

/** Строй, который должен звучать при игре ученика на данном инструменте по напечатанным нотам */
export function concertScore(score, instrumentId) {
  return transposeScore(score, accompanimentShift(instrumentId));
}

/** Подсказка пользователю: на сколько полутонов сдвинут минус и в какой тональности он звучит */
export function transpositionHint(scoreKey, instrumentId, extraSemitones = 0) {
  const shift = accompanimentShift(instrumentId) + Math.round(extraSemitones);
  const target = transposeKey(scoreKey || { tonic: 'C', mode: 'major', fifths: 0 }, shift);
  const steps = Math.abs(shift);
  const direction = shift > 0 ? 'вверх' : shift < 0 ? 'вниз' : 'без изменений';
  return {
    semitones: shift,
    writtenKey: scoreKey,
    soundingKey: target,
    text: shift === 0
      ? `Минус звучит в исходной тональности (${target.tonic} ${target.mode === 'minor' ? 'moll' : 'dur'})`
      : `Минус сдвинут на ${steps} полутон(а/ов) ${direction}: звучит в ${target.tonic} ${target.mode === 'minor' ? 'moll' : 'dur'}`,
  };
}

export { spellMidi, pitchClassName, STEP_SEMITONES };