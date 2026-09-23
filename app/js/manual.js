// FluteBand AI — ручной ввод пьесы (страховка на случай ошибок распознавания; решение №15).
import { createScore } from './score.js';
import { fifthsForTonic } from './harmony.js';
import { midiFromName } from './pitch.js';
import { DEFAULT_TEMPO } from './tempo.js';
import { DEFAULT_METER } from './timeline.js';

const METER_PRESETS = ['4/4', '3/4', '2/4', '6/8', '2/2', '3/8'];

export function parseMeter(text) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(text || '').trim());
  if (!m) return { ...DEFAULT_METER };
  const beats = Number(m[1]);
  const beatType = Number(m[2]);
  if (!Number.isFinite(beats) || !Number.isFinite(beatType) || beats <= 0 || beatType <= 0) return { ...DEFAULT_METER };
  return { beats, beatType };
}

export function meterText(meter) {
  return `${meter?.beats ?? 4}/${meter?.beatType ?? 4}`;
}

export function measureBeatsOf(meter) {
  return ((meter?.beats ?? 4) * 4) / (meter?.beatType ?? 4);
}

/** "D A7 | D | G, A7" -> аккорды по тактам (несколько через запятую делят такт поровну) */
export function parseChordLine(text, measureCount = null) {
  const raw = String(text || '').trim();
  if (!raw) return Array.from({ length: measureCount || 0 }, () => []);
  const groups = raw.split('|').map((g) => g.trim()).filter((g) => g.length > 0);
  const result = groups.map((group) => group.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
  if (measureCount && result.length < measureCount) {
    while (result.length < measureCount) result.push([]);
  }
  return result;
}

/**
 * Мелодия текстом: такты через "|", ноты через пробел.
 * Форматы ноты: "F#4", "F#4:0.5" (длительность), "F#4+C#5" (аккорд/двойная нота), "r" или "r:1" (пауза).
 */
export function parseMelodyLine(text, meter = DEFAULT_METER) {
  const raw = String(text || '').trim();
  const measureLen = measureBeatsOf(meter);
  if (!raw) return [];
  const groups = raw.split('|');
  return groups.map((group) => {
    let beat = 0;
    const events = [];
    for (const tokenRaw of group.trim().split(/\s+/).filter(Boolean)) {
      const [notesPart, durPart] = tokenRaw.split(':');
      const dur = durPart === undefined ? 1 : Number(durPart);
      const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 1;
      if (/^r(est)?$/i.test(notesPart)) {
        beat += safeDur;
        continue;
      }
      const pitches = [];
      for (const noteName of notesPart.split('+').filter(Boolean)) {
        try {
          pitches.push(midiFromName(noteName));
        } catch {
          /* непонятную ноту пропускаем, её увидит проверка */
        }
      }
      if (pitches.length) {
        events.push({ beat: Number(beat.toFixed(4)), dur: safeDur, pitches: pitches.sort((a, b) => a - b), voice: 'melody' });
      }
      beat += safeDur;
      if (beat > measureLen + 1e-6) break;
    }
    return events;
  });
}

/**
 * Собрать пьесу из ручного ввода.
 * Все поля необязательны: достаточно аккордов, чтобы получить минус.
 */
export function scoreFromManualInput({
  title = 'Новая пьеса',
  composer = '',
  tonic = 'C',
  mode = 'major',
  meterText: meterInput = '4/4',
  tempo = DEFAULT_TEMPO,
  chordsText = '',
  melodyText = '',
  id = null,
} = {}) {
  const meter = parseMeter(meterInput);
  const measureLen = measureBeatsOf(meter);
  const melody = parseMelodyLine(melodyText, meter);
  const chordGroups = parseChordLine(chordsText, melody.length || null);
  const count = Math.max(1, melody.length, chordGroups.length);

  const measures = [];
  for (let i = 0; i < count; i += 1) {
    const symbols = (chordGroups[i] || []).filter(Boolean);
    const harmony = symbols.map((symbol, index) => ({
      beat: Number(((measureLen / symbols.length) * index).toFixed(4)),
      dur: Number((measureLen / symbols.length).toFixed(4)),
      symbol,
      source: 'manual',
    }));
    measures.push({
      number: String(i + 1),
      events: melody[i] || [],
      harmony,
    });
  }

  const fifths = fifthsForTonic(tonic, mode);
  return createScore({
    id: id || undefined,
    title,
    composer,
    tempo,
    tempoSource: 'задан вручную',
    meter,
    key: { tonic, mode, fifths },
    measures,
    source: { kind: 'manual', engine: 'ручной ввод' },
    warnings: [],
  });
}

export { METER_PRESETS };