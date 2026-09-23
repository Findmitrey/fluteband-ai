// FluteBand AI — поиск, теги и порядок в библиотеке пьес.
//
// Модуль без DOM: библиотека может быть длинной (сборник за год занятий), поэтому поиск и теги
// живут отдельно от интерфейса и проверяются юнит-тестами.

import { scoreSummary } from './score.js';

/** Привести текст к виду, удобному для поиска: регистр, ё/е, лишние знаки. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Тег в том виде, в каком он хранится: без решётки, без лишних пробелов, в нижнем регистре. */
export function normalizeTag(tag) {
  return normalizeText(String(tag ?? '').replace(/^#+/, ''));
}

/** Теги пьесы (нормализованные, без повторов). */
export function pieceTags(score) {
  const tags = Array.isArray(score?.tags) ? score.tags : [];
  const seen = new Set();
  for (const tag of tags) {
    const clean = normalizeTag(tag);
    if (clean) seen.add(clean);
  }
  return [...seen];
}

export function withTag(score, tag) {
  const clean = normalizeTag(tag);
  if (!clean) return pieceTags(score);
  const tags = pieceTags(score);
  return tags.includes(clean) ? tags : [...tags, clean];
}

export function withoutTag(score, tag) {
  const clean = normalizeTag(tag);
  return pieceTags(score).filter((item) => item !== clean);
}

/**
 * Готовые теги для сборника: то, что реально пишут на полях — класс, жанр, задание.
 * Пользователь по-прежнему может ввести свой тег; это только подсказки, чтобы не набирать руками.
 */
export const SUGGESTED_TAGS = [
  'класс 1',
  'класс 2',
  'класс 3',
  'класс 4',
  'класс 5',
  'этюд',
  'пьеса',
  'гамма',
  'упражнение',
  'домашка',
  'на повторение',
  'концерт',
];

/** Готовые теги, которых у пьесы ещё нет (в том же порядке, что и подсказки). */
export function suggestedTags(score, presets = SUGGESTED_TAGS) {
  const tags = new Set(pieceTags(score));
  return presets.map((tag) => normalizeTag(tag)).filter((tag) => tag && !tags.has(tag));
}

/** Все теги библиотеки с числом пьес: сначала частые, потом по алфавиту. */
export function collectTags(scores) {
  const counts = new Map();
  for (const score of scores || []) {
    for (const tag of pieceTags(score)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'ru'));
}

/** Текст, по которому ищется пьеса: название, автор, теги, тональность, размер, источник. */
export function searchableText(score) {
  const summary = scoreSummary(score);
  return normalizeText([
    score?.title,
    score?.composer,
    pieceTags(score).join(' '),
    summary.key,
    summary.meter,
    score?.source?.engine,
    score?.source?.kind,
  ].filter(Boolean).join(' '));
}

/**
 * Подходит ли пьеса под запрос. Запрос разбивается на слова, и каждое слово должно найтись
 * хотя бы в одном поле: «шопен вальс» найдёт «Вальс» с тегом «шопен», а не потребует точной фразы.
 */
export function matchesQuery(score, query) {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const text = searchableText(score);
  return words.every((word) => text.includes(word));
}

export const SORTS = [
  { id: 'savedAt', title: 'сначала новые' },
  { id: 'title', title: 'по названию' },
  { id: 'composer', title: 'по автору' },
  { id: 'measures', title: 'по длине' },
];

export function sortScores(scores, sort = 'savedAt') {
  const list = [...(scores || [])];
  const byTitle = (score) => normalizeText(score?.title || '');
  if (sort === 'title') return list.sort((a, b) => byTitle(a).localeCompare(byTitle(b), 'ru'));
  if (sort === 'composer') return list.sort((a, b) => normalizeText(a?.composer).localeCompare(normalizeText(b?.composer), 'ru') || byTitle(a).localeCompare(byTitle(b), 'ru'));
  if (sort === 'measures') return list.sort((a, b) => (b?.measures?.length || 0) - (a?.measures?.length || 0));
  return list.sort((a, b) => (b?.savedAt || 0) - (a?.savedAt || 0));
}

/** Отфильтровать и отсортировать библиотеку: сначала тег, потом поиск, потом порядок. */
export function filterScores(scores, { query = '', tag = null, sort = 'savedAt' } = {}) {
  const cleanTag = normalizeTag(tag);
  const filtered = (scores || []).filter((score) => {
    if (cleanTag && !pieceTags(score).includes(cleanTag)) return false;
    return matchesQuery(score, query);
  });
  return sortScores(filtered, sort);
}

/** Сколько всего пьес, тегов и страниц в библиотеке — для строки состояния. */
export function libraryStats(scores) {
  const list = scores || [];
  return {
    pieces: list.length,
    tags: collectTags(list).length,
    pages: list.reduce((sum, score) => sum + (score?.pages || 1), 0),
    scanned: list.filter((score) => score?.source?.kind === 'omr').length,
    withCover: list.filter((score) => !!score?.cover).length,
  };
}