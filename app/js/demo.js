// FluteBand AI — встроенные демо-пьесы (public domain) для проверки без сканирования.

function ev(beat, dur, pitches, voice = 'melody') {
  return { beat, dur, pitches: Array.isArray(pitches) ? pitches : [pitches], voice };
}

function h(beat, dur, symbol) {
  return { beat, dur, symbol, source: 'source' };
}

/** Бетховен, «Ода к радости» (фрагмент, D-dur, 4/4) — общественное достояние */
export function odeToJoy() {
  const Fs4 = 66; const G4 = 67; const A4 = 69; const E4 = 64; const D4 = 62;
  return {
    id: 'demo-ode-to-joy',
    title: 'Ода к радости (фрагмент)',
    composer: 'Л. ван Бетховен',
    tempo: 100,
    tempoSource: 'по умолчанию для демо',
    meter: { beats: 4, beatType: 4 },
    key: { tonic: 'D', mode: 'major', fifths: 2 },
    measures: [
      { number: '1', events: [ev(0, 1, Fs4), ev(1, 1, Fs4), ev(2, 1, G4), ev(3, 1, A4)], harmony: [h(0, 4, 'D')] },
      { number: '2', events: [ev(0, 1, A4), ev(1, 1, G4), ev(2, 1, Fs4), ev(3, 1, E4)], harmony: [h(0, 4, 'A7')] },
      { number: '3', events: [ev(0, 1, D4), ev(1, 1, D4), ev(2, 1, E4), ev(3, 1, Fs4)], harmony: [h(0, 4, 'D')] },
      { number: '4', events: [ev(0, 1.5, Fs4), ev(1.5, 0.5, E4), ev(2, 2, E4)], harmony: [h(0, 4, 'A7')] },
      { number: '5', events: [ev(0, 1, Fs4), ev(1, 1, Fs4), ev(2, 1, G4), ev(3, 1, A4)], harmony: [h(0, 4, 'D')] },
      { number: '6', events: [ev(0, 1, A4), ev(1, 1, G4), ev(2, 1, Fs4), ev(3, 1, E4)], harmony: [h(0, 4, 'A7')] },
      { number: '7', events: [ev(0, 1, D4), ev(1, 1, D4), ev(2, 1, E4), ev(3, 1, Fs4)], harmony: [h(0, 4, 'D')] },
      { number: '8', events: [ev(0, 1.5, Fs4), ev(1.5, 0.5, E4), ev(2, 2, D4)], harmony: [h(0, 4, 'D')] },
    ],
    source: { kind: 'demo', engine: 'manual' },
    warnings: [],
  };
}

/** Учебный вальс (G-dur, 3/4) — простая диатоника I–V7, для проверки стиля «вальс» */
export function studyWaltz() {
  const D4 = 62; const E4 = 64; const Fs4 = 66; const G4 = 67; const A4 = 69; const B4 = 71; const C5 = 72; const D5 = 74;
  return {
    id: 'demo-study-waltz',
    title: 'Учебный вальс',
    composer: 'учебный пример (public domain)',
    tempo: 132,
    tempoSource: 'по умолчанию для демо',
    meter: { beats: 3, beatType: 4 },
    key: { tonic: 'G', mode: 'major', fifths: 1 },
    measures: [
      { number: '1', events: [ev(0, 1, D4), ev(1, 1, G4), ev(2, 1, B4)], harmony: [h(0, 3, 'G')] },
      { number: '2', events: [ev(0, 1, A4), ev(1, 1, Fs4), ev(2, 1, D4)], harmony: [h(0, 3, 'D7')] },
      { number: '3', events: [ev(0, 1, G4), ev(1, 1, B4), ev(2, 1, D5)], harmony: [h(0, 3, 'G')] },
      { number: '4', events: [ev(0, 1, E4), ev(1, 1, G4), ev(2, 1, C5)], harmony: [h(0, 3, 'C')] },
      { number: '5', events: [ev(0, 2, B4), ev(2, 1, A4)], harmony: [h(0, 3, 'G')] },
      { number: '6', events: [ev(0, 2, A4), ev(2, 1, Fs4)], harmony: [h(0, 3, 'D7')] },
      { number: '7', events: [ev(0, 3, G4)], harmony: [h(0, 3, 'G')] },
      { number: '8', events: [ev(0, 3, G4)], harmony: [h(0, 3, 'G')] },
    ],
    source: { kind: 'demo', engine: 'manual' },
    warnings: [],
  };
}

/** Учебная пьеса без аккордов — проверяет автоматическую достройку гармонии */
export function harmonyInferenceDemo() {
  const C4 = 60; const D4 = 62; const E4 = 64; const F4 = 65; const G4 = 67; const A4 = 69; const B4 = 71; const C5 = 72;
  return {
    id: 'demo-harmony-inference',
    title: 'Мелодия без аккордов (проверка авто-гармонии)',
    composer: 'учебный пример (public domain)',
    tempo: 96,
    tempoSource: 'по умолчанию для демо',
    meter: { beats: 4, beatType: 4 },
    key: { tonic: 'C', mode: 'major', fifths: 0 },
    measures: [
      { number: '1', events: [ev(0, 1, C4), ev(1, 1, E4), ev(2, 1, G4), ev(3, 1, E4)], harmony: [] },
      { number: '2', events: [ev(0, 1, F4), ev(1, 1, A4), ev(2, 1, C5), ev(3, 1, A4)], harmony: [] },
      { number: '3', events: [ev(0, 1, G4), ev(1, 1, B4), ev(2, 1, D4 + 12), ev(3, 1, B4)], harmony: [] },
      { number: '4', events: [ev(0, 2, C4), ev(2, 2, C4)], harmony: [] },
    ],
    source: { kind: 'demo', engine: 'manual' },
    warnings: [],
  };
}

export const DEMOS = [
  { id: 'demo-ode-to-joy', name: 'Ода к радости (Бетховен)', factory: odeToJoy },
  { id: 'demo-study-waltz', name: 'Учебный вальс (3/4)', factory: studyWaltz },
  { id: 'demo-harmony-inference', name: 'Мелодия без аккордов', factory: harmonyInferenceDemo },
];

export function demoById(id) {
  const demo = DEMOS.find((d) => d.id === id);
  return demo ? demo.factory() : null;
}

export function demoScore(id) {
  return demoById(id) || odeToJoy();
}