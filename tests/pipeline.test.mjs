// FluteBand AI — тесты тракта «MusicXML -> модель -> аккомпанемент» и встроенных демо-пьес.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXml, children, first, nodeText, attr } from '../app/js/xml.js';
import { musicXmlToScore } from '../app/js/musicxml.js';
import { FIXTURES } from '../app/js/fixtures.js';
import { odeToJoy, studyWaltz, harmonyInferenceDemo, DEMOS, demoById } from '../app/js/demo.js';
import { createScore, validateScore, scoreSummary, harmonyGrid } from '../app/js/score.js';
import { generateAccompaniment, chooseStyle, patternSlots, chordAtBeat } from '../app/js/accompaniment.js';
import { totalBeats, measureStarts, melodyTimeline, measureLengthBeats } from '../app/js/timeline.js';
import { resolveHarmony } from '../app/js/harmony.js';

test('XML: минимальный парсер', () => {
  const root = parseXml('<?xml version="1.0"?><a x="1" y=\'два\'><b>привет</b><c/></a>');
  assert.equal(root.name, 'a');
  assert.equal(attr(root, 'x'), '1');
  assert.equal(attr(root, 'y'), 'два');
  assert.equal(children(root).length, 2);
  assert.equal(nodeText(first(root, 'b')), 'привет');
  assert.equal(nodeText(root), 'привет');
  assert.equal(children(root, 'c').length, 1);

  const cmt = parseXml('<a><!-- комментарий --><b>1</b></a>');
  assert.equal(children(cmt).length, 1);

  const escaped = parseXml('<a><b>A &amp; B</b></a>');
  assert.equal(nodeText(first(escaped, 'b')), 'A & B');

  assert.throws(() => parseXml('не xml вовсе'));
});

test('MusicXML: «Ода к радости» (4 такта, Andante, D-dur, аккорды)', () => {
  const score = musicXmlToScore(FIXTURES.odeToJoy);
  assert.equal(score.title, 'Ода к радости (фрагмент)');
  assert.equal(score.composer, 'Л. ван Бетховен');
  assert.equal(score.tempo, 80);
  assert.ok(score.tempoSource.includes('andante'));
  assert.deepEqual(score.meter, { beats: 4, beatType: 4 });
  assert.equal(score.key.tonic, 'D');
  assert.equal(score.key.mode, 'major');
  assert.equal(score.key.fifths, 2);
  assert.equal(score.measures.length, 4);

  assert.deepEqual(score.measures[0].events.map((e) => e.pitches[0]), [66, 66, 67, 69]);
  assert.deepEqual(score.measures[0].events.map((e) => e.voice), ['melody', 'melody', 'melody', 'melody']);
  assert.deepEqual(score.measures[3].events.map((e) => e.dur), [1.5, 0.5, 2]);
  assert.deepEqual(score.measures.map((m) => m.harmony[0].symbol), ['D', 'A7', 'D', 'A7']);
  assert.deepEqual(score.measures.map((m) => m.harmony[0].dur), [4, 4, 4, 4]);

  const validation = validateScore(score);
  assert.equal(validation.ok, true, validation.problems.join('; '));
  assert.equal(validation.metrics.measureCount, 4);
  assert.equal(validation.metrics.harmonyCount, 4);
  assert.equal(validation.metrics.totalBeats, 16);
});

test('MusicXML: двухголосие и <backup>', () => {
  const score = musicXmlToScore(FIXTURES.twoVoice);
  assert.equal(score.tempo, 88);
  const measure = score.measures[0];
  assert.equal(measure.events.length, 4);
  const melody = measure.events.filter((e) => e.voice === 'melody');
  const bass = measure.events.filter((e) => e.voice === 'bass');
  assert.deepEqual(melody.map((e) => e.pitches[0]), [76, 79]);
  assert.deepEqual(bass.map((e) => e.pitches[0]), [48, 43]); // C3 и G2
  assert.deepEqual(bass.map((e) => e.beat), [0, 2]);
  assert.equal(validateScore(score).ok, true);
});

test('MusicXML: сборник «фортепиано + блокфлейта» — мелодия с верхней строки, левая рука в разборе', () => {
  // Так выглядит настоящая страница сборника после распознавания: две партии, в первой партии два стана.
  // Раньше приложение читало одну партию с наибольшим числом нот, и левая рука фортепиано пропадала.
  const note = (step, octave, duration, voice, staff) =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice>`
    + `${staff ? `<staff>${staff}</staff>` : ''}<type>quarter</type></note>`;
  const attrs = (clef, line) => `<attributes><divisions>1</divisions><key><fifths>-1</fifths></key>`
    + `<time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>${clef}</sign><line>${line}</line></clef></attributes>`;
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list>`
    + `<score-part id="P1"><part-name>Voice</part-name></score-part>`
    + `<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>`
    + `<part id="P1">`
    + `<measure number="1">${attrs('G', 2)}${note('D', 5, 1, 1, 1)}${note('A', 4, 1, 1, 1)}`
    + `<backup><duration>2</duration></backup>${note('F', 4, 1, 5, 2)}${note('D', 4, 1, 5, 2)}</measure>`
    + `<measure number="2">${note('E', 5, 1, 1, 1)}${note('C', 5, 1, 1, 1)}`
    + `<backup><duration>2</duration></backup>${note('A', 4, 1, 5, 2)}${note('F', 4, 1, 5, 2)}</measure>`
    + `</part><part id="P2">`
    + `<measure number="1">${attrs('F', 4)}${note('D', 3, 2, 1, 1)}</measure>`
    + `<measure number="2">${note('A', 2, 2, 1, 1)}</measure>`
    + `</part></score-partwise>`;

  const score = musicXmlToScore(xml);
  assert.equal(score.measures.length, 2);
  const voicesOf = (index) => score.measures[index].events.map((e) => `${e.voice}:${e.pitches[0]}`);
  // Мелодия — верхний стан первой партии (блокфлейта), правая рука — средние, левая — бас
  // (события идут по долям, внутри доли — по высоте, поэтому бас первой доли стоит первым)
  assert.deepEqual(voicesOf(0), ['bass:50', 'inner:65', 'melody:74', 'inner:62', 'melody:69']);
  assert.deepEqual(voicesOf(1), ['bass:45', 'inner:69', 'melody:76', 'inner:65', 'melody:72']);
  assert.equal(score.measures[0].events.find((e) => e.voice === 'bass').dur, 2, 'левая рука: половинная нота');
  // Левая рука раньше не попадала в разбор вообще — теперь она есть и в нотах, и в гармонии
  assert.ok(score.measures[0].events.some((e) => e.pitches[0] < 55), 'нет нот левой руки фортепиано');
  assert.ok(score.warnings.some((w) => w.includes('мелодия взята с верхней строки')), 'нет пояснения про партии');
  assert.equal(validateScore(score).ok, true, validateScore(score).problems.join('; '));

  const acc = generateAccompaniment(score, { style: 'auto' });
  assert.ok(acc.events.length > 0, 'минус не построился');
  assert.ok(acc.events.every((e) => e.midi.every((midi) => midi >= 28 && midi <= 96)), 'аккомпанемент вне разумного диапазона');
});

test('MusicXML: одноголосные ноты по-прежнему разбираются как мелодия', () => {
  // Правило «мелодия — верхняя строка» должно молчать там, где строка одна: иначе одноголосные
  // пьесы (школа, этюды) развалились бы на «мелодию» и «аккомпанемент».
  const score = musicXmlToScore(FIXTURES.odeToJoy);
  assert.ok(score.measures.every((m) => m.events.every((e) => e.voice === 'melody')));
});

test('MusicXML без аккордовых символов: гармония достраивается', () => {
  const score = musicXmlToScore(FIXTURES.noHarmony);
  assert.equal(score.measures[0].harmony.length, 0);
  const segments = resolveHarmony(score.measures[0], { meter: { beats: 4, beatType: 4 }, key: score.key });
  assert.deepEqual(segments.map((s) => s.symbol), ['C', 'G']);
  const acc = generateAccompaniment(score, { style: 'blockChords' });
  assert.equal(acc.events.length, 4);
  assert.ok(acc.events.every((e) => e.midi.length >= 3));
});

test('демо-пьесы: целостность и метрики', () => {
  const ode = odeToJoy();
  const waltz = studyWaltz();
  const infer = harmonyInferenceDemo();
  assert.equal(validateScore(ode).ok, true);
  assert.equal(validateScore(waltz).ok, true);
  assert.equal(validateScore(infer).ok, true);
  assert.equal(totalBeats(ode), 32);
  assert.equal(totalBeats(waltz), 24);
  assert.deepEqual(measureStarts(waltz), [0, 3, 6, 9, 12, 15, 18, 21]);
  assert.equal(melodyTimeline(ode).length, 30); // в 4-м и 8-м тактах по 3 ноты (пунктирный ритм)
  const summary = scoreSummary(ode);
  assert.equal(summary.measures, 8);
  assert.equal(summary.key, 'D dur');
  assert.equal(summary.duration, '0:19');
  assert.equal(DEMOS.length, 3);
  assert.equal(demoById('demo-study-waltz').title, 'Учебный вальс');
  assert.equal(demoById('нет-такого'), null);
});

test('стили аккомпанемента: выбор и рисунок', () => {
  assert.equal(chooseStyle(4, 100), 'march');
  assert.equal(chooseStyle(4, 60), 'ballad');
  assert.equal(chooseStyle(3, 132), 'waltz');
  assert.equal(chooseStyle(2, 120), 'polka');
  assert.equal(chooseStyle(4, 100), 'march');
  assert.equal(patternSlots('march', 4).length, 4);
  assert.equal(patternSlots('waltz', 3).length, 3);
  assert.equal(patternSlots('arpeggio', 4).length, 8);
  assert.equal(patternSlots('arpeggio', 3).length, 6);
  assert.equal(patternSlots('blockChords', 4).length, 4);
  assert.deepEqual(patternSlots('polka', 2).map((s) => s.kind), ['bass', 'chord']);
});

test('генератор минуса: марш, вальс, разложенные аккорды, транспонирование', () => {
  const ode = odeToJoy();
  const march = generateAccompaniment(ode);
  assert.equal(march.style, 'march');
  assert.equal(march.events.length, 32);
  assert.deepEqual(march.events.slice(0, 4).map((e) => e.startBeat), [0, 1, 2, 3]);
  assert.deepEqual(march.events[0].midi, [38]); // D2 — основной тон D
  assert.equal(march.events[0].role, 'bass');
  assert.equal(march.events[1].midi.length, 3); // трезвучие D
  assert.equal(march.totalBeats, 32);
  assert.equal(march.transpositionSemitones, 0);
  assert.ok(march.events.every((e) => e.midi.every((p) => p >= 24 && p <= 84)));
  assert.ok(march.events.every((e) => e.velocity > 0 && e.velocity <= 1));

  const waltz = generateAccompaniment(studyWaltz());
  assert.equal(waltz.style, 'waltz');
  assert.equal(waltz.events.length, 24);
  assert.deepEqual(waltz.events.slice(0, 3).map((e) => e.role), ['bass', 'chord', 'chord']);

  const arp = generateAccompaniment(ode, { style: 'arpeggio' });
  assert.equal(arp.events.length, 64);
  assert.ok(arp.events.every((e) => e.role === 'chord' && e.midi.length === 1));

  // кларнет Bb: минус должен звучать на тон ниже написанного
  const clarinet = generateAccompaniment(ode, { instrumentId: 'clarinet-bb' });
  assert.equal(clarinet.transpositionSemitones, -2);
  assert.deepEqual(clarinet.events[0].midi, [36]); // C2
  assert.equal(clarinet.concertScore.key.tonic, 'C');
  assert.equal(clarinet.concertScore.measures[0].harmony[0].symbol, 'C');

  // мелодия в минус не попадает (решение №20: только аккомпанемент)
  assert.equal(march.melodyEvents.length, 0);
  const withMelody = generateAccompaniment(ode, { includeMelody: true, melodyVolume: 0.25 });
  assert.equal(withMelody.melodyEvents.length, 30);
  assert.ok(withMelody.melodyEvents.every((e) => e.role === 'melody'));

  assert.equal(generateAccompaniment(createScore({})).events.length, 0);
  assert.ok(generateAccompaniment(createScore({})).warnings.length > 0);
});

test('аккомпанемент не дублирует мелодию и знает аккорд в доле', () => {
  const ode = odeToJoy();
  const acc = generateAccompaniment(ode);
  // в 1-м такте марша аккорд звучит на 2-й доле (на 1-й — бас), мелодия F#4 (pc 6) не дублируется
  const chordEvent = acc.events.find((e) => e.startBeat === 1 && e.role === 'chord');
  assert.ok(chordEvent);
  assert.ok(chordEvent.midi.length >= 3);

  assert.equal(chordAtBeat(ode, 0), 'D');
  assert.equal(chordAtBeat(ode, 5), 'A7');
  assert.equal(chordAtBeat(ode, 8), 'D');
  assert.equal(chordAtBeat(ode, 999), null);
});

test('такты 6/8 и гармоническая сетка', () => {
  const sixEight = createScore({
    title: '6/8',
    meter: { beats: 6, beatType: 8 },
    measures: [{ events: [{ beat: 0, dur: 1.5, pitches: [67] }, { beat: 1.5, dur: 1.5, pitches: [72] }], harmony: [{ beat: 0, dur: 3, symbol: 'G' }] }],
  });
  assert.equal(measureLengthBeats(sixEight, sixEight.measures[0]), 3);
  assert.equal(totalBeats(sixEight), 3);
  assert.equal(validateScore(sixEight).ok, true);
  const acc = generateAccompaniment(sixEight, { style: 'arpeggio' });
  assert.equal(acc.events.length, 6);
  const grid = harmonyGrid(odeToJoy(), 0);
  assert.equal(grid.length, 1);
  assert.equal(grid[0].symbol, 'D');
  assert.equal(grid[0].dur, 4);
});