// FluteBand AI — генератор фортепианного аккомпанемента (бас + аккорды в ритме).
import { chordPitches, bassPitch, parseChord } from './chords.js';
import { resolveHarmony, harmonyAtBeat, detectChord } from './harmony.js';
import { transposeScore, accompanimentShift, getInstrument } from './transpose.js';
import { pitchClass } from './pitch.js';
import { measureLengthBeats, measureStarts, totalBeats } from './timeline.js';

export const STYLES = [
  { id: 'auto', name: 'Автоматически (по размеру и темпу)' },
  { id: 'waltz', name: 'Вальс (3/4)' },
  { id: 'march', name: 'Марш / oom-pah (4/4)' },
  { id: 'ballad', name: 'Баллада (медленно, выдержанно)' },
  { id: 'polka', name: 'Полька (2/4)' },
  { id: 'arpeggio', name: 'Разложенные аккорды (восьмые)' },
  { id: 'blockChords', name: 'Аккорд на каждую долю' },
];

export function chooseStyle(lenQuarters, tempo) {
  const t = tempo || 100;
  if (lenQuarters >= 2.9 && lenQuarters <= 3.1) return 'waltz';
  if (lenQuarters >= 5.9) return 'arpeggio';
  if (lenQuarters >= 1.9 && lenQuarters <= 2.1) return 'polka';
  if (lenQuarters >= 3.9) return t < 76 ? 'ballad' : 'march';
  return 'blockChords';
}

/** Ритмические «слоты» аккомпанемента внутри такта (в четвертных долях) */
export function patternSlots(style, lenQuarters) {
  const slots = [];
  const push = (at, kind, dur, extra = {}) => {
    if (at < lenQuarters - 1e-6) slots.push({ at, kind, dur: Math.min(dur, lenQuarters - at), ...extra });
  };
  switch (style) {
    case 'waltz':
      push(0, 'bass', 1);
      for (let b = 1; b < lenQuarters; b += 1) push(b, 'chord', 0.9);
      break;
    case 'march':
      for (let b = 0; b < lenQuarters; b += 4) {
        push(b, 'bass', 0.9);
        push(b + 1, 'chord', 0.9);
        push(b + 2, 'bass5', 0.9);
        push(b + 3, 'chord', 0.9);
      }
      break;
    case 'ballad':
      push(0, 'bass', 1.9);
      push(0, 'chord', Math.min(lenQuarters, 3.8));
      push(2, 'bass5', 1.9);
      break;
    case 'polka':
      for (let b = 0; b < lenQuarters; b += 2) {
        push(b, 'bass', 0.9);
        push(b + 1, 'chord', 0.9);
      }
      break;
    case 'arpeggio': {
      let i = 0;
      for (let b = 0; b < lenQuarters - 1e-6; b += 0.5) {
        push(b, 'arp', 0.45, { index: i });
        i += 1;
      }
      break;
    }
    case 'blockChords':
    default:
      for (let b = 0; b < lenQuarters; b += 1) push(b, 'chord', 0.95);
      break;
  }
  return slots;
}

function melodyIndexByMeasure(score) {
  const index = [];
  (score.measures || []).forEach((m, i) => {
    const list = [];
    for (const e of m.events || []) {
      if (!e.pitches?.length) continue;
      list.push({ beat: e.beat || 0, dur: e.dur || 0.5, pitches: e.pitches });
    }
    index.push(list);
  });
  return index;
}

function melodyPcsAt(list, beat) {
  const pcs = new Set();
  for (const e of list || []) {
    if (beat >= e.beat - 1e-6 && beat < e.beat + e.dur - 1e-6) {
      for (const p of e.pitches) pcs.add(pitchClass(p));
    }
  }
  return pcs;
}

function voiceChord(symbol, { octave, maxNotes, avoidPcs }) {
  let pitches = chordPitches(symbol, { octave, maxNotes });
  if (!pitches.length) return [];
  if (avoidPcs && avoidPcs.size) {
    const filtered = pitches.filter((p) => !avoidPcs.has(pitchClass(p)));
    if (filtered.length >= 3) pitches = filtered;
  }
  return pitches;
}

function arpTone(symbol, index, octave, bassOctave) {
  const tones = chordPitches(symbol, { octave, maxNotes: 4 });
  const parsed = parseChord(symbol);
  const bass = bassPitch(symbol, { octave: bassOctave });
  const ladder = [bass, ...tones.filter((p) => p > bass), (parsed.rootPc != null ? tones[0] + 12 : tones[0])];
  const clean = ladder.filter((p, i, a) => p != null && (i === 0 || p > a[i - 1] - 1));
  return [clean[index % clean.length]];
}

/**
 * Построить аккомпанемент.
 * Возвращает события в концертном (звучащем) строе: startBeat/durBeats — в четвертных долях.
 */
export function generateAccompaniment(score, options = {}) {
  const {
    style = 'auto',
    instrumentId = 'flute',
    extraSemitones = 0,
    bassOctave = 2,
    chordOctave = 3,
    dynamics = 0.8,
    maxChordNotes = 4,
    includeMelody = false,
    melodyVolume = 0,
    avoidMelodyDoubling = true,
  } = options;

  if (!score?.measures?.length) {
    return { events: [], melodyEvents: [], style: 'none', totalBeats: 0, warnings: ['Пьеса пустая — нечего играть'] };
  }

  const shift = accompanimentShift(instrumentId) + Math.round(extraSemitones);
  const concert = transposeScore(score, shift);
  const starts = measureStarts(concert);
  const len = totalBeats(concert);
  const tempo = options.tempo ?? concert.tempo ?? 100;
  const warnings = [];
  const events = [];
  const melodyIdx = melodyIndexByMeasure(concert);
  let previousSymbol = null;
  const usedStyles = new Set();

  concert.measures.forEach((measure, mi) => {
    const measureLen = measureLengthBeats(concert, measure);
    const localStyle = style === 'auto' ? chooseStyle(measureLen, tempo) : style;
    usedStyles.add(localStyle);
    const segments = resolveHarmony(measure, {
      meter: { beats: measureLen, beatType: 4 },
      key: concert.key,
      previousSymbol,
    });
    const primary = segments.find((s) => s.symbol)?.symbol || previousSymbol || 'C';
    previousSymbol = primary;
    for (const s of segments) {
      if (s.source === 'fallback' || (s.confidence != null && s.confidence < 0.45)) {
        warnings.push(`Такт ${mi + 1}: гармония определена неуверенно (${s.symbol})`);
      }
    }

    const slots = patternSlots(localStyle, measureLen);
    for (const slot of slots) {
      const seg = harmonyAtBeat(segments, slot.at) || segments[segments.length - 1];
      const symbol = seg?.symbol || primary;
      const avoid = avoidMelodyDoubling ? melodyPcsAt(melodyIdx[mi], slot.at) : new Set();
      let midi = [];
      if (slot.kind === 'bass') midi = [bassPitch(symbol, { octave: bassOctave })].filter((p) => p != null);
      else if (slot.kind === 'bass5') {
        const b = bassPitch(symbol, { octave: bassOctave });
        const fifth = b == null ? null : (b + 7 <= (bassOctave + 2) * 12 - 1 ? b + 7 : b - 5);
        midi = [fifth].filter((p) => p != null);
      } else if (slot.kind === 'arp') midi = arpTone(symbol, slot.index || 0, chordOctave, bassOctave);
      else midi = voiceChord(symbol, { octave: chordOctave, maxNotes: maxChordNotes, avoidPcs: avoid });
      if (!midi.length) continue;

      const accent = slot.at < 1e-6 ? 1 : 0.82;
      const roleBoost = slot.kind === 'bass' || slot.kind === 'bass5' ? 0.06 : -0.04;
      const velocity = Math.max(0.15, Math.min(1, dynamics * accent + roleBoost));
      events.push({
        startBeat: starts[mi] + slot.at,
        durBeats: slot.dur,
        midi,
        velocity,
        role: slot.kind === 'arp' ? 'chord' : slot.kind,
        symbol,
        measureIndex: mi,
      });
    }
  });

  const melodyEvents = includeMelody
    ? (() => {
        const out = [];
        concert.measures.forEach((m, mi) => {
          for (const e of m.events || []) {
            if (!e.pitches?.length) continue;
            out.push({
              startBeat: starts[mi] + (e.beat || 0),
              durBeats: e.dur || 0.5,
              midi: [...e.pitches],
              velocity: Math.max(0.1, Math.min(1, melodyVolume)),
              role: 'melody',
              measureIndex: mi,
            });
          }
        });
        return out;
      })()
    : [];

  const uniqueWarnings = [...new Set(warnings)];
  return {
    events,
    melodyEvents,
    style: usedStyles.size === 1 ? [...usedStyles][0] : [...usedStyles].join('+'),
    totalBeats: len,
    tempo,
    instrument: getInstrument(instrumentId),
    transpositionSemitones: shift,
    concertScore: concert,
    warnings: uniqueWarnings,
  };
}

/** Вспомогательное: аккорд, который звучит в конкретной доле (для UI) */
export function chordAtBeat(score, beat, { instrumentId = 'flute', extraSemitones = 0 } = {}) {
  const concert = transposeScore(score, accompanimentShift(instrumentId) + Math.round(extraSemitones));
  const starts = measureStarts(concert);
  for (let i = 0; i < concert.measures.length; i += 1) {
    const len = measureLengthBeats(concert, concert.measures[i]);
    if (beat >= starts[i] - 1e-6 && beat < starts[i] + len - 1e-6) {
      const segments = resolveHarmony(concert.measures[i], {
        meter: { beats: len, beatType: 4 },
        key: concert.key,
      });
      return harmonyAtBeat(segments, beat - starts[i])?.symbol || null;
    }
  }
  return null;
}

export { detectChord };