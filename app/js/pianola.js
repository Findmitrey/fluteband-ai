// FluteBand AI — «пианола»: полоса нот с курсором (решение №21).
import { measureStarts, measureLengthBeats } from './timeline.js';
import { resolveHarmony } from './harmony.js';

const COLORS = {
  background: '#0f172a',
  laneMelody: '#132033',
  laneBass: '#101a2b',
  grid: '#1e2b40',
  measureLine: '#2b3d59',
  melody: '#7dd3fc',
  melodyLow: '#38bdf8',
  bass: '#fbbf24',
  chord: '#a78bfa',
  playhead: '#f472b6',
  text: '#cbd5e1',
};

export class Pianola {
  constructor(canvas, { onSeek = null } = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.pxPerBeat = 34;
    this.score = null;
    this.accompaniment = null;
    this.position = 0;
    this.range = { lo: 48, hi: 84 };
    this.measureOffsets = [];
    this.measureLens = [];
    this.bindEvents();
    this.resize();
  }

  bindEvents() {
    this.canvas.addEventListener('click', (event) => {
      if (!this.score || !this.onSeek) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const beat = this.leftBeat + x / this.pxPerBeat;
      this.onSeek(Math.max(0, beat), event);
    });
    this.canvas.style.cursor = 'pointer';
  }

  setScore(score, accompaniment = null) {
    this.score = score;
    this.accompaniment = accompaniment;
    this.measureOffsets = measureStarts(score);
    this.measureLens = (score?.measures || []).map((m) => measureLengthBeats(score, m));
    this.range = this.#computeRange();
    this.resize();
  }

  #computeRange() {
    let lo = 127;
    let hi = 0;
    const collect = (events) => {
      for (const ev of events || []) {
        for (const p of ev.midi || ev.pitches || []) {
          if (p < lo) lo = p;
          if (p > hi) hi = p;
        }
      }
    };
    for (const m of this.score?.measures || []) collect(m.events);
    collect(this.accompaniment?.events);
    if (lo > hi) return { lo: 48, hi: 84 };
    return { lo: Math.max(12, lo - 3), hi: Math.min(108, hi + 3) };
  }

  resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(280, rect.width || this.canvas.clientWidth || 320);
    const height = Math.max(160, rect.height || this.canvas.clientHeight || 220);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.draw(this.position);
  }

  get leftBeat() {
    return this._leftBeat ?? 0;
  }

  draw(position = 0) {
    this.position = position;
    const ctx = this.ctx2d;
    if (!ctx || !this.width) return;

    const total = this.measureOffsets.length
      ? this.measureOffsets[this.measureOffsets.length - 1] + this.measureLens[this.measureLens.length - 1]
      : 0;
    const windowBeats = this.width / this.pxPerBeat;
    const left = Math.max(0, Math.min(Math.max(0, total - windowBeats), position - windowBeats / 2));
    this._leftBeat = left;

    const bassLaneHeight = Math.round(this.height * 0.42);
    const melodyTop = 6;
    const melodyBottom = this.height - bassLaneHeight - 18;
    const melodyHeight = Math.max(30, melodyBottom - melodyTop);
    const bassTop = melodyBottom + 14;
    const bassHeight = Math.max(24, this.height - bassTop - 4);

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    const xOf = (beat) => (beat - left) * this.pxPerBeat;
    const yOfMelody = (midi) => melodyBottom - ((midi - this.range.lo) / (this.range.hi - this.range.lo || 1)) * melodyHeight;
    const yOfBass = (midi) => bassTop + bassHeight - ((midi - this.range.lo) / (this.range.hi - this.range.lo || 1)) * bassHeight;

    // фон дорожек
    ctx.fillStyle = COLORS.laneMelody;
    ctx.fillRect(0, melodyTop, this.width, melodyHeight);
    ctx.fillStyle = COLORS.laneBass;
    ctx.fillRect(0, bassTop, this.width, bassHeight);

    // линии тактов
    for (let i = 0; i < this.measureOffsets.length; i += 1) {
      const start = this.measureOffsets[i];
      const end = start + this.measureLens[i];
      if (end < left - 1 || start > left + windowBeats + 1) continue;
      const x = xOf(start);
      ctx.strokeStyle = COLORS.measureLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, melodyTop);
      ctx.lineTo(x, this.height - 2);
      ctx.stroke();

      // аккорд такта
      const measure = this.score?.measures?.[i];
      const segments = measure
        ? resolveHarmony(measure, { meter: { beats: this.measureLens[i], beatType: 4 }, key: this.score.key })
        : [];
      for (const seg of segments) {
        const sx = xOf(start + seg.beat);
        const sw = seg.dur * this.pxPerBeat;
        if (sx + sw < 0 || sx > this.width) continue;
        ctx.fillStyle = 'rgba(167,139,250,0.18)';
        ctx.fillRect(sx, bassTop, sw, bassHeight);
        if (seg.symbol) {
          ctx.fillStyle = COLORS.chord;
          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillText(seg.symbol, sx + 4, bassTop - 4);
        }
      }
      ctx.fillStyle = COLORS.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(String(i + 1), x + 3, this.height - 3);
    }

    // мелодия
    for (const m of this.score?.measures || []) {
      const index = m.index ?? 0;
      const offset = this.measureOffsets[index] ?? 0;
      for (const ev of m.events || []) {
        const start = offset + ev.beat;
        if (start + ev.dur < left - 1 || start > left + windowBeats + 1) continue;
        const x = xOf(start);
        const w = Math.max(3, ev.dur * this.pxPerBeat - 2);
        for (const p of ev.pitches) {
          const y = yOfMelody(p);
          const gradient = ctx.createLinearGradient(0, y - 8, 0, y + 8);
          gradient.addColorStop(0, COLORS.melody);
          gradient.addColorStop(1, COLORS.melodyLow);
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y - 7, w, 14);
        }
      }
    }

    // аккомпанемент
    for (const ev of this.accompaniment?.events || []) {
      if (ev.startBeat + ev.durBeats < left - 1 || ev.startBeat > left + windowBeats + 1) continue;
      const x = xOf(ev.startBeat);
      const w = Math.max(2, ev.durBeats * this.pxPerBeat - 2);
      ctx.globalAlpha = Math.max(0.25, Math.min(1, ev.velocity ?? 0.8));
      ctx.fillStyle = ev.role === 'bass' ? COLORS.bass : COLORS.chord;
      for (const p of ev.midi) {
        const y = yOfBass(p);
        ctx.fillRect(x, y - 3, w, 6);
      }
      ctx.globalAlpha = 1;
    }

    // курсор
    const px = xOf(position);
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, melodyTop);
    ctx.lineTo(px, this.height - 2);
    ctx.stroke();
  }
}