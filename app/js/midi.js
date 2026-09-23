// FluteBand AI — экспорт MIDI (SMF Format 1), без внешних зависимостей.
export const PPQ = 480;

function vlq(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function chunk(id, data) {
  const out = new Uint8Array(8 + data.length);
  for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
  out[4] = (data.length >>> 24) & 0xff;
  out[5] = (data.length >>> 16) & 0xff;
  out[6] = (data.length >>> 8) & 0xff;
  out[7] = data.length & 0xff;
  out.set(data, 8);
  return out;
}

/** Текстовые мета-события MIDI пишем только ASCII — так их читают все плееры */
function asciiSafe(text) {
  return String(text ?? '').replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Собрать .mid из событий аккомпанемента.
 * events: [{ startBeat, durBeats, midi: [..], velocity 0..1 }]
 */
export function buildMidiFile({
  events = [],
  tempo = 100,
  meter = { beats: 4, beatType: 4 },
  program = 0,
  channel = 0,
  trackName = 'FluteBand AI',
  ppq = PPQ,
} = {}) {
  const notes = [];
  for (const ev of events) {
    if (!ev?.midi?.length) continue;
    const start = Math.round((ev.startBeat || 0) * ppq);
    const end = Math.max(start + 12, Math.round(((ev.startBeat || 0) + (ev.durBeats || 0.5) * 0.96) * ppq));
    const velocity = Math.max(1, Math.min(127, Math.round((ev.velocity ?? 0.8) * 127)));
    for (const pitch of ev.midi) {
      notes.push({ start, end, pitch: Math.round(pitch), velocity });
    }
  }

  const stream = [];
  for (const n of notes) {
    stream.push({ tick: n.start, order: 1, bytes: [0x90 | channel, n.pitch & 0x7f, n.velocity] });
    stream.push({ tick: n.end, order: 0, bytes: [0x80 | channel, n.pitch & 0x7f, 0x40] });
  }
  stream.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);

  const track = [];
  const meta = (bytes) => track.push(...bytes);
  // название дорожки
  const nameBytes = [...new TextEncoder().encode(asciiSafe(trackName))].slice(0, 100);
  meta([0x00, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes]);
  // темп
  const usPerQuarter = Math.max(1, Math.round(60000000 / (tempo || 100)));
  meta([0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]);
  // размер
  const dd = Math.max(0, Math.round(Math.log2(meter?.beatType || 4)));
  meta([0x00, 0xff, 0x58, 0x04, (meter?.beats || 4) & 0xff, dd, 24, 8]);
  // инструмент
  meta([0x00, 0xc0 | channel, program & 0x7f]);

  let lastTick = 0;
  for (const item of stream) {
    const delta = item.tick - lastTick;
    track.push(...vlq(delta), ...item.bytes);
    lastTick = item.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64], 0); // MThd
  header[4] = 0; header[5] = 0; header[6] = 0; header[7] = 6;
  header[8] = 0; header[9] = 1;             // format 1
  header[10] = 0; header[11] = 1;           // 1 track
  header[12] = (ppq >> 8) & 0xff; header[13] = ppq & 0xff;

  const trackChunk = chunk('MTrk', new Uint8Array(track));
  const out = new Uint8Array(header.length + trackChunk.length);
  out.set(header, 0);
  out.set(trackChunk, header.length);
  return out;
}

/** Краткая проверка корректности заголовка (используется в тестах и при экспорте) */
export function describeMidi(bytes) {
  if (!bytes || bytes.length < 14) return { ok: false, reason: 'слишком короткий файл' };
  const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const format = (bytes[8] << 8) | bytes[9];
  const tracks = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  return { ok: id === 'MThd', id, format, tracks, division, size: bytes.length };
}