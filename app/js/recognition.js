// FluteBand AI — клиент сервиса распознавания (OMR). Сервер отдаёт MusicXML, клиент строит модель.
import { musicXmlToScore } from './musicxml.js';
import { FIXTURES } from './fixtures.js';

export const DEFAULT_ENDPOINT = '/api/recognize';

/**
 * Базовый адрес сервиса распознавания.
 * Пусто — сервис рядом с приложением (`/api/*`, так работает локальный запуск и прокси),
 * иначе адрес указывается целиком: приложение на статическом хостинге и сервис на другом
 * бесплатном тарифе живут на разных адресах.
 */
export function normalizeApiBase(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // Разрешаем писать без схемы: «omr.example.com/api» → https://omr.example.com/api
  if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(raw)) return `https://${raw}`;
  return raw;
}

/** Адрес ручки сервиса: без базы получается свой каталог (`.../api/recognize`). */
export function apiEndpoint(path, base = '') {
  const cleanBase = normalizeApiBase(base);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (cleanBase) return `${cleanBase}${suffix}`;
  // «Сервис рядом с приложением»: адрес считается от самого приложения, а не от корня сайта.
  // На бесплатном хостинге приложение лежит в подкаталоге (https://имя.github.io/fluteband/),
  // и путь от корня увёл бы запрос в чужой сайт.
  const href = globalThis.location?.href;
  if (href) {
    try {
      return new URL(`api${suffix}`, href).toString();
    } catch {
      /* некорректный адрес страницы — остаётся путь от корня */
    }
  }
  return `/api${suffix}`;
}

export async function checkServer(base = '', { timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiEndpoint('/health', base), { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const info = await res.json().catch(() => ({}));
    return { ok: true, info };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'таймаут' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Отправить страницу на распознавание.
 * Ответ сервера: JSON { musicxml, engine, mode, warnings } либо сам MusicXML.
 *
 * `mode`:
 *   'full'   — вся страница: мелодия и партии фортепиано (гармония точнее, ждать дольше);
 *   'melody' — только мелодический стан каждой системы: сервис вырезает аккомпанирующие станы, и
 *              распознавание идёт в разы быстрее, потому что движок приводит картинку к ширине 1920 px
 *              и время зависит от высоты. Мелодия при этом получается та же, а гармония выводится из неё.
 */
export async function recognizeImageBlob(blob, {
  base = '',
  endpoint = null,
  timeoutMs = 45000,
  engine = null,
  mode = 'full',
  signal = null,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const url = endpoint || apiEndpoint('/recognize', base);
  try {
    const form = new FormData();
    form.append('image', blob, 'page.jpg');
    if (engine) form.append('engine', engine);
    if (mode && mode !== 'full') form.append('mode', mode);
    const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Сервер ответил ${res.status}`, detail: detail.slice(0, 400) };
    }
    if (contentType.includes('xml')) {
      const musicxml = await res.text();
      return { ok: true, musicxml, engine: 'server', mode: 'full', confidence: null, warnings: [] };
    }
    const payload = await res.json();
    if (payload.musicxml) {
      return {
        ok: true,
        musicxml: payload.musicxml,
        engine: payload.engine || 'server',
        mode: payload.mode || 'full',
        melody: payload.melody || null,
        elapsedMs: payload.elapsedMs ?? null,
        confidence: payload.confidence ?? null,
        warnings: payload.warnings || [],
      };
    }
    if (payload.error) return { ok: false, error: payload.error, detail: payload.hint || '' };
    return { ok: false, error: 'Неожиданный ответ сервера' };
  } catch (error) {
    const aborted = error.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'Превышено время ожидания распознавания' : 'Не удалось связаться с сервером распознавания',
      detail: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function scoreFromMusicXmlText(xmlText, meta = {}) {
  return musicXmlToScore(xmlText, meta);
}

/** Эталонная страница — позволяет проверить весь тракт без сервера (решение: демо-режим) */
export function demoRecognitionScore(which = 'odeToJoy') {
  const xml = FIXTURES[which] || FIXTURES.odeToJoy;
  return musicXmlToScore(xml, {
    engine: 'эталонная страница (демо)',
    kind: 'demo',
    confidence: 1,
  });
}

export const FIXTURE_CHOICES = [
  { id: 'odeToJoy', name: 'Ода к радости (4 такта, аккорды есть)' },
  { id: 'noHarmony', name: 'Мелодия без аккордов (авто-гармония)' },
  { id: 'twoVoice', name: 'Двухголосие: мелодия + бас' },
];

// ---------------------------------------------------------------------------
// Загрузка файлов с устройства: фото нот и файлы MusicXML.
// Разбор MusicXML идёт целиком на устройстве — сервер не нужен вообще.

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|bmp|gif|tiff?)$/i;
const XML_EXT = /\.(musicxml|xml)$/i;
const ZIP_EXT = /\.(mxl|zip)$/i;

export function isImageFile(file) {
  const type = file?.type || '';
  return type.startsWith('image/') || IMAGE_EXT.test(file?.name || '');
}

export function isMusicXmlFile(file) {
  const type = file?.type || '';
  return XML_EXT.test(file?.name || '') || type.includes('xml');
}

export function isCompressedScore(file) {
  return ZIP_EXT.test(file?.name || '');
}

/**
 * Прочитать пьесу прямо из файла MusicXML (без сервера).
 * Возвращает { ok, score } либо { ok: false, error } — чтобы вызывающий код показал понятный текст.
 */
export async function scoreFromUploadedFile(file, meta = {}) {
  if (isCompressedScore(file)) {
    return {
      ok: false,
      error: 'Файл .mxl — это архив. Распакуйте его и загрузите .musicxml или .xml',
    };
  }
  if (!isMusicXmlFile(file)) {
    return { ok: false, error: 'Это не файл MusicXML — нужен .musicxml или .xml' };
  }
  const text = await file.text();
  if (!text.trim().startsWith('<')) {
    return { ok: false, error: 'Файл не похож на MusicXML (внутри не разметка)' };
  }
  const score = musicXmlToScore(text, {
    ...meta,
    kind: meta.kind || 'manual',
    engine: meta.engine || `файл ${file.name}`,
    title: meta.title || file.name.replace(/\.[^.]+$/, ''),
  });
  return { ok: true, score };
}