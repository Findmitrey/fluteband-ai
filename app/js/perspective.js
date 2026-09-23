// FluteBand AI — выравнивание страницы (шаг 3 дорожной карты, работа с реальным фото).
//
// Телефон почти никогда не смотрит на сборник строго сверху: лист получается трапецией,
// строки — наклонными. Движок распознавания ждёт ровную страницу, поэтому мы:
//   1) находим четыре угла листа на снимке;
//   2) считаем проективное преобразование (гомографию) в прямоугольник;
//   3) пересэмплируем картинку — строки становятся горизонтальными.
//
// Модуль без DOM и без canvas: только массивы яркостей, поэтому всё проверяется юнит-тестами.

import { otsuThreshold, percentileValue } from './image-stats.js';

/**
 * Карта уровня бумаги: для каждого участка кадра — насколько светла бумага именно здесь.
 * Нужна потому, что на фото с телефона свет неравномерный: правый край листа может быть темнее
 * левого стола, и любой общий порог «по всей картинке» отрежет часть страницы (проверено замером).
 *
 * Считаем не перцентиль блока «как есть» (в блоке со столом он равен столу — тогда стол
 * объявляется бумагой), а перцентиль только тех пикселей, что прошли «затравку»:
 * грубый порог Оцу или нижний перцентиль, то есть всё, что похоже на светлый фон.
 * Блоки без затравки берут уровень у соседей — так уровень бумаги «протягивается» на стол.
 */
export function paperLevelMap(gray, width, height, { blocks = 10, percentile = 88, seedMask = null, seedCut = null } = {}) {
  const cols = Math.max(2, Math.min(blocks, Math.ceil(width / 8)));
  const rows = Math.max(2, Math.min(blocks, Math.ceil(height / 8)));
  const blockWidth = width / cols;
  const blockHeight = height / rows;

  let seed = seedMask;
  let cut = seedCut;
  if (!seed && cut == null) {
    // Порог Оцу делит кадр на «светлый фон» и «всё остальное»: стол, тень, ноты.
    // Ниже порога не опускаемся: иначе затравка захватит стол, и он станет «бумагой».
    cut = otsuThreshold(gray);
  }

  const levels = new Float32Array(cols * rows).fill(-1);
  const hist = new Uint32Array(256);
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      hist.fill(0);
      let count = 0;
      const x0 = Math.floor(bx * blockWidth);
      const x1 = Math.min(width, Math.ceil((bx + 1) * blockWidth));
      const y0 = Math.floor(by * blockHeight);
      const y1 = Math.min(height, Math.ceil((by + 1) * blockHeight));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = y * width + x;
          // Сравнение строгое: порог Оцу — это последнее значение тёмного класса (например, стол),
          // поэтому сам порог ещё не бумага.
          if (seed ? !seed[i] : gray[i] <= cut) continue;
          hist[gray[i]] += 1;
          count += 1;
        }
      }
      if (count > 0) levels[by * cols + bx] = percentileValue(hist, count, percentile);
    }
  }

  // Пустые блоки (стол без бумаги) получают уровень соседей — иначе стол стал бы «бумагой»
  for (let pass = 0; pass < cols + rows; pass += 1) {
    let changed = 0;
    const snapshot = Float32Array.from(levels);
    for (let by = 0; by < rows; by += 1) {
      for (let bx = 0; bx < cols; bx += 1) {
        const index = by * cols + bx;
        if (snapshot[index] >= 0) continue;
        let sum = 0;
        let neighbours = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = bx + dx;
            const ny = by + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const value = snapshot[ny * cols + nx];
            if (value < 0) continue;
            sum += value;
            neighbours += 1;
          }
        }
        if (!neighbours) continue;
        levels[index] = sum / neighbours;
        changed += 1;
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < levels.length; i += 1) if (levels[i] < 0) levels[i] = 255;

  // Растягиваем уровни блоков на весь кадр (билинейно): получается гладкая карта освещения
  const map = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = y / blockHeight - 0.5;
    const y0 = Math.max(0, Math.min(rows - 1, Math.floor(gy)));
    const y1 = Math.max(0, Math.min(rows - 1, y0 + 1));
    const wy = Math.max(0, Math.min(1, gy - y0));
    for (let x = 0; x < width; x += 1) {
      const gx = x / blockWidth - 0.5;
      const x0 = Math.max(0, Math.min(cols - 1, Math.floor(gx)));
      const x1 = Math.max(0, Math.min(cols - 1, x0 + 1));
      const wx = Math.max(0, Math.min(1, gx - x0));
      const top = levels[y0 * cols + x0] * (1 - wx) + levels[y0 * cols + x1] * wx;
      const bottom = levels[y1 * cols + x0] * (1 - wx) + levels[y1 * cols + x1] * wx;
      map[y * width + x] = Math.max(1, top * (1 - wy) + bottom * wy);
    }
  }
  return { map, cols, rows, blockWidth, blockHeight, seedCut: cut };
}

/**
 * Маска бумаги с учётом неравномерного света: пиксель считается бумагой,
 * если он светлее местного уровня бумаги на заданную долю.
 * Второй проход уточняет уровень уже по найденной маске — так в маску попадает
 * затенённая часть листа, которая не прошла грубую затравку.
 */
export function paperMaskAdaptive(gray, width, height, { ratio = 0.8, map = null, refine = true } = {}) {
  let level = map || paperLevelMap(gray, width, height).map;
  const build = () => {
    const mask = new Uint8Array(width * height);
    let count = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (gray[i] >= level[i] * ratio) {
        mask[i] = 1;
        count += 1;
      }
    }
    return { mask, count, map: level };
  };
  let result = build();
  if (refine) {
    level = paperLevelMap(gray, width, height, { seedMask: result.mask }).map;
    result = build();
  }
  return result;
}

/**
 * Выровнять освещение: делим каждый пиксель на местный уровень бумаги.
 * После этого бумага одинаковая по всей странице, тени и градиент исчезают —
 * дальше работают обычные пороги (контраст по перцентилям и порог Оцу для нот).
 */
export function normalizeByPaperLevel(gray, width, height, level, { target = 235, maxGain = 2.6, minGain = 0.5 } = {}) {
  const map = level?.map || level;
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < out.length; i += 1) {
    const local = Math.max(24, map ? map[i] : 255);
    const gain = Math.max(minGain, Math.min(maxGain, target / local));
    out[i] = gray[i] * gain;
  }
  return out;
}

/** Найти четыре угла выпуклой фигуры (листа) среди точек маски. */
export function extremeCorners(mask, width, height) {
  let topLeft = null;
  let topRight = null;
  let bottomRight = null;
  let bottomLeft = null;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        topLeft = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        bottomRight = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        topRight = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bottomLeft = { x, y };
      }
    }
  }
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/** Упорядочить углы: левый верхний, правый верхний, правый нижний, левый нижний. */
export function orderCorners(points) {
  if (!points || points.length !== 4) return null;
  const cx = points.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // atan2 даёт порядок по кругу начиная с направления «вправо-вниз»; прокручиваем к верхнему левому
  let startIndex = 0;
  let bestSum = Infinity;
  sorted.forEach((p, index) => {
    const sum = p.x + p.y;
    if (sum < bestSum) {
      bestSum = sum;
      startIndex = index;
    }
  });
  const rotated = [...sorted.slice(startIndex), ...sorted.slice(0, startIndex)];
  // при обходе по часовой стрелке вторым должен идти верхний правый
  if (rotated[1].x < rotated[3].x) return [rotated[0], rotated[3], rotated[2], rotated[1]];
  return rotated;
}

/** Расстояние между точками. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Площадь четырёхугольника (формула шнуровки). */
export function quadArea(corners) {
  if (!corners) return 0;
  let sum = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Наклон верхней кромки листа в градусах (0 — страница стоит ровно). */
export function tiltDegrees(corners) {
  if (!corners) return 0;
  const [tl, tr] = corners;
  const angle = (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI;
  return Math.abs(angle) > 90 ? Math.abs(180 - Math.abs(angle)) : Math.abs(angle);
}

/** Маска бумаги: светлые пиксели (лист) против стола и тени. */
export function paperMask(gray, width, height, { level = null, percentile = 70 } = {}) {
  let cut = level;
  if (cut == null) {
    const hist = new (Uint32Array)(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    const target = (gray.length * percentile) / 100;
    let seen = 0;
    cut = 255;
    for (let v = 0; v < 256; v += 1) {
      seen += hist[v];
      if (seen >= target) {
        cut = v;
        break;
      }
    }
  }
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (gray[i] >= cut) {
      mask[i] = 1;
      count += 1;
    }
  }
  return { mask, count, level: cut };
}

/**
 * Найти лист как четырёхугольник. Возвращает углы и проверки качества,
 * либо null, если лист не найден или найденная фигура не похожа на страницу.
 */
export function findPageQuad(gray, width, height, {
  minAreaShare = 0.12,
  maxAreaShare = 0.98,
  minCoverage = 0.6,
  maxCoverage = 1.6,
  minSideShare = 0.2,
  mask = null,
  adaptive = true,
} = {}) {
  let prepared;
  if (mask && !(mask instanceof Uint8Array)) prepared = mask;
  else if (mask) prepared = { mask, count: mask.reduce((sum, v) => sum + (v ? 1 : 0), 0), level: null };
  else if (adaptive) prepared = paperMaskAdaptive(gray, width, height);
  else prepared = paperMask(gray, width, height);
  const { mask: paper, count } = prepared;
  const share = count / (width * height);
  if (share < 0.05 || share > maxAreaShare) return null;

  const raw = extremeCorners(paper, width, height);
  if (!raw) return null;
  const corners = orderCorners(raw);
  const area = quadArea(corners);
  if (area < width * height * minAreaShare) return null;

  // Для выпуклого листа площадь четырёхугольника примерно равна площади маски
  const coverage = area / Math.max(1, count);
  if (coverage < minCoverage || coverage > maxCoverage) return null;

  const sides = [
    distance(corners[0], corners[1]),
    distance(corners[1], corners[2]),
    distance(corners[2], corners[3]),
    distance(corners[3], corners[0]),
  ];
  const minSide = Math.min(...sides);
  if (minSide < Math.min(width, height) * minSideShare) return null;

  return {
    corners,
    area,
    coverage: Number(coverage.toFixed(3)),
    paperShare: Number(share.toFixed(3)),
    level: prepared.level ?? null,
    tiltDeg: Number(tiltDegrees(corners).toFixed(2)),
    sides,
  };
}

/** Решить систему линейных уравнений A·x = b методом Гаусса с выбором главного элемента. */
export function solveLinearSystem(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / m[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}

/**
 * Гомография: перевод четырёх точек источника в четыре точки назначения.
 * Возвращает матрицу 3×3 (строки), либо null, если преобразование вырождено.
 */
export function computeHomography(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinearSystem(A, b);
  if (!h) return null;
  if (h.some((value) => !Number.isFinite(value))) return null;
  return [h.slice(0, 3), h.slice(3, 6), [h[6], h[7], 1]];
}

/** Применить гомографию к точке. */
export function applyHomography(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return { x: NaN, y: NaN };
  return {
    x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
    y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w,
  };
}

/**
 * Пересэмплировать лист в прямоугольник: для каждого пикселя результата ищем точку на снимке.
 * Билинейная интерполяция, координаты вне снимка зажимаются к краю.
 */
export function warpQuad(gray, width, height, corners, { outWidth, outHeight } = {}) {
  const area = quadArea(corners);
  if (!corners || !area) return null;
  const topLen = distance(corners[0], corners[1]);
  const bottomLen = distance(corners[3], corners[2]);
  const leftLen = distance(corners[0], corners[3]);
  const rightLen = distance(corners[1], corners[2]);
  const dstWidth = Math.max(1, Math.round(outWidth || Math.max(topLen, bottomLen)));
  const dstHeight = Math.max(1, Math.round(outHeight || Math.max(leftLen, rightLen)));

  const dstCorners = [
    { x: 0, y: 0 },
    { x: dstWidth - 1, y: 0 },
    { x: dstWidth - 1, y: dstHeight - 1 },
    { x: 0, y: dstHeight - 1 },
  ];
  const H = computeHomography(dstCorners, corners); // из результата в исходный снимок
  if (!H) return null;

  const out = new Uint8ClampedArray(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y += 1) {
    for (let x = 0; x < dstWidth; x += 1) {
      const point = applyHomography(H, x, y);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        out[y * dstWidth + x] = 255;
        continue;
      }
      const sx = Math.min(width - 1, Math.max(0, point.x));
      const sy = Math.min(height - 1, Math.max(0, point.y));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const wx = sx - x0;
      const wy = sy - y0;
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx;
      const bottom = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx;
      out[y * dstWidth + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return { gray: out, width: dstWidth, height: dstHeight };
}

/**
 * Выровнять страницу, если она снята под углом.
 * `minTiltDeg` — насколько сильным должен быть наклон, чтобы вообще что-то делать:
 * ровные снимки не трогаем, чтобы не портить их лишним пересэмплированием.
 */
export function perspectiveCorrect(gray, width, height, {
  minTiltDeg = 1.2,
  maxSide = 3000,
  minAreaShare = 0.12,
  mask = null,
  adaptive = true,
} = {}) {
  const quad = findPageQuad(gray, width, height, { minAreaShare, mask, adaptive });
  if (!quad) return { applied: false, reason: 'лист не найден', gray, width, height };

  const topLen = distance(quad.corners[0], quad.corners[1]);
  const bottomLen = distance(quad.corners[3], quad.corners[2]);
  const leftLen = distance(quad.corners[0], quad.corners[3]);
  const rightLen = distance(quad.corners[1], quad.corners[2]);
  // «Растянутость» сторон: у трапеции противоположные стороны сильно разной длины
  const stretch = Math.max(
    Math.abs(topLen - bottomLen) / Math.max(topLen, bottomLen),
    Math.abs(leftLen - rightLen) / Math.max(leftLen, rightLen),
  );
  if (quad.tiltDeg < minTiltDeg && stretch < 0.03) {
    return { applied: false, reason: 'страница уже ровная', gray, width, height, quad };
  }

  let outWidth = Math.max(topLen, bottomLen);
  let outHeight = Math.max(leftLen, rightLen);
  const scale = Math.min(1, maxSide / Math.max(outWidth, outHeight));
  outWidth = Math.round(outWidth * scale);
  outHeight = Math.round(outHeight * scale);

  const warped = warpQuad(gray, width, height, quad.corners, { outWidth, outHeight });
  if (!warped) return { applied: false, reason: 'выравнивание не удалось', gray, width, height, quad };
  return {
    applied: true,
    gray: warped.gray,
    width: warped.width,
    height: warped.height,
    quad,
    tiltDeg: quad.tiltDeg,
    stretch: Number(stretch.toFixed(3)),
  };
}