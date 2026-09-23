// FluteBand AI — проверка OMR-сервиса из командной строки.
// Отправляет страницу на распознавание и разбирает MusicXML нашим же парсером.
//
// Запуск: node tools/omr-check.mjs [baseUrl] [imagePath] [--mode=full|melody] [--engine=id]
//   node tools/omr-check.mjs                                   # http://127.0.0.1:8000, проверка контракта (движок-заглушка)
//   node tools/omr-check.mjs http://127.0.0.1:3030/api        # через прокси dev-сервера
//   node tools/omr-check.mjs http://127.0.0.1:8000 page.png    # настоящее распознавание страницы
//   node tools/omr-check.mjs http://127.0.0.1:8000 page.png --mode=melody   # только мелодический стан

import { readFileSync } from 'node:fs';
import { musicXmlToScore } from '../app/js/musicxml.js';
import { generateAccompaniment } from '../app/js/accompaniment.js';
import { validateScore } from '../app/js/score.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const found = argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const positional = argv.filter((item) => !item.startsWith('--'));
const base = (positional[0] || 'http://127.0.0.1:8000').replace(/\/$/, '');
const imagePath = positional[1] || null;
const mode = flag('mode', 'full');
const engineFlag = flag('engine', null);

/** Минимальный корректный по подписи JPEG (проверяем контракт, а не декодирование картинки) */
function sampleJpeg(size = 2048) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes.fill(0x20, 3);
  return bytes;
}

async function main() {
  const healthRes = await fetch(`${base}/health`);
  const health = await healthRes.json();
  console.log(`Сервис: ${base}`);
  console.log(`  /health -> ${healthRes.status} ${JSON.stringify(health)}`);

  const enginesRes = await fetch(`${base}/engines`);
  const engines = await enginesRes.json();
  const available = (engines.engines || []).filter((e) => e.available).map((e) => e.id);
  console.log(`  /engines -> доступны: ${available.join(', ') || 'нет'}${engines.defaultEngine ? ` (по умолчанию ${engines.defaultEngine})` : ''}`);
  if (imagePath) console.log(`  страница: ${imagePath}`);

  const form = new FormData();
  const imageBytes = imagePath ? new Uint8Array(readFileSync(imagePath)) : sampleJpeg();
  const mime = imagePath?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  form.append('image', new Blob([imageBytes], { type: mime }), imagePath ? imagePath.split(/[\\/]/).pop() : 'page.jpg');
  // Без настоящей страницы проверяем только контракт: подпись JPEG без картинки. Боевой движок такую
  // «страницу» честно отвергает («формат не поддерживается»), поэтому просим заглушку.
  if (!imagePath) form.append('engine', 'stub');
  if (engineFlag) form.append('engine', engineFlag);
  if (mode && mode !== 'full') form.append('mode', mode);
  const started = Date.now();
  const res = await fetch(`${base}/recognize`, { method: 'POST', body: form });
  const elapsed = Date.now() - started;
  const payload = await res.json();
  if (!res.ok) {
    console.error(`  /recognize -> ${res.status} ${JSON.stringify(payload)}`);
    process.exitCode = 1;
    return;
  }

  const score = musicXmlToScore(payload.musicxml, {
    engine: payload.engine,
    confidence: payload.confidence,
    kind: 'omr',
  });
  const validation = validateScore(score);
  const accompaniment = generateAccompaniment(score, { style: 'auto', instrumentId: 'flute' });

  console.log(`  /recognize -> ${res.status} за ${elapsed} мс, движок «${payload.engine}», режим «${payload.mode || mode}»`);
  if (payload.melody) console.log(`    мелодия: ${JSON.stringify(payload.melody)}`);
  console.log(`    пьеса: ${score.title} — ${score.composer || 'без автора'}`);
  console.log(`    тональность: ${score.key.tonic} ${score.key.mode}, размер ${score.meter.beats}/${score.meter.beatType}, темп ${score.tempo}`);
  console.log(`    тактов: ${score.measures.length}, событий: ${validation.metrics.eventCount}, аккордов: ${validation.metrics.harmonyCount}`);
  console.log(`    проверка модели: ${validation.ok ? 'без замечаний' : validation.problems.slice(0, 4).join('; ')}`);
  console.log(`    минус: рисунок «${accompaniment.style}», событий ${accompaniment.events.length}, бас первой доли ${JSON.stringify(accompaniment.events[0]?.midi)}`);
  if (payload.warnings?.length) console.log(`    предупреждения сервиса: ${payload.warnings.join(' | ')}`);

  const ok = validation.ok && accompaniment.events.length > 0;
  console.log(ok ? '\nИтог: OK — страница превращена в минус' : '\nИтог: FAIL');
  process.exitCode = ok ? 0 : 1;
}

await main().catch((error) => {
  console.error(`Ошибка проверки OMR: ${error.message}`);
  process.exitCode = 1;
});