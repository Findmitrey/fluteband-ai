// FluteBand AI — WAV-энкодер (16 бит PCM), без внешних зависимостей.

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Замеры сигнала: пик и средняя громкость. Нужны, чтобы честно проверять,
 * что экспорт не пустой и что банк звуков действительно звучит.
 */
export function analyzeChannels(channels = []) {
  let peak = 0;
  let sumSquares = 0;
  let frames = 0;
  let nonSilent = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i];
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
      sumSquares += value * value;
      if (abs > 0.001) nonSilent += 1;
    }
    frames += channel.length;
  }
  const rms = frames ? Math.sqrt(sumSquares / frames) : 0;
  return {
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    peakDb: peak > 0 ? Number((20 * Math.log10(peak)).toFixed(1)) : -Infinity,
    frames,
    nonSilentRatio: frames ? Number((nonSilent / frames).toFixed(4)) : 0,
    silent: peak < 0.01,
  };
}

/** channels: массив Float32Array (по каналам), значения -1..1 */
export function encodeWav(channels, sampleRate = 44100) {
  const numChannels = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * Распределение энергии по трём полосам (низ / середина / верх).
 * Нужно, чтобы отличать «богатый» тембр записи рояля от простого синтеза не на слух, а числом.
 * Фильтры простые (однополюсные), этого достаточно для сравнения двух вариантов одного и того же минуса.
 */
export function bandEnergy(channels = [], sampleRate = 44100, { lowHz = 300, highHz = 2000 } = {}) {
  const dt = 1 / sampleRate;
  const lowAlpha = dt / (dt + 1 / (2 * Math.PI * lowHz));
  const highAlpha = dt / (dt + 1 / (2 * Math.PI * highHz));

  let low = 0;
  let high = 0;
  let total = 0;

  for (const channel of channels) {
    let lowState = 0;
    let highState = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i];
      lowState += lowAlpha * (value - lowState);
      highState += highAlpha * (value - highState);
      const highPart = value - highState; // всё, что выше порога
      low += lowState * lowState;
      high += highPart * highPart;
      total += value * value;
    }
  }

  if (!total) return { low: 0, mid: 0, high: 0, centroidHz: 0 };
  const lowShare = low / total;
  const highShare = high / total;
  const midShare = Math.max(0, 1 - lowShare - highShare);
  return {
    low: Number(lowShare.toFixed(4)),
    mid: Number(midShare.toFixed(4)),
    high: Number(highShare.toFixed(4)),
    // грубая оценка «яркости»: середина спектра между полосами
    centroidHz: Math.round(lowShare * (lowHz / 2) + midShare * ((lowHz + highHz) / 2) + highShare * (highHz * 3)),
  };
}

export function describeWav(bytes) {
  if (!bytes || bytes.length < 44) return { ok: false, reason: 'слишком короткий файл' };
  const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ok: id === 'RIFF',
    id,
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
    size: bytes.length,
  };
}