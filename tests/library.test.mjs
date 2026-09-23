// FluteBand AI — тесты библиотеки: поиск и теги, сборка пьесы из нескольких страниц.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText,
  normalizeTag,
  pieceTags,
  withTag,
  withoutTag,
  collectTags,
  matchesQuery,
  filterScores,
  sortScores,
  libraryStats,
  suggestedTags,
  SUGGESTED_TAGS,
} from '../app/js/library-index.js';
import { createScore } from '../app/js/score.js';
import { appendScorePage, insertScorePage, moveScorePage, removeScorePage, rebuildScore, pageCount, pageStarts, pageOfMeasure, pagesText, DEFAULT_MAX_PAGES } from '../app/js/score-pages.js';

function piece(title, options = {}) {
  return {
    ...createScore({
      title,
      composer: options.composer || '',
      meter: options.meter,
      key: options.key,
      tempo: options.tempo,
      measures: Array.from({ length: options.measures || 4 }, (_, i) => ({
        number: String(i + 1),
        events: [{ beat: 0, dur: 1, pitches: [60 + i], voice: 'melody' }],
      })),
    }),
    id: options.id || title.toLowerCase(),
    tags: options.tags || [],
    savedAt: options.savedAt ?? 1000,
    ...(options.cover ? { cover: options.cover } : {}),
    ...(options.pages ? { pages: options.pages } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

test('поиск: регистр, ё/е и знаки не мешают находить пьесу', () => {
  assert.equal(normalizeText('  Вальс №2 (Шопен)  '), 'вальс 2 шопен');
  assert.equal(normalizeText('ВсёЁЖ'), 'всееж');
  const score = piece('Песенка про ёжика', { composer: 'Кабалевский' });
  assert.equal(matchesQuery(score, 'ежика'), true);
  assert.equal(matchesQuery(score, 'ЁЖИКА'), true);
  assert.equal(matchesQuery(score, 'кабалевск'), true);
  assert.equal(matchesQuery(score, 'шопен'), false);
  assert.equal(matchesQuery(score, ''), true, 'пустой запрос показывает всё');
});

test('поиск: несколько слов ищутся по разным полям, а теги участвуют в поиске', () => {
  const score = piece('Этюд', { composer: 'Черни', tags: ['класс 2', 'домашка'] });
  assert.equal(matchesQuery(score, 'черни этюд'), true);
  assert.equal(matchesQuery(score, 'этюд домашка'), true);
  assert.equal(matchesQuery(score, 'этюд концерт'), false);
  // Тональность и размер тоже ищутся: «D dur» находит пьесу в ре мажоре
  const inD = piece('Марш', { key: { tonic: 'D', mode: 'major', fifths: 2 }, meter: { beats: 4, beatType: 4 } });
  assert.equal(matchesQuery(inD, 'D dur'), true);
  assert.equal(matchesQuery(inD, 'марш 4/4'), true);
  assert.equal(matchesQuery(inD, 'a moll'), false);
});

test('теги: нормализация, добавление, снятие и повторы', () => {
  assert.equal(normalizeTag('  #Класс 2 '), 'класс 2');
  assert.equal(normalizeTag('ДОМАШКА'), 'домашка');
  assert.deepEqual(withTag(piece('A', { tags: ['Этюд'] }), 'этюд'), ['этюд'], 'повтор не добавляется');
  assert.deepEqual(withTag(piece('A', { tags: ['этюд'] }), 'класс 1'), ['этюд', 'класс 1']);
  assert.deepEqual(withoutTag(piece('A', { tags: ['этюд', 'класс 1'] }), 'ЭТЮД'), ['класс 1']);
  assert.deepEqual(pieceTags({ title: 'x', tags: [' Этюд ', 'этюд', '', '#Класс 2'] }), ['этюд', 'класс 2']);
});

test('теги: готовые подсказки не повторяют уже поставленные', () => {
  const score = piece('Этюд', { tags: ['класс 2', 'ЭТЮД'] });
  const suggestions = suggestedTags(score);
  assert.equal(suggestions.includes('класс 2'), false, 'уже поставленный тег не подсказываем');
  assert.equal(suggestions.includes('этюд'), false, 'повтор с другим регистром тоже учтён');
  assert.equal(suggestions.includes('класс 3'), true);
  assert.equal(suggestions.includes('домашка'), true);
  assert.ok(suggestions.length >= 8, `подсказок должно быть достаточно: ${suggestions.length}`);
  // Подсказки — обычные теги: их можно применить и они нормализуются
  assert.deepEqual(withTag(score, suggestions[0]).includes(suggestions[0]), true);
  assert.equal(normalizeTag(SUGGESTED_TAGS[0]), SUGGESTED_TAGS[0], 'подсказки уже нормализованы');
  assert.deepEqual(suggestedTags(piece('Пусто')), SUGGESTED_TAGS, 'у пьесы без тегов — весь набор');
});

test('теги библиотеки: сначала частые, потом по алфавиту', () => {
  const scores = [
    piece('A', { tags: ['этюд', 'класс 2'] }),
    piece('B', { tags: ['этюд', 'концерт'] }),
    piece('C', { tags: ['этюд'] }),
  ];
  assert.deepEqual(collectTags(scores), [
    { tag: 'этюд', count: 3 },
    { tag: 'класс 2', count: 1 },
    { tag: 'концерт', count: 1 },
  ]);
  assert.deepEqual(collectTags([]), []);
});

test('фильтр библиотеки: тег + запрос + порядок', () => {
  const scores = [
    piece('Вальс', { tags: ['концерт'], savedAt: 300, measures: 8 }),
    piece('Этюд', { tags: ['домашка'], savedAt: 200, measures: 4 }),
    piece('Песня', { tags: ['домашка'], savedAt: 100, measures: 6, composer: 'Чайковский' }),
  ];
  assert.deepEqual(filterScores(scores, { tag: 'домашка' }).map((s) => s.title), ['Этюд', 'Песня']);
  assert.deepEqual(filterScores(scores, { query: 'чайк' }).map((s) => s.title), ['Песня']);
  assert.deepEqual(filterScores(scores, { sort: 'title' }).map((s) => s.title), ['Вальс', 'Песня', 'Этюд']);
  assert.deepEqual(filterScores(scores, { sort: 'measures' }).map((s) => s.title), ['Вальс', 'Песня', 'Этюд']);
  // Тег и запрос действуют вместе
  assert.deepEqual(filterScores(scores, { tag: 'домашка', query: 'этюд' }).map((s) => s.title), ['Этюд']);
  assert.deepEqual(filterScores(scores, { tag: 'концерт', query: 'этюд' }), []);
  assert.deepEqual(sortScores(scores).map((s) => s.title), ['Вальс', 'Этюд', 'Песня'], 'по умолчанию — сначала новые');
});

test('сводка библиотеки: пьесы, теги, страницы, снимки с обложкой', () => {
  const stats = libraryStats([
    piece('A', { tags: ['этюд'], pages: 2, cover: 'data:image/jpeg;base64,x', source: { kind: 'omr' } }),
    piece('B', { tags: ['этюд', 'класс 2'], source: { kind: 'manual' } }),
  ]);
  assert.deepEqual(stats, { pieces: 2, tags: 2, pages: 3, scanned: 1, withCover: 1 });
  assert.deepEqual(libraryStats([]), { pieces: 0, tags: 0, pages: 0, scanned: 0, withCover: 0 });
});

test('страницы: две страницы склеиваются в одну пьесу с нумерацией тактов', () => {
  const first = piece('Сборник', { measures: 4, pages: 1, pageStarts: [0] });
  const second = piece('Сборник', { measures: 3, id: 'page2' });
  const result = appendScorePage(first, second);
  assert.equal(result.ok, true);
  assert.equal(result.addedMeasures, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.score.measures.length, 7);
  assert.deepEqual(result.score.measures.map((m) => m.number), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(result.score.measures.map((m) => m.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pageStarts(result.score), [0, 4]);
  assert.equal(pageCount(result.score), 2);
  assert.equal(first.measures.length, 4, 'исходная пьеса не изменилась');
});

test('страницы: третья страница продолжает ту же пьесу', () => {
  const first = piece('Сборник', { measures: 4, pages: 1, pageStarts: [0] });
  const second = piece('Сборник', { measures: 4 });
  const third = piece('Сборник', { measures: 2 });
  const afterTwo = appendScorePage(first, second).score;
  const afterThree = appendScorePage(afterTwo, third).score;
  assert.equal(afterThree.measures.length, 10);
  assert.equal(pageCount(afterThree), 3);
  assert.deepEqual(pageStarts(afterThree), [0, 4, 8]);
  assert.equal(pageOfMeasure(afterThree, 0), 1);
  assert.equal(pageOfMeasure(afterThree, 3), 1);
  assert.equal(pageOfMeasure(afterThree, 4), 2);
  assert.equal(pageOfMeasure(afterThree, 9), 3);
  assert.equal(pagesText(afterThree), '3 стр.');
  assert.equal(pagesText(first), null, 'одна страница — подпись не нужна');
});

test('страницы: расхождения размера, тональности и темпа дают предупреждения', () => {
  const first = piece('Сборник', { meter: { beats: 4, beatType: 4 }, key: { tonic: 'C', mode: 'major', fifths: 0 }, tempo: 100 });
  const other = piece('Сборник', {
    meter: { beats: 3, beatType: 4 },
    key: { tonic: 'G', mode: 'major', fifths: 1 },
    tempo: 132,
  });
  const result = appendScorePage(first, other);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /размер/);
  assert.match(result.warnings[1], /тональность/);
  assert.match(result.warnings[2], /темп/);
  // Размер и тональность остаются прежними — пьеса не разваливается на две
  assert.deepEqual(result.score.meter, { beats: 4, beatType: 4 });
  assert.equal(result.score.key.tonic, 'C');
  assert.equal(result.score.tempo, 100);
  assert.equal(result.score.measures.length, first.measures.length + other.measures.length);
});

test('страницы: пустая страница и превышение лимита не портят пьесу', () => {
  const first = piece('Сборник', { measures: 4 });
  const empty = { ...piece('Пусто', { measures: 0 }), measures: [] };
  const rejected = appendScorePage(first, empty);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /нот/);
  assert.equal(rejected.score.measures.length, 4);

  let collected = first;
  for (let i = 1; i < DEFAULT_MAX_PAGES; i += 1) collected = appendScorePage(collected, piece('Сборник', { measures: 2 })).score;
  assert.equal(pageCount(collected), DEFAULT_MAX_PAGES);
  const overflow = appendScorePage(collected, piece('Сборник', { measures: 2 }));
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, new RegExp(String(DEFAULT_MAX_PAGES)));
  assert.equal(overflow.score.measures.length, collected.measures.length);
});

test('страницы: первая страница становится пьесой, если пьесы ещё нет', () => {
  const page = piece('Новая', { measures: 3 });
  const result = appendScorePage(null, page);
  assert.equal(result.ok, true);
  assert.equal(result.first, true);
  assert.equal(result.score.measures.length, 3);
  assert.equal(pageCount(result.score), 1);
  assert.equal(appendScorePage(null, null).ok, false);
});

test('страницы: пропущенную страницу можно вставить в середину', () => {
  const first = piece('Сборник', { measures: 4, pages: 1, pageStarts: [0] });
  const second = piece('Сборник', { measures: 3 });
  const third = piece('Сборник', { measures: 2 });
  // Сняли 1-ю и 3-ю страницы, потом нашли 2-ю: вставляем её между ними
  const afterTwo = appendScorePage(first, third).score;
  assert.deepEqual(pageStarts(afterTwo), [0, 4]);

  const result = insertScorePage(afterTwo, second, { at: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.at, 1);
  assert.equal(result.pages, 3);
  assert.equal(result.score.measures.length, 9);
  assert.deepEqual(result.score.measures.map((m) => m.number), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(pageStarts(result.score), [0, 4, 7], 'вставка перед третьей страницей');
  assert.equal(pageOfMeasure(result.score, 4), 2, 'вставленная страница начинается с 5-го такта');
  assert.equal(pageOfMeasure(result.score, 6), 2);
  assert.equal(pageOfMeasure(result.score, 7), 3, 'прежняя вторая страница сдвинулась и стала третьей');
  assert.equal(afterTwo.measures.length, 6, 'исходная пьеса не изменилась');
  // Вставка в начало и в конец — тоже допустима
  assert.equal(insertScorePage(afterTwo, second, { at: 0 }).at, 0);
  assert.deepEqual(pageStarts(insertScorePage(afterTwo, second, { at: 0 }).score), [0, 3, 7]);
  assert.equal(insertScorePage(afterTwo, second, { at: 99 }).at, 2, 'позиция за пределами — в конец');
  assert.equal(insertScorePage(null, second).first, true, 'вставка в пустую пьесу = первая страница');
});

test('страницы: страницы можно переставить местами и убрать лишнюю', () => {
  const first = piece('Сборник', { measures: 4, pages: 1, pageStarts: [0] });
  const second = piece('Сборник', { measures: 3 });
  const combined = appendScorePage(first, second).score;
  assert.deepEqual(pageStarts(combined), [0, 4]);

  // Сняли страницы не в том порядке: поднимаем вторую наверх
  const moved = moveScorePage(combined, { from: 1, to: 0 });
  assert.equal(moved.ok, true);
  assert.equal(moved.moved, true);
  assert.deepEqual(pageStarts(moved.score), [0, 3], 'теперь первая страница — три такта');
  assert.equal(moved.score.measures.length, 7, 'такт не потерялся');
  assert.deepEqual(moved.score.measures.map((m) => m.number), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(combined.measures.length, 7);

  const noop = moveScorePage(combined, { from: 0, to: 0 });
  assert.equal(noop.moved, false);
  assert.equal(noop.score, combined, 'перестановка на себя ничего не меняет');
  assert.equal(moveScorePage(combined, { from: 5, to: 0 }).ok, false);
  assert.match(moveScorePage(combined, { from: 5, to: 0 }).reason, /нет такой страницы/);
  assert.equal(moveScorePage(piece('Одна', { measures: 4 }), { from: 0, to: 1 }).ok, false, 'одна страница не переставляется');

  // Лишняя страница (сняли чужую пьесу) убирается
  const removed = removeScorePage(combined, { at: 1 });
  assert.equal(removed.ok, true);
  assert.equal(removed.removedMeasures, 3);
  assert.equal(removed.score.measures.length, 4);
  assert.equal(pageCount(removed.score), 1);
  assert.deepEqual(removed.score.pageStarts, [0]);
  assert.equal(removeScorePage(combined, { at: 9 }).ok, false);
  assert.equal(removeScorePage(piece('Одна', { measures: 4 }), { at: 0 }).ok, false);
});

test('страницы: вставка многостраничной пьесы сохраняет её собственные границы', () => {
  const first = piece('Сборник', { measures: 2, pages: 1, pageStarts: [0] });
  const block = rebuildScore(piece('Блок', { measures: 6 }), [
    piece('Блок', { measures: 4 }).measures,
    piece('Блок', { measures: 2 }).measures,
  ]);
  assert.equal(pageCount(block), 2);
  const result = insertScorePage(first, block, { at: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.score.measures.length, 8);
  assert.deepEqual(pageStarts(result.score), [0, 4, 6], 'обе страницы блока встали перед первой');
  assert.equal(result.score.pages, 3);
});