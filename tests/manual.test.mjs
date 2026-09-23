// FluteBand AI — тесты ручного ввода (страховка при ошибках распознавания).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMeter, meterText, parseChordLine, parseMelodyLine, scoreFromManualInput, measureBeatsOf } from '../app/js/manual.js';
import { validateScore } from '../app/js/score.js';
import { generateAccompaniment } from '../app/js/accompaniment.js';

test('ручной ввод: размер', () => {
  assert.deepEqual(parseMeter('3/4'), { beats: 3, beatType: 4 });
  assert.deepEqual(parseMeter('6 / 8'), { beats: 6, beatType: 8 });
  assert.deepEqual(parseMeter('ерунда'), { beats: 4, beatType: 4 });
  assert.deepEqual(parseMeter(''), { beats: 4, beatType: 4 });
  assert.equal(meterText({ beats: 3, beatType: 4 }), '3/4');
  assert.equal(measureBeatsOf({ beats: 6, beatType: 8 }), 3);
});

test('ручной ввод: аккорды по тактам', () => {
  assert.deepEqual(parseChordLine('C | G7 | C'), [['C'], ['G7'], ['C']]);
  assert.deepEqual(parseChordLine('C, G7 | F'), [['C', 'G7'], ['F']]);
  assert.deepEqual(parseChordLine('', 3), [[], [], []]);
  assert.deepEqual(parseChordLine('C', 2), [['C'], []]);
});

test('ручной ввод: мелодия текстом', () => {
  const meter = { beats: 4, beatType: 4 };
  const measures = parseMelodyLine('C4 D4 E4 F4 | G4:2 r:2', meter);
  assert.equal(measures.length, 2);
  assert.deepEqual(measures[0].map((e) => e.beat), [0, 1, 2, 3]);
  assert.deepEqual(measures[0].map((e) => e.pitches[0]), [60, 62, 64, 65]);
  assert.equal(measures[1].length, 1);
  assert.equal(measures[1][0].dur, 2);
  assert.deepEqual(measures[1][0].pitches, [67]);

  const withChordNote = parseMelodyLine('C4+E4:2 G4:2', meter);
  assert.deepEqual(withChordNote[0][0].pitches, [60, 64]);
  assert.equal(withChordNote[0][1].beat, 2);
  assert.deepEqual(parseMelodyLine('', meter), []);
});

test('ручной ввод: пьеса только из аккордов (минус без мелодии)', () => {
  const score = scoreFromManualInput({
    title: 'Только аккорды',
    tonic: 'C',
    meterText: '3/4',
    tempo: 120,
    chordsText: 'C | G7 | C | F | C | G7 | C | C',
  });
  assert.equal(score.measures.length, 8);
  assert.deepEqual(score.meter, { beats: 3, beatType: 4 });
  assert.equal(score.key.fifths, 0);
  assert.deepEqual(score.measures[0].harmony.map((h) => h.symbol), ['C']);
  const validation = validateScore(score);
  assert.equal(validation.ok, true, validation.problems.join('; '));
  const acc = generateAccompaniment(score);
  assert.equal(acc.style, 'waltz');
  assert.equal(acc.events.length, 24); // 8 тактов × (бас + 2 аккорда)
});

test('ручной ввод: мелодия + аккорды, транспонирующие тональности', () => {
  const score = scoreFromManualInput({
    title: 'Мелодия и аккорды',
    tonic: 'Bb',
    mode: 'major',
    meterText: '4/4',
    tempo: 96,
    chordsText: 'Bb | Eb | F7 | Bb',
    melodyText: 'Bb4 D5 F5 D5 | Eb5 G5 Bb5 G5 | F5 A5 C6 A5 | Bb5:4',
  });
  assert.equal(score.measures.length, 4);
  assert.equal(score.key.fifths, -2);
  assert.deepEqual(score.measures[0].events.map((e) => e.pitches[0]), [70, 74, 77, 74]);
  assert.equal(validateScore(score).ok, true, validateScore(score).problems.join('; '));
  const acc = generateAccompaniment(score, { instrumentId: 'clarinet-bb' });
  assert.equal(acc.transpositionSemitones, -2);
  assert.equal(acc.concertScore.key.tonic, 'Ab');
  assert.ok(acc.events.length >= 16);

  const minor = scoreFromManualInput({ tonic: 'A', mode: 'minor', chordsText: 'Am | Dm | E7 | Am' });
  assert.equal(minor.key.fifths, 0);
  assert.equal(minor.key.mode, 'minor');
  assert.equal(minor.measures.length, 4);
});