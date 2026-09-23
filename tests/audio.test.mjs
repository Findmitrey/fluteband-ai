// FluteBand AI — тесты звука: банки сэмплов, выбор опорной ноты, метрики WAV.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOMPANIMENT_MAX_MIDI,
  ACCOMPANIMENT_MIN_MIDI,
  BANKS,
  anchorMidis,
  bankById,
  chooseAnchor,
  describeBank,
  formatBytes,
  noteFileName,
  planLoad,
  velocityShape,
  voiceEnvelope,
} from '../app/js/sampler.js';
import { analyzeChannels, bandEnergy, encodeWav, describeWav } from '../app/js/wav.js';

test('звук: оба свободных банка описаны и доступны по id', () => {
  assert.equal(BANKS.length, 3);
  assert.equal(bankById('royal').title.includes('Salamander'), true);
  assert.equal(bankById('compact').license.includes('MIT'), true);
  assert.equal(bankById('нет-такого').id, 'tone', 'неизвестный банк → встроенный синтез');
  assert.equal(bankById('tone').offline, true);
  for (const bank of BANKS) {
    if (bank.id === 'tone') continue;
    assert.ok(bank.base.startsWith('https://'), `банк ${bank.id}: только https`);
    assert.ok(bank.license && bank.source, `банк ${bank.id}: нужны лицензия и источник`);
  }
});

test('звук: имена файлов сэмплов по правилам банков (диезы и бемоли)', () => {
  assert.equal(noteFileName(60), 'C4');
  assert.equal(noteFileName(60, 'sharp'), 'C4');
  assert.equal(noteFileName(61, 'sharp'), 'Cs4');
  assert.equal(noteFileName(61, 'flat'), 'Db4');
  assert.equal(noteFileName(70, 'sharp'), 'As4');
  assert.equal(noteFileName(70, 'flat'), 'Bb4');
  assert.equal(noteFileName(36), 'C2');
  assert.equal(noteFileName(24), 'C1');
  assert.equal(noteFileName(95), 'B6');
  // ровно то, что реально лежит на серверах банков
  assert.equal(noteFileName(66, 'flat'), 'Gb4');
  assert.equal(noteFileName(66, 'sharp'), 'Fs4');
});

test('звук: сетка опорных нот покрывает диапазон минуса', () => {
  const royal = anchorMidis(bankById('royal'));
  assert.equal(royal[0], ACCOMPANIMENT_MIN_MIDI);
  assert.ok(royal[royal.length - 1] <= ACCOMPANIMENT_MAX_MIDI);
  assert.equal(royal[1] - royal[0], 3, 'у записи рояля шаг 3 полутона');
  for (let i = 1; i < royal.length; i += 1) assert.equal(royal[i] - royal[i - 1], 3);

  const compact = anchorMidis(bankById('compact'));
  assert.equal(compact.length, ACCOMPANIMENT_MAX_MIDI - ACCOMPANIMENT_MIN_MIDI + 1, 'у компактного банка есть все ноты');
  assert.equal(compact[1] - compact[0], 1);
});

test('звук: план загрузки считает ссылки и объём', () => {
  const plan = planLoad(bankById('royal'));
  assert.equal(plan.count, plan.notes.length);
  assert.ok(plan.count >= 15 && plan.count <= 20, `нот в плане: ${plan.count}`);
  assert.ok(plan.notes.every((note) => note.url.endsWith(`/${note.name}.mp3`)));
  assert.equal(plan.notes[0].url.includes('/C2.mp3'), true);
  assert.ok(plan.approxBytes > 1024 * 1024, 'рояль весит больше мегабайта');
  assert.equal(plan.approxBytesText.includes('МБ'), true);

  const compactPlan = planLoad(bankById('compact'));
  assert.ok(compactPlan.approxBytes < plan.approxBytes, 'компактный банк легче');
  assert.equal(formatBytes(0), '0 КБ');
  assert.equal(formatBytes(25 * 1024), '25 КБ');
});

test('звук: выбирается ближайшая опорная нота, сдвиг минимальный', () => {
  const anchors = anchorMidis(bankById('royal')); // 36, 39, 42, …
  assert.equal(chooseAnchor(36, anchors).anchorMidi, 36);
  assert.equal(chooseAnchor(37, anchors).anchorMidi, 36);
  assert.equal(chooseAnchor(38, anchors).anchorMidi, 39, '38 ближе к 39');
  assert.equal(chooseAnchor(43, anchors).semitones, 1);
  assert.equal(chooseAnchor(43, anchors).playbackRate.toFixed(3), Math.pow(2, 1 / 12).toFixed(3));
  assert.equal(chooseAnchor(36, []), null);

  // для каждой ноты минуса сдвиг не больше половины шага банка
  for (let midi = ACCOMPANIMENT_MIN_MIDI; midi <= ACCOMPANIMENT_MAX_MIDI; midi += 1) {
    const anchor = chooseAnchor(midi, anchors);
    assert.ok(anchor.distance <= 1.5, `нота ${midi}: сдвиг ${anchor.distance}`);
  }
  // в компактном банке сдвига нет вообще
  const compact = anchorMidis(bankById('compact'));
  for (const midi of [36, 55, 72, 84]) assert.equal(chooseAnchor(midi, compact).distance, 0);
});

test('звук: сила нажатия меняет громкость и яркость по возрастанию', () => {
  const soft = velocityShape(0.25);
  const hard = velocityShape(0.95);
  assert.ok(soft.amplitude < hard.amplitude, 'тихая нота тише');
  assert.ok(soft.lowpassHz < hard.lowpassHz, 'тихая нота глуше');
  assert.ok(soft.releaseSeconds > hard.releaseSeconds, 'тихая нота затухает мягче');
  assert.equal(velocityShape(0).amplitude > 0, true, 'нулевая сила не даёт тишину-деление на ноль');
  assert.equal(velocityShape(2).velocity, 1, 'сила ограничена сверху');
});

test('звук: огибающая ноты не короче требуемой длительности', () => {
  const env = voiceEnvelope({ durSeconds: 1.5, velocity: 0.8, sampleSeconds: 3 });
  assert.ok(env.attack > 0 && env.attack < 0.02);
  assert.ok(env.end > 1.5, 'нота звучит дольше, чем держится клавиша');
  assert.ok(env.release > 0.1);
  const short = voiceEnvelope({ durSeconds: 0.1 });
  assert.ok(short.hold >= 0.05, 'слишком короткие ноты всё равно слышны');
});

test('звук: описание банка для интерфейса', () => {
  const royal = describeBank('royal');
  assert.equal(royal.id, 'royal');
  assert.ok(royal.notes > 10);
  assert.ok(royal.bytes.includes('МБ'));
  assert.ok(royal.license.includes('CC BY'));
  const tone = describeBank('tone');
  assert.equal(tone.offline, true);
  assert.equal(tone.notes, 0);
});

test('звук: замеры сигнала отличают звук от тишины', () => {
  const silent = analyzeChannels([new Float32Array(1000)]);
  assert.equal(silent.silent, true);
  assert.equal(silent.peak, 0);
  assert.equal(silent.nonSilentRatio, 0);

  const wave = new Float32Array(1000);
  for (let i = 0; i < wave.length; i += 1) wave[i] = 0.5 * Math.sin((i / 1000) * Math.PI * 20);
  const loud = analyzeChannels([wave]);
  assert.equal(loud.silent, false);
  assert.ok(loud.peak > 0.4 && loud.peak <= 0.5);
  assert.ok(loud.rms > 0.2 && loud.rms < loud.peak);
  assert.ok(loud.peakDb < 0, 'пик меньше единицы, значит децибелы отрицательные');

  const doubled = analyzeChannels([wave, wave]);
  assert.equal(doubled.frames, loud.frames * 2, 'учитываются оба канала');
  assert.equal(doubled.rms, loud.rms, 'средняя громкость канала не меняется');
  assert.equal(doubled.silent, false);
});

test('звук: распределение энергии по полосам различает низкий и высокий тон', () => {
  const sampleRate = 44100;
  const makeTone = (hz, seconds = 0.5) => {
    const data = new Float32Array(Math.round(sampleRate * seconds));
    for (let i = 0; i < data.length; i += 1) data[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    return data;
  };

  const bass = bandEnergy([makeTone(80)], sampleRate);
  assert.ok(bass.low > 0.9, `низкий тон должен быть в нижней полосе, а не ${bass.low}`);
  assert.ok(bass.high < 0.05, 'в низком тоне почти нет верха');

  const mid = bandEnergy([makeTone(700)], sampleRate);
  assert.ok(mid.mid > 0.7, `середина должна попасть в среднюю полосу: ${mid.mid}`);

  const high = bandEnergy([makeTone(6000)], sampleRate);
  // Фильтры однополюсные, поэтому оценка грубая: важна не абсолютная доля, а порядок
  assert.ok(high.high > 0.6, `высокий тон должен быть в верхней полосе: ${high.high}`);
  assert.ok(high.high > high.mid && high.mid > high.low, 'у высокого тона верхняя полоса главная');
  assert.ok(high.high > mid.high && mid.high > bass.high, 'доля верха растёт с частотой тона');

  assert.ok(high.centroidHz > mid.centroidHz && mid.centroidHz > bass.centroidHz, 'яркость растёт с частотой');
  assert.deepEqual(bandEnergy([new Float32Array(100)]), { low: 0, mid: 0, high: 0, centroidHz: 0 });
});

test('звук: экспорт WAV из каналов читается обратно', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const right = new Float32Array([0, -0.5, 0.5, -1, 1]);
  const bytes = encodeWav([left, right], 44100);
  const info = describeWav(bytes);
  assert.equal(info.ok, true);
  assert.equal(info.id, 'RIFF');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.bits, 16);
  assert.equal(info.dataSize, 5 * 2 * 2, 'кадров 5, каналов 2, по 2 байта');
  assert.equal(info.size, 44 + info.dataSize);
  const metrics = analyzeChannels([left, right]);
  assert.ok(metrics.peak >= 0.99, 'единичная амплитуда должна читаться как пик');
});