// FluteBand AI — время и координаты пьесы (единая единица: четвертная доля = 1 beat)
import { pitchClass } from './pitch.js';

export const DEFAULT_METER = { beats: 4, beatType: 4 };

export function meterOf(score, measure) {
  return measure?.meter || score?.meter || DEFAULT_METER;
}

export function measureLengthBeats(score, measure) {
  const meter = meterOf(score, measure);
  // в 6/8 и подобных размерах доля для аккомпанемента = четверть, длина такта = beats * 4 / beatType
  return (meter.beats * 4) / (meter.beatType || 4);
}

/** Абсолютная позиция начала каждого такта (в четвертных долях) */
export function measureStarts(score) {
  const starts = [];
  let acc = 0;
  for (const m of score?.measures || []) {
    starts.push(acc);
    acc += measureLengthBeats(score, m);
  }
  return starts;
}

export function totalBeats(score) {
  const starts = measureStarts(score);
  const last = (score?.measures || []).length - 1;
  if (last < 0) return 0;
  return starts[last] + measureLengthBeats(score, score.measures[last]);
}

export function beatsToSeconds(beats, bpm) {
  return (beats * 60) / (bpm || 100);
}

export function secondsToBeats(seconds, bpm) {
  return (seconds * (bpm || 100)) / 60;
}

/** Все нотные события пьесы в абсолютном времени (для пианолы и экспорта) */
export function melodyTimeline(score) {
  const starts = measureStarts(score);
  const out = [];
  (score?.measures || []).forEach((m, i) => {
    for (const e of m.events || []) {
      if (!e.pitches?.length) continue;
      out.push({
        startBeat: starts[i] + (e.beat || 0),
        durBeats: e.dur || 0.5,
        pitches: [...e.pitches],
        voice: e.voice || 'melody',
        measureIndex: i,
      });
    }
  });
  return out;
}

export function pitchRange(events) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events || []) {
    for (const p of e.pitches || e.midi || []) {
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
  }
  if (lo === Infinity) return { lo: 60, hi: 72 };
  return { lo, hi };
}

export function pitchClassSetOf(events) {
  const set = new Set();
  for (const e of events || []) {
    for (const p of e.pitches || e.midi || []) set.add(pitchClass(p));
  }
  return [...set];
}