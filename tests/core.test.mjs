// FluteBand AI — юнит-тесты ядра: ноты, аккорды, тональности, транспонирование, гармония.
import test from 'node:test';
import assert from 'node:assert/strict';

import { midiFromName, nameFromMidi, midiToFreq, pitchClass, spellMidi } from '../app/js/pitch.js';
import { parseChord, renderChord, chordPitches, bassPitch, chordPitchClasses, isChordSymbolLike } from '../app/js/chords.js';
import { detectChord, diatonicChords, resolveHarmony, normalizeFifths, fifthsForTonic } from '../app/js/harmony.js';
import { transposeKey, transposeChordSymbol, transposeScore, accompanimentShift, getInstrument, transpositionHint } from '../app/js/transpose.js';
import { tempoFromText, tempoName } from '../app/js/tempo.js';

test('ноты: разбор и печать', () => {
  assert.equal(midiFromName('C4'), 60);
  assert.equal(midiFromName('Bb3'), 58);
  assert.equal(midiFromName('F#4'), 66);
  assert.equal(midiFromName('Cb4'), 59);
  assert.equal(nameFromMidi(60), 'C4');
  assert.equal(nameFromMidi(58, { flats: true }), 'Bb3');
  assert.equal(nameFromMidi(58), 'A#3');
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(60) - 261.63) < 0.05);
  assert.equal(pitchClass(-1), 11);
  assert.equal(spellMidi(63, -3), 'Eb4');
  assert.equal(spellMidi(63, 2), 'D#4');
  assert.throws(() => midiFromName('H7'));
});

test('аккорды: разбор, отображение, озвучивание', () => {
  const d = parseChord('D');
  assert.deepEqual(d.intervals, [0, 4, 7]);
  assert.equal(d.rootPc, 2);
  assert.ok(d.valid);

  const fsm = parseChord('F#m7/A');
  assert.equal(fsm.rootPc, 6);
  assert.equal(fsm.bassPc, 9);
  assert.equal(renderChord(fsm), 'F#m7/A');

  assert.deepEqual(parseChord('A7').intervals, [0, 4, 7, 10]);
  assert.deepEqual(parseChord('Dm7b5').intervals, [0, 3, 6, 10]);
  assert.equal(renderChord(parseChord('Bb')), 'Bb');
  assert.deepEqual(chordPitches('C', { octave: 3 }), [48, 52, 55]);
  assert.deepEqual(bassPitch('C/G', { octave: 2 }), [43][0]);
  assert.deepEqual([...new Set(chordPitchClasses('D7'))].sort((a, b) => a - b), [2, 6, 9, 0].sort((a, b) => a - b));

  const broken = parseChord('H7');
  assert.equal(broken.valid, false);
  assert.ok(broken.warning);
  const oddQuality = parseChord('Cfoo');
  assert.equal(oddQuality.valid, false);
  assert.ok(oddQuality.warning?.includes('качество'));

  assert.ok(isChordSymbolLike('Am7'));
  assert.ok(isChordSymbolLike('C/G'));
  assert.ok(!isChordSymbolLike('Andante'));
  assert.ok(!isChordSymbolLike(''));
});

test('тональности: квинтовый круг и диатоника', () => {
  assert.equal(normalizeFifths(16), 4);
  assert.equal(normalizeFifths(-12), 0);
  assert.equal(fifthsForTonic('D', 'major'), 2);
  assert.equal(fifthsForTonic('Bb', 'major'), -2);
  const c = diatonicChords({ tonic: 'C', mode: 'major', fifths: 0 });
  assert.equal(c[0].symbol, 'C');
  assert.equal(c[1].symbol, 'Dm');
  assert.equal(c[6].symbol, 'Bdim');
});

test('определение аккорда по нотам', () => {
  const keyD = { tonic: 'D', mode: 'major', fifths: 2 };
  assert.equal(detectChord([2, 6, 9], { key: keyD }).symbol, 'D');
  assert.equal(detectChord([9, 1, 4, 7], { key: keyD }).symbol, 'A7');
  const keyC = { tonic: 'C', mode: 'major', fifths: 0 };
  assert.equal(detectChord([0, 4, 7], { key: keyC }).symbol, 'C');
  assert.equal(detectChord([5, 9, 0], { key: keyC }).symbol, 'F');
  assert.equal(detectChord([0, 4, 7], { key: keyC, bassPc: 7 }).symbol, 'C');
  assert.equal(detectChord([]).symbol, null);
});

test('достройка гармонии по мелодии', () => {
  const measure = {
    events: [
      { beat: 0, dur: 1, pitches: [60] },
      { beat: 1, dur: 1, pitches: [64] },
      { beat: 2, dur: 1, pitches: [67] },
      { beat: 3, dur: 1, pitches: [67] },
    ],
    harmony: [],
  };
  const segments = resolveHarmony(measure, { meter: { beats: 4, beatType: 4 }, key: { tonic: 'C', mode: 'major', fifths: 0 } });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].symbol, 'C');
  assert.equal(segments[1].symbol, 'G');
  assert.equal(segments.reduce((s, x) => s + x.dur, 0), 4);
  assert.ok(segments.every((s) => s.source === 'inferred'));

  const withSymbols = resolveHarmony(
    { events: [], harmony: [{ beat: 0, dur: 2, symbol: 'F' }] },
    { meter: { beats: 4, beatType: 4 }, key: { tonic: 'C', mode: 'major', fifths: 0 } },
  );
  assert.equal(withSymbols.length, 2);
  assert.equal(withSymbols[1].symbol, 'F');
  assert.equal(withSymbols[1].source, 'carry');
});

test('транспонирование и профили инструментов', () => {
  assert.equal(accompanimentShift('clarinet-bb'), -2);
  assert.equal(accompanimentShift('sax-alto'), -9);
  assert.equal(accompanimentShift('flute'), 0);
  assert.equal(getInstrument('нет-такого').id, 'flute');

  const e = transposeKey({ tonic: 'D', mode: 'major', fifths: 2 }, 2);
  assert.equal(e.tonic, 'E');
  assert.equal(e.fifths, 4);

  const c = transposeKey({ tonic: 'D', mode: 'major', fifths: 2 }, -2);
  assert.equal(c.tonic, 'C');
  assert.equal(c.fifths, 0);

  assert.equal(transposeChordSymbol('D', 2, 4), 'E');
  assert.equal(transposeChordSymbol('D', 1, -3), 'Eb');
  assert.equal(transposeChordSymbol('C/G', 2, 4), 'D/A');
  assert.equal(transposeChordSymbol('A7', -2, 0), 'G7');

  const score = {
    key: { tonic: 'D', mode: 'major', fifths: 2 },
    measures: [{ events: [{ beat: 0, dur: 1, pitches: [62] }], harmony: [{ beat: 0, dur: 4, symbol: 'D' }] }],
  };
  const up = transposeScore(score, 2);
  assert.equal(up.measures[0].events[0].pitches[0], 64);
  assert.equal(up.measures[0].harmony[0].symbol, 'E');
  assert.equal(up.key.tonic, 'E');

  const hint = transpositionHint({ tonic: 'D', mode: 'major', fifths: 2 }, 'clarinet-bb');
  assert.equal(hint.semitones, -2);
  assert.equal(hint.soundingKey.tonic, 'C');
  assert.ok(hint.text.includes('вниз'));

  const hintFlute = transpositionHint({ tonic: 'D', mode: 'major', fifths: 2 }, 'flute');
  assert.ok(hintFlute.text.includes('исходной тональности'));
});

test('темп: итальянские термины', () => {
  assert.deepEqual(tempoFromText('Andante'), { bpm: 80, term: 'andante' });
  assert.equal(tempoFromText('Allegro con moto').bpm, 136);
  assert.equal(tempoFromText('Andante non troppo').bpm, 72);
  assert.equal(tempoFromText('неизвестно'), null);
  assert.equal(tempoName(80), 'andante');
});