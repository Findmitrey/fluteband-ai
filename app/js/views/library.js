// FluteBand AI — экран «Библиотека»: демо-пьесы, поиск и теги, сохранённые пьесы, импорт MusicXML.
import { DEMOS, demoById } from '../demo.js';
import { listScores, deleteScore, patchScore } from '../storage.js';
import { scoreSummary } from '../score.js';
import { pageCount } from '../score-pages.js';
import { collectTags, filterScores, libraryStats, withTag, withoutTag, normalizeTag, suggestedTags, SUGGESTED_TAGS, SORTS } from '../library-index.js';
import { scoreFromMusicXmlText, FIXTURE_CHOICES, demoRecognitionScore, isImageFile, isMusicXmlFile, scoreFromUploadedFile } from '../recognition.js';
import { prepareImageBlob } from '../camera.js';
import { S, measuresText, t } from '../ui-strings.js';

/** Экранирование текста в разметке: названия приходят из файлов и MusicXML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export class LibraryView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.query = '';
    this.sort = 'savedAt';
    this.tag = null;
    this.all = [];
  }

  mount() {
    this.root.innerHTML = `
      <section class="card">
        <h2>${S.library.demoTitle}</h2>
        <div class="list" id="demo-list"></div>
      </section>

      <section class="card">
        <h2>${S.library.omrTitle}</h2>
        <div class="filters">
          <input class="input" id="lib-search" type="search" placeholder="${S.library.search}" autocomplete="off">
          <select class="input" id="lib-sort" title="${S.library.sort}">
            ${SORTS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}
          </select>
        </div>
        <div class="tags" id="lib-tags"></div>
        <p class="muted small" id="lib-summary"></p>
        <div class="list" id="saved-list"></div>
        <p class="muted small">${S.library.tagHint}</p>
      </section>

      <section class="card">
        <h2>${S.library.importMusicXml}</h2>
        <div class="row">
          <button class="btn" id="btn-import-file">${S.scan.uploadFile}</button>
          <select class="input" id="fixture-select">
            ${FIXTURE_CHOICES.map((f) => `<option value="${f.id}">${f.name}</option>`).join('')}
          </select>
          <button class="btn ghost" id="btn-fixture">${S.scan.useDemoPage}</button>
        </div>
        <p class="muted small">${S.scan.uploadHint}</p>
        <details class="details">
          <summary>${S.library.pasteMusicXml}</summary>
          <textarea class="input mono" id="musicxml-text" rows="6" placeholder="${S.library.pastePlaceholder}"></textarea>
          <button class="btn" id="btn-parse-xml">${S.library.parse}</button>
        </details>
        <input type="file" id="file-xml" accept="image/*,.musicxml,.xml,application/xml,text/xml" hidden>
        <p class="muted small" id="import-status"></p>
      </section>
    `;

    const demos = this.root.querySelector('#demo-list');
    for (const demo of DEMOS) {
      const score = demoById(demo.id);
      const item = document.createElement('button');
      item.className = 'list-item';
      item.innerHTML = `
        <span class="list-title">${esc(demo.name)}</span>
        <span class="list-meta">${esc(score.composer || '—')} · ${measuresText(score.measures.length)}</span>
      `;
      item.addEventListener('click', () => this.app.openScore(score, { source: 'demo' }));
      demos.appendChild(item);
    }

    const search = this.root.querySelector('#lib-search');
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.refresh();
    });
    const sort = this.root.querySelector('#lib-sort');
    sort.value = this.sort;
    sort.addEventListener('change', () => {
      this.sort = sort.value;
      this.refresh();
    });

    this.root.querySelector('#btn-import-file').addEventListener('click', () => {
      this.root.querySelector('#file-xml').click();
    });
    this.root.querySelector('#file-xml').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      await this.acceptFile(file);
    });
    this.root.querySelector('#btn-parse-xml').addEventListener('click', async () => {
      const text = this.root.querySelector('#musicxml-text').value;
      if (!text.trim()) return;
      await this.#parseText(text, null);
    });
    this.root.querySelector('#btn-fixture').addEventListener('click', () => {
      const id = this.root.querySelector('#fixture-select').value;
      this.app.openScore(demoRecognitionScore(id), { source: 'demo' });
    });

    this.refresh();
  }

  /**
   * Один вход для файлов: MusicXML разбираем сразу, фото нот отправляем на экран распознавания.
   */
  async acceptFile(file) {
    const status = this.root.querySelector('#import-status');
    if (isMusicXmlFile(file)) {
      const loaded = await scoreFromUploadedFile(file, { engine: 'импорт MusicXML' });
      if (!loaded.ok) {
        status.textContent = loaded.error;
        this.app.toast(loaded.error);
        return;
      }
      status.textContent = `${S.library.loaded}: ${loaded.score.title} (${measuresText(loaded.score.measures.length)})`;
      this.app.openScore(loaded.score, { source: 'manual' });
      return;
    }
    if (isImageFile(file)) {
      // Фото нот обрабатывается на экране «Сканировать»: там камера, подготовка снимка и распознавание
      this.app.setView('scan');
      const scan = this.app.views?.scan;
      if (scan) {
        const prepared = await prepareImageBlob(file, { maxSide: 2000 });
        await scan.setImage(prepared, file.name);
        status.textContent = `${file.name}: фото готово к распознаванию`;
      }
      return;
    }
    status.textContent = S.scan.fileUnsupported;
    this.app.toast(S.scan.fileUnsupported);
  }

  async #parseText(text, name) {
    const status = this.root.querySelector('#import-status');
    try {
      const score = scoreFromMusicXmlText(text, { engine: 'импорт MusicXML', kind: 'manual', title: name || undefined });
      status.textContent = `${S.library.loaded}: ${score.title} (${measuresText(score.measures.length)})`;
      this.app.openScore(score, { source: 'manual' });
    } catch (error) {
      status.textContent = `${S.common.error}: ${error.message}`;
    }
  }

  /** Добавить тег пьесе. Поле ввода появляется прямо в строке — без всплывающих окон. */
  #tagEditor(score) {
    const wrap = document.createElement('div');
    wrap.className = 'tags';
    wrap.dataset.tags = score.id;
    for (const tag of score.tags || []) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.dataset.tag = tag;
      chip.innerHTML = `${esc(tag)} <span class="tag-x">×</span>`;
      chip.title = S.library.tagRemoved;
      chip.addEventListener('click', async (event) => {
        event.stopPropagation();
        await patchScore(score.id, { tags: withoutTag(score, tag) });
        this.app.toast(`${S.library.tagRemoved}: ${tag}`);
        this.refresh();
      });
      wrap.appendChild(chip);
    }

    const add = document.createElement('button');
    add.className = 'btn ghost small';
    add.dataset.addTag = score.id;
    add.textContent = `+ ${S.library.tags.slice(0, -1)}`;
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      const editor = document.createElement('span');
      editor.className = 'tag-editor';

      const input = document.createElement('input');
      input.className = 'input small';
      input.dataset.newTag = score.id;
      input.placeholder = S.library.tagAdd;
      input.style.maxWidth = '110px';
      const commit = async () => {
        const value = normalizeTag(input.value);
        if (value) {
          await patchScore(score.id, { tags: withTag(score, value) });
          this.app.toast(`${S.library.tagAdded}: ${value}`);
        }
        this.refresh();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') this.refresh();
      });
      input.addEventListener('blur', () => { if (!input.value) this.refresh(); });
      editor.appendChild(input);

      // Готовые теги: класс, жанр, задание — то, что обычно пишут на полях сборника
      const presets = document.createElement('span');
      presets.className = 'tag-presets';
      presets.title = S.library.tagPresets;
      for (const preset of suggestedTags(score, SUGGESTED_TAGS).slice(0, 8)) {
        const chip = document.createElement('button');
        chip.className = 'tag preset';
        chip.dataset.presetTag = preset;
        chip.textContent = preset;
        chip.addEventListener('click', async (click) => {
          click.stopPropagation();
          await patchScore(score.id, { tags: withTag(score, preset) });
          this.app.toast(`${S.library.tagAdded}: ${preset}`);
          this.refresh();
        });
        presets.appendChild(chip);
      }
      if (presets.childElementCount) editor.appendChild(presets);

      add.replaceWith(editor);
      input.focus();
    });
    wrap.appendChild(add);
    return wrap;
  }

  #renderTags() {
    const box = this.root.querySelector('#lib-tags');
    box.innerHTML = '';
    const tags = collectTags(this.all);
    const all = document.createElement('button');
    all.className = `tag${this.tag ? '' : ' active'}`;
    all.dataset.tagFilter = '';
    all.textContent = `${S.library.tagAll} (${this.all.length})`;
    all.addEventListener('click', () => {
      this.tag = null;
      this.refresh();
    });
    box.appendChild(all);
    for (const { tag, count } of tags) {
      const chip = document.createElement('button');
      chip.className = `tag${this.tag === tag ? ' active' : ''}`;
      chip.dataset.tagFilter = tag;
      chip.innerHTML = `${esc(tag)} <span class="tag-count">${count}</span>`;
      chip.addEventListener('click', () => {
        this.tag = this.tag === tag ? null : tag;
        this.refresh();
      });
      box.appendChild(chip);
    }
    box.hidden = tags.length === 0;
  }

  async refresh() {
    const container = this.root.querySelector('#saved-list');
    if (!container) return;
    let scores = [];
    try {
      scores = await listScores();
    } catch {
      scores = [];
    }
    this.all = scores;
    this.#renderTags();

    const stats = libraryStats(scores);
    const summary = this.root.querySelector('#lib-summary');
    if (summary) {
      summary.textContent = stats.pieces
        ? `${S.library.librarySummary}: ${stats.pieces} ${S.library.pieces} · ${stats.tags} ${S.library.tags.toLowerCase()} · ${stats.pages} ${S.library.pagesShort} · ${stats.withCover} ${S.library.scannedMark}`
        : '';
    }

    const shown = filterScores(scores, { query: this.query, tag: this.tag, sort: this.sort });
    container.innerHTML = '';
    if (!scores.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = S.library.empty;
      container.appendChild(empty);
      return;
    }
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = S.library.searchEmpty;
      container.appendChild(empty);
      return;
    }

    for (const score of shown) {
      const summaryOfScore = scoreSummary(score);
      const pages = pageCount(score);
      const row = document.createElement('div');
      row.className = 'list-row';
      row.dataset.scoreId = score.id;
      const open = document.createElement('button');
      open.className = `list-item${score.cover ? ' with-cover' : ''}`;
      open.dataset.openScore = score.id;
      open.innerHTML = `
        ${score.cover ? `<img class="cover" src="${score.cover}" alt="" loading="lazy">` : ''}
        <span class="list-text">
          <span class="list-title">${esc(score.title)}</span>
          <span class="list-meta">${esc(summaryOfScore.key)} · ${esc(summaryOfScore.meter)} · ${summaryOfScore.measures} ${t('common.measure', 'такт')}${pages > 1 ? ` · ${pages} ${S.library.pagesShort}` : ''} · ♩=${score.tempo}${summaryOfScore.lowConfidence ? ' · ⚠' : ''}</span>
        </span>
      `;
      open.addEventListener('click', () => this.app.openScore(score, { source: score.source?.kind || 'saved' }));

      const actions = document.createElement('div');
      actions.className = 'list-actions';
      const del = document.createElement('button');
      del.className = 'btn danger small';
      del.dataset.deleteScore = score.id;
      del.textContent = S.library.delete;
      del.addEventListener('click', async () => {
        await deleteScore(score.id);
        this.app.toast(S.library.deleted);
        this.refresh();
      });
      actions.append(this.#tagEditor(score), del);
      row.append(open, actions);
      container.appendChild(row);
    }
  }

  /** Сколько пьес сейчас показано — для проверок и подписи. */
  visibleCount() {
    return this.root.querySelectorAll('#saved-list [data-open-score]').length;
  }
}