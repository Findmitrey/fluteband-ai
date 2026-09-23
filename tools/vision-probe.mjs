// FluteBand AI — спросить у модели, что видно на картинке (проверка снимков «глазами»).
//
// Зачем: подготовку снимка можно мерить числами, но часть ошибок видна только глазами —
// отрезало ли часть листа, выпрямились ли строки, не стали ли ноты серыми. Этот инструмент
// отправляет картинку мультимодальной модели и печатает её ответ.
//
// Запуск: node tools/vision-probe.mjs <файл.png> "<вопрос>" [--model=qwen3.8-max]
//         node tools/vision-probe.mjs --selftest        (проверка: нарисованная цифра 7)
// Ключ берётся из QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY или из ~/.dsh/.credentials.yaml

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';
import { askImage, MODEL_CANDIDATES } from './vision-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};

/** Нарисовать проверочную картинку с цифрой 7 — чтобы знать правильный ответ заранее */
function drawTestImage({ width = 220, height = 140 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 255;
  };
  for (let x = 50; x <= 170; x += 1) for (let d = 0; d < 6; d += 1) put(x, 30 + d); // верхняя перекладина
  for (let t = 0; t <= 1; t += 0.001) {
    const x = Math.round(170 - 90 * t);
    const y = Math.round(30 + 80 * t);
    for (let d = 0; d < 6; d += 1) put(x + d, y);
  }
  return { data, width, height };
}

async function main() {
  if (process.argv.includes('--selftest')) {
    const artifacts = join(ROOT, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const path = join(artifacts, 'vision-test.png');
    writeFileSync(path, encodePng(drawTestImage()));
    console.log(`Проверочная картинка: ${path} (нарисована цифра 7)`);
    for (const model of MODEL_CANDIDATES) {
      const result = await askImage(path, 'Какая цифра нарисована на картинке? Ответь только цифрой.', model);
      if (result.ok) {
        console.log(`OK   ${model}: «${result.answer.trim().slice(0, 120)}»`);
        return;
      }
      console.log(`нет  ${model}: ${result.status} ${result.error.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    console.log('Ни одна модель не приняла картинку.');
    process.exitCode = 1;
    return;
  }

  const imagePath = process.argv[2];
  const question = process.argv[3] || 'Что на картинке? Опиши коротко по-русски.';
  const model = arg('model', MODEL_CANDIDATES[0]);
  if (!imagePath || !existsSync(imagePath)) {
    console.error(`Нет файла: ${imagePath}`);
    process.exitCode = 2;
    return;
  }
  const result = await askImage(imagePath, question, model);
  if (!result.ok) {
    console.error(`Ошибка ${result.status}: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.answer.trim());
  if (result.usage) console.log(`\n[токены: ${JSON.stringify(result.usage)}]`);
}

await main();