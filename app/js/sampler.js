// FluteBand AI — библиотеки фортепианных звуков и правила игры сэмплами.
// Модуль без DOM и без Web Audio: только расчёты, поэтому его проверяют юнит-тесты.
//
// Оба банка — свободные (см. лицензии ниже) и раздаются статикой, поэтому не нужны ни аккаунт, ни ключ.
// Имена файлов у банков разные: у Salamander диезы (Fs4), у FluidR3 — бемоли (Gb4).

const SHARP_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Диапазон, реально доступный в обоих банках (C1…B6) */
export const BANK_MIN_MIDI = 24;
export const BANK_MAX_MIDI = 95;

/** Диапазон, который нужен минусу: бас C2–C3, аккорды C3–C4, с запасом до C6 */
export const ACCOMPANIMENT_MIN_MIDI = 36;
export const ACCOMPANIMENT_MAX_MIDI = 84;

export const BANKS = [
  {
    id: 'tone',
    title: 'Встроенный синтез',
    short: 'синтез',
    detail: 'работает всегда и без загрузки, звук простой',
    offline: true,
    approxBytes: 0,
  },
  {
    id: 'royal',
    title: 'Рояль Salamander',
    short: 'рояль',
    detail: 'запись настоящего рояля, самая качественная; около 4 МБ один раз, дальше из памяти',
    license: 'Salamander Grand Piano (Alexander Holm), CC BY 3.0',
    source: 'https://nbrosowsky.github.io/tonejs-instruments/',
    base: 'https://nbrosowsky.github.io/tonejs-instruments/samples/piano',
    naming: 'sharp',
    step: 3,
    approxBytesPerNote: 260 * 1024,
    offline: false,
  },
  {
    id: 'compact',
    title: 'FluidR3 (компактный)',
    short: 'компактный',
    detail: 'синтезированный рояль, мало весит и есть все ноты; около 1,2 МБ',
    license: 'FluidR3_GM SoundFont, MIT',
    source: 'https://gleitz.github.io/midi-js-soundfonts/',
    base: 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3',
    naming: 'flat',
    step: 1,
    approxBytesPerNote: 25 * 1024,
    offline: false,
  },
];

export function bankById(id) {
  return BANKS.find((bank) => bank.id === id) || BANKS[0];
}

export function bankIds() {
  return BANKS.map((bank) => bank.id);
}

/** Имя файла сэмпла: 60 → C4 (наш стандарт: C4 = 60), 61 → Cs4 или Db4 */
export function noteFileName(midi, naming = 'sharp') {
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  const table = naming === 'flat' ? FLAT_NAMES : SHARP_NAMES;
  return `${table[((rounded % 12) + 12) % 12]}${octave}`;
}

/** Опорные ноты банка внутри диапазона: у Salamander — каждая третья, у FluidR3 — все */
export function anchorMidis(bank, { minMidi = ACCOMPANIMENT_MIN_MIDI, maxMidi = ACCOMPANIMENT_MAX_MIDI } = {}) {
  const step = Math.max(1, Math.round(bank.step || 1));
  const base = step === 1 ? BANK_MIN_MIDI : ACCOMPANIMENT_MIN_MIDI;
  const from = Math.max(BANK_MIN_MIDI, Math.min(minMidi, maxMidi));
  const to = Math.min(BANK_MAX_MIDI, Math.max(minMidi, maxMidi));
  const result = [];
  for (let midi = from; midi <= to; midi += 1) {
    if ((midi - base) % step === 0) result.push(midi);
  }
  if (!result.length) result.push(from);
  return result;
}

/** Что и откуда качать: список нот и оценка объёма */
export function planLoad(bank, options = {}) {
  const midis = anchorMidis(bank, options);
  const notes = midis.map((midi) => ({
    midi,
    name: noteFileName(midi, bank.naming),
    url: `${bank.base}/${noteFileName(midi, bank.naming)}.mp3`,
  }));
  const perNote = bank.approxBytesPerNote || 0;
  return {
    notes,
    count: notes.length,
    approxBytes: notes.length * perNote,
    approxBytesText: formatBytes(notes.length * perNote),
  };
}

export function formatBytes(bytes) {
  if (!bytes) return '0 КБ';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Выбор опорного сэмпла для ноты: берём ближайший, чтобы сдвиг по высоте был минимальным.
 * При равном расстоянии (шаг 1) сдвиг нулевой, при нечётном шаге равных расстояний не бывает.
 */
export function chooseAnchor(midi, anchors = []) {
  if (!anchors.length) return null;
  let best = null;
  for (const anchor of anchors) {
    const anchorMidi = typeof anchor === 'number' ? anchor : anchor.midi;
    const semitones = midi - anchorMidi;
    const distance = Math.abs(semitones);
    if (!best || distance < best.distance || (distance === best.distance && anchorMidi < best.anchorMidi)) {
      best = { anchorMidi, semitones, distance };
    }
  }
  return { ...best, playbackRate: Math.pow(2, best.semitones / 12) };
}

/**
 * Громкость и «яркость» по силе нажатия: тихая нота тише и глуше, громкая — звонче.
 * Это приближает живую механику рояля, ведь в банке одна запись на ноту, без слоёв по силе.
 */
export function velocityShape(velocity) {
  const v = Math.max(0.01, Math.min(1, Number(velocity) || 0.8));
  return {
    velocity: v,
    amplitude: Math.pow(v, 1.4),
    lowpassHz: 900 + 9000 * Math.pow(v, 0.7),
    releaseSeconds: 0.32 + (1 - v) * 0.18,
  };
}

/** Огибающая одной ноты в секундах: атака, выдержка, спад */
export function voiceEnvelope({ durSeconds = 0.5, velocity = 0.8, sampleSeconds = 1 } = {}) {
  const shape = velocityShape(velocity);
  const hold = Math.max(0.05, Math.min(durSeconds, sampleSeconds > 0 ? sampleSeconds * 4 : durSeconds));
  return {
    attack: 0.004,
    hold,
    release: shape.releaseSeconds,
    end: hold + shape.releaseSeconds,
  };
}

/** Короткое описание банка для интерфейса и отчётов */
export function describeBank(id) {
  const bank = bankById(id);
  if (bank.id === 'tone') return { id: bank.id, title: bank.title, notes: 0, bytes: '0 КБ', offline: true };
  const plan = planLoad(bank);
  return {
    id: bank.id,
    title: bank.title,
    notes: plan.count,
    bytes: plan.approxBytesText,
    offline: false,
    license: bank.license,
    source: bank.source,
  };
}