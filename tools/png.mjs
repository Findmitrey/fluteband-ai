// FluteBand AI — минимальный PNG-кодер/декодер для стенда предобработки.
//
// Зачем свой: стенд должен прогонять через предобработку (app/js/image-prep.js) ровно те же пиксели,
// что получает движок распознавания, а ставить графические библиотеки ради замера не хочется.
// Поддержано то, что реально отдают Chrome и наши инструменты: 8 бит на канал,
// типы 0 (серый), 2 (RGB), 4 (серый+альфа), 6 (RGBA), без интерлейса.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Прочитать PNG и вернуть {width, height, data} — data в формате RGBA (как ImageData). */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('это не PNG');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!header) throw new Error('в PNG нет IHDR');
  if (header.bitDepth !== 8) throw new Error(`поддержаны только 8 бит на канал (получено ${header.bitDepth})`);
  if (header.interlace !== 0) throw new Error('интерлейс не поддержан');
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`не поддержан тип цвета ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`неизвестный фильтр PNG ${filter}`);
      }
      pixels[rowStart + x] = restored & 0xff;
    }
    position += stride;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
    const s = i * channels;
    if (channels === 1) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = pixels[s];
      rgba[p + 3] = 255;
    } else if (channels === 2) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = pixels[s];
      rgba[p + 3] = pixels[s + 1];
    } else if (channels === 3) {
      rgba[p] = pixels[s];
      rgba[p + 1] = pixels[s + 1];
      rgba[p + 2] = pixels[s + 2];
      rgba[p + 3] = 255;
    } else {
      rgba[p] = pixels[s];
      rgba[p + 1] = pixels[s + 1];
      rgba[p + 2] = pixels[s + 2];
      rgba[p + 3] = pixels[s + 3];
    }
  }
  return { width, height, data: rgba };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Записать PNG (RGBA, 8 бит) — используется для «страницы после предобработки». */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // фильтр 0 — так файл больше, зато код простой и предсказуемый
    for (let x = 0; x < stride; x += 1) raw[y * (stride + 1) + 1 + x] = data[y * stride + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}