// FluteBand AI — картинки для сравнения: что делает подготовка снимка.
//
// Стенд считает точность числами, но глазами видно то, что числами не опишешь:
// отрезало ли часть листа, выпрямились ли строки, не стали ли ноты серыми.
//
// Запуск: node tools/photo-compare.mjs [--piece=02-waltz-3-4] [--preset=tilt] [--label=base]
// Результат: artifacts/photo-1-original.png, photo-2-prep.png, photo-3-deskew.png

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { preprocessImageData } from '../app/js/image-prep.js';
import { PHOTO_PRESETS, simulatePhoto } from './photo-sim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};

const piece = arg('piece', '02-waltz-3-4');
const label = arg('label', 'base');
const presetName = arg('preset', 'tilt');
const preset = PHOTO_PRESETS[presetName] || PHOTO_PRESETS.tilt;

const source = join(ROOT, '.omr-bench', 'bench', `${piece}-${label}.png`);
if (!existsSync(source)) {
  console.error(`Нет страницы ${source}\nСначала: node tools/omr-bench.mjs --engine=homr --scale=40 --crop --render-only --label=${label}`);
  process.exitCode = 2;
} else {
  const artifacts = join(ROOT, 'artifacts');
  mkdirSync(artifacts, { recursive: true });

  const flat = decodePng(readFileSync(source));
  const photo = simulatePhoto(flat, preset);
  const prep = preprocessImageData(photo, { autoCrop: true, deskew: false, flatten: true, minWidth: 0, contrast: true });
  const deskew = preprocessImageData(photo, { autoCrop: true, deskew: true, flatten: true, minWidth: 0, contrast: true });

  const files = [
    [`photo-1-original.png`, photo, `фото как есть ${photo.width}×${photo.height}: ${preset.title}`],
    [`photo-2-prep.png`, prep, `подготовка без выравнивания ${prep.width}×${prep.height}`],
    [`photo-3-deskew.png`, deskew, `подготовка с выравниванием ${deskew.width}×${deskew.height}`],
  ];
  for (const [name, image, description] of files) {
    writeFileSync(join(artifacts, name), encodePng(image));
    console.log(`${name.padEnd(24)} ${description}`);
    console.log(`${' '.repeat(24)} шаги: ${image === photo ? '—' : image.stats.steps.join(', ') || '—'}`);
  }
  console.log('\nОткройте три файла из artifacts/ по порядку: 1 — что снял телефон, 2 — что было раньше, 3 — что стало.');
}