// FluteBand AI — синтезатор фортепиано на Web Audio.
// Два движка: 'tone' (встроенный, работает офлайн) и 'sample' (свободный банк звуков, по желанию).
// Один и тот же класс используется и для живого звука, и для экспорта WAV — чтобы файл звучал как плеер.

import { midiToFreq, nameFromMidi } from './pitch.js';
import {
  ACCOMPANIMENT_MAX_MIDI,
  ACCOMPANIMENT_MIN_MIDI,
  bankById,
  chooseAnchor,
  planLoad,
  velocityShape,
  voiceEnvelope,
} from './sampler.js';

const HARMONICS = [
  { mult: 1, gain: 1.0, type: 'triangle' },
  { mult: 2, gain: 0.32, type: 'sine' },
  { mult: 3, gain: 0.14, type: 'sine' },
  { mult: 4.01, gain: 0.06, type: 'sine' },
];

/** Обратная совместимость: старый адрес компактного банка */
export const DEFAULT_SOUNDFONT_BASE = bankById('compact').base;

export class PianoSynth {
  constructor(ctx, { destination = null, volume = 0.85 } = {}) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(destination || ctx.destination);
    this.buffers = new Map();
    this.engine = 'tone';
    this.bankId = 'tone';
    this.active = new Set();
    this.volume = volume;
  }

  get engineName() {
    return this.engine === 'sample' ? bankById(this.bankId).title : bankById('tone').title;
  }

  /** Сколько нот реально подгружено из банка */
  get sampleCount() {
    return this.buffers.size;
  }

  get anchorList() {
    return [...this.buffers.keys()].sort((a, b) => a - b);
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.ctx.state !== 'closed') this.master.gain.value = this.volume;
  }

  /**
   * Загрузить свободный банк. `getBytes(note)` возвращает ArrayBuffer (из кэша или из сети),
   * поэтому политика кэширования живёт в приложении, а не здесь.
   */
  async loadBank(bankId, {
    minMidi = ACCOMPANIMENT_MIN_MIDI,
    maxMidi = ACCOMPANIMENT_MAX_MIDI,
    getBytes = null,
    onProgress = null,
  } = {}) {
    const bank = bankById(bankId);
    if (bank.id === 'tone') {
      this.useToneEngine();
      return { ok: true, bank: 'tone', title: bank.title, notes: 0, failed: 0 };
    }
    if (typeof this.ctx?.decodeAudioData !== 'function') {
      return { ok: false, bank: bank.id, reason: 'нет декодера звука', notes: 0, failed: 0 };
    }

    const plan = planLoad(bank, { minMidi, maxMidi });
    const loaded = new Map();
    let failed = 0;
    let done = 0;

    await Promise.all(plan.notes.map(async (note) => {
      try {
        const bytes = getBytes
          ? await getBytes(note)
          : await (async () => {
              const res = await fetch(note.url);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.arrayBuffer();
            })();
        if (!bytes) throw new Error('нет данных');
        // decodeAudioData забирает буфер себе, поэтому декодируем копию
        const buffer = await this.ctx.decodeAudioData(bytes.slice ? bytes.slice(0) : bytes);
        loaded.set(note.midi, buffer);
      } catch {
        failed += 1;
      } finally {
        done += 1;
        onProgress?.({ done, total: plan.notes.length });
      }
    }));

    if (!loaded.size) {
      return { ok: false, bank: bank.id, title: bank.title, reason: 'банк не загрузился', notes: 0, failed };
    }
    this.buffers = loaded;
    this.bankId = bank.id;
    this.engine = 'sample';
    return {
      ok: true,
      bank: bank.id,
      title: bank.title,
      notes: loaded.size,
      failed,
      planned: plan.count,
      bytesText: plan.approxBytesText,
    };
  }

  /** Старое имя метода: грузим компактный банк */
  loadSoundFont(baseUrl = DEFAULT_SOUNDFONT_BASE) {
    const bankId = baseUrl.includes('FluidR3') ? 'compact' : 'royal';
    return this.loadBank(bankId).then((result) => ({ ok: result.ok, reason: result.reason, anchors: result.notes }));
  }

  /** Готовые декодированные сэмплы — чтобы экспорт WAV звучал тем же инструментом */
  getBuffers() {
    return this.engine === 'sample' ? new Map(this.buffers) : new Map();
  }

  /** Принять готовые сэмплы (например, для офлайн-рендера в OfflineAudioContext) */
  setBuffers(buffers, bankId = 'royal') {
    if (buffers && buffers.size) {
      this.buffers = new Map(buffers);
      this.bankId = bankId;
      this.engine = 'sample';
    } else {
      this.buffers = new Map();
      this.bankId = 'tone';
      this.engine = 'tone';
    }
    return this.engine;
  }

  /** Для офлайн-рендера: те же сэмплы в новом контексте декодировать заново не нужно */
  cloneInto(ctx, { volume = this.volume } = {}) {
    const clone = new PianoSynth(ctx, { volume });
    clone.setBuffers(this.getBuffers(), this.bankId);
    return clone;
  }

  useToneEngine() {
    this.buffers = new Map();
    this.engine = 'tone';
    this.bankId = 'tone';
  }

  nearestBuffer(midi) {
    const anchor = chooseAnchor(midi, this.anchorList);
    if (!anchor) return null;
    return { anchorMidi: anchor.anchorMidi, buffer: this.buffers.get(anchor.anchorMidi), ...anchor };
  }

  /**
   * Запланировать ноту. when/dur — в секундах аудиоконтекста.
   * Поддерживает и аккорд (массив MIDI), и одиночную ноту.
   */
  noteOn(midiInput, when, dur, velocity = 0.8) {
    const pitches = Array.isArray(midiInput) ? midiInput : [midiInput];
    for (const midi of pitches) this.#note(midi, when, dur, velocity);
  }

  #note(midi, when, dur, velocity) {
    const ctx = this.ctx;
    const start = Math.max(when, ctx.currentTime);
    const hold = Math.max(0.05, dur);
    const shape = velocityShape(velocity);
    const gain = ctx.createGain();
    gain.connect(this.master);
    const peak = Math.max(0.02, Math.min(0.95, shape.amplitude)) * 0.5;

    const sample = this.engine === 'sample' ? this.nearestBuffer(midi) : null;
    let source;
    if (sample) {
      const envelope = voiceEnvelope({ durSeconds: hold, velocity, sampleSeconds: sample.buffer.duration });
      source = ctx.createBufferSource();
      source.buffer = sample.buffer;
      source.playbackRate.value = sample.playbackRate;

      // Тихая нота звучит глуше: мягкий фильтр вместо простого усиления
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(16000, shape.lowpassHz + midiToFreq(midi) * 1.6);
      filter.Q.value = 0.4;

      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + envelope.attack);
      gain.gain.setValueAtTime(peak, start + Math.min(envelope.hold, envelope.end * 0.6));
      gain.gain.exponentialRampToValueAtTime(0.0001, start + envelope.end);
      source.connect(filter);
      filter.connect(gain);
      source.start(start);
      source.stop(start + envelope.end + 0.03);
    } else {
      source = ctx.createOscillator();
      source.type = 'triangle';
      source.frequency.value = midiToFreq(midi);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(12000, midiToFreq(midi) * 6 + 1200);
      source.connect(filter);
      filter.connect(gain);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(peak * 0.35, start + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + hold + 0.45);
      source.start(start);
      source.stop(start + hold + 0.5);

      // обертоны для «фортепианного» тембра
      for (const h of HARMONICS.slice(1)) {
        const partial = ctx.createOscillator();
        partial.type = h.type;
        partial.frequency.value = midiToFreq(midi) * h.mult;
        const pg = ctx.createGain();
        pg.gain.setValueAtTime(0, start);
        pg.gain.linearRampToValueAtTime(peak * h.gain, start + 0.006);
        pg.gain.exponentialRampToValueAtTime(0.0001, start + hold * 0.8 + 0.2);
        partial.connect(pg);
        pg.connect(this.master);
        partial.start(start);
        partial.stop(start + hold + 0.3);
        this.#track(partial, pg);
      }
    }
    this.#track(source, gain);
  }

  #track(source, gain) {
    const entry = { source, gain };
    this.active.add(entry);
    source.onended = () => {
      this.active.delete(entry);
      try {
        gain.disconnect();
      } catch {
        /* уже отключён */
      }
    };
  }

  /** Мгновенная тишина (кнопка «Стоп») */
  allNotesOff() {
    for (const { source, gain } of [...this.active]) {
      try {
        if (this.ctx.state !== 'closed') {
          gain.gain.cancelScheduledValues(this.ctx.currentTime);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), this.ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.06);
        }
        source.stop(this.ctx.currentTime + 0.08);
      } catch {
        /* источник уже остановлен */
      }
    }
    this.active.clear();
  }
}

export function describeNote(midi) {
  return nameFromMidi(midi);
}

export { HARMONICS };