// FluteBand AI — офлайн-рендер минуса в WAV (без ffmpeg и внешних библиотек).
// Важно: рендер идёт тем же инструментом, что играет в плеере. Если подключён банк звуков,
// его сэмплы передаются сюда через `buffers`, поэтому файл звучит так же, как плеер.
import { PianoSynth } from './synth.js';
import { encodeWav, analyzeChannels, bandEnergy } from './wav.js';

/**
 * Отрисовать события минуса в аудиоканалы.
 * Возвращает каналы, длительность и замеры — без кодирования в WAV.
 */
export async function renderEvents({
  events = [],
  tempo = 100,
  totalBeats = 0,
  sampleRate = 44100,
  tailSeconds = 2,
  volume = 0.9,
  buffers = null,
  bankId = 'tone',
  synth = null,
} = {}) {
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error('Браузер не поддерживает OfflineAudioContext');
  if (!events.length) throw new Error('Нет нот для экспорта');

  const secondsPerBeat = 60 / (tempo || 100);
  const duration = Math.max(1, totalBeats * secondsPerBeat + tailSeconds);
  const ctx = new OfflineCtx(2, Math.ceil(duration * sampleRate), sampleRate);

  // Готовые сэмплы переиспользуем как есть; если их нет — играем встроенным синтезом
  let player;
  if (buffers?.size && synth) {
    player = synth.cloneInto(ctx, { volume });
  } else {
    player = new PianoSynth(ctx, { volume });
    if (buffers?.size) player.setBuffers(buffers, bankId);
  }

  for (const ev of events) {
    if (!ev?.midi?.length) continue;
    player.noteOn(
      ev.midi,
      Math.max(0, (ev.startBeat || 0) * secondsPerBeat),
      Math.max(0.05, (ev.durBeats || 0.5) * secondsPerBeat),
      ev.velocity ?? 0.8,
    );
  }

  const buffer = await ctx.startRendering();
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  if (!channels.length) throw new Error('Пустой аудиобуфер');

  const metrics = analyzeChannels(channels);
  if (metrics.silent) throw new Error('Получилась тишина — банк звуков не загрузился?');

  return {
    channels,
    sampleRate,
    seconds: Number(duration.toFixed(2)),
    engine: player.engine,
    engineName: player.engineName,
    samples: player.sampleCount,
    metrics,
    bands: bandEnergy(channels, sampleRate),
  };
}

/** Готовый WAV-файл (Uint8Array) — используется кнопкой экспорта */
export async function renderEventsToWav(options = {}) {
  const rendered = await renderEvents(options);
  return encodeWav(rendered.channels, rendered.sampleRate);
}

export function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  return downloadBlob(blob, filename);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

export function safeFileName(text, fallback = 'fluteband') {
  const base = String(text || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');
  return base ? base.slice(0, 60) : fallback;
}