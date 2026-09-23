// FluteBand AI — разбор MusicXML по партиям, станам и голосам.
//
// Зачем: на настоящей странице сборника распознавание отдаёт несколько партий (у «фортепиано + блокфлейта»
// их две, а в первой партии два стана). Чтобы понять, где напечатана мелодия, а где фортепиано, нужно видеть
// разметку файла: сколько партий, какие станы, какие голоса и что из этого сделало приложение.
//
// Запуск: node tools/inspect-musicxml.mjs путь.musicxml [ещё.musicxml ...]
// Ничего не меняет, только печатает разбор. В приложении не участвует.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { musicXmlToScore } from '../app/js/musicxml.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Укажите файл(ы) MusicXML: node tools/inspect-musicxml.mjs ноты.musicxml');
  process.exit(1);
}

for (const file of files) {
  const xml = readFileSync(file, 'utf8');
  console.log(`\n=== ${basename(file)} ===`);

  const parts = [...xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)];
  console.log(`частей: ${parts.length}`);
  for (const [, partId, body] of parts) {
    const counts = (pattern) => (body.match(pattern) || []).length;
    const staffs = {};
    for (const m of body.matchAll(/<staff>(\d+)<\/staff>/g)) staffs[m[1]] = (staffs[m[1]] || 0) + 1;
    const clefs = [...body.matchAll(/<sign>([A-Z])<\/sign>\s*<line>(\d)<\/line>/g)].map((m) => m[1] + m[2]);
    console.log(`  партия ${partId}: тактов ${counts(/<measure /g)}, нот ${counts(/<note>/g)} `
      + `(аккордовых ${counts(/<chord\s*\/>/g)}), пауз ${counts(/<rest/g)}, `
      + `станы ${JSON.stringify(staffs)}, ключи ${clefs.join(',') || '—'}`);
  }

  const score = musicXmlToScore(xml, { kind: 'inspect' });
  const voices = {};
  for (const measure of score.measures) {
    for (const event of measure.events) {
      const key = event.voice || '?';
      const bucket = voices[key] || { events: 0, pitches: 0, min: 999, max: -1 };
      bucket.events += 1;
      bucket.pitches += (event.pitches || []).length;
      for (const midi of event.pitches || []) {
        bucket.min = Math.min(bucket.min, midi);
        bucket.max = Math.max(bucket.max, midi);
      }
      voices[key] = bucket;
    }
  }
  console.log('приложение разобрало:', JSON.stringify(voices));
  console.log(`тональность ${score.key.tonic} ${score.key.mode}, размер ${score.meter.beats}/${score.meter.beatType}`);
  if (score.warnings.length) for (const warning of score.warnings) console.log(`  предупреждение: ${warning}`);
  const first = score.measures[0]?.events || [];
  console.log('первый такт:', JSON.stringify(first.slice(0, 10).map((e) => `${e.voice}:${e.pitches.join('+')}@${e.beat}`)));
}