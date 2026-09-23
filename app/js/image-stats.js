// FluteBand AI — статистика по яркостям: гистограмма, перцентили, порог Оцу, бинаризация.
//
// Вынесено отдельным модулем, потому что этим пользуются и предобработка снимка (image-prep.js),
// и выравнивание страницы (perspective.js). Модуль без DOM — проверяется юнит-тестами.

/** Гистограмма яркостей (256 корзин). */
export function histogram(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  return hist;
}

/** Значение яркости на заданном проценте распределения (например, 2% и 96%). */
export function percentileValue(hist, total, percent) {
  const target = (total * percent) / 100;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += hist[value];
    if (seen >= target) return value;
  }
  return 255;
}

/** Перцентиль яркости по массиву (удобная обёртка). */
export function percentileOf(gray, percent) {
  return percentileValue(histogram(gray), gray.length, percent);
}

/**
 * Границы для растяжения контраста.
 * Нижний перцентиль отсекает тёмный шум, верхний — «бумагу» (она становится белой).
 */
export function contrastBounds(gray, { lowPercent = 1, highPercent = 96 } = {}) {
  const hist = histogram(gray);
  const low = percentileValue(hist, gray.length, lowPercent);
  const high = Math.max(low + 8, percentileValue(hist, gray.length, highPercent));
  return { low, high };
}

/** Линейно растянуть диапазон [low, high] на 0..255. */
export function stretchContrast(gray, low, high) {
  const out = new Uint8ClampedArray(gray.length);
  const scale = 255 / Math.max(1, high - low);
  for (let i = 0; i < gray.length; i += 1) out[i] = (gray[i] - low) * scale;
  return out;
}

/** Порог Оцу — автоматический порог для двухмодального изображения (печать на бумаге). */
export function otsuThreshold(gray) {
  const hist = histogram(gray);
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v += 1) sum += v * hist[v];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let v = 0; v < 256; v += 1) {
    weightBackground += hist[v];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += v * hist[v];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = v;
    }
  }
  return best;
}

/** Бинаризация: тёмное — чёрное, светлое — белое. */
export function binarize(gray, threshold = null) {
  const cut = threshold ?? otsuThreshold(gray);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = gray[i] <= cut ? 0 : 255;
  return out;
}