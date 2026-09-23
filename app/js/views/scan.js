// FluteBand AI — экран «Сканировать»: камера/фото, распознавание, ручной ввод.
import { CameraCapture, cameraSupport, prepareImageBlob, imageStats, blobToObjectUrl, makeThumbnail } from '../camera.js';
import {
  recognizeImageBlob,
  checkServer,
  apiEndpoint,
  demoRecognitionScore,
  FIXTURE_CHOICES,
  isImageFile,
  isMusicXmlFile,
  scoreFromUploadedFile,
} from '../recognition.js';
import { scoreFromManualInput, METER_PRESETS } from '../manual.js';
import { autoRepairScore, markRestMeasures } from '../score-fixes.js';
import { pageCount } from '../score-pages.js';
import { S, t } from '../ui-strings.js';

export class ScanView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.camera = null;
    this.imageBlob = null;
    this.previewUrl = null;
  }

  mount() {
    const support = cameraSupport();
    this.root.innerHTML = `
      <section class="card">
        <h2>${S.scan.title}</h2>
        <p class="muted small">${S.scan.hint}</p>
        <div class="camera-wrap" id="drop-zone">
          <video id="camera" class="camera" playsinline muted></video>
          <img id="preview" class="camera hidden" alt="${S.scan.preview}">
          <div class="drop-hint hidden" id="drop-hint">${S.scan.dropHere}</div>
        </div>
        <div class="row wrap">
          <button class="btn" id="btn-start">${S.scan.startCamera}</button>
          <button class="btn" id="btn-shoot" disabled>${S.scan.shoot}</button>
          <button class="btn ghost" id="btn-file">${S.scan.uploadFile}</button>
          <button class="btn ghost" id="btn-sample">${S.scan.samplePage}</button>
        </div>
        <input type="file" id="file-image" accept="image/*,.musicxml,.xml,application/xml,text/xml" hidden>
        <p class="muted small">${S.scan.uploadHint}</p>
        <p class="muted small" id="camera-status"></p>
        <div class="row wrap">
          <select class="input" id="engine-select">
            <option value="">Движок: авто</option>
            <option value="stub">Эталонная страница (проверка)</option>
          </select>
          <select class="input" id="mode-select">
            <option value="melody">Только мелодия — быстрее</option>
            <option value="full">Вся страница — мелодия и фортепиано</option>
          </select>
          <button class="btn primary" id="btn-recognize" disabled>${S.scan.recognize}</button>
          <button class="btn ghost" id="btn-retake" disabled>${S.scan.retake}</button>
        </div>
        <p class="muted small" id="mode-hint">${S.scan.modeHintMelody}</p>
        <div class="row wrap" id="current-row" hidden>
          <label class="check"><input type="checkbox" id="append-current"> ${S.scan.appendToCurrent}</label>
          <span class="muted small" id="current-piece"></span>
        </div>
        <p class="muted small" id="append-hint" hidden>${S.scan.appendHint}</p>
        <div class="row wrap" id="insert-row" hidden>
          <label class="field small"><span>${S.library.pageInsertAt}</span>
            <select class="input" id="insert-at"></select>
          </label>
        </div>
        <details class="details">
          <summary>${S.scan.serverSettings}</summary>
          <p class="muted small">${S.scan.serverSettingsHint}</p>
          <div class="row wrap">
            <input class="input mono" id="omr-url" placeholder="${S.scan.serverPlaceholder}" autocomplete="off">
            <button class="btn" id="btn-save-omr">${S.common.save}</button>
            <button class="btn ghost" id="btn-check-omr">${S.scan.serverCheck}</button>
          </div>
          <p class="muted small" id="omr-status"></p>
        </details>
        <div id="scan-result"></div>
      </section>

      <section class="card">
        <h2>${S.scan.manualEntry}</h2>
        <p class="muted small">Если распознавание ошиблось или сервер недоступен — введите аккорды вручную. Минус построится сразу.</p>
        <div class="grid">
          <label class="field"><span>${S.common.scoreTitle}</span><input class="input" id="m-title" value="Учебная пьеса"></label>
          <label class="field"><span>Тоника</span>
            <select class="input" id="m-tonic">
              ${['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db'].map((k) => `<option${k === 'C' ? ' selected' : ''}>${k}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>Лад</span>
            <select class="input" id="m-mode"><option value="major">мажор</option><option value="minor">минор</option></select>
          </label>
          <label class="field"><span>Размер</span>
            <select class="input" id="m-meter">${METER_PRESETS.map((m) => `<option${m === '4/4' ? ' selected' : ''}>${m}</option>`).join('')}</select>
          </label>
          <label class="field"><span>${S.player.tempo} (BPM)</span><input class="input" id="m-tempo" type="number" min="30" max="220" value="100"></label>
        </div>
        <label class="field"><span>Аккорды по тактам (через <code>|</code>, можно несколько через запятую)</span>
          <input class="input mono" id="m-chords" value="C | G7 | C | F | C | G7 | C | C">
        </label>
        <label class="field"><span>Мелодия (необязательно): ноты через пробел, такты через <code>|</code>, длительность через <code>:</code>. Пример: <code>C4 D4 E4 F4 | G4:2 E4:2</code></span>
          <input class="input mono" id="m-melody" value="">
        </label>
        <button class="btn primary" id="btn-manual">${S.scan.manualEntry}</button>
      </section>
    `;

    this.video = this.root.querySelector('#camera');
    this.preview = this.root.querySelector('#preview');
    this.status = this.root.querySelector('#camera-status');
    this.result = this.root.querySelector('#scan-result');
    this.camera = new CameraCapture(this.video);

    if (!support.ok) {
      this.status.textContent = support.hasApi ? S.scan.insecure : S.scan.noCamera;
      this.root.querySelector('#btn-start').disabled = true;
    }

    this.root.querySelector('#btn-start').addEventListener('click', () => this.toggleCamera());
    this.root.querySelector('#btn-shoot').addEventListener('click', () => this.shoot());
    this.root.querySelector('#btn-file').addEventListener('click', () => this.root.querySelector('#file-image').click());
    this.root.querySelector('#file-image').addEventListener('change', (event) => this.fromFile(event));
    this.root.querySelector('#btn-sample').addEventListener('click', () => this.loadSamplePage());
    this.root.querySelector('#btn-recognize').addEventListener('click', () => this.recognize());
    this.root.querySelector('#btn-retake').addEventListener('click', () => this.reset());
    this.root.querySelector('#btn-manual').addEventListener('click', () => this.createManual());
    this.root.querySelector('#append-current').addEventListener('change', (event) => {
      // Ручной выбор пользователя запоминаем, чтобы галочка не «прыгала»
      this.appendChosen = event.target.checked;
    });
    this.setupDropZone();
    this.#mountServerAddress();
    this.#mountModeChoice();
    this.checkServerStatus();
    this.updateCurrentPiece();
  }

  /** Адрес сервиса распознавания: пусто — сервис рядом с приложением, иначе внешний адрес. */
  #mountServerAddress() {
    const input = this.root.querySelector('#omr-url');
    const status = this.root.querySelector('#omr-status');
    if (!input) return;
    const current = this.app.state?.settings?.omrUrl || '';
    input.value = current;
    this.#serverStatusText(status, current);
    this.root.querySelector('#btn-save-omr').addEventListener('click', () => {
      const value = input.value.trim();
      this.app.updateSettings({ omrUrl: value });
      input.value = this.app.state.settings.omrUrl || '';
      this.#serverStatusText(status, this.app.state.settings.omrUrl || '');
      this.app.toast(S.scan.serverSaved);
      this.checkServerStatus();
    });
    this.root.querySelector('#btn-check-omr').addEventListener('click', async () => {
      status.textContent = `${S.scan.serverCheck}…`;
      const base = input.value.trim();
      const health = await checkServer(base);
      status.textContent = health.ok
        ? `Сервис отвечает: ${health.info?.engines?.join(', ') || 'готов'} (${apiEndpoint('/health', base)})`
        : `${S.scan.serverOffline}: ${health.error || health.status || '—'} (${apiEndpoint('/health', base)})`;
      return health;
    });
  }

  /**
   * Режим распознавания: только мелодия (быстрее) или вся страница (гармония точнее).
   * Выбор сохраняется в настройках устройства, чтобы не переключать его перед каждой страницей.
   */
  #mountModeChoice() {
    const select = this.root.querySelector('#mode-select');
    const hint = this.root.querySelector('#mode-hint');
    if (!select) return;
    select.value = this.app.state?.settings?.omrMode === 'full' ? 'full' : 'melody';
    const showHint = () => {
      if (hint) hint.textContent = select.value === 'full' ? S.scan.modeHintFull : S.scan.modeHintMelody;
    };
    showHint();
    select.addEventListener('change', () => {
      this.app.updateSettings({ omrMode: select.value });
      showHint();
    });
  }

  #serverStatusText(status, base) {
    if (!status) return;
    status.textContent = base
      ? `Адрес сервиса: ${apiEndpoint('/recognize', base)}`
      : `Адрес сервиса: ${apiEndpoint('/recognize', '')} — ${S.scan.serverLocal}`;
  }

  /**
   * Подсказка о текущей пьесе: сборник снимают по страницам, поэтому следующую страницу
   * логично приклеить к уже открытой пьесе, а не создавать новую.
   */
  updateCurrentPiece() {
    const row = this.root.querySelector('#current-row');
    const box = this.root.querySelector('#append-current');
    const label = this.root.querySelector('#current-piece');
    const hint = this.root.querySelector('#append-hint');
    const score = this.app.state?.score;
    if (!row || !score?.measures?.length) {
      if (row) row.hidden = true;
      if (hint) hint.hidden = true;
      this.#renderInsertChoice(null);
      return;
    }
    const pages = pageCount(score);
    row.hidden = false;
    hint.hidden = false;
    label.textContent = `${S.scan.currentPiece}: «${score.title}» — ${score.measures.length} ${t('common.measure', 'такт')}${pages > 1 ? `, ${pages} ${S.library.pagesShort}` : ''}`;
    // По умолчанию приклеиваем, если открытая пьеса сама собрана из снимков
    const fromScan = score.source?.kind === 'omr';
    box.checked = this.appendChosen ?? fromScan;
    this.#renderInsertChoice(score);
  }

  /**
   * Куда вставить снятую страницу: в конец (обычный случай) или перед одной из уже собранных —
   * так пропущенная страница попадает на своё место.
   */
  #renderInsertChoice(score) {
    const row = this.root.querySelector('#insert-row');
    const select = this.root.querySelector('#insert-at');
    if (!row || !select) return;
    if (!score?.measures?.length) {
      row.hidden = true;
      select.innerHTML = '';
      return;
    }
    const pages = pageCount(score);
    const previous = select.value;
    select.innerHTML = '';
    const end = document.createElement('option');
    end.value = 'end';
    end.textContent = `${S.library.pageInsertEnd} (${pages} ${S.library.pagesShort})`;
    select.appendChild(end);
    for (let page = 0; page < pages; page += 1) {
      const option = document.createElement('option');
      option.value = String(page);
      option.textContent = `${S.library.pageInsertBefore} ${page + 1}`;
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    row.hidden = false;
  }

  /** Номер страницы для вставки из выпадающего списка (null — в конец). */
  insertAt() {
    const value = this.root.querySelector('#insert-at')?.value;
    return value == null || value === 'end' ? null : Number(value);
  }

  unmount() {
    this.camera?.stop();
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  async checkServerStatus() {
    const base = this.app.state?.settings?.omrUrl || '';
    const health = await checkServer(base);
    this.serverInfo = health;
    if (!health.ok) {
      this.status.textContent = `${S.scan.serverOffline} (${apiEndpoint('/health', base)}). ${S.scan.serverHint}`;
    } else {
      this.status.textContent = `Сервер распознавания доступен: ${health.info?.engines?.join(', ') || 'готов'} (${apiEndpoint('/health', base)})`;
    }
    return health;
  }

  async toggleCamera() {
    if (this.camera.active) {
      this.camera.stop();
      this.root.querySelector('#btn-start').textContent = S.scan.startCamera;
      this.root.querySelector('#btn-shoot').disabled = true;
      this.video.classList.remove('hidden');
      return;
    }
    try {
      await this.camera.start();
      this.root.querySelector('#btn-start').textContent = S.scan.stopCamera;
      this.root.querySelector('#btn-shoot').disabled = false;
      this.video.classList.remove('hidden');
      this.preview.classList.add('hidden');
      this.status.textContent = 'Камера включена';
    } catch (error) {
      const message = error.message === 'INSECURE_CONTEXT' ? S.scan.insecure : S.scan.cameraDenied;
      this.status.textContent = message;
      this.app.toast(message);
    }
  }

  async shoot() {
    try {
      const raw = await this.camera.capture({ maxSide: 2400 });
      // Кадр с камеры проходит ту же подготовку, что и загруженный файл
      const blob = await prepareImageBlob(raw, { maxSide: 2000, preprocess: true });
      await this.setImage(blob);
      this.app.toast(S.scan.preview);
    } catch (error) {
      this.app.toast(`${S.common.error}: ${error.message}`);
    }
  }

  async fromFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await this.acceptFile(file);
  }

  /**
   * Один вход для любых файлов: фото нот уходит на распознавание, MusicXML разбирается сразу.
   * Так ученик может и сфотографировать сборник, и загрузить готовый файл нот.
   */
  async acceptFile(file) {
    if (isMusicXmlFile(file)) {
      const loaded = await scoreFromUploadedFile(file, { source: 'file' });
      if (!loaded.ok) {
        this.status.textContent = loaded.error;
        this.app.toast(loaded.error);
        return;
      }
      this.status.textContent = `${S.scan.xmlLoaded}: ${file.name}`;
      this.app.toast(`${S.scan.xmlLoaded}: ${loaded.score.title}`);
      this.app.openScore(loaded.score, { source: 'file' });
      return;
    }
    if (isImageFile(file)) {
      const prepared = await prepareImageBlob(file, { maxSide: 2000 });
      await this.setImage(prepared, file.name);
      return;
    }
    this.status.textContent = S.scan.fileUnsupported;
    this.app.toast(S.scan.fileUnsupported);
  }

  /** Перетаскивание файла в область кадра — привычный способ на компьютере */
  setupDropZone() {
    const zone = this.root.querySelector('#drop-zone');
    const hint = this.root.querySelector('#drop-hint');
    if (!zone) return;
    const show = (on) => {
      hint?.classList.toggle('hidden', !on);
      zone.classList.toggle('dragging', on);
    };
    for (const type of ['dragenter', 'dragover']) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        show(true);
      });
    }
    for (const type of ['dragleave', 'drop']) {
      zone.addEventListener(type, () => show(false));
    }
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) await this.acceptFile(file);
    });
  }

  /** Демо-страница: позволяет проверить распознавание, когда камеры под рукой нет */
  async loadSamplePage() {
    try {
      const response = await fetch('./demo/ode-page.png');
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      await this.setImage(blob, 'ode-page.png');
      this.app.toast(S.scan.samplePageHint);
    } catch {
      this.status.textContent = S.scan.sampleMissing;
      this.app.toast(S.scan.sampleMissing);
    }
  }

  async setImage(blob, name = null) {
    this.imageBlob = blob;
    this.imageName = name;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = blobToObjectUrl(blob);
    this.preview.src = this.previewUrl;
    this.preview.classList.remove('hidden');
    this.camera.stop();
    this.root.querySelector('#btn-start').textContent = S.scan.startCamera;
    this.root.querySelector('#btn-shoot').disabled = true;
    this.root.querySelector('#btn-recognize').disabled = false;
    this.root.querySelector('#btn-retake').disabled = false;

    const stats = await imageStats(blob).catch(() => null);
    const parts = [];
    if (name) parts.push(name);
    if (stats) {
      parts.push(`${stats.width}×${stats.height}`);
      parts.push(stats.portrait ? 'книжная ориентация' : 'альбомная ориентация');
      parts.push(stats.contrastOk ? S.scan.contrastOk : S.scan.contrastLow);
      const prepFound = !!(blob.prepStats?.deskewed || blob.prepStats?.cropped);
      if (!stats.fillsFrame && !prepFound) parts.push(S.scan.tooFar);
      else if (stats.pageFound || prepFound) parts.push(S.scan.pageFound);
      else parts.push(S.scan.pageNotFound);
    }
    if (blob.prepStats?.deskewed) {
      const tilt = blob.prepStats.deskew?.tiltDeg;
      parts.push(tilt ? `${S.scan.tiltFixed} (${tilt.toFixed(1)}°)` : S.scan.tiltFixed);
    }
    if (blob.prepStats?.flattened) parts.push(S.scan.lightEvened);
    if (blob.prepStats?.cropped) parts.push(S.scan.fieldsTrimmed);
    this.status.textContent = parts.join(' · ');
  }

  reset() {
    this.imageBlob = null;
    this.preview.classList.add('hidden');
    this.root.querySelector('#btn-recognize').disabled = true;
    this.root.querySelector('#btn-retake').disabled = true;
    this.result.innerHTML = '';
  }

  async recognize() {
    if (!this.imageBlob) {
      this.app.toast(S.scan.noImage);
      return;
    }
    const engine = this.root.querySelector('#engine-select').value || null;
    const mode = this.root.querySelector('#mode-select')?.value === 'full' ? 'full' : 'melody';
    this.result.innerHTML = `<p class="muted">${S.scan.recognizing}</p>`;
    if (engine === 'stub') {
      const which = this.root.querySelector('#engine-select').dataset.fixture || 'odeToJoy';
      const score = demoRecognitionScore(which);
      this.result.innerHTML = `<p class="ok">${S.scan.success} (${S.scan.useDemoPage})</p>`;
      this.app.openScore(score, { source: 'omr' });
      return;
    }
    const response = await recognizeImageBlob(this.imageBlob, {
      engine,
      mode,
      base: this.app.state?.settings?.omrUrl || '',
    });
    if (!response.ok) {
      this.result.innerHTML = `
        <p class="error">${S.scan.serverOffline}: ${response.error}</p>
        <p class="muted small">${S.scan.serverHint}</p>
        <div class="row wrap">
          <select class="input" id="fallback-fixture">
            ${FIXTURE_CHOICES.map((f) => `<option value="${f.id}">${f.name}</option>`).join('')}
          </select>
          <button class="btn" id="btn-fallback">${S.scan.useDemoPage}</button>
        </div>
      `;
      this.result.querySelector('#btn-fallback').addEventListener('click', () => {
        const which = this.result.querySelector('#fallback-fixture').value;
        this.app.openScore(demoRecognitionScore(which), { source: 'omr' });
      });
      return;
    }
    try {
      const { scoreFromMusicXmlText } = await import('../recognition.js');
      const parsed = scoreFromMusicXmlText(response.musicxml, {
        engine: response.engine,
        confidence: response.confidence,
        kind: 'omr',
      });
      const warnings = [...(parsed.warnings || []), ...(response.warnings || [])];
      parsed.warnings = [...new Set(warnings)];
      // В режиме «только мелодия» такт без нот — это место, где флейта молчит (играет фортепиано).
      // Такой такт нельзя выбрасывать: минус сдвинется, и ученик услышит аккомпанемент не с той доли.
      const rested = response.mode === 'melody' ? markRestMeasures(parsed) : { score: parsed, marked: [] };
      if (rested.marked.length) {
        rested.score.warnings = [...new Set([...(rested.score.warnings || []),
          S.scan.restMeasures.replace('{list}', rested.marked.join(', '))])];
      }
      // Пустые такты — гарантированный артефакт распознавания: убираем сразу, остальное предложим на экране «Минус»
      const { score, applied } = autoRepairScore(rested.score);
      // Обложка снятой страницы: попадает в библиотеку вместе с пьесой
      const cover = await makeThumbnail(this.imageBlob).catch(() => null);
      const appendTo = this.root.querySelector('#append-current')?.checked ? this.app.state?.score : null;
      if (appendTo) {
        const at = this.insertAt();
        const merged = this.app.appendPage(score, { cover: null, pageCover: cover, at });
        if (merged?.ok) {
          const place = merged.at != null && merged.at < merged.pages - 1 ? `, перед стр. ${merged.at + 1}` : '';
          this.result.innerHTML = `
            <p class="ok">${S.scan.appendDone}: <b>${merged.score.title}</b> — ${merged.score.measures.length} ${t('common.measure', 'такт')}, ${merged.pages} ${S.library.pagesShort}${place}</p>
            <p class="muted small">${S.scan.engine}: ${response.engine || '—'} (+${merged.addedMeasures} ${t('common.measure', 'такт')})</p>
            ${applied.length ? `<p class="muted small">${applied.join('; ')}</p>` : ''}
            ${merged.warnings.length ? `<p class="warn small">${merged.warnings.map((w) => `• ${w}`).join('<br>')}</p>` : ''}
          `;
          this.updateCurrentPiece();
          return;
        }
        this.result.innerHTML = `<p class="warn">${merged?.reason || S.common.error}</p>`;
      }
      this.result.innerHTML = `
        <p class="ok">${S.scan.success}: <b>${score.title}</b></p>
        <p class="muted small">${S.scan.engine}: ${response.engine || '—'}${response.confidence != null ? ` · ${S.scan.confidence}: ${Math.round(response.confidence * 100)}%` : ''}${response.elapsedMs ? ` · ${S.scan.elapsed}: ${(response.elapsedMs / 1000).toFixed(1)} с` : ''} · ${response.mode === 'melody' ? S.scan.modeMelody : S.scan.modeFull}</p>
        ${mode === 'melody' && response.mode !== 'melody' ? `<p class="muted small">${S.scan.modeNotApplied}</p>` : ''}
        ${applied.length ? `<p class="muted small">${applied.join('; ')}</p>` : ''}
        ${score.warnings.length ? `<p class="warn small">${S.scan.warnings}:<br>${score.warnings.map((w) => `• ${w}`).join('<br>')}</p>` : ''}
        <p class="muted small">${S.scan.fixesHint}</p>
      `;
      this.app.openScore(score, { source: 'omr', image: null, cover });
    } catch (error) {
      this.result.innerHTML = `<p class="error">${S.common.error}: ${error.message}</p>`;
    }
  }

  createManual() {
    const score = scoreFromManualInput({
      title: this.root.querySelector('#m-title').value || 'Учебная пьеса',
      tonic: this.root.querySelector('#m-tonic').value,
      mode: this.root.querySelector('#m-mode').value,
      meterText: this.root.querySelector('#m-meter').value,
      tempo: Number(this.root.querySelector('#m-tempo').value) || 100,
      chordsText: this.root.querySelector('#m-chords').value,
      melodyText: this.root.querySelector('#m-melody').value,
    });
    this.app.openScore(score, { source: 'manual' });
  }
}