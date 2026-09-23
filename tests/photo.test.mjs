// FluteBand AI — тесты уровня бумаги и выравнивания света на «фотографии» сборника.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findPageQuad,
  normalizeByPaperLevel,
  paperLevelMap,
  paperMaskAdaptive,
  perspectiveCorrect,
} from '../app/js/perspective.js';
import { grayFromRgba, grayStats, grayToRgba, preprocessImageData } from '../app/js/image-prep.js';
import { PHOTO_PRESETS, pageQuadInPhoto, simulatePhoto } from '../tools/photo-sim.mjs';

/** Синтетическое фото: стол с градиентом света, лист с наклоном, тёмные «ноты» на листе */
function makeGradientShot({ width = 400, height = 300, table = 90, paper = 220, shadow = 0.45 } = {}) {
  const corners = pageQuadInPhoto({
    photoWidth: width,
    photoHeight: height,
    pageWidth: 300,
    pageHeight: 200,
    scale: 0.7,
    tiltDeg: 6,
    squeeze: 0.08,
  });
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (Math.abs(cross) < 1e-9) continue;
      const current = cross > 0 ? 1 : -1;
      if (sign === 0) sign = current;
      else if (sign !== current) return false;
    }
    return true;
  };
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Свет падает слева: правый край кадра темнее в 1.8 раза
      const light = 1 - shadow * (x / width);
      gray[y * width + x] = (inside(x, y) ? paper : table) * light;
    }
  }
  // Ноты: три горизонтальные линии внутри листа
  for (let line = 0; line < 3; line += 1) {
    const t = 0.3 + line * 0.2;
    for (let u = 0.15; u <= 0.85; u += 0.004) {
      const top = { x: corners[0].x + (corners[1].x - corners[0].x) * u, y: corners[0].y + (corners[1].y - corners[0].y) * u };
      const bottom = { x: corners[3].x + (corners[2].x - corners[3].x) * u, y: corners[3].y + (corners[2].y - corners[3].y) * u };
      const px = Math.round(top.x + (bottom.x - top.x) * t);
      const py = Math.round(top.y + (bottom.y - top.y) * t);
      if (px >= 0 && px < width && py >= 0 && py < height) gray[py * width + px] = 35;
    }
  }
  return { gray, width, height, corners };
}

test('свет: карта уровня бумаги повторяет градиент освещения', () => {
  const shot = makeGradientShot();
  const level = paperLevelMap(shot.gray, shot.width, shot.height);
  const left = level.map[Math.round(shot.height / 2) * shot.width + Math.round(shot.width * 0.15)];
  const right = level.map[Math.round(shot.height / 2) * shot.width + Math.round(shot.width * 0.85)];
  assert.ok(left > right * 1.25, `слева бумага ярче: ${Math.round(left)} против ${Math.round(right)}`);
  assert.ok(right > 120, `уровень бумаги не должен падать до стола: ${Math.round(right)}`);

  // Стол не должен попасть в уровень бумаги: в левом верхнем углу кадра уровень — это бумага
  const corner = level.map[0];
  assert.ok(corner > 180, `в углу кадра уровень бумаги, а не стола: ${Math.round(corner)}`);
});

test('свет: выравнивание по уровню бумаги делает бумагу ровной', () => {
  const shot = makeGradientShot();
  const level = paperLevelMap(shot.gray, shot.width, shot.height);
  const flat = normalizeByPaperLevel(shot.gray, shot.width, shot.height, level);

  const sample = (gray, fx) => {
    // Берём пиксели бумаги вдоль середины листа и смотрим на самый светлый (сама бумага без нот)
    let best = 0;
    for (let y = Math.round(shot.height * 0.25); y < shot.height * 0.75; y += 1) {
      const value = gray[y * shot.width + Math.round(shot.width * fx)];
      if (value > best) best = value;
    }
    return best;
  };
  const beforeSpread = sample(shot.gray, 0.15) - sample(shot.gray, 0.85);
  const afterSpread = sample(flat, 0.15) - sample(flat, 0.85);
  assert.ok(beforeSpread > 40, `до выравнивания градиент заметный: ${Math.round(beforeSpread)}`);
  assert.ok(afterSpread < 20, `после выравнивания бумага почти ровная: ${Math.round(afterSpread)}`);
});

test('свет: маска бумаги не захватывает стол', () => {
  const shot = makeGradientShot();
  const prepared = paperMaskAdaptive(shot.gray, shot.width, shot.height);
  const share = prepared.count / (shot.width * shot.height);
  // Лист занимает около трети кадра: маска не должна раздуться до всего кадра
  assert.ok(share > 0.15 && share < 0.6, `доля маски ${(share * 100).toFixed(1)}%`);

  // В маске не должно быть пикселей стола: проверяем точки вне листа
  const outside = [
    [4, 4],
    [shot.width - 5, 4],
    [4, shot.height - 5],
    [shot.width - 5, shot.height - 5],
  ];
  for (const [x, y] of outside) {
    assert.equal(prepared.mask[y * shot.width + x], 0, `стол попал в маску в точке ${x},${y}`);
  }
});

test('свет: лист на градиентном фото находится целиком', () => {
  const shot = makeGradientShot();
  const quad = findPageQuad(shot.gray, shot.width, shot.height);
  assert.ok(quad, 'лист должен находиться даже при перепаде света');
  for (let i = 0; i < 4; i += 1) {
    const found = quad.corners[i];
    const expected = shot.corners[i];
    assert.ok(Math.hypot(found.x - expected.x, found.y - expected.y) < 8, `угол ${i}: ${Math.round(found.x)},${Math.round(found.y)} вместо ${Math.round(expected.x)},${Math.round(expected.y)}`);
  }
  assert.ok(quad.tiltDeg > 3, `наклон должен быть найден: ${quad.tiltDeg}`);
});

test('свет: конвейер отмечает выравнивание света и наклона', () => {
  const shot = makeGradientShot({ width: 300, height: 220 });
  const image = { data: null, width: shot.width, height: shot.height };
  const rgba = new Uint8ClampedArray(shot.width * shot.height * 4);
  for (let i = 0, p = 0; i < shot.gray.length; i += 1, p += 4) {
    rgba[p] = shot.gray[i];
    rgba[p + 1] = shot.gray[i];
    rgba[p + 2] = shot.gray[i];
    rgba[p + 3] = 255;
  }
  const result = preprocessImageData({ ...image, data: rgba }, { autoCrop: true, deskew: true, flatten: true, minWidth: 0 });
  assert.ok(result.stats.steps.some((step) => step.startsWith('наклон')), `шаги: ${result.stats.steps.join(', ')}`);
  assert.equal(result.stats.deskewed, true);
  assert.equal(result.stats.flattened, true);
  assert.ok(result.width > 100 && result.height > 60, `размер ${result.width}×${result.height}`);

  // Ноты после подготовки должны быть заметно темнее бумаги
  const stats = grayStats(grayFromRgba(result.data, result.width, result.height));
  assert.ok(stats.darkRatio > 0.0005, `тёмных пикселей (ноты): ${stats.darkRatio}`);
});

test('свет: после контраста свет выравнивается повторно (тень не превращается в полосу)', () => {
  const shot = makeGradientShot({ width: 320, height: 240 });
  const rgba = grayToRgba(shot.gray);
  const options = { autoCrop: true, deskew: true, flatten: true, minWidth: 0, contrast: true, edgeTrim: false };
  const without = preprocessImageData({ data: rgba, width: shot.width, height: shot.height }, { ...options, flattenAfterContrast: false });
  const withEven = preprocessImageData({ data: rgba, width: shot.width, height: shot.height }, { ...options, flattenAfterContrast: true });

  /**
   * Насколько тёмный правый край относительно середины: берём самый светлый пиксель
   * (это бумага без нот) в правой пятой части и в середине страницы.
   */
  const rightToCenter = (result) => {
    const gray = grayFromRgba(result.data, result.width, result.height);
    const brightest = (from, to) => {
      let best = 0;
      for (let y = 0; y < result.height; y += 1) {
        for (let x = from; x < to; x += 1) {
          const value = gray[y * result.width + x];
          if (value > best) best = value;
        }
      }
      return best;
    };
    const strip = Math.max(1, Math.round(result.width * 0.2));
    const right = brightest(result.width - strip, result.width);
    const center = brightest(Math.round(result.width * 0.4), Math.round(result.width * 0.6));
    return center ? right / center : 1;
  };

  const before = rightToCenter(without);
  const after = rightToCenter(withEven);
  assert.ok(before < 0.95, `без повторного выравнивания правый край темнее: ${before.toFixed(2)}`);
  assert.ok(after > before + 0.02, `повторное выравнивание должно осветлить край: ${before.toFixed(2)} → ${after.toFixed(2)}`);
  assert.ok(after > 0.88, `после выравнивания бумага по краю почти как в середине: ${before.toFixed(2)} → ${after.toFixed(2)}`);
  if (withEven.stats.flattenedAfterContrast) {
    assert.ok(
      withEven.stats.steps.some((step) => step.startsWith('свет выровнен после контраста')),
      `шаг не записан в отчёт: ${withEven.stats.steps.join(', ')}`,
    );
  }
});

test('фото: имитация делает наклонный лист на столе', () => {
  const page = { data: new Uint8ClampedArray(200 * 300 * 4).fill(255), width: 200, height: 300 };
  const photo = simulatePhoto(page, { photoWidth: 400, photoHeight: 300, scale: 0.7, tiltDeg: 5 });
  assert.equal(photo.width, 400);
  assert.equal(photo.height, 300);
  assert.equal(photo.data.length, 400 * 300 * 4);
  const gray = grayFromRgba(photo.data, photo.width, photo.height);
  const stats = grayStats(gray);
  assert.ok(stats.meanLuminance > 100 && stats.meanLuminance < 240, `средняя яркость ${Math.round(stats.meanLuminance)}`);
  assert.ok(stats.brightRatio > 0.2, 'лист должен быть светлым');

  // Углы листа внутри кадра и с наклоном
  const topEdge = Math.atan2(photo.quad[1].y - photo.quad[0].y, photo.quad[1].x - photo.quad[0].x);
  assert.ok(Math.abs((topEdge * 180) / Math.PI) > 3, 'верхняя кромка должна быть наклонена');
  for (const point of photo.quad) {
    assert.ok(point.x > 0 && point.x < 400 && point.y > 0 && point.y < 300, `угол вне кадра: ${point.x},${point.y}`);
  }

  // Один и тот же вход даёт одно и то же фото (стенд должен повторяться)
  const again = simulatePhoto(page, { photoWidth: 400, photoHeight: 300, scale: 0.7, tiltDeg: 5 });
  assert.deepEqual(Array.from(photo.data.slice(0, 400)), Array.from(again.data.slice(0, 400)));

  const presets = Object.values(PHOTO_PRESETS);
  assert.ok(presets.length >= 2, 'нужны разные по тяжести пресеты');
  for (const preset of presets) assert.ok(preset.tiltDeg > 0 && preset.title, 'у пресета есть название и наклон');
});