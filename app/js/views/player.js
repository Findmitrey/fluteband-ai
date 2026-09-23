// FluteBand AI — экран «Минус»: транспорт, темный, правка аккордов, экспорт.
import { INSTRUMENTS, transpositionHint } from '../transpose.js';
import { STYLES } from '../accompaniment.js';
import { S, semitonesText, clockText, measuresText, t } from '../ui-strings.js';
import { scoreSummary, validateScore } from '../score.js';
import { pageCount, pageSlices } from '../score-pages.js';
import { scoreToMusicXml } from '../musicxml.js';
import { suggestFixes } from '../score-fixes.js';
import { tempoName } from '../tempo.js';
import { parseChordLine } from '../manual.js';
import { measureStarts, measureLengthBeats } from '../timeline.js';
import { buildMidiFile } from '../midi.js';
import { renderEvents, downloadBytes, safeFileName } from '../wav-render.js';
import { encodeWav } from '../wav.js';
import { BANKS, bankById, formatBytes, planLoad } from '../sampler.js';

export class PlayerView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.lastLoopLabel = '';
  }

  mount() {
    this.root.innerHTML = `
      <section class="card" id="player-head">
        <h2 id="p-title">${S.player.title}</h2>
        <p class="muted small" id="p-meta"></p>
        <div id="p-warnings"></div>
        <div id="p-pages"></div>
        <div id="p-fixes"></div>
      </section>

      <section class="card">
        <div class="pianola-wrap">
          <canvas id="pianola" class="pianola"></canvas>
        </div>
        <div class="row wrap transport">
          <button class="btn primary big" id="p-play">${S.player.play}</button>
          <button class="btn big" id="p-stop">${S.player.stop}</button>
          <button class="btn" id="p-loop">${S.player.loopSet}</button>
          <button class="btn ghost" id="p-loop-clear">${S.player.loopClear}</button>
          <span class="position muted small" id="p-position">0:00</span>
        </div>
        <p class="muted small">${S.player.spaceHint}</p>
      </section>

      <section class="card">
        <div class="grid">
          <label class="field"><span>${S.player.instrument}</span>
            <select class="input" id="p-instrument">
              ${INSTRUMENTS.map((i) => `<option value="${i.id}">${i.ru}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>${S.player.style}</span>
            <select class="input" id="p-style">
              ${STYLES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>${S.player.transposition}</span>
            <select class="input" id="p-transpose-mode">
              <option value="auto">${S.player.transposeAuto}</option>
              <option value="manual">${S.player.transposeManual}</option>
            </select>
          </label>
          <label class="field"><span>${S.player.transposeManual}</span>
            <input class="input" id="p-semitones" type="number" min="-12" max="12" step="1" value="0">
          </label>
        </div>
        <p class="muted small" id="p-transpose-hint"></p>
        <label class="field"><span>${S.player.tempo}: <b id="p-tempo-value">100</b> BPM <span class="muted" id="p-tempo-term"></span></span>
          <input type="range" id="p-tempo" min="40" max="200" step="1" value="100">
        </label>
        <label class="field"><span>${S.player.volume}</span>
          <input type="range" id="p-volume" min="0" max="1" step="0.01" value="0.85">
        </label>
        <label class="field"><span>${S.player.sound}</span>
          <select class="input" id="p-bank"></select>
        </label>
        <p class="muted small" id="p-bank-status"></p>
        <div class="row wrap">
          <label class="check"><input type="checkbox" id="p-metronome"> ${S.player.metronome}</label>
          <label class="check"><input type="checkbox" id="p-countin"> ${S.player.countIn}</label>
        </div>
        <p class="muted small">${S.player.retempoNote}</p>
        <div class="row wrap">
          <button class="btn" id="p-save">Сохранить в библиотеку</button>
          <button class="btn ghost" id="p-midi">${S.player.exportMidi}</button>
          <button class="btn ghost" id="p-wav">${S.player.exportWav}</button>
          <button class="btn ghost" id="p-xml">${S.library.musicXml}</button>
        </div>
        <p class="muted small" id="p-export-status"></p>
      </section>

      <section class="card">
        <h2>${S.player.editHarmony}</h2>
        <p class="muted small">${S.player.editHint}</p>
        <div class="harmony-grid" id="p-harmony"></div>
      </section>
    `;

    this.#fillBanks();
    this.#bind();
  }

  #bind() {
    const q = (id) => this.root.querySelector(id);
    q('#p-play').addEventListener('click', () => this.app.togglePlay());
    q('#p-stop').addEventListener('click', () => {
      this.app.state.transport.stop();
      this.updateTransport();
    });
    q('#p-loop').addEventListener('click', () => this.loopCurrentMeasure());
    q('#p-loop-clear').addEventListener('click', () => {
      this.app.state.transport.setLoopRange(null, null);
      this.updateTransport();
    });
    q('#p-instrument').addEventListener('change', (e) => {
      this.app.updateSettings({ instrumentId: e.target.value, transposeMode: 'auto' });
      this.app.rebuildAccompaniment();
    });
    q('#p-style').addEventListener('change', (e) => {
      this.app.updateSettings({ style: e.target.value });
      this.app.rebuildAccompaniment();
    });
    q('#p-transpose-mode').addEventListener('change', (e) => {
      this.app.updateSettings({ transposeMode: e.target.value });
      this.app.rebuildAccompaniment();
    });
    q('#p-semitones').addEventListener('change', (e) => {
      this.app.updateSettings({ manualSemitones: Math.max(-12, Math.min(12, Number(e.target.value) || 0)) });
      this.app.rebuildAccompaniment();
    });
    q('#p-tempo').addEventListener('input', (e) => {
      const bpm = Number(e.target.value) || 100;
      this.app.setTempo(bpm);
      this.updateTransport();
    });
    q('#p-volume').addEventListener('input', (e) => {
      const volume = Number(e.target.value);
      this.app.updateSettings({ volume });
      this.app.state.synth.setVolume(volume);
    });
    q('#p-metronome').addEventListener('change', (e) => {
      this.app.updateSettings({ metronome: e.target.checked });
      this.app.state.transport.setMetronome(e.target.checked);
    });
    q('#p-countin').addEventListener('change', (e) => {
      this.app.updateSettings({ countIn: e.target.checked });
      this.app.state.transport.setCountIn(e.target.checked);
    });
    q('#p-bank').addEventListener('change', (e) => this.app.setPianoBank(e.target.value));
    q('#p-save').addEventListener('click', () => this.app.saveCurrentScore());
    q('#p-midi').addEventListener('click', () => this.exportMidi());
    q('#p-wav').addEventListener('click', () => this.exportWav());
    q('#p-xml').addEventListener('click', () => this.exportMusicXml());
  }

  render() {
    const { score, settings } = this.app.state;
    const head = this.root.querySelector('#player-head');
    if (!score) {
      head.querySelector('#p-title').textContent = S.player.noScore;
      head.querySelector('#p-meta').textContent = '';
      this.root.querySelector('#pianola').classList.add('hidden');
      return;
    }
    this.root.querySelector('#pianola').classList.remove('hidden');
    this.updateMeta();

    const q = (id) => this.root.querySelector(id);
    q('#p-instrument').value = settings.instrumentId;
    q('#p-style').value = settings.style;
    q('#p-transpose-mode').value = settings.transposeMode;
    q('#p-semitones').value = String(settings.manualSemitones);
    q('#p-semitones').disabled = settings.transposeMode !== 'manual';
    q('#p-tempo').value = String(score.tempo);
    q('#p-volume').value = String(settings.volume);
    q('#p-metronome').checked = settings.metronome;
    q('#p-countin').checked = settings.countIn;
    q('#p-bank').value = settings.pianoBank || 'tone';
    this.updateSoundStatus();

    this.renderHarmonyGrid();
    this.updateTransposeHint();
    this.updateTransport();
  }

  /** Заголовок, метрики и замечания — обновляются и без перерисовки всего экрана */
  updateMeta() {
    const { score } = this.app.state;
    const title = this.root.querySelector('#p-title');
    const meta = this.root.querySelector('#p-meta');
    const warningsBox = this.root.querySelector('#p-warnings');
    if (!score) {
      if (title) title.textContent = S.player.noScore;
      if (meta) meta.textContent = '';
      if (warningsBox) warningsBox.innerHTML = '';
      return;
    }
    const summary = scoreSummary(score);
    const sourceLabel = { omr: S.player.fromOmr, demo: S.player.fromDemo, manual: S.player.fromManual }[score.source?.kind] || '';
    if (title) title.textContent = score.title;
    if (meta) {
      meta.textContent = [
        score.composer || null,
        `${summary.key}`,
        `${summary.meter}`,
        measuresText(summary.measures),
        pageCount(score) > 1 ? `${pageCount(score)} ${S.library.pagesShort}` : null,
        `♩=${score.tempo}`,
        clockText(this.app.durationSeconds()),
        sourceLabel ? `(${sourceLabel}${score.source?.engine ? `: ${score.source.engine}` : ''})` : null,
      ].filter(Boolean).join(' · ');
    }
    const validation = validateScore(score);
    const warnings = [...new Set([...(score.warnings || []), ...validation.problems.slice(0, 6)])];
    if (warningsBox) {
      warningsBox.innerHTML = warnings.length
        ? `<p class="warn small">${S.scan.warnings}:<br>${warnings.map((w) => `• ${w}`).join('<br>')}</p>`
        : '<p class="ok small">Распознавание без замечаний</p>';
    }
    this.renderFixes();
    this.renderPages();
  }

  /**
   * Страницы пьесы: видно, сколько тактов на каждой, и можно переставить — если сборник сняли
   * не в том порядке, повторная съёмка не нужна (см. app/js/score-pages.js).
   */
  renderPages() {
    const box = this.root.querySelector('#p-pages');
    if (!box) return;
    const { score } = this.app.state;
    const pages = pageCount(score);
    if (!score || pages < 2) {
      box.innerHTML = '';
      return;
    }
    const slices = pageSlices(score);
    const rows = slices
      .map((measures, index) => {
        const first = measures[0]?.number || '—';
        const last = measures[measures.length - 1]?.number || '—';
        return `
          <li class="page-row" data-page-row="${index}">
            <span class="page-num">${index + 1}</span>
            <span class="muted small">${t('common.measure', 'такт')} ${first}–${last} (${measures.length})</span>
            <span class="page-actions">
              <button class="btn ghost small" data-page-up="${index}" title="${S.library.pageUp}" ${index === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn ghost small" data-page-down="${index}" title="${S.library.pageDown}" ${index === slices.length - 1 ? 'disabled' : ''}>↓</button>
            </span>
          </li>`;
      })
      .join('');
    box.innerHTML = `
      <details class="details">
        <summary>${S.library.pagesTitle}: ${pages} ${S.library.pagesShort}</summary>
        <ul class="page-list">${rows}</ul>
      </details>`;
    for (const button of box.querySelectorAll('[data-page-up]')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.app.movePage(Number(button.dataset.pageUp), Number(button.dataset.pageUp) - 1);
      });
    }
    for (const button of box.querySelectorAll('[data-page-down]')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.app.movePage(Number(button.dataset.pageDown), Number(button.dataset.pageDown) + 1);
      });
    }
  }

  /**
   * «Проверка распознавания»: показывает, что можно поправить после OMR, и правит одним нажатием.
   * Ошибки движка типовые (лишний такт, 6/8 как 3/8, недописанный последний такт) — см. score-fixes.js.
   */
  renderFixes() {
    const box = this.root.querySelector('#p-fixes');
    if (!box) return;
    const { score } = this.app.state;
    if (!score) {
      box.innerHTML = '';
      return;
    }
    const suggestions = suggestFixes(score);
    if (!suggestions.length) {
      box.innerHTML = score.source?.kind === 'omr'
        ? `<p class="ok small">${S.player.fixesNone}</p>`
        : '';
      return;
    }
    box.innerHTML = `
      <p class="muted small">${S.player.fixesHint}</p>
      <div class="row wrap">
        ${suggestions.map((s) => `<button class="btn ghost" data-fix="${s.id}" title="${s.hint}">${s.label}</button>`).join('')}
      </div>
    `;
    for (const suggestion of suggestions) {
      box.querySelector(`[data-fix="${suggestion.id}"]`)?.addEventListener('click', () => {
        const fixed = suggestion.apply(this.app.state.score);
        fixed.warnings = [...new Set([...(fixed.warnings || []), `${suggestion.label} — применено`])];
        this.app.replaceScore(fixed, { reason: suggestion.id });
      });
    }
  }

  renderHarmonyGrid() {
    const container = this.root.querySelector('#p-harmony');
    const { score } = this.app.state;
    container.innerHTML = '';
    if (!score) return;
    score.measures.forEach((measure, index) => {
      const cell = document.createElement('label');
      cell.className = `harmony-cell${measure.lowConfidence ? ' low' : ''}`;
      const symbols = (measure.harmony || []).map((h) => h.symbol).filter(Boolean);
      cell.innerHTML = `
        <span class="harmony-number">${measure.number || index + 1}</span>
        <input class="input mono" value="${symbols.join(', ')}" placeholder="—">
      `;
      const input = cell.querySelector('input');
      const commit = () => {
        const raw = input.value;
        const groups = parseChordLine(raw, 1)[0] || [];
        const len = measureLengthBeats(score, measure);
        measure.harmony = groups.map((symbol, i) => ({
          beat: Number(((len / groups.length) * i).toFixed(4)),
          dur: Number((len / groups.length).toFixed(4)),
          symbol,
          source: 'manual',
        }));
        this.app.rebuildAccompaniment();
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          input.blur();
        }
      });
      container.appendChild(cell);
    });
  }

  updateTransposeHint() {
    const { score, settings } = this.app.state;
    if (!score) return;
    const extra = settings.transposeMode === 'manual' ? settings.manualSemitones : 0;
    const hint = transpositionHint(score.key, settings.instrumentId, extra);
    const total = hint.semitones;
    this.root.querySelector('#p-transpose-hint').textContent = total === 0
      ? hint.text
      : `${hint.text} (${semitonesText(total)})`;
  }

  updateTransport() {
    const { transport, score } = this.app.state;
    const playButton = this.root.querySelector('#p-play');
    if (playButton) playButton.textContent = transport.playing ? S.player.pause : S.player.play;
    const position = transport.positionBeats;
    const seconds = score ? (position * 60) / (transport.bpm || 100) : 0;
    const total = this.app.durationSeconds();
    const positionEl = this.root.querySelector('#p-position');
    if (positionEl) positionEl.textContent = `${clockText(seconds)} / ${clockText(total)}`;
    const tempoValue = this.root.querySelector('#p-tempo-value');
    if (tempoValue) {
      tempoValue.textContent = String(transport.bpm);
      const term = tempoName(transport.bpm);
      this.root.querySelector('#p-tempo-term').textContent = term ? `(${term})` : '';
    }
    const loopButton = this.root.querySelector('#p-loop');
    if (loopButton && transport.loopStart != null) {
      const measureIndex = this.app.measureIndexAtBeat(transport.loopStart);
      loopButton.textContent = `${S.player.loop}: такт ${measureIndex + 1}`;
    } else if (loopButton) {
      loopButton.textContent = S.player.loopSet;
    }
    this.app.state.pianola?.draw(position);
  }

  loopCurrentMeasure() {
    const { transport, score } = this.app.state;
    if (!score) return;
    const starts = measureStarts(score);
    const beat = transport.positionBeats;
    const index = this.app.measureIndexAtBeat(beat);
    const start = starts[index] ?? 0;
    const len = measureLengthBeats(score, score.measures[index]);
    transport.setLoopRange(start, start + len);
    this.app.toast(`${S.player.loop}: такт ${index + 1}`);
    this.updateTransport();
  }

  exportMidi() {
    const { score, accompaniment } = this.app.state;
    const status = this.root.querySelector('#p-export-status');
    if (!score || !accompaniment?.events?.length) {
      status.textContent = 'Нет минуса для экспорта';
      return;
    }
    const bytes = buildMidiFile({
      events: accompaniment.events,
      tempo: score.tempo,
      meter: score.meter,
      trackName: score.title,
    });
    const name = `${safeFileName(score.title)}.mid`;
    downloadBytes(bytes, name, 'audio/midi');
    status.textContent = `${S.player.exportMidi}: ${name} (${Math.round(bytes.length / 1024)} КБ)`;
  }

  /**
   * Экспорт пьесы в MusicXML: файл открывается в MuseScore и других редакторах,
   * а в приложении его можно загрузить обратно (импорт уже работает и проверен round-trip тестом).
   */
  exportMusicXml() {
    const { score } = this.app.state;
    const status = this.root.querySelector('#p-export-status');
    if (!score?.measures?.length) {
      status.textContent = 'Нет пьесы для экспорта';
      return;
    }
    const xml = scoreToMusicXml(score);
    const name = `${safeFileName(score.title)}.musicxml`;
    downloadBytes(xml, name, 'application/vnd.recordare.musicxml+xml');
    const pages = pageCount(score);
    status.textContent = `${S.library.musicXml}: ${name} (${Math.round(xml.length / 1024)} КБ, ${score.measures.length} ${t('common.measure', 'такт')}${pages > 1 ? `, ${pages} ${S.library.pagesShort}` : ''})`;
  }

  /** Строка о текущем звуке: движок, число сэмплов, объём, прогресс загрузки */
  updateSoundStatus() {
    const box = this.root.querySelector('#p-bank-status');
    if (!box) return;
    const select = this.root.querySelector('#p-bank');
    if (select) {
      const current = this.app.state.settings.pianoBank || 'tone';
      if (select.value !== current) select.value = current;
    }
    const info = this.app.soundInfo();
    const parts = [];
    if (info.status?.state === 'loading') {
      const done = info.status.done || 0;
      const total = info.status.total || 0;
      const detail = bankById(info.status.bankId)?.detail;
      parts.push(`${S.player.bankLoading} ${done}/${total || '…'}${detail ? ` — ${detail}` : ''}`);
    } else if (info.status?.state === 'failed') {
      parts.push(S.player.realPianoFailed);
    } else if (info.engine === 'sample') {
      parts.push(`${info.engineName}: ${info.samples} ${S.player.samplesLoaded}`);
      if (info.bank?.bytes) parts.push(`≈${info.bank.bytes}`);
      if (info.bank?.license) parts.push(info.bank.license);
    } else {
      parts.push(S.player.toneHint);
    }
    box.textContent = parts.filter(Boolean).join(' · ');
  }

  /** Заполнить список банков (один раз, при первой отрисовке) */
  #fillBanks() {
    const select = this.root.querySelector('#p-bank');
    if (!select || select.options.length) return;
    for (const bank of BANKS) {
      const option = document.createElement('option');
      option.value = bank.id;
      // В списке — короткое имя и вес, подробности показываем строкой ниже
      const size = bank.approxBytes ? ` (≈${formatBytes(planLoad(bank).approxBytes)})` : '';
      option.textContent = `${bank.title}${size}`;
      if (bank.detail) option.title = bank.detail;
      select.appendChild(option);
    }
  }

  async exportWav() {
    const { score, accompaniment } = this.app.state;
    const status = this.root.querySelector('#p-export-status');
    if (!score || !accompaniment?.events?.length) {
      status.textContent = 'Нет минуса для экспорта';
      return;
    }
    status.textContent = S.player.exportWavBusy;
    try {
      const synth = this.app.state.synth;
      const rendered = await renderEvents({
        events: accompaniment.events,
        tempo: score.tempo,
        totalBeats: accompaniment.totalBeats,
        volume: this.app.state.settings.volume,
        buffers: synth?.getBuffers() || null,
        bankId: synth?.bankId || 'tone',
        synth,
      });
      const bytes = encodeWav(rendered.channels, rendered.sampleRate);
      const name = `${safeFileName(score.title)}.wav`;
      downloadBytes(bytes, name, 'audio/wav');
      // Честно показываем, каким инструментом сделан файл и что сигнал не пустой
      status.textContent = `${S.player.exportWav}: ${name} (${Math.round(bytes.length / 1024)} КБ) · ${rendered.engineName}`
        + `${rendered.samples ? `, ${rendered.samples} ${S.player.samplesLoaded}` : ''}`
        + ` · ${S.player.peak} ${rendered.metrics.peak}`;
    } catch (error) {
      status.textContent = `${S.common.error}: ${error.message}`;
    }
  }

  /** Совместимость со старым флажком «реалистичное пиано» */
  async enableRealPianoFlag(value) {
    const result = await this.app.setPianoBank(value ? 'royal' : 'tone');
    this.updateSoundStatus();
    return result;
  }
}