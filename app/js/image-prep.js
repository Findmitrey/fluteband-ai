// FluteBand AI — предобработка снимка страницы перед распознаванием (шаг 3 дорожной карты).
//
// Модуль работает с «сырыми» пикселями (те же данные, что в ImageData браузера) и не зависит от DOM:
// поэтому его можно проверять юнит-тестами в Node и использовать в браузере без изменений.
//
// Что делаем со снимком телефона, прежде чем отдать его движку распознавания:
//   1) переводим в оттенки серого (движки всё равно работают с яркостью);
//   2) выравниваем наклон страницы (perspective.js) — строки становятся горизонтальными;
//   3) обрезаем поля вокруг страницы (в кадре почти всегда стол, тень, край сборника);
//   4) растягиваем контраст по перцентилям — убираем серый фон и бледную печать;
//   5) при необходимости увеличиваем страницу, если штрихи слишком мелкие для движка;
//   6) при необходимости бинаризуем (порог Оцу) — по умолчанию выключено, помогает не всегда.

import {
  normalizeByPaperLevel,
  paperLevelMap,
  paperMaskAdaptive,
  perspectiveCorrect,
} from './perspective.js';
import {
  binarize,
  contrastBounds,
  histogram,
  otsuThreshold,
  percentileValue,
  stretchContrast,
} from './image-stats.js';

/** Яркость пикселя по стандартным весам (как в imageStats). */
export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** RGBA → массив яркостей (0..255). */
export function grayFromRgba(data, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = luminance(data[p], data[p + 1], data[p + 2]);
  }
  return gray;
}

// Статистика по яркостям живёт в image-stats.js: её использует и выравнивание страницы.
// Здесь оставляем привычные имена (их импортируют тесты, приложение и стенды).
export { binarize, contrastBounds, histogram, otsuThreshold, percentileValue, stretchContrast };

/**
 * Границы светлого листа (бумаги) — первый шаг обрезки для фото сборника на столе.
 * Ищем не тёмные ноты, а саму бумагу: стол, тень и фон вокруг листа обычно темнее.
 *
 * Порог берём не общий по кадру, а местный (карта уровня бумаги): на фото с телефона
 * правый край листа бывает темнее левого стола, и общий порог отрезал бы часть страницы.
 * Проверка на имитации фото: docs/omr-photo.md.
 */
export function pageBounds(gray, width, height, { adaptive = true, ratio = 0.82, percentile = 75, minShare = 0.08, maxShare = 0.985 } = {}) {
  let mask;
  let paper = 0;
  if (adaptive) {
    const prepared = paperMaskAdaptive(gray, width, height, { ratio });
    mask = prepared.mask;
    paper = prepared.count;
  } else {
    const hist = histogram(gray);
    const paperLevel = percentileValue(hist, gray.length, percentile);
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i += 1) {
      if (gray[i] >= paperLevel) {
        mask[i] = 1;
        paper += 1;
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const share = paper / (width * height);
  if (maxX < 0 || share < minShare || share > maxShare) return null;

  // Если бумага доходит до всех четырёх краёв кадра, обрезать нечего:
  // страница и так занимает весь снимок (типичный случай скана или ровного фото).
  const strip = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const touches = { left: false, right: false, top: false, bottom: false };
  for (let y = 0; y < height && !(touches.left && touches.right); y += 1) {
    for (let x = 0; x < strip; x += 1) {
      if (mask[y * width + x]) touches.left = true;
      if (mask[y * width + (width - 1 - x)]) touches.right = true;
    }
  }
  for (let x = 0; x < width && !(touches.top && touches.bottom); x += 1) {
    for (let y = 0; y < strip; y += 1) {
      if (mask[y * width + x]) touches.top = true;
      if (mask[(height - 1 - y) * width + x]) touches.bottom = true;
    }
  }
  if (touches.left && touches.right && touches.top && touches.bottom) return null;

  const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  // Если «лист» занимает почти весь кадр, обрезать нечего
  if (box.width > width * maxShare && box.height > height * maxShare) return null;
  return box;
}

/**
 * Границы нот внутри листа (тёмное на светлом) — второй шаг обрезки: убираем пустые поля бумаги.
 * Возвращает {x, y, width, height} или null, если содержимое занимает почти весь лист.
 */
export function inkBounds(gray, width, height, { threshold = null, marginPercent = 1.5, minInkRatio = 0.0005, maxShare = 0.97 } = {}) {
  const cut = threshold ?? otsuThreshold(gray);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let ink = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] > cut) continue;
      ink += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || ink / (width * height) < minInkRatio) return null;
  const marginX = Math.max(4, Math.round(width * (marginPercent / 100)));
  const marginY = Math.max(4, Math.round(height * (marginPercent / 100)));
  const x = Math.max(0, minX - marginX);
  const y = Math.max(0, minY - marginY);
  const right = Math.min(width - 1, maxX + marginX);
  const bottom = Math.min(height - 1, maxY + marginY);
  const box = { x, y, width: right - x + 1, height: bottom - y + 1 };
  if (box.width > width * maxShare && box.height > height * maxShare) return null;
  return box;
}

/** Совместимость: границы содержимого (нот) — используется подсказками в интерфейсе. */
export function contentBounds(gray, width, height, options = {}) {
  return inkBounds(gray, width, height, options);
}

/**
 * Тёмная кромка по краям выпрямленной страницы (шаг 3а): после выравнивания наклона у самых
 * краёв остаётся полоса тени и границы листа. На распознавание она почти не влияет, но в кадре
 * выглядит некрасиво, а при обрезке полей мешает порогам.
 *
 * Ищем её именно как **непрерывную полосу от края**: пока средняя яркость строки (или столбца)
 * заметно ниже уровня бумаги — это кромка. Как только встретили нормальную строку, останавливаемся,
 * поэтому нотная строка или заголовок у края под нож не попадают. Сверху есть жёсткий предел
 * (доля стороны), чтобы ошибка не отрезала часть страницы.
 *
 * Возвращает {x, y, width, height} или null, если срезать нечего.
 */
export function edgeTrimBounds(gray, width, height, { maxPercent = 0.035, ratio = 0.75, innerPercent = 0.15 } = {}) {
  if (width < 32 || height < 32) return null;
  const maxX = Math.max(1, Math.round(width * maxPercent));
  const maxY = Math.max(1, Math.round(height * maxPercent));

  // Уровень бумаги считаем по внутренней части страницы: края для этого как раз и не годятся
  const insetX = Math.max(1, Math.round(width * innerPercent));
  const insetY = Math.max(1, Math.round(height * innerPercent));
  const innerHist = new Uint32Array(256);
  let innerCount = 0;
  for (let y = insetY; y < height - insetY; y += 1) {
    const row = y * width;
    for (let x = insetX; x < width - insetX; x += 1) {
      innerHist[gray[row + x]] += 1;
      innerCount += 1;
    }
  }
  if (innerCount < 256) return null;
  const paperLevel = percentileValue(innerHist, innerCount, 60);
  const limit = paperLevel * ratio;

  const lineMean = (side, index) => {
    let sum = 0;
    let count = 0;
    if (side === 'top' || side === 'bottom') {
      const row = (side === 'top' ? index : height - 1 - index) * width;
      for (let x = 0; x < width; x += 1) {
        sum += gray[row + x];
        count += 1;
      }
    } else {
      const column = side === 'left' ? index : width - 1 - index;
      for (let y = 0; y < height; y += 1) {
        sum += gray[y * width + column];
        count += 1;
      }
    }
    return sum / count;
  };

  const stripSize = (side, limitPercent) => {
    let cut = 0;
    while (cut < limitPercent && lineMean(side, cut) < limit) cut += 1;
    return cut;
  };

  const left = stripSize('left', maxX);
  const right = stripSize('right', maxX);
  const top = stripSize('top', maxY);
  const bottom = stripSize('bottom', maxY);
  if (!left && !right && !top && !bottom) return null;

  const box = { x: left, y: top, width: width - left - right, height: height - top - bottom };
  // Страховка: кромка не может занимать половину страницы — значит, порог сработал не на тени
  if (box.width < width * 0.6 || box.height < height * 0.6) return null;
  return box;
}

/** Свести два прямоугольника: внешний (лист) и внутренний (ноты). */
export function combineBoxes(outer, inner) {
  if (!outer) return inner || null;
  if (!inner) return outer;
  return {
    x: outer.x + inner.x,
    y: outer.y + inner.y,
    width: inner.width,
    height: inner.height,
  };
}

/** Вырезать прямоугольник из массива яркостей. */
export function cropGray(gray, width, height, box) {
  const out = new Uint8ClampedArray(box.width * box.height);
  for (let y = 0; y < box.height; y += 1) {
    const srcStart = (box.y + y) * width + box.x;
    out.set(gray.subarray(srcStart, srcStart + box.width), y * box.width);
  }
  return { gray: out, width: box.width, height: box.height };
}

/** Изменить размер массива яркостей (билинейная интерполяция). */
export function resizeGray(gray, width, height, newWidth, newHeight) {
  if (newWidth === width && newHeight === height) return gray;
  const out = new Uint8ClampedArray(newWidth * newHeight);
  const xRatio = width / newWidth;
  const yRatio = height / newHeight;
  for (let y = 0; y < newHeight; y += 1) {
    const srcY = Math.min(height - 1, y * yRatio);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = srcY - y0;
    for (let x = 0; x < newWidth; x += 1) {
      const srcX = Math.min(width - 1, x * xRatio);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = srcX - x0;
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx;
      const bottom = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx;
      out[y * newWidth + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/** Яркости → RGBA (для putImageData и для сохранения PNG). */
export function grayToRgba(gray) {
  const out = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    const v = gray[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return out;
}

/** Статистика по яркостям — для подсказок пользователю и для отчёта стенда. */
export function grayStats(gray, { threshold = null } = {}) {
  let sum = 0;
  let bright = 0;
  let dark = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i];
    sum += v;
    if (v > 200) bright += 1;
    else if (v < 90) dark += 1;
  }
  const pixels = gray.length;
  const cut = threshold ?? otsuThreshold(gray);
  let ink = 0;
  for (let i = 0; i < pixels; i += 1) if (gray[i] <= cut) ink += 1;
  return {
    meanLuminance: sum / pixels,
    brightRatio: bright / pixels,
    darkRatio: dark / pixels,
    inkRatio: ink / pixels,
    contrastOk: (bright + dark) / pixels > 0.06,
  };
}

/**
 * План обработки: обрезать поля и/или увеличить страницу.
 * Вынесено отдельно, потому что это самое важное решение — и его удобно проверять тестами.
 * Если прямоугольник не передан, считаем, что обрезать нечего (решение об обрезке принимает вызывающий код).
 */
export function planPreprocess(width, height, { minWidth = 0, maxSide = 3000, box = null } = {}) {
  const crop = box || { x: 0, y: 0, width, height };
  let scale = 1;
  if (maxSide > 0) scale = Math.min(scale, maxSide / Math.max(crop.width, crop.height));
  if (minWidth > 0 && crop.width * scale < minWidth) {
    scale = Math.min(minWidth / crop.width, 2.5, maxSide / Math.max(crop.width, crop.height));
  }
  const outWidth = Math.max(1, Math.round(crop.width * scale));
  const outHeight = Math.max(1, Math.round(crop.height * scale));
  return { crop, scale, width: outWidth, height: outHeight, cropped: crop.x !== 0 || crop.y !== 0 || crop.width !== width || crop.height !== height };
}

/**
 * Полный конвейер предобработки.
 * Принимает {data, width, height} в формате ImageData, возвращает такие же данные + отчёт о шагах.
 */
export function preprocessImageData(imageData, options = {}) {
  const {
    autoCrop = true,
    deskew = true, // выравнивать наклон страницы, если лист снят под углом
    flatten = true, // выравнивать неравномерный свет (тень, градиент) по местному уровню бумаги
    edgeTrim = true, // срезать тёмную кромку по краям выпрямленной страницы (тень и граница листа)
    flattenAfterContrast = false, // повторно выровнять свет после контраста: кромка чище, но замер дал −2.4 п.п. точности
    trimMargins = false, // обрезать поля даже если лист занимает весь кадр (на замерах это чуть снижает точность)
    binarize: doBinarize = false,
    minWidth = 0, // увеличение по умолчанию выключено — на замерах оно ухудшало распознавание
    maxSide = 3000,
    contrast = true,
  } = options;

  const { data, width, height } = imageData;
  let gray = grayFromRgba(data, width, height);
  let currentWidth = width;
  let currentHeight = height;
  const before = grayStats(gray);
  const steps = [];

  // Неравномерный свет мешает всем порогам, поэтому карту уровня бумаги считаем сразу
  let level = paperLevelMap(gray, currentWidth, currentHeight);

  // Выравниваем страницу: искать лист и обрезать поля проще, когда он ровный
  let deskewInfo = null;
  if (deskew) {
    const mask = paperMaskAdaptive(gray, currentWidth, currentHeight, { map: level.map });
    const fixed = perspectiveCorrect(gray, currentWidth, currentHeight, { maxSide, mask });
    if (fixed.applied) {
      gray = fixed.gray;
      currentWidth = fixed.width;
      currentHeight = fixed.height;
      level = paperLevelMap(gray, currentWidth, currentHeight);
      deskewInfo = { tiltDeg: fixed.tiltDeg, stretch: fixed.stretch, reason: 'страница выровнена' };
      steps.push(`наклон ${fixed.tiltDeg.toFixed(1)}° исправлен`);
    } else if (fixed.quad) {
      deskewInfo = { tiltDeg: fixed.quad.tiltDeg, reason: fixed.reason };
    }
  }

  // Тень и градиент убираем до обрезки: иначе тёмный угол выглядит как «ноты».
  // Делаем это только если свет действительно неровный — ровный снимок лишний раз не трогаем.
  if (flatten) {
    let minLevel = 255;
    let maxLevel = 0;
    for (let i = 0; i < level.map.length; i += 1) {
      const value = level.map[i];
      if (value < minLevel) minLevel = value;
      if (value > maxLevel) maxLevel = value;
    }
    const spread = maxLevel - minLevel;
    if (spread > 20) {
      gray = normalizeByPaperLevel(gray, currentWidth, currentHeight, level);
      level = paperLevelMap(gray, currentWidth, currentHeight);
      steps.push(`свет выровнен (разброс ${Math.round(spread)})`);
    }
  }

  // Тёмная кромка: выравнивание наклона оставляет у краёв полосу тени и границы листа.
  // Срезаем её до поиска листа: тогда и порог бумаги, и обрезка полей работают по чистой странице.
  if (edgeTrim) {
    const edge = edgeTrimBounds(gray, currentWidth, currentHeight);
    if (edge) {
      const cut = { left: edge.x, top: edge.y, right: currentWidth - edge.width - edge.x, bottom: currentHeight - edge.height - edge.y };
      gray = cropGray(gray, currentWidth, currentHeight, edge).gray;
      currentWidth = edge.width;
      currentHeight = edge.height;
      level = paperLevelMap(gray, currentWidth, currentHeight);
      steps.push(`кромка срезана (${cut.left}/${cut.right}/${cut.top}/${cut.bottom} px)`);
    }
  }

  // Порядок важен: сначала находим лист на исходном снимке (стол и тень темнее бумаги),
  // и только потом растягиваем контраст внутри листа — иначе тёмный стол сам станет «нотами».
  let box = null;
  if (autoCrop) {
    const paper = pageBounds(gray, currentWidth, currentHeight);
    if (paper) {
      gray = cropGray(gray, currentWidth, currentHeight, paper).gray;
      currentWidth = paper.width;
      currentHeight = paper.height;
      box = paper;
      steps.push('лист найден');
    }
  }

  if (contrast) {
    const { low, high } = contrastBounds(gray);
    // Страховка от вырожденного кадра: если тёмного на странице нет (например, срез кромки
    // оставил одну бумагу), растягивать нечего — иначе ровная бумага стала бы чёрной.
    if (high - low >= 16) {
      gray = stretchContrast(gray, low, high);
    } else {
      steps.push('контраст не нужен (тёмного на странице нет)');
    }
  }

  // Контраст растягивает яркости по всему кадру, поэтому остаточный градиент света (тень сбоку)
  // он превращает в заметную тёмную полосу: на имитации фото замер дал 0.92 до контраста и 0.77
  // после него. Повторное выравнивание эту полосу убирает (кромка 0.996), но на пресете
  // «наклон 5°» оно стоило 2.4 п.п. точности (86.7% → 84.3%), поэтому по умолчанию шаг выключен:
  // распознавание важнее красоты кадра. Замер: docs/omr-photo.md; включить — flattenAfterContrast.
  if (flatten && flattenAfterContrast) {
    const level2 = paperLevelMap(gray, currentWidth, currentHeight);
    let min2 = 255;
    let max2 = 0;
    for (let i = 0; i < level2.map.length; i += 1) {
      const value = level2.map[i];
      if (value < min2) min2 = value;
      if (value > max2) max2 = value;
    }
    if (max2 - min2 > 12) {
      gray = normalizeByPaperLevel(gray, currentWidth, currentHeight, level2);
      level = paperLevelMap(gray, currentWidth, currentHeight);
      steps.push(`свет выровнен после контраста (разброс ${Math.round(max2 - min2)})`);
    }
  }

  // Поля вокруг нот убираем, если лист уже найден на фоне, либо если обрезку попросили явно:
  // на чистых страницах, занимающих весь кадр, обрезка полей чуть снижает точность (docs/omr-prep.md).
  if (autoCrop && (box || trimMargins)) {
    const ink = inkBounds(gray, currentWidth, currentHeight);
    if (ink) {
      gray = cropGray(gray, currentWidth, currentHeight, ink).gray;
      box = combineBoxes(box, ink);
      steps.push('поля обрезаны');
    }
  }

  const finalWidth = box?.width || currentWidth;
  const finalHeight = box?.height || currentHeight;
  const plan = planPreprocess(width, height, {
    minWidth,
    maxSide,
    box: { x: 0, y: 0, width: finalWidth, height: finalHeight },
  });
  if (plan.width !== finalWidth || plan.height !== finalHeight) {
    gray = resizeGray(gray, finalWidth, finalHeight, plan.width, plan.height);
    if (plan.scale > 1.001) steps.push(`увеличено в ${plan.scale.toFixed(2)} раза`);
  }
  if (doBinarize) {
    gray = binarize(gray, otsuThreshold(gray));
    steps.push('чёрно-белое');
  }

  const after = grayStats(gray);
  return {
    data: grayToRgba(gray),
    width: plan.width,
    height: plan.height,
    stats: {
      before,
      after,
      cropped: !!box,
      crop: box,
      scale: Number(plan.scale.toFixed(3)),
      binarized: !!doBinarize,
      deskewed: !!deskewInfo?.tiltDeg && steps.some((step) => step.startsWith('наклон')),
      deskew: deskewInfo,
      flattened: steps.some((step) => step.startsWith('свет выровнен')),
      flattenedAfterContrast: steps.some((step) => step.startsWith('свет выровнен после контраста')),
      edgeTrimmed: steps.some((step) => step.startsWith('кромка срезана')),
      steps,
      width: plan.width,
      height: plan.height,
    },
  };
}