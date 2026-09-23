// FluteBand AI — тесты выравнивания страницы (наклон снимка сборника).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHomography,
  computeHomography,
  distance,
  extremeCorners,
  findPageQuad,
  orderCorners,
  paperMask,
  perspectiveCorrect,
  quadArea,
  solveLinearSystem,
  tiltDegrees,
  warpQuad,
} from '../app/js/perspective.js';

/** Собрать «снимок»: тёмный стол, светлый лист заданным четырёхугольником, чёрная линия-ноты */
function makeShot({ width = 320, height = 260, corners = null, table = 110, paper = 215 } = {}) {
  const gray = new Uint8ClampedArray(width * height).fill(table);
  const quad = corners || [
    { x: 60, y: 40 },
    { x: 260, y: 40 },
    { x: 260, y: 210 },
    { x: 60, y: 210 },
  ];

  // Заливка листа: точка внутри четырёхугольника, если она с одной стороны от всех рёбер
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (Math.abs(cross) < 1e-9) continue;
      const current = cross > 0 ? 1 : -1;
      if (sign === 0) sign = current;
      else if (sign !== current) return false;
    }
    return true;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (inside(x, y)) gray[y * width + x] = paper;
  }

  // Линия нот: горизонтальная в координатах листа (интерполируем по верхней и нижней кромке)
  const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let t = 0.15; t <= 0.85; t += 0.002) {
    const top = mix(quad[0], quad[1], (t - 0.15) / 0.7);
    const bottom = mix(quad[3], quad[2], (t - 0.15) / 0.7);
    const point = mix(top, bottom, 0.5);
    const px = Math.round(point.x);
    const py = Math.round(point.y);
    for (let dy = -1; dy <= 1; dy += 1) {
      const yy = py + dy;
      if (yy >= 0 && yy < height && px >= 0 && px < width) gray[yy * width + px] = 30;
    }
  }
  return { gray, width, height, quad };
}

test('выравнивание: гомография переводит углы точно', () => {
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const dst = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const H = computeHomography(src, dst);
  assert.ok(H, 'гомография должна считаться');
  for (let i = 0; i < 4; i += 1) {
    const mapped = applyHomography(H, src[i].x, src[i].y);
    assert.ok(Math.abs(mapped.x - dst[i].x) < 1e-6, `x: ${mapped.x} вместо ${dst[i].x}`);
    assert.ok(Math.abs(mapped.y - dst[i].y) < 1e-6, `y: ${mapped.y} вместо ${dst[i].y}`);
  }
});

test('выравнивание: гомография справляется с трапецией и работает как единица', () => {
  const identity = computeHomography(
    [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 9 }, { x: 1, y: 9 }],
    [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 9 }, { x: 1, y: 9 }],
  );
  const point = applyHomography(identity, 3, 4);
  assert.ok(Math.abs(point.x - 3) < 1e-9 && Math.abs(point.y - 4) < 1e-9, 'единичное преобразование сдвигает точку');

  const src = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 90, y: 200 }, { x: 10, y: 190 }];
  const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
  const H = computeHomography(src, dst);
  for (let i = 0; i < 4; i += 1) {
    const mapped = applyHomography(H, src[i].x, src[i].y);
    assert.ok(distance(mapped, dst[i]) < 1e-6, `угол ${i} не совпал`);
  }
  assert.equal(computeHomography(null, dst), null);
  assert.equal(solveLinearSystem([[0, 0], [0, 0]], [1, 1]), null, 'вырожденная система должна вернуть null');
});

test('выравнивание: углы страницы находятся и упорядочиваются', () => {
  const shot = makeShot();
  const { mask } = paperMask(shot.gray, shot.width, shot.height);
  const raw = extremeCorners(mask, shot.width, shot.height);
  assert.equal(raw.length, 4);
  const corners = orderCorners(raw);
  // Ожидаем порядок: левый верх, правый верх, правый низ, левый низ
  assert.ok(corners[0].x < corners[1].x, 'первый угол должен быть левым верхним');
  assert.ok(corners[0].y < corners[3].y, 'левый верх выше левого низа');
  assert.ok(corners[2].x > corners[3].x, 'правый низ правее левого низа');
  for (let i = 0; i < 4; i += 1) {
    assert.ok(distance(corners[i], shot.quad[i]) < 2, `угол ${i} найден неточно: ${JSON.stringify(corners[i])}`);
  }

  const quad = findPageQuad(shot.gray, shot.width, shot.height);
  assert.ok(quad, 'лист должен находиться');
  assert.ok(quad.coverage > 0.9 && quad.coverage < 1.1, `покрытие ${quad.coverage}`);
  assert.ok(quad.tiltDeg < 1, `ровный лист не должен считаться наклонным: ${quad.tiltDeg}`);
  assert.ok(quadArea(corners) > 30000, 'площадь листа посчитана');
});

test('выравнивание: наклонный лист определяется по наклону кромки', () => {
  const corners = [
    { x: 50, y: 60 },
    { x: 270, y: 30 }, // верхняя кромка поднята — наклон
    { x: 280, y: 220 },
    { x: 60, y: 240 },
  ];
  const shot = makeShot({ corners });
  const quad = findPageQuad(shot.gray, shot.width, shot.height);
  assert.ok(quad, 'наклонный лист тоже должен находиться');
  const expected = (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180) / Math.PI;
  assert.ok(Math.abs(quad.tiltDeg - Math.abs(expected)) < 1.5, `наклон ${quad.tiltDeg} вместо ${Math.abs(expected).toFixed(1)}`);
  assert.ok(tiltDegrees(corners) > 5, 'наклон должен быть заметным');
});

test('выравнивание: после коррекции строки становятся горизонтальными', () => {
  const corners = [
    { x: 70, y: 80 },
    { x: 280, y: 40 },
    { x: 265, y: 225 },
    { x: 55, y: 245 },
  ];
  const shot = makeShot({ corners, width: 340, height: 300 });
  const flat = makeShot({ corners: null, width: 340, height: 300 });

  const before = findPageQuad(shot.gray, shot.width, shot.height);
  assert.ok(before.tiltDeg > 5, `наклон должен быть заметным: ${before.tiltDeg}`);

  const fixed = perspectiveCorrect(shot.gray, shot.width, shot.height);
  assert.equal(fixed.applied, true, 'выравнивание должно примениться');
  assert.ok(fixed.width > 100 && fixed.height > 100, `размер страницы: ${fixed.width}×${fixed.height}`);

  // Ищем самую тёмную строку в каждой колонке: у ровной страницы она одна и та же по всей ширине
  const darkRow = (image) => {
    const rows = [];
    for (let x = Math.round(image.width * 0.2); x < image.width * 0.8; x += Math.max(1, Math.round(image.width / 20))) {
      let bestRow = -1;
      let bestValue = 255;
      for (let y = 0; y < image.height; y += 1) {
        const value = image.gray[y * image.width + x];
        if (value < bestValue) {
          bestValue = value;
          bestRow = y;
        }
      }
      rows.push(bestRow);
    }
    const mean = rows.reduce((sum, value) => sum + value, 0) / rows.length;
    const spread = Math.max(...rows) - Math.min(...rows);
    return { mean, spread };
  };

  const beforeRows = darkRow(shot);
  assert.ok(beforeRows.spread > 20, `до выравнивания строка должна быть наклонной, разброс ${beforeRows.spread}`);
  const afterRows = darkRow(fixed);
  assert.ok(afterRows.spread <= 4, `после выравнивания строка должна быть горизонтальной, разброс ${afterRows.spread}`);

  // Ровную страницу не трогаем
  const untouched = perspectiveCorrect(flat.gray, flat.width, flat.height);
  assert.equal(untouched.applied, false, 'ровный снимок пересэмплировать не нужно');
  assert.equal(untouched.reason, 'страница уже ровная');
});

test('выравнивание: без листа в кадре коррекция не выдумывается', () => {
  const width = 200;
  const height = 150;
  const noise = new Uint8ClampedArray(width * height);
  for (let i = 0; i < noise.length; i += 1) noise[i] = 40 + ((i * 37) % 30);
  const mask = paperMask(noise, width, height);
  assert.ok(mask.count > 0 && mask.count < noise.length, 'часть шумовых пикселей попадёт в маску');
  assert.equal(findPageQuad(noise, width, height), null, 'разбросанный шум — не страница');
  const dark = new Uint8ClampedArray(width * height).fill(60);
  assert.equal(findPageQuad(dark, width, height), null, 'на тёмном кадре листа нет');

  const white = new Uint8ClampedArray(width * height).fill(240);
  assert.equal(findPageQuad(white, width, height), null, 'если бумага занимает весь кадр, углов не ищем');

  const result = perspectiveCorrect(dark, width, height);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'лист не найден');
});

test('выравнивание: пересэмплирование сохраняет размер и не портит ровный лист', () => {
  const shot = makeShot();
  const warped = warpQuad(shot.gray, shot.width, shot.height, shot.quad, { outWidth: 100, outHeight: 80 });
  assert.equal(warped.width, 100);
  assert.equal(warped.height, 80);
  assert.equal(warped.gray.length, 8000);
  // Углы листа становятся углами результата: светлая бумага по краям
  assert.ok(warped.gray[0] > 200, 'левый верх должен быть бумагой');
  assert.ok(warped.gray[99] > 200, 'правый верх должен быть бумагой');
  const middle = warped.gray[Math.floor(80 / 2) * 100 + 50];
  assert.ok(middle < 200, 'в середине должна быть линия нот');
  assert.equal(warpQuad(shot.gray, shot.width, shot.height, null), null);
});