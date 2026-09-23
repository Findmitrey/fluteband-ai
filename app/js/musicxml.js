// FluteBand AI — MusicXML -> внутренняя модель ScoreDoc.
import { midiFromName, pitchClass, averageMidi, spellMidi, pitchClassName } from './pitch.js';
import { parseChord, renderChord } from './chords.js';
import { fifthsForTonic } from './harmony.js';
import { parseXml, children, first, findAll, nodeText, attr, numberAttr, numberText } from './xml.js';
import { tempoFromText, DEFAULT_TEMPO } from './tempo.js';
import { DEFAULT_METER } from './timeline.js';

const KIND_TO_QUALITY = {
  major: '',
  minor: 'm',
  augmented: 'aug',
  diminished: 'dim',
  dominant: '7',
  'major-seventh': 'maj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'half-diminished': 'm7b5',
  'major-sixth': '6',
  'minor-sixth': 'm6',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  'dominant-ninth': '9',
  'dominant-11th': '11',
  'major-11th': '11',
  'dominant-13th': '13',
  'major-13th': 'maj13',
  'suspended-fourth': 'sus4',
  'suspended-second': 'sus2',
  power: '5',
  none: '',
};

function stepToMidi(step, alter, octave) {
  const name = `${step}${alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter)}${octave}`;
  return midiFromName(name);
}

function readHarmony(node, warnings) {
  const rootNode = first(node, 'root');
  const bassNode = first(node, 'bass');
  const rootStep = nodeText(rootNode, 'root-step') || nodeText(rootNode) || '';
  const rootAlter = numberText(rootNode, 'root-alter', 0) || 0;
  const kindNode = first(node, 'kind');
  const kindValue = (attr(kindNode, 'value') || nodeText(kindNode) || 'major').toLowerCase();
  const quality = KIND_TO_QUALITY[kindValue];
  if (quality === undefined) warnings.push(`Неизвестный тип аккорда «${kindValue}» — считаем мажором`);
  const bassStep = nodeText(bassNode, 'bass-step') || null;
  const bassAlter = numberText(bassNode, 'bass-alter', 0) || 0;
  const rootName = `${rootStep}${rootAlter > 0 ? '#'.repeat(rootAlter) : rootAlter < 0 ? 'b'.repeat(-rootAlter) : ''}`;
  if (!/^[A-Ga-g]/.test(rootName)) return null;
  const parsed = parseChord(rootName + (quality ?? ''));
  const flats = rootAlter < 0 || bassAlter < 0;
  const bassName = bassStep && /^[A-Ga-g]/.test(bassStep)
    ? `${bassStep.toUpperCase()}${bassAlter > 0 ? '#'.repeat(bassAlter) : bassAlter < 0 ? 'b'.repeat(-bassAlter) : ''}`
    : null;
  const symbol = renderChord({
    ...parsed,
    rootName: flats ? parsed.rootName.replace('#', 'b') : parsed.rootName,
    bassName,
    bassPc: bassName ? pitchClass(parseChord(bassName).rootPc) : null,
  });
  return symbol;
}

/**
 * Прочитать одну партию MusicXML в такты.
 *
 * Почему так: у каждой партии свой счётчик времени внутри такта (`<backup>`/`<forward>` считаются
 * внутри своей партии), поэтому одним общим курсором все партии читать нельзя.
 *
 * Каждая нота помечается «строкой» (`lineKey` = партия + стан): по ней потом видно, где напечатана
 * мелодия, а где фортепиано. Снимок размера (`meter`) сохраняется отдельно для каждого такта — так
 * поздние смены размера не переписывают длину предыдущих тактов.
 */
function readPart(partNode, partIndex, state, warnings, trackKeyChanges) {
  let divisions = state.divisions;
  const measures = [];
  const measureNodes = children(partNode, 'measure');

  measureNodes.forEach((mNode, index) => {
    let cursor = 0; // в четвертных долях внутри такта
    const events = [];
    const rawHarmony = [];
    let lastNoteStart = null;
    let hasRepeat = false;

    for (const node of mNode.children) {
      switch (node.name) {
        case 'attributes': {
          divisions = numberText(node, 'divisions', divisions) || divisions;
          state.divisions = divisions;
          const keyNode = first(node, 'key');
          if (keyNode) {
            const nextFifths = numberText(keyNode, 'fifths', state.fifths) ?? state.fifths;
            const modeText = nodeText(keyNode, 'mode');
            const nextMode = modeText ? (modeText.toLowerCase().includes('min') ? 'minor' : 'major') : state.mode;
            if (modeText) state.modeDeclared = true;
            // Тональность пьесы — та, что объявлена в начале. Поздние смены ключа (частая ошибка OMR)
            // не должны «переписывать» тональность всей пьесы: о них сообщаем предупреждением.
            if (state.keyDeclared && trackKeyChanges && (nextFifths !== state.fifths || nextMode !== state.mode)) {
              state.keyChanges.push({ measure: index + 1, fifths: nextFifths, mode: nextMode });
            } else if (!state.keyDeclared || trackKeyChanges) {
              state.fifths = nextFifths;
              state.mode = nextMode;
              state.keyDeclared = true;
            }
          }
          const timeNode = first(node, 'time');
          if (timeNode) {
            state.beats = numberText(timeNode, 'beats', state.beats) ?? state.beats;
            state.beatType = numberText(timeNode, 'beat-type', state.beatType) ?? state.beatType;
          }
          break;
        }
        case 'direction': {
          const wordsNode = findAll(node, 'words')[0];
          const words = wordsNode ? nodeText(wordsNode) : null;
          if (words && !state.tempoTerm) {
            const guess = tempoFromText(words);
            if (guess && state.tempo == null) { state.tempo = guess.bpm; state.tempoTerm = guess.term; }
            else if (words.length < 24) state.tempoTerm = words;
          }
          const perMinuteNode = findAll(node, 'per-minute')[0];
          const perMinute = perMinuteNode ? Number(nodeText(perMinuteNode)) : NaN;
          if (Number.isFinite(perMinute) && perMinute > 0 && state.tempo == null) state.tempo = Math.round(perMinute);
          break;
        }
        case 'sound': {
          const t = numberAttr(node, 'tempo', null);
          if (t && state.tempo == null) state.tempo = Math.round(t);
          break;
        }
        case 'harmony': {
          const offsetDiv = numberText(node, 'offset', 0) || 0;
          const symbol = readHarmony(node, warnings);
          if (symbol) rawHarmony.push({ beat: Math.max(0, cursor + offsetDiv / divisions), symbol, source: 'source' });
          break;
        }
        case 'backup': {
          cursor = Math.max(0, cursor - (numberText(node, 'duration', 0) || 0) / divisions);
          lastNoteStart = null;
          break;
        }
        case 'forward': {
          cursor += (numberText(node, 'duration', 0) || 0) / divisions;
          lastNoteStart = null;
          break;
        }
        case 'barline': {
          if (first(node, 'repeat') || first(node, 'ending')) hasRepeat = true;
          break;
        }
        case 'note': {
          const durQ = (numberText(node, 'duration', 0) || 0) / (divisions || 1);
          const isChord = !!first(node, 'chord');
          const isGrace = !!first(node, 'grace');
          const isRest = !!first(node, 'rest');
          const voiceId = nodeText(node, 'voice') || '1';
          const staffId = nodeText(node, 'staff') || '1';
          const pitchNode = first(node, 'pitch');
          let midi = null;
          if (pitchNode) {
            const step = nodeText(pitchNode, 'step') || 'C';
            const alter = numberText(pitchNode, 'alter', 0) || 0;
            const octave = numberText(pitchNode, 'octave', 4) ?? 4;
            midi = stepToMidi(step, alter, octave);
          }
          const base = { voiceId, staffId, lineKey: `${partIndex}:${staffId}`, partIndex };

          if (isGrace) {
            events.push({ ...base, beat: cursor, dur: 0, pitches: midi == null ? [] : [midi], grace: true });
            break;
          }
          if (isChord && lastNoteStart != null) {
            const target = events.filter((e) => e.beat === lastNoteStart && e.voiceId === voiceId && e.lineKey === base.lineKey).pop();
            if (target && midi != null) target.pitches.push(midi);
            break;
          }
          const start = cursor;
          if (!isRest && midi != null) {
            events.push({ ...base, beat: start, dur: durQ, pitches: [midi], rest: false });
          } else {
            events.push({ ...base, beat: start, dur: durQ, pitches: [], rest: true });
          }
          lastNoteStart = start;
          cursor += durQ;
          break;
        }
        default:
          break;
      }
    }

    const harmony = rawHarmony.sort((a, b) => a.beat - b.beat);
    measures.push({ index, number: attr(mNode, 'number', String(index + 1)), events, harmony, hasRepeat, meter: { beats: state.beats, beatType: state.beatType } });
  });

  return measures;
}

/** Средняя высота по ключу (для сравнения строк и голосов между собой). */
function meanPitchBy(measures, getKey) {
  const stats = new Map();
  for (const measure of measures) {
    for (const event of measure.events) {
      if (!event.pitches.length) continue;
      const key = getKey(event);
      const stat = stats.get(key) || { sum: 0, n: 0 };
      stat.sum += averageMidi(event.pitches) ?? 0;
      stat.n += 1;
      stats.set(key, stat);
    }
  }
  return new Map([...stats.entries()].map(([key, stat]) => [key, stat.sum / Math.max(1, stat.n)]));
}

/**
 * Кто в пьесе мелодия, кто аккомпанемент.
 *
 * Правило для нот со сборника (фортепиано + блокфлейта): **мелодия — верхняя строка** (первая партия,
 * первый стан), остальные строки — аккомпанемент: самая низкая по звучанию строка становится «басом»,
 * остальные — «средними». Раньше мелодия выбиралась по средней высоте голоса в каждом такте отдельно,
 * и на настоящей странице «фортепиано + блокфлейта» голоса перескакивали из такта в такт.
 *
 * Если в файле всего одна строка (обычные одноголосные ноты), правило не применяется: там по-прежнему
 * мелодия — самый высокий голос такта, бас — самый низкий голос такта.
 */
function classifyLines(measures) {
  const lineMeans = meanPitchBy(measures, (e) => e.lineKey);
  if (lineMeans.size < 2) return null;
  const order = [...lineMeans.keys()].sort((a, b) => {
    const [ap, as] = a.split(':').map(Number);
    const [bp, bs] = b.split(':').map(Number);
    return ap - bp || as - bs;
  });
  const melodyLine = order[0];
  const others = order.slice(1).sort((a, b) => lineMeans.get(a) - lineMeans.get(b));
  const bassLine = others[0] ?? null;
  return { melodyLine, bassLine, order };
}

/** Голос внутри строки: в мелодической строке самый высокий голос — мелодия, в басовой — самый низкий. */
function voiceInsideLine(measures, lineKey, wantLowest) {
  const voiceMeans = [...meanPitchBy(measures, (e) => `${e.lineKey}|${e.voiceId}`).entries()]
    .filter(([key]) => key.startsWith(`${lineKey}|`))
    .map(([key, mean]) => ({ id: key.split('|')[1], mean }))
    .sort((a, b) => a.mean - b.mean);
  if (!voiceMeans.length) return null;
  return (wantLowest ? voiceMeans[0] : voiceMeans[voiceMeans.length - 1]).id;
}

/**
 * Преобразовать MusicXML в ScoreDoc.
 * Ожидается score-partwise (формат, который отдают oemer/audiveris/MuseScore).
 */
export function musicXmlToScore(xmlText, meta = {}) {
  const warnings = [...(meta.warnings || [])];
  const root = typeof xmlText === 'string' ? parseXml(xmlText) : xmlText;
  if (root.name !== 'score-partwise') {
    warnings.push(`Поддерживается только score-partwise, получено «${root.name}». Пробуем прочитать как есть.`);
  }

  const titleNode = findAll(root, 'work-title')[0] || findAll(root, 'movement-title')[0] || null;
  const title = meta.title || (titleNode ? nodeText(titleNode) : null) || 'Без названия';
  const creators = findAll(root, 'creator');
  const composerNode = creators.find((c) => attr(c, 'type') === 'composer') || creators[0] || null;
  const composer = composerNode ? nodeText(composerNode) : '';

  const parts = children(root, 'part');
  if (!parts.length) throw new Error('В MusicXML нет ни одной партии (<part>)');
  // Читаем ВСЕ партии. Раньше бралась одна партия с наибольшим числом нот, и на нотной странице
  // «фортепиано + блокфлейта» партия левой руки фортепиано пропадала целиком, а её ноты не попадали
  // в разбор гармонии — от этого страдал минус (проверено на страницах «Финской», см. docs/omr-real.md).
  if (parts.length > 1) {
    warnings.push(`В файле ${parts.length} партии — мелодия взята с верхней строки, ноты остальных пошли в аккомпанемент`);
  }

  const state = {
    divisions: 1,
    fifths: 0,
    mode: 'major',
    modeDeclared: false,
    keyDeclared: false,
    keyChanges: [],
    beats: DEFAULT_METER.beats,
    beatType: DEFAULT_METER.beatType,
    tempo: null,
    tempoTerm: null,
  };
  const partMeasures = parts.map((partNode, partIndex) => readPart(partNode, partIndex, state, warnings, partIndex === 0));
  const partIndexes = partMeasures.map((list) => new Map(list.map((measure) => [measure.index, measure])));
  const measureCount = partMeasures.reduce(
    (max, list) => list.reduce((inner, measure) => Math.max(inner, measure.index + 1), max),
    0,
  );
  const fifths = state.fifths;
  let mode = state.mode;
  const modeDeclared = state.modeDeclared;
  const keyChanges = state.keyChanges;
  const tempo = state.tempo;
  const tempoTerm = state.tempoTerm;
  const beats = state.beats;
  const beatType = state.beatType;

  // Верхняя строка — мелодия, остальные строки — аккомпанемент
  const flatMeasures = partMeasures.flat();
  const lines = classifyLines(flatMeasures);
  const melodyVoiceInLine = lines ? voiceInsideLine(flatMeasures, lines.melodyLine, false) : null;
  const bassVoiceInLine = lines && lines.bassLine ? voiceInsideLine(flatMeasures, lines.bassLine, true) : null;

  const measures = [];
  for (let index = 0; index < measureCount; index += 1) {
    const here = partIndexes.map((map) => map.get(index)).filter(Boolean);
    const rawEvents = here.flatMap((measure) => measure.events);
    const rawHarmony = [];
    for (const measure of here) {
      for (const item of measure.harmony) {
        if (!rawHarmony.some((h) => Math.abs(h.beat - item.beat) < 1e-6 && h.symbol === item.symbol)) rawHarmony.push(item);
      }
    }
    const hasRepeat = here.some((measure) => measure.hasRepeat);
    const meterHere = here[0]?.meter || { beats, beatType };

    // классификация голосов внутри такта — только когда строк не различить (одна строка нот)
    const voiceStats = new Map();
    if (!lines) {
      for (const e of rawEvents) {
        if (!e.pitches.length) continue;
        const stat = voiceStats.get(e.voiceId) || { sum: 0, n: 0 };
        stat.sum += averageMidi(e.pitches) ?? 0;
        stat.n += 1;
        voiceStats.set(e.voiceId, stat);
      }
    }
    const voiceMeans = [...voiceStats.entries()]
      .map(([id, s]) => ({ id, mean: s.sum / Math.max(1, s.n) }))
      .sort((a, b) => b.mean - a.mean);
    const melodyVoice = lines ? null : (voiceMeans[0]?.id ?? null);
    const bassVoice = lines || voiceMeans.length < 2 ? null : voiceMeans[voiceMeans.length - 1].id;

    const voiceOf = (e) => {
      if (lines) {
        if (e.lineKey === lines.melodyLine) return e.voiceId === melodyVoiceInLine ? 'melody' : 'inner';
        if (e.lineKey === lines.bassLine) return e.voiceId === bassVoiceInLine ? 'bass' : 'inner';
        return 'inner';
      }
      return e.voiceId === melodyVoice ? 'melody' : e.voiceId === bassVoice ? 'bass' : 'inner';
    };

    const measureLen = (meterHere.beats * 4) / (meterHere.beatType || 4);
    const cleanEvents = rawEvents
      .filter((e) => e.pitches.length && e.dur > 0)
      .map((e) => ({
        beat: Number(e.beat.toFixed(4)),
        dur: Number(e.dur.toFixed(4)),
        pitches: [...e.pitches].sort((a, b) => a - b),
        voice: voiceOf(e),
      }))
      .sort((a, b) => a.beat - b.beat || (a.pitches[0] ?? 0) - (b.pitches[0] ?? 0));

    const filled = cleanEvents.reduce((max, e) => Math.max(max, e.beat + e.dur), 0);
    const lowConfidence = Math.abs(filled - measureLen) > 0.34;

    // длительности аккордов: до следующего символа или до конца такта
    const harmony = rawHarmony
      .sort((a, b) => a.beat - b.beat)
      .map((h, i, arr) => {
        const next = arr[i + 1]?.beat ?? measureLen;
        return { ...h, beat: Number(h.beat.toFixed(4)), dur: Number(Math.max(0.25, next - h.beat).toFixed(4)) };
      });

    const numberNode = partIndexes[0] ? partIndexes[0].get(index) : null;
    const measure = {
      index,
      number: numberNode ? numberNode.number : String(index + 1),
      events: cleanEvents,
      harmony,
    };
    if (lowConfidence) {
      measure.lowConfidence = true;
      warnings.push(`Такт ${measure.number}: длительности не сходятся с размером (${filled} из ${measureLen} долей) — проверьте распознавание`);
    }
    if (hasRepeat) measure.hasRepeat = true;
    measures.push(measure);
  }

  if (measures.some((m) => m.hasRepeat)) warnings.push('В нотах есть повторы/вольты — они пока не разворачиваются автоматически');
  if (keyChanges.length) {
    const firstChange = keyChanges[0];
    warnings.push(`В нотах найдена смена тональности в такте ${firstChange.measure} — тональность пьесы взята по началу (${fifthsToTonic(fifths, mode)})`);
  }

  // Программы распознавания (например homr) часто не пишут лад <mode>, и тогда минор
  // молча превращался в параллельный мажор — это ломало и гармонию, и минус.
  // Определяем лад по нотам: считаем терцию от тоники и смотрим, чем пьеса заканчивается.
  if (!modeDeclared) {
    const inferred = inferKey(measures, fifths);
    if (inferred.mode === 'minor') {
      mode = 'minor';
      warnings.push(`В нотах не указан лад — по нотам определён минор (${inferred.tonic})`);
    }
  }

  // Размер 3/8 в учебном репертуаре 1-3 класса практически не встречается:
  // обычно это неверно прочитанный 6/8 (проверено на стенде, см. docs/omr-benchmark.md).
  if (beatType === 8 && beats === 3) {
    warnings.push('Размер распознан как 3/8 — в учебных пьесах это чаще всего 6/8. Проверьте размер перед игрой');
  }

  const tonic = fifthsToTonic(fifths, mode);
  return {
    id: meta.id || `omr-${Date.now().toString(36)}`,
    title,
    composer,
    tempo: tempo ?? meta.tempo ?? DEFAULT_TEMPO,
    tempoSource: tempo != null ? (tempoTerm ? `из нот: ${tempoTerm}` : 'из нот') : 'по умолчанию',
    tempoTerm,
    meter: { beats, beatType },
    key: { tonic, mode, fifths },
    measures,
    source: { kind: meta.kind || 'omr', engine: meta.engine || 'musicxml', confidence: meta.confidence ?? null },
    warnings: [...new Set(warnings)],
  };
}

/**
 * Определить тональность по нотам, если в MusicXML не указан <mode>.
 *
 * Приём: тонику подсказывает последняя нота пьесы (финал почти всегда на тонике),
 * а лад — терция от этой тоники: если малой терции больше, чем большой, это минор.
 * Проверено на стенде: homr вообще не пишет <mode>, и без этой логики ля минор
 * превращался в до мажор (портились гармония и минус).
 */
export function inferKey(measures, fifths) {
  const majorTonic = fifthsToTonic(fifths, 'major');
  const minorTonic = fifthsToTonic(fifths, 'minor');
  const notes = [];
  for (const measure of measures || []) {
    for (const event of measure.events || []) {
      for (const midi of event.pitches || []) notes.push(pitchClass(midi));
    }
  }
  if (!notes.length) return { mode: 'major', tonic: majorTonic };

  const majorPc = pitchClass(midiFromName(`${majorTonic}4`));
  const minorPc = pitchClass(midiFromName(`${minorTonic}4`));
  const lastPc = notes[notes.length - 1];
  const tonicPc = lastPc === minorPc && lastPc !== majorPc ? minorPc : majorPc;

  const majorThird = notes.filter((pc) => pc === (tonicPc + 4) % 12).length;
  const minorThird = notes.filter((pc) => pc === (tonicPc + 3) % 12).length;
  const mode = minorThird > majorThird && tonicPc === minorPc ? 'minor' : 'major';
  return { mode, tonic: mode === 'minor' ? minorTonic : majorTonic, tonicPc, majorThird, minorThird };
}

function fifthsToTonic(fifths, mode) {
  const majorSharps = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const majorFlats = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
  const minorSharps = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const minorFlats = ['A', 'D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'];
  const f = Math.abs(fifths);
  if (mode === 'minor') return (fifths >= 0 ? minorSharps : minorFlats)[Math.min(7, f)];
  return (fifths >= 0 ? majorSharps : majorFlats)[Math.min(7, f)];
}

export { fifthsForTonic };

// ---------------------------------------------------------------------------
// ScoreDoc -> MusicXML (экспорт и генерация эталонных страниц для проверки OMR)
//
// Важно: ключ (<clef>) выводится всегда. Если в MusicXML нет ключа, гравировальные программы
// не рисуют его на странице, и распознавание нот ошибается в высоте (проверено: homr принимал
// страницу без ключа за альтовый ключ и сдвигал все ноты на 10-11 полутонов).

const QUALITY_TO_KIND = {
  '': 'major',
  m: 'minor',
  aug: 'augmented',
  dim: 'diminished',
  '5': 'power',
  7: 'dominant',
  maj7: 'major-seventh',
  m7: 'minor-seventh',
  dim7: 'diminished-seventh',
  m7b5: 'half-diminished',
  6: 'major-sixth',
  m6: 'minor-sixth',
  maj9: 'major-ninth',
  m9: 'minor-ninth',
  9: 'dominant-ninth',
  11: 'dominant-11th',
  13: 'dominant-13th',
  sus4: 'suspended-fourth',
  sus2: 'suspended-second',
  add9: 'major-ninth',
};

const NOTE_TYPES = [
  { type: 'whole', divisions: 16 },
  { type: 'half', divisions: 8 },
  { type: 'quarter', divisions: 4 },
  { type: 'eighth', divisions: 2 },
  { type: '16th', divisions: 1 },
];

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Подобрать тип ноты и точки по длительности в divisions */
function noteTypeFor(divisions) {
  for (const base of NOTE_TYPES) {
    if (divisions >= base.divisions && divisions % base.divisions === 0) {
      const dots = divisions / base.divisions - 1;
      if (dots <= 2) return { type: base.type, dots };
    }
  }
  // Длительность с точкой (например 6 = 4 + 2) описываем как базовый тип с точкой
  for (const base of NOTE_TYPES) {
    for (const dots of [1, 2]) {
      const value = base.divisions * (2 - 0.5 ** dots);
      if (Math.abs(value - divisions) < 1e-6) return { type: base.type, dots };
    }
  }
  return { type: 'quarter', dots: 0 };
}

function pitchXml(midi, fifths) {
  const name = spellMidi(midi, fifths);
  const step = name[0].toUpperCase();
  const alter = name.includes('#') ? 1 : name.includes('b') ? -1 : 0;
  const octave = Number(name.replace(/[^0-9-]/g, '')) || 4;
  const alterXml = alter === 1 ? '<alter>1</alter>' : alter === -1 ? '<alter>-1</alter>' : '';
  return `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>`;
}

function harmonyXml(symbol, fifths) {
  const parsed = parseChord(symbol);
  if (!parsed || parsed.rootPc == null) return '';
  const rootName = pitchClassName(parsed.rootPc, { flats: fifths < 0 });
  const step = rootName[0].toUpperCase();
  const alter = rootName.includes('#') ? 1 : rootName.includes('b') ? -1 : 0;
  const kind = QUALITY_TO_KIND[parsed.quality] || 'major';
  const kindText = parsed.quality ? escapeXml(symbol) : '';
  const bass = parsed.bassPc != null
    ? `<bass><bass-step>${pitchClassName(parsed.bassPc, { flats: fifths < 0 })[0].toUpperCase()}</bass-step></bass>`
    : '';
  return `<harmony><root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>`
    + `<kind ${kindText ? `text="${kindText}" ` : ''}>${kind}</kind>${bass}</harmony>`;
}

function noteXml({ pitches, duration, dots, fifths, voice, rest }) {
  const type = rest ? 'rest' : noteTypeFor(duration);
  const parts = [];
  if (rest) {
    parts.push('<rest/>');
  } else {
    pitches.forEach((midi, index) => {
      const chord = index > 0 ? '<chord/>' : '';
      parts.push(`<note>${chord}${pitchXml(midi, fifths)}<duration>${duration}</duration>`
        + `<voice>${voice}</voice><type>${type.type || type}</type>`
        + `${(rest ? 0 : dots ?? 0) > 0 ? '<dot/>'.repeat(dots ?? 0) : ''}</note>`);
    });
    return parts.join('\n        ');
  }
  return `<note>${parts[0]}<duration>${duration}</duration><voice>${voice}</voice><type>${type.type || type}</type>`
    + `${dots ? '<dot/>'.repeat(dots) : ''}</note>`;
}

/**
 * Собрать MusicXML из внутренней модели.
 * options: { clef: {sign, line}, divisions, includeHarmony }
 */
export function scoreToMusicXml(score, options = {}) {
  const divisions = options.divisions || 4;
  const clef = options.clef || { sign: 'G', line: 2 };
  const fifths = score?.key?.fifths ?? fifthsForTonic(score?.key?.tonic || 'C', score?.key?.mode || 'major');
  const mode = score?.key?.mode === 'minor' ? 'minor' : 'major';
  const beats = score?.meter?.beats || 4;
  const beatType = score?.meter?.beatType || 4;
  const measureLength = (beats * 4) / beatType;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push('  <work><work-title>' + escapeXml(score?.title || 'Без названия') + '</work-title></work>');
  if (score?.composer) lines.push('  <identification><creator type="composer">' + escapeXml(score.composer) + '</creator></identification>');
  lines.push('  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>');
  lines.push('  <part id="P1">');

  (score?.measures || []).forEach((measure, index) => {
    lines.push(`    <measure number="${escapeXml(measure.number || String(index + 1))}">`);
    if (index === 0) {
      lines.push('      <attributes>');
      lines.push(`        <divisions>${divisions}</divisions>`);
      lines.push(`        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>`);
      lines.push(`        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`);
      lines.push(`        <clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>`);
      lines.push('      </attributes>');
      if (score?.tempoTerm) {
        lines.push(`      <direction><direction-type><words>${escapeXml(score.tempoTerm)}</words></direction-type><sound tempo="${score?.tempo || 80}"/></direction>`);
      }
    }

    const voices = new Map();
    for (const event of measure.events || []) {
      // Три голоса не смешиваем: мелодия — 1, средние (правая рука фортепиано) — 2, бас — 3.
      // Раньше в голос 1 попадало всё, кроме баса, и при экспорте страницы «фортепиано + блокфлейта»
      // партия правой руки приклеивалась к мелодии.
      const voice = event.voice === 'bass' ? '3' : event.voice === 'inner' ? '2' : '1';
      if (!voices.has(voice)) voices.set(voice, []);
      voices.get(voice).push(event);
    }
    if (!voices.size) voices.set('1', []);

    const orderedVoices = [...voices.keys()].sort();
    orderedVoices.forEach((voice, voiceIndex) => {
      if (voiceIndex > 0) {
        lines.push(`      <backup><duration>${Math.round(measureLength * divisions)}</duration></backup>`);
      }
      let cursor = 0;
      const events = [...voices.get(voice)].sort((a, b) => a.beat - b.beat);
      for (const event of events) {
        if (event.beat > cursor + 1e-6) {
          const restDuration = Math.round((event.beat - cursor) * divisions);
          lines.push('      ' + noteXml({ duration: restDuration, ...noteTypeFor(restDuration), fifths, voice, rest: true }));
        }
        const duration = Math.max(1, Math.round((event.dur || 0.5) * divisions));
        lines.push('      ' + noteXml({
          pitches: [...(event.pitches || [])].sort((a, b) => a - b),
          duration,
          ...noteTypeFor(duration),
          fifths,
          voice,
        }));
        cursor = event.beat + (event.dur || 0.5);
      }
      if (cursor < measureLength - 1e-6) {
        const restDuration = Math.max(1, Math.round((measureLength - cursor) * divisions));
        lines.push('      ' + noteXml({ duration: restDuration, ...noteTypeFor(restDuration), fifths, voice, rest: true }));
      }
    });

    if (options.includeHarmony !== false) {
      for (const item of measure.harmony || []) {
        const xml = harmonyXml(item.symbol, fifths);
        if (xml) {
          const offsetBeats = item.beat || 0;
          const offset = offsetBeats > 0 ? `<offset>${Math.round(offsetBeats * divisions)}</offset>` : '';
          lines.push(`      ${xml.includes('<offset>') ? xml : xml.replace('</harmony>', `${offset}</harmony>`)}`);
        }
      }
    }
    lines.push('    </measure>');
  });

  lines.push('  </part>');
  lines.push('</score-partwise>');
  return lines.join('\n');
}