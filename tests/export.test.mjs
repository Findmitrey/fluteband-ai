// FluteBand AI — тесты экспорта: MIDI (SMF) и WAV.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMidiFile, describeMidi, PPQ } from '../app/js/midi.js';
import { encodeWav, describeWav } from '../app/js/wav.js';
import { generateAccompaniment } from '../app/js/accompaniment.js';
import { odeToJoy } from '../app/js/demo.js';

function countByte(bytes, value) {
  let n = 0;
  for (const b of bytes) if (b === value) n += 1;
  return n;
}

test('MIDI: заголовок, темп, размер, ноты', () => {
  const acc = generateAccompaniment(odeToJoy());
  const bytes = buildMidiFile({
    events: acc.events,
    tempo: 100,
    meter: { beats: 4, beatType: 4 },
    trackName: 'FluteBand AI — Ода к радости',
  });

  const info = describeMidi(bytes);
  assert.equal(info.ok, true);
  assert.equal(info.id, 'MThd');
  assert.equal(info.format, 1);
  assert.equal(info.tracks, 1);
  assert.equal(info.division, PPQ);
  assert.ok(bytes.length > 200);

  // темп 100 BPM => 600000 мкс на четверть
  const idx = bytes.findIndex((_, i) => bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 0x03);
  assert.ok(idx > 0, 'не найден мета-событий темпа');
  const usPerQuarter = (bytes[idx + 3] << 16) | (bytes[idx + 4] << 8) | bytes[idx + 5];
  assert.equal(usPerQuarter, 600000);

  // размер 4/4
  const tsIdx = bytes.findIndex((_, i) => bytes[i] === 0xff && bytes[i + 1] === 0x58 && bytes[i + 2] === 0x04);
  assert.ok(tsIdx > 0);
  assert.equal(bytes[tsIdx + 3], 4);
  assert.equal(bytes[tsIdx + 4], 2);

  // конец дорожки
  assert.deepEqual([...bytes.slice(-3)], [0xff, 0x2f, 0x00]);

  // количество note-on = число нот в аккомпанементе
  const expectedNotes = acc.events.reduce((sum, e) => sum + e.midi.length, 0);
  assert.equal(countByte(bytes, 0x90), expectedNotes);
  assert.equal(countByte(bytes, 0x80), expectedNotes);

  // смена темпа меняет мкс на четверть
  const slow = buildMidiFile({ events: acc.events, tempo: 50 });
  const slowIdx = slow.findIndex((_, i) => slow[i] === 0xff && slow[i + 1] === 0x51 && slow[i + 2] === 0x03);
  const slowUs = (slow[slowIdx + 3] << 16) | (slow[slowIdx + 4] << 8) | slow[slowIdx + 5];
  assert.equal(slowUs, 1200000);

  assert.equal(describeMidi(new Uint8Array([1, 2, 3])).ok, false);
  const empty = buildMidiFile({ events: [] });
  assert.equal(describeMidi(empty).ok, true);
});

test('WAV: корректный заголовок и размах', () => {
  const frames = 100;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = i % 2 === 0 ? 1 : -1;
  const bytes = encodeWav([samples], 44100);
  const info = describeWav(bytes);
  assert.equal(info.ok, true);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bits, 16);
  assert.equal(info.dataSize, frames * 2);
  assert.equal(bytes.length, 44 + frames * 2);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);

  const stereo = encodeWav([new Float32Array(10), new Float32Array(10)], 48000);
  assert.equal(describeWav(stereo).channels, 2);
  assert.equal(describeWav(stereo).dataSize, 40);
  assert.equal(describeWav(new Uint8Array(10)).ok, false);
});