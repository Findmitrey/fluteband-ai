// FluteBand AI — сборка приложения: состояние, виды, звук, транспорт.
import { PianoSynth } from './synth.js';
import { bankById, describeBank } from './sampler.js';
import { bankCacheInfo, loadBankSample, saveBankSample } from './storage.js';
import { Transport } from './transport.js';
import { Pianola } from './pianola.js';
import { generateAccompaniment } from './accompaniment.js';
import { loadSettings, saveSettings, saveScore } from './storage.js';
import { insertScorePage, moveScorePage } from './score-pages.js';
import { totalBeats, measureStarts, measureLengthBeats } from './timeline.js';
import { getInstrument } from './transpose.js';
import { S } from './ui-strings.js';
import { LibraryView } from './views/library.js';
import { ScanView } from './views/scan.js';
import { PlayerView } from './views/player.js';

export class FluteBandApp {
  constructor(root) {
    this.root = root;
    this.state = {
      settings: loadSettings(),
      score: null,
      accompaniment: null,
      synth: null,
      transport: null,
      pianola: null,
      view: 'library',
      audioReady: false,
      bankStatus: null,
    };
    this.views = {};
  }

  async init() {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) {
      this.toast('Браузер не поддерживает Web Audio — воспроизведение недоступно');
    } else {
      this.state.synth = new PianoSynth(new AudioCtx(), { volume: this.state.settings.volume });
      this.state.transport = new Transport({
        synth: this.state.synth,
        onPosition: () => this.views.player?.updateTransport(),
        onState: () => this.views.player?.updateTransport(),
      });
      this.state.transport.setMetronome(this.state.settings.metronome);
      this.state.transport.setCountIn(this.state.settings.countIn);
    }

    this.views.library = new LibraryView(this, this.root.querySelector('#view-library'));
    this.views.scan = new ScanView(this, this.root.querySelector('#view-scan'));
    this.views.player = new PlayerView(this, this.root.querySelector('#view-player'));
    this.views.library.mount();
    this.views.scan.mount();
    this.views.player.mount();

    this.state.pianola = new Pianola(this.root.querySelector('#pianola'), {
      onSeek: (beat) => {
        this.state.transport.seek(beat);
        this.views.player.updateTransport();
      },
    });

    this.#bindNav();
    this.#bindKeyboard();
    this.setView('library');
    const requested = new URLSearchParams(globalThis.location?.search || '').get('view');
    if (requested && ['library', 'scan', 'player'].includes(requested)) this.setView(requested);
    this.toast('FluteBand AI готов. Начните с демо-пьесы в библиотеке.');

    // Регистрация service worker не должна задерживать запуск приложения
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {
        /* офлайн-режим необязателен */
      });
    }

    // Банк звуков поднимаем из памяти устройства в фоне, не задерживая запуск
    this.restorePianoBank().catch(() => {
      /* без банка играем встроенным синтезом */
    });
    return this;
  }

  #bindNav() {
    this.root.querySelectorAll('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view));
    });
  }

  #bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.code === 'Space') {
        event.preventDefault();
        this.togglePlay();
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        this.seekByMeasure(1);
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        this.seekByMeasure(-1);
      }
    });
    globalThis.addEventListener('resize', () => this.state.pianola?.resize());
  }

  setView(name) {
    this.state.view = name;
    for (const key of ['library', 'scan', 'player']) {
      const section = this.root.querySelector(`#view-${key}`);
      if (section) section.classList.toggle('hidden', key !== name);
    }
    this.root.querySelectorAll('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === name);
    });
    if (name === 'library') this.views.library?.refresh();
    if (name === 'scan') {
      // На экране сканирования показываем, какая пьеса открыта: к ней можно приклеить страницу
      this.views.scan?.updateCurrentPiece();
    }
    if (name === 'player') {
      setTimeout(() => this.state.pianola?.resize(), 30);
      this.views.player?.render();
    }
    if (name !== 'scan') this.views.scan?.unmount();
  }

  updateSettings(patch) {
    this.state.settings = saveSettings({ ...this.state.settings, ...patch });
  }

  openScore(score, { source = null, image = null, cover = null } = {}) {
    if (!score) return;
    if (source && !score.source) score.source = { kind: source };
    if (cover) score.cover = cover;
    if (!score.pages) score.pages = score.measures?.length ? 1 : 0;
    this.state.score = score;
    this.setView('player');
    this.rebuildAccompaniment();
    this.toast(`${score.title} — ${score.measures.length} тактов, тон. ${score.key?.tonic || 'C'}`);
  }

  /**
   * Приклеить распознанную страницу к уже открытой пьесе.
   * Сборник снимают по страницам (см. app/js/score-pages.js), поэтому вторая и следующие
   * страницы не создают новую пьесу, а продолжают текущую. `at` — номер страницы, перед которой
   * вставить (0 — в начало, null — в конец): пропущенную страницу можно вставить в середину.
   */
  appendPage(pageScore, { pageCover = null, at = null } = {}) {
    const current = this.state.score;
    const result = insertScorePage(current, pageScore, { at });
    if (!result.ok) {
      this.toast(result.reason || 'Не удалось добавить страницу');
      return result;
    }
    const merged = result.score;
    if (pageCover) {
      const covers = [...(current?.pageCovers || (current?.cover ? [current.cover] : []))];
      const position = Number.isInteger(result.at) ? result.at : covers.length;
      covers.splice(position, 0, pageCover);
      merged.pageCovers = covers;
    }
    this.state.score = merged;
    this.rebuildAccompaniment();
    this.setView('player');
    const place = result.at != null && result.at < result.pages - 1 ? `, вставлена перед стр. ${result.at + 1}` : '';
    this.toast(`${merged.title}: ${merged.measures.length} тактов, страниц ${result.pages}${place}`);
    for (const warning of result.warnings) this.toast(warning);
    this.views.player?.updateMeta();
    return result;
  }

  /** Переставить страницы пьесы: сняли не в том порядке — исправляем без повторной съёмки. */
  movePage(from, to) {
    const result = moveScorePage(this.state.score, { from, to });
    if (!result.ok) {
      this.toast(result.reason || 'Не удалось переставить страницы');
      return result;
    }
    if (!result.moved) return result;
    this.state.score = result.score;
    this.rebuildAccompaniment();
    this.toast(`${S.library.pagesMoved}: ${from + 1} → ${to + 1}`);
    this.views.player?.updateMeta();
    return result;
  }

  rebuildAccompaniment() {
    const { score, settings } = this.state;
    if (!score) return null;
    const extra = settings.transposeMode === 'manual' ? settings.manualSemitones : 0;
    const accompaniment = generateAccompaniment(score, {
      style: settings.style,
      instrumentId: settings.instrumentId,
      extraSemitones: extra,
      includeMelody: false,
      tempo: score.tempo,
      dynamics: 0.8,
    });
    this.state.accompaniment = accompaniment;
    this.state.transport?.load({
      events: accompaniment.events,
      tempo: score.tempo,
      meter: score.meter,
      totalBeats: accompaniment.totalBeats,
    });
    this.state.pianola?.setScore(score, accompaniment);
    this.views.player?.render();
    if (accompaniment.warnings?.length) this.toast(`Гармония: ${accompaniment.warnings.length} замечаний — проверьте аккорды`);
    return accompaniment;
  }

  /**
   * Заменить текущую пьесу исправленной версией (правка распознавания: убрать такт, сменить размер).
   * Держим это отдельно от openScore, чтобы не сбрасывать выбор инструмента и не менять экран.
   */
  replaceScore(score, { reason = null } = {}) {
    if (!score) return;
    const previous = this.state.score;
    this.state.score = score;
    // Правку распознавания имеет смысл запомнить отдельно: пьесу легко сравнить с исходной
    this.state.score.repairs = [...(previous?.repairs || []), ...(reason ? [reason] : [])];
    this.rebuildAccompaniment();
    const summary = score.measures.length;
    this.toast(`${score.title}: ${summary} тактов после правки${reason ? ` (${reason})` : ''}`);
    this.views.player?.updateMeta();
  }

  setTempo(bpm) {
    if (!this.state.score) return;
    this.state.score.tempo = Math.max(20, Math.min(240, Math.round(bpm)));
    this.state.score.tempoSource = 'изменён вручную';
    this.state.transport?.setTempo(this.state.score.tempo);
    this.views.player?.updateMeta();
    this.views.player?.updateTransport();
  }

  togglePlay() {
    const { transport } = this.state;
    if (!transport) {
      this.toast('Звук недоступен в этом браузере');
      return;
    }
    this.state.synth.ctx.resume?.();
    if (transport.playing) transport.pause();
    else transport.play({ countIn: this.state.settings.countIn });
    this.views.player?.updateTransport();
  }

  seekByMeasure(direction) {
    const { score, transport } = this.state;
    if (!score || !transport) return;
    const starts = measureStarts(score);
    const current = this.measureIndexAtBeat(transport.positionBeats);
    const target = Math.max(0, Math.min(score.measures.length - 1, current + direction));
    transport.seek(starts[target] ?? 0);
    this.views.player?.updateTransport();
  }

  measureIndexAtBeat(beat) {
    const { score } = this.state;
    if (!score?.measures?.length) return 0;
    const starts = measureStarts(score);
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      const len = measureLengthBeats(score, score.measures[i]);
      if (beat >= starts[i] - 1e-6 && beat < starts[i] + len - 1e-6) {
        index = i;
        break;
      }
      if (beat >= starts[i]) index = i;
    }
    return index;
  }

  durationSeconds() {
    const { score } = this.state;
    if (!score) return 0;
    return (totalBeats(score) * 60) / (score.tempo || 100);
  }

  async saveCurrentScore() {
    const { score } = this.state;
    if (!score) return;
    await saveScore(score);
    this.toast('Пьеса сохранена в библиотеке');
    this.views.library?.refresh();
  }

  /**
   * Выбор фортепианного звука. Все банки свободные и качаются один раз,
   * после чего лежат в памяти устройства (IndexedDB) и работают офлайн.
   */
  async setPianoBank(bankId) {
    const { synth } = this.state;
    const bank = bankById(bankId);
    this.updateSettings({ pianoBank: bank.id, realPiano: bank.id !== 'tone' });
    if (!synth) return { ok: false, bank: bank.id };

    if (bank.id === 'tone') {
      synth.useToneEngine();
      this.state.bankStatus = null;
      this.views.player?.render();
      return { ok: true, bank: 'tone', notes: 0 };
    }

    this.toast(`${S.player.realPianoOn} ${bank.title}`);
    this.state.bankStatus = { state: 'loading', done: 0, total: 0, bankId: bank.id };
    this.views.player?.updateSoundStatus();

    const cached = await bankCacheInfo(bank.id);
    const result = await synth.loadBank(bank.id, {
      getBytes: async (note) => {
        // Сначала кэш на устройстве, потом сеть — второй запуск идёт без интернета
        const fromCache = await loadBankSample(bank.id, note.midi);
        if (fromCache) return fromCache;
        const res = await fetch(note.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        await saveBankSample(bank.id, { midi: note.midi, name: note.name, bytes });
        return bytes;
      },
      onProgress: ({ done, total }) => {
        this.state.bankStatus = { state: 'loading', done, total, bankId: bank.id };
        this.views.player?.updateSoundStatus();
      },
    });

    if (!result.ok) {
      synth.useToneEngine();
      this.updateSettings({ pianoBank: 'tone', realPiano: false });
      this.state.bankStatus = { state: 'failed', bankId: bank.id, reason: result.reason };
      this.toast(S.player.realPianoFailed);
      this.views.player?.render();
      return result;
    }

    const info = await bankCacheInfo(bank.id);
    this.state.bankStatus = {
      state: 'ready',
      bankId: bank.id,
      notes: result.notes,
      total: result.planned,
      failed: result.failed,
      bytes: info.bytes,
      cachedBefore: cached.notes,
    };
    const fromCacheText = cached.notes ? `, из памяти ${cached.notes}` : '';
    this.toast(`${result.title}: ${result.notes} ${S.player.samplesLoaded}${fromCacheText}`);
    this.views.player?.render();
    if (this.state.score) this.rebuildAccompaniment();
    return result;
  }

  /** Старый вызов (флажок «реалистичное пиано»): true — рояль, false — встроенный синтез */
  enableRealPiano(value) {
    return this.setPianoBank(value ? 'royal' : 'tone');
  }

  /** После запуска: если банк уже выбран, пробуем поднять его из памяти устройства */
  async restorePianoBank() {
    const { pianoBank } = this.state.settings;
    if (!pianoBank || pianoBank === 'tone') return;
    const info = await bankCacheInfo(pianoBank);
    if (!info.notes) return; // в кэше пусто — не тянем мегабайты без просьбы
    await this.setPianoBank(pianoBank);
  }

  /** Что сейчас со звуком: движок, сэмплы, объём кэша */
  soundInfo() {
    const { synth, bankStatus } = this.state;
    const bankId = synth?.bankId || 'tone';
    return {
      bankId,
      engine: synth?.engine || 'tone',
      engineName: synth?.engineName || bankById('tone').title,
      samples: synth?.sampleCount || 0,
      anchors: synth?.anchorList || [],
      status: bankStatus,
      bank: describeBank(bankId),
    };
  }

  toast(message) {
    const box = this.root.querySelector('#toast');
    if (!box) return;
    box.textContent = message;
    box.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => box.classList.remove('visible'), 4200);
  }

  get instrument() {
    return getInstrument(this.state.settings.instrumentId);
  }
}

export async function bootstrap() {
  const app = new FluteBandApp(document.querySelector('#app'));
  await app.init();
  globalThis.fluteband = app;
  return app;
}