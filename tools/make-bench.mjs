// FluteBand AI — генерация эталонных пьес для проверки распознавания (public-domain репертуар,
// уровень 1-3 класса ДМШ). Мы знаем точные ноты, поэтому можем честно измерить точность OMR.
//
// Запуск: node tools/make-bench.mjs
// Результат: server/fixtures/bench/*.musicxml + список с ожидаемыми характеристиками.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreFromManualInput } from '../app/js/manual.js';
import { scoreToMusicXml } from '../app/js/musicxml.js';
import { validateScore } from '../app/js/score.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '..', 'server', 'fixtures', 'bench');

/** Пьесы: компактная запись мелодии и аккордов (формат ручного ввода приложения) */
export const BENCH_PIECES = [
  {
    id: '01-ode-to-joy',
    title: 'Ода к радости (фрагмент)',
    composer: 'Л. ван Бетховен',
    tonic: 'D',
    mode: 'major',
    meterText: '4/4',
    tempo: 80,
    melodyText: 'F#4 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | F#4:1.5 E4:0.5 E4:2 | F#4 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | F#4:1.5 E4:0.5 D4:2',
    chordsText: 'D | A7 | D | A7 | D | A7 | D | D',
    note: 'четверти и пунктир — базовый уровень',
  },
  {
    id: '02-waltz-3-4',
    title: 'Учебный вальс',
    composer: 'Учебный репертуар',
    tonic: 'C',
    mode: 'major',
    meterText: '3/4',
    tempo: 120,
    melodyText: 'C4 E4 G4 | G4:2 E4 | F4 A4 C5 | C5:2 G4 | C4 E4 G4 | A4 F4 D4 | C4 E4 G4 | C4:3',
    chordsText: 'C | C | F | C | C | G7 | C | C',
    note: 'размер 3/4, половинные и целая ноты',
  },
  {
    id: '03-etude-eighths',
    title: 'Этюд восьмыми',
    composer: 'Учебный репертуар',
    tonic: 'G',
    mode: 'major',
    meterText: '4/4',
    tempo: 96,
    melodyText: 'G4:0.5 A4:0.5 B4:0.5 C5:0.5 D5:2 | D5:0.5 C5:0.5 B4:0.5 A4:0.5 G4:2 | B4:0.5 C5:0.5 D5:0.5 E5:0.5 D5:1 B4:1 | G4:1 A4:1 B4:2 | G4:0.5 A4:0.5 B4:0.5 C5:0.5 D5:2 | D5:0.5 C5:0.5 B4:0.5 A4:0.5 G4:2 | A4:0.5 B4:0.5 C5:0.5 D5:0.5 E5:1 D5:1 | G4:4',
    chordsText: 'G | D7 | G | G | G | D7 | G | G',
    note: 'восьмые и целая нота',
  },
  {
    id: '04-etude-sixteenths',
    title: 'Этюд шестнадцатыми (2/4)',
    composer: 'Учебный репертуар',
    tonic: 'F',
    mode: 'major',
    meterText: '2/4',
    tempo: 100,
    melodyText: 'F4:0.25 G4:0.25 A4:0.25 Bb4:0.25 A4:1 | G4:0.5 F4:0.5 F4:1 | A4:0.25 Bb4:0.25 C5:0.25 D5:0.25 C5:1 | Bb4:0.5 A4:0.5 G4:1 | F4:0.25 G4:0.25 A4:0.25 Bb4:0.25 A4:1 | G4:0.5 F4:0.5 F4:1 | C5:0.5 A4:0.5 G4:0.5 F4:0.5 | F4:2',
    chordsText: 'F | C7 | F | Bb | F | C7 | F | F',
    note: 'шестнадцатые, бемоль в ключе',
  },
  {
    id: '05-minor-study',
    title: 'Этюд ля минор',
    composer: 'Учебный репертуар',
    tonic: 'A',
    mode: 'minor',
    meterText: '3/4',
    tempo: 92,
    melodyText: 'A4 C5 E5 | E5:2 C5 | D5 B4 G#4 | A4:3 | A4 C5 E5 | E5:2 A4 | B4 D5 G#4 | A4:3',
    chordsText: 'Am | Am | E7 | Am | Am | Am | E7 | Am',
    note: 'минор со случайным соль-диезом',
  },
  {
    id: '06-six-eight',
    title: 'Песенка в размере 6/8',
    composer: 'Учебный репертуар',
    tonic: 'G',
    mode: 'major',
    meterText: '6/8',
    tempo: 108,
    melodyText: 'G4:1.5 B4:1.5 | D5:1.5 B4:1.5 | C5:1.5 A4:1.5 | G4:3 | G4:1.5 B4:1.5 | D5:1.5 B4:1.5 | A4:1.5 F#4:1.5 | G4:3',
    chordsText: 'G | G | C | G | G | G | D7 | G',
    note: 'размер 6/8, пунктирные четверти',
  },
];

export function buildBenchScore(piece) {
  return scoreFromManualInput({
    id: `bench-${piece.id}`,
    title: piece.title,
    composer: piece.composer,
    tonic: piece.tonic,
    mode: piece.mode,
    meterText: piece.meterText,
    tempo: piece.tempo,
    chordsText: piece.chordsText,
    melodyText: piece.melodyText,
  });
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  for (const piece of BENCH_PIECES) {
    const score = buildBenchScore(piece);
    const validation = validateScore(score);
    const xml = scoreToMusicXml(score, { includeHarmony: true });
    const file = join(OUT_DIR, `${piece.id}.musicxml`);
    writeFileSync(file, xml, 'utf8');
    manifest.push({
      id: piece.id,
      title: piece.title,
      file,
      note: piece.note,
      measures: validation.metrics.measureCount,
      events: validation.metrics.eventCount,
      beats: validation.metrics.totalBeats,
      meter: piece.meterText,
      key: `${piece.tonic} ${piece.mode}`,
      problems: validation.problems,
    });
    const state = validation.problems.length ? `ЗАМЕЧАНИЯ: ${validation.problems.join('; ')}` : 'без замечаний';
    console.log(`${piece.id.padEnd(22)} ${piece.meterText.padEnd(4)} ${String(validation.metrics.eventCount).padStart(3)} событий  ${state}`);
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nГотово: ${manifest.length} эталонных пьес в server/fixtures/bench`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}