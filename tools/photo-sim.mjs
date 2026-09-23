// FluteBand AI — имитация фотографии сборника: стол, наклон, неравномерный свет, шум.
//
// Зачем: точность подготовки снимка нельзя честно измерить на ровных синтетических страницах
// (см. docs/omr-prep.md — там предобработке просто нечего исправлять). Этот модуль делает из ровной
// страницы «фото с телефона», чтобы мерить распознавание в условиях, близких к реальным.
//
// Модуль детерминированный (один и тот же вход → один и тот же выход), поэтому стенд воспроизводим.

import { applyHomography, computeHomography } from '../app/js/perspective.js';

/** Насколько «тяжёлое» фото имитируем */
export const PHOTO_PRESETS = {
  tilt: {
    title: 'наклон 5° и свет сбоку',
    photoWidth: 1200,
    photoHeight: 900,
    scale: 0.78,
    tiltDeg: 5,
    squeeze: 0.06,
    light: 0.3,
    shadow: 0.18,
    blur: 1,
    noise: 5,
  },
  hard: {
    title: 'наклон 9°, тень и размытие',
    photoWidth: 1200,
    photoHeight: 900,
    scale: 0.86,
    tiltDeg: 9,
    squeeze: 0.13,
    light: 0.4,
    shadow: 0.3,
    blur: 1,
    noise: 9,
  },
};

/** Простой детерминированный генератор — чтобы стенд повторялся от запуска к запуску */
function makeRandom(seed = 1) {
  let state = (seed * 2654435761) % 4294967296;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Гладкий «стол»: редкая сетка случайных значений, растянутая билинейно */
function makeTable(width, height, { base = [92, 78, 66], variance = 14, cell = 26, seed = 7 } = {}) {
  const random = makeRandom(seed);
  const cols = Math.ceil(width / cell) + 2;
  const rows = Math.ceil(height / cell) + 2;
  const grid = new Float32Array(cols * rows);
  for (let i = 0; i < grid.length; i += 1) grid[i] = (random() - 0.5) * 2 * variance;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const gy = y / cell;
    const y0 = Math.floor(gy);
    const wy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = x / cell;
      const x0 = Math.floor(gx);
      const wx = gx - x0;
      const top = grid[y0 * cols + x0] * (1 - wx) + grid[y0 * cols + x0 + 1] * wx;
      const bottom = grid[(y0 + 1) * cols + x0] * (1 - wx) + grid[(y0 + 1) * cols + x0 + 1] * wx;
      const texture = top * (1 - wy) + bottom * wy;
      const p = (y * width + x) * 4;
      data[p] = base[0] + texture;
      data[p + 1] = base[1] + texture * 0.9;
      data[p + 2] = base[2] + texture * 0.8;
      data[p + 3] = 255;
    }
  }
  return data;
}

/** Четыре угла листа в кадре: масштаб, перспективное сжатие дальней кромки и поворот */
export function pageQuadInPhoto({
  photoWidth,
  photoHeight,
  pageWidth,
  pageHeight,
  scale = 0.8,
  tiltDeg = 0,
  squeeze = 0,
  offsetX = 0,
  offsetY = 0,
} = {}) {
  const targetHeightByScale = photoHeight * scale;
  const aspect = pageWidth / pageHeight;
  // Широкие страницы (например, разворот) могут не влезть по ширине — тогда уменьшаем по ширине кадра
  const maxWidth = photoWidth * 0.94;
  const targetHeight = Math.min(targetHeightByScale, maxWidth / aspect);
  const targetWidth = targetHeight * aspect;
  const halfWidth = targetWidth / 2;
  const halfHeight = targetHeight / 2;
  const rad = (tiltDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const corners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ];
  // Дальняя (верхняя) кромка короче — так выглядит лист, снятый не строго сверху
  corners[0].x *= 1 - squeeze;
  corners[1].x *= 1 - squeeze;

  return corners.map((point) => ({
    x: photoWidth / 2 + offsetX + point.x * cos - point.y * sin,
    y: photoHeight / 2 + offsetY + point.x * sin + point.y * cos,
  }));
}

/**
 * Сделать «фото» из ровной страницы.
 * page: {data, width, height} в RGBA (как ImageData). Возвращает такое же фото + углы листа.
 */
export function simulatePhoto(page, options = {}) {
  const preset = { ...PHOTO_PRESETS.tilt, ...options };
  const {
    photoWidth,
    photoHeight,
    scale,
    tiltDeg,
    squeeze,
    light,
    shadow,
    blur,
    noise,
    seed = 3,
    tableBase,
  } = preset;

  const data = makeTable(photoWidth, photoHeight, tableBase ? { base: tableBase } : {});
  const quad = pageQuadInPhoto({
    photoWidth,
    photoHeight,
    pageWidth: page.width,
    pageHeight: page.height,
    scale,
    tiltDeg,
    squeeze,
  });

  const pageCorners = [
    { x: 0, y: 0 },
    { x: page.width - 1, y: 0 },
    { x: page.width - 1, y: page.height - 1 },
    { x: 0, y: page.height - 1 },
  ];
  const H = computeHomography(quad, pageCorners); // из кадра в координаты страницы
  if (!H) throw new Error('Не удалось построить имитацию фото');

  const random = makeRandom(seed + 11);
  const noiseMap = new Float32Array(photoWidth * photoHeight);
  for (let i = 0; i < noiseMap.length; i += 1) noiseMap[i] = (random() - 0.5) * 2 * noise;

  for (let y = 0; y < photoHeight; y += 1) {
    for (let x = 0; x < photoWidth; x += 1) {
      const point = applyHomography(H, x, y);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (point.x < 0 || point.y < 0 || point.x > page.width - 1 || point.y > page.height - 1) continue;

      const x0 = Math.floor(point.x);
      const y0 = Math.floor(point.y);
      const x1 = Math.min(page.width - 1, x0 + 1);
      const y1 = Math.min(page.height - 1, y0 + 1);
      const wx = point.x - x0;
      const wy = point.y - y0;

      const p = (y * photoWidth + x) * 4;
      const sample = (channel) => {
        const a = page.data[(y0 * page.width + x0) * 4 + channel];
        const b = page.data[(y0 * page.width + x1) * 4 + channel];
        const c = page.data[(y1 * page.width + x0) * 4 + channel];
        const d = page.data[(y1 * page.width + x1) * 4 + channel];
        return (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      };
      data[p] = sample(0);
      data[p + 1] = sample(1);
      data[p + 2] = sample(2);
      data[p + 3] = 255;
    }
  }

  // Неравномерный свет: слева ярче, к правому нижнему углу темнее; плюс мягкая тень по краю кадра
  for (let y = 0; y < photoHeight; y += 1) {
    for (let x = 0; x < photoWidth; x += 1) {
      const nx = x / photoWidth;
      const ny = y / photoHeight;
      const vignette = 1 - shadow * Math.max(0, Math.hypot(nx - 0.42, ny - 0.38) - 0.35);
      const factor = Math.max(0.45, (1.06 - light * nx * 0.55 - shadow * ny * 0.5) * vignette);
      const p = (y * photoWidth + x) * 4;
      data[p] = data[p] * factor + noiseMap[y * photoWidth + x];
      data[p + 1] = data[p + 1] * factor + noiseMap[y * photoWidth + x];
      data[p + 2] = data[p + 2] * factor + noiseMap[y * photoWidth + x];
    }
  }

  if (blur > 0) boxBlurInPlace(data, photoWidth, photoHeight, blur);

  return {
    data,
    width: photoWidth,
    height: photoHeight,
    quad,
    preset: { scale, tiltDeg, squeeze, light, shadow, blur, noise },
  };
}

/** Простое размытие «ящиком» (имитация оптики телефона) */
export function boxBlurInPlace(data, width, height, radius = 1) {
  if (radius < 1) return data;
  const copy = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const p = (yy * width + xx) * 4;
          r += copy[p];
          g += copy[p + 1];
          b += copy[p + 2];
          count += 1;
        }
      }
      const p = (y * width + x) * 4;
      data[p] = r / count;
      data[p + 1] = g / count;
      data[p + 2] = b / count;
    }
  }
  return data;
}