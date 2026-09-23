// FluteBand AI — темп: итальянские термины из нот -> BPM (с ручной правкой в UI).

export const TEMPO_TERMS = [
  { term: 'grave', bpm: 44 },
  { term: 'largo', bpm: 50 },
  { term: 'lento', bpm: 54 },
  { term: 'adagio', bpm: 60 },
  { term: 'larghetto', bpm: 63 },
  { term: 'andante', bpm: 80 },
  { term: 'andantino', bpm: 88 },
  { term: 'moderato', bpm: 100 },
  { term: 'sostenuto', bpm: 92 },
  { term: 'comodo', bpm: 104 },
  { term: 'allegretto', bpm: 112 },
  { term: 'allegro', bpm: 126 },
  { term: 'vivace', bpm: 152 },
  { term: 'presto', bpm: 176 },
  { term: 'prestissimo', bpm: 200 },
  { term: 'марш', bpm: 120 },
  { term: 'вальс', bpm: 132 },
];

const MODIFIERS = [
  { re: /molto|assai/, factor: 1.12 },
  { re: /non\s+troppo/, factor: 0.9 },
  { re: /con\s+moto/, factor: 1.08 },
  { re: /maestoso/, factor: 0.95 },
  { re: /cantabile/, factor: 0.95 },
];

/** "Andante con moto" -> 86; "Allegro" -> 126; неизвестно -> null */
export function tempoFromText(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  let best = null;
  for (const { term, bpm } of TEMPO_TERMS) {
    if (lower.includes(term) && (!best || term.length > best.term.length)) best = { term, bpm };
  }
  if (!best) return null;
  let bpm = best.bpm;
  for (const m of MODIFIERS) if (m.re.test(lower)) bpm *= m.factor;
  return { bpm: Math.round(bpm), term: best.term };
}

export function tempoName(bpm) {
  let closest = TEMPO_TERMS[0];
  let diff = Infinity;
  for (const t of TEMPO_TERMS) {
    const d = Math.abs(t.bpm - bpm);
    if (d < diff) { diff = d; closest = t; }
  }
  return diff <= 18 ? closest.term : null;
}

export const DEFAULT_TEMPO = 100;