// FluteBand AI — pitch utilities (без DOM, тестируется в Node)

export const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** "C#4" | "Bb3" | "Cb4" -> MIDI number (C4 = 60) */
export function midiFromName(name) {
  const m = /^([A-Ga-g])([#b]{0,2})(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`Не удалось разобрать ноту: ${name}`);
  const step = m[1].toUpperCase();
  let alter = 0;
  for (const ch of m[2]) alter += ch === '#' ? 1 : -1;
  const octave = parseInt(m[3], 10);
  return (octave + 1) * 12 + STEP_SEMITONES[step] + alter;
}

/** MIDI -> note name, octave included. flats=true -> "Bb3" instead of "A#3" */
export function nameFromMidi(midi, { flats = false } = {}) {
  const m = Math.round(midi);
  const pc = pitchClass(m);
  const octave = Math.floor(m / 12) - 1;
  return (flats ? FLAT_NAMES[pc] : SHARP_NAMES[pc]) + octave;
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (Math.round(midi) - 69) / 12);
}

export function pitchClass(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function pitchClassName(pc, { flats = false } = {}) {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((Math.round(pc) % 12) + 12) % 12];
}

/** Тональности с бемолями (fifths < 0) — пишем бемолями */
export function spellMidi(midi, fifths = 0) {
  return nameFromMidi(midi, { flats: fifths < 0 });
}

export function transposePitch(midi, semitones) {
  return Math.round(midi) + Math.round(semitones);
}

export function averageMidi(pitches) {
  if (!pitches || !pitches.length) return null;
  let sum = 0;
  for (const p of pitches) sum += p;
  return sum / pitches.length;
}