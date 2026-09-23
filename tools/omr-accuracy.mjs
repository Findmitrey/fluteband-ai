// FluteBand AI — сравнение распознанных нот с эталоном (точность OMR).
//
// Использование как CLI:
//   node tools/omr-accuracy.mjs эталон.musicxml распознанное.musicxml [--json]
//
// Как модуль:
//   import { compareScores, loadScoreFile } from './omr-accuracy.mjs';
//
// Сопоставление: нота считается найденной, если совпали такт, высота (MIDI) и позиция внутри такта
// (допуск 0.3 доли). Дополнительно считаются «октавные» ошибки — верная ступень, но не та октава:
// это самая частая ошибка OMR, и её полезно видеть отдельно.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { musicXmlToScore } from '../app/js/musicxml.js';
import { keyLabel } from '../app/js/harmony.js';
import { totalBeats } from '../app/js/timeline.js';

const ONSET_TOLERANCE = 0.3;

export function loadScoreFile(path) {
  const text = readFileSync(path, 'utf8');
  return musicXmlToScore(text, { kind: 'omr-benchmark', title: path });
}

/** Разложить пьесу в плоский список нот: такт, доля, MIDI, длительность */
export function flattenNotes(score) {
  const notes = [];
  (score?.measures || []).forEach((measure, index) => {
    for (const event of measure.events || []) {
      for (const midi of event.pitches || []) {
        notes.push({
          measure: index,
          beat: Number(event.beat || 0),
          midi,
          dur: Number(event.dur || 0),
          voice: event.voice || 'melody',
        });
      }
    }
  });
  return notes;
}

function harmonySequence(score) {
  const out = [];
  (score?.measures || []).forEach((measure, index) => {
    for (const item of measure.harmony || []) {
      if (item?.symbol) out.push({ measure: index, beat: Number(item.beat || 0), symbol: item.symbol });
    }
  });
  return out;
}

export function compareScores(groundTruth, recognized) {
  const expected = flattenNotes(groundTruth);
  const actual = flattenNotes(recognized);
  const usedActual = new Array(actual.length).fill(false);

  let truePositives = 0;
  const missing = [];
  const octaveErrors = [];
  const durationMismatches = [];

  for (const want of expected) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < actual.length; i += 1) {
      if (usedActual[i]) continue;
      const got = actual[i];
      if (got.measure !== want.measure || got.midi !== want.midi) continue;
      const distance = Math.abs(got.beat - want.beat);
      if (distance <= ONSET_TOLERANCE && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      usedActual[bestIndex] = true;
      truePositives += 1;
      // Длительность важна не меньше высоты: от неё зависит, чем заполнен такт в минусе
      const got = actual[bestIndex];
      if (Math.abs(got.dur - want.dur) > 0.25) {
        durationMismatches.push({ measure: want.measure + 1, beat: want.beat, midi: want.midi, expected: want.dur, got: got.dur });
      }
      continue;
    }
    // Не нашли точного совпадения: проверяем, не перепутана ли октава
    const sameClass = actual.findIndex((got, i) =>
      !usedActual[i] && got.measure === want.measure && Math.abs(got.beat - want.beat) <= ONSET_TOLERANCE && got.midi % 12 === want.midi % 12);
    if (sameClass >= 0) {
      usedActual[sameClass] = true;
      octaveErrors.push({ measure: want.measure + 1, beat: want.beat, expected: want.midi, got: actual[sameClass].midi });
      continue;
    }
    missing.push({ measure: want.measure + 1, beat: want.beat, midi: want.midi });
  }

  const spurious = actual.filter((_, i) => !usedActual[i]).map((note) => ({ measure: note.measure + 1, beat: note.beat, midi: note.midi }));

  const precision = actual.length ? truePositives / actual.length : 0;
  const recall = expected.length ? truePositives / expected.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const expectedHarmony = harmonySequence(groundTruth);
  const actualHarmony = harmonySequence(recognized);
  const harmonyHits = expectedHarmony.filter((want) =>
    actualHarmony.some((got) => got.measure === want.measure && Math.abs(got.beat - want.beat) <= ONSET_TOLERANCE && got.symbol === want.symbol)).length;

  return {
    expectedNotes: expected.length,
    recognizedNotes: actual.length,
    matched: truePositives,
    missing,
    spurious,
    octaveErrors,
    durationMismatches,
    durationAccuracy: truePositives ? Number((1 - durationMismatches.length / truePositives).toFixed(3)) : 0,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    measures: { expected: groundTruth?.measures?.length || 0, recognized: recognized?.measures?.length || 0 },
    beats: { expected: Number(totalBeats(groundTruth).toFixed(2)), recognized: Number(totalBeats(recognized).toFixed(2)) },
    key: {
      expected: keyLabel(groundTruth?.key),
      recognized: keyLabel(recognized?.key),
      match: keyLabel(groundTruth?.key) === keyLabel(recognized?.key),
    },
    meter: {
      expected: `${groundTruth?.meter?.beats}/${groundTruth?.meter?.beatType}`,
      recognized: `${recognized?.meter?.beats}/${recognized?.meter?.beatType}`,
      match: groundTruth?.meter?.beats === recognized?.meter?.beats && groundTruth?.meter?.beatType === recognized?.meter?.beatType,
    },
    harmony: { expected: expectedHarmony.length, recognized: actualHarmony.length, matched: harmonyHits },
  };
}

function formatReport(name, report) {
  const lines = [];
  lines.push(`${name}`);
  lines.push(`  ноты: эталон ${report.expectedNotes}, распознано ${report.recognizedNotes}, совпало ${report.matched}`);
  lines.push(`  точность (precision) ${(report.precision * 100).toFixed(1)}% · полнота (recall) ${(report.recall * 100).toFixed(1)}% · F1 ${(report.f1 * 100).toFixed(1)}%`);
  lines.push(`  такты: ${report.measures.recognized}/${report.measures.expected} · тональность: ${report.key.recognized} ${report.key.match ? '(верно)' : `(эталон ${report.key.expected})`} · размер: ${report.meter.recognized} ${report.meter.match ? '(верно)' : `(эталон ${report.meter.expected})`}`);
  if (report.harmony.expected) lines.push(`  аккорды: ${report.harmony.matched}/${report.harmony.expected}`);
  lines.push(`  длительности нот верны у ${(report.durationAccuracy * 100).toFixed(0)}% найденных нот`);
  if (report.durationMismatches.length) lines.push(`  неверная длительность: ${report.durationMismatches.length} (например ${JSON.stringify(report.durationMismatches.slice(0, 3))})`);
  if (report.octaveErrors.length) lines.push(`  октавные ошибки: ${report.octaveErrors.length}`);
  if (report.missing.length) lines.push(`  пропущено нот: ${report.missing.length} (например ${JSON.stringify(report.missing.slice(0, 3))})`);
  if (report.spurious.length) lines.push(`  лишних нот: ${report.spurious.length} (например ${JSON.stringify(report.spurious.slice(0, 3))})`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const asJson = process.argv.includes('--json');
  if (args.length < 2) {
    console.log('Использование: node tools/omr-accuracy.mjs эталон.musicxml распознанное.musicxml [--json]');
    process.exitCode = 2;
    return;
  }
  const groundTruth = loadScoreFile(args[0]);
  const recognized = loadScoreFile(args[1]);
  const report = compareScores(groundTruth, recognized);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(`${args[1]} против ${args[0]}`, report));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}