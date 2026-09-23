// FluteBand AI — все тексты интерфейса в одном месте (решение №16: только русский, но с заделом на перевод).

export const S = {
  appName: 'FluteBand AI',
  appTagline: 'Умный аккомпаниатор и транспонировщик для учеников',

  tabLibrary: 'Библиотека',
  tabScan: 'Сканировать',
  tabPlayer: 'Минус',

  library: {
    title: 'Мои пьесы',
    demoTitle: 'Демонстрационные пьесы (public domain)',
    empty: 'Пока пусто. Откройте демо-пьесу или отсканируйте ноты.',
    open: 'Открыть',
    delete: 'Удалить',
    deleted: 'Пьеса удалена',
    importMusicXml: 'Импорт MusicXML',
    pasteMusicXml: 'Вставить MusicXML',
    pastePlaceholder: 'Вставьте MusicXML и нажмите «Разобрать»',
    parse: 'Разобрать',
    loaded: 'Пьеса загружена',
    measures: 'тактов',
    omrTitle: 'Распознанные пьесы',
    search: 'Поиск по названию, автору или тегу',
    searchEmpty: 'Ничего не найдено. Измените запрос или снимите фильтр по тегу.',
    sort: 'Порядок',
    tags: 'Теги',
    tagAll: 'все',
    tagAdd: 'Добавить тег',
    tagPrompt: 'Тег для пьесы',
    tagHint: 'Теги помогают найти пьесу: «класс 2», «домашка», «концерт», «этюд».',
    tagPresets: 'Готовые теги: класс, жанр, задание',
    tagAdded: 'Тег добавлен',
    tagRemoved: 'Тег убран',
    pagesMoved: 'Страница переставлена',
    pagesTitle: 'Страницы пьесы',
    pageUp: 'Выше',
    pageDown: 'Ниже',
    pageInsertAt: 'Куда вставить страницу',
    pageInsertEnd: 'В конец',
    pageInsertBefore: 'Перед страницей',
    pieces: 'пьес',
    pagesShort: 'стр.',
    scannedMark: 'снимок',
    musicXml: 'Скачать MusicXML',
    librarySummary: 'Библиотека',
  },

  scan: {
    title: 'Сканирование нот',
    hint: 'Положите сборник на ровную поверхность, заполните кадр страницей, держите телефон параллельно листу. Свет должен быть ровным, без бликов.',
    startCamera: 'Включить камеру',
    stopCamera: 'Выключить камеру',
    shoot: 'Снять страницу',
    fromFile: 'Выбрать фото из галереи',
    uploadFile: 'Загрузить файл',
    uploadHint: 'Можно загрузить фото нот (JPG, PNG, HEIC) или готовый файл MusicXML (.musicxml, .xml) — он разберётся сразу, без сервера.',
    dropHere: 'Отпустите файл — загрузим его',
    fileUnsupported: 'Такой файл не подходит: нужны фото нот или MusicXML (.musicxml, .xml)',
    xmlLoaded: 'Пьеса загружена из файла MusicXML',
    samplePage: 'Пример страницы',
    samplePageHint: 'Нет камеры под рукой? Возьмите готовую страницу «Оды к радости» и проверьте распознавание.',
    sampleMissing: 'Демо-страница не найдена — сгенерируйте её командой node tools/make-demo-page.mjs',
    recognize: 'Распознать ноты',
    recognizing: 'Распознаём ноты…',
    contrastOk: 'контраст достаточный',
    contrastLow: 'низкий контраст — проверьте свет',
    pageFound: 'страница найдена, поля обрезаны',
    pageNotFound: 'страница не найдена — снимайте на однотонном фоне',
    tooFar: 'страница занимает мало места в кадре — подойдите ближе',
    fieldsTrimmed: 'поля обрезаны автоматически',
    tiltFixed: 'наклон страницы выровнен',
    lightEvened: 'тень и градиент света убраны',
    noCamera: 'Камера недоступна',
    cameraDenied: 'Доступ к камере запрещён. Разрешите доступ в настройках браузера или выберите фото из галереи.',
    insecure: 'Камера работает только на localhost или по HTTPS. На телефоне по локальной сети нужен HTTPS.',
    noImage: 'Сначала снимите или выберите страницу',
    preview: 'Страница для распознавания',
    serverOffline: 'Сервер распознавания не отвечает',
    serverHint: 'Распознавание выполняется на сервере (бесплатный тариф). Пока сервер недоступен, можно:',
    useDemoPage: 'Взять эталонную страницу (демо)',
    fixesHint: 'Проверьте распознанное: типовые ошибки движка исправляются одной кнопкой.',
    fixesNone: 'Спорных тактов не найдено — можно играть.',
    manualEntry: 'Ввести аккорды вручную',
    engine: 'Движок',
    confidence: 'Уверенность',
    success: 'Ноты распознаны',
    modeMelody: 'Режим: только мелодия',
    modeFull: 'Режим: вся страница',
    modeHintMelody: 'Быстрее: сервис оставляет только мелодический стан каждой строки. Мелодия распознаётся та же, а гармония выводится из неё — партии фортепиано в разборе не будет.',
    modeHintFull: 'Точнее по гармонии: сервис читает всю страницу, включая партии фортепиано. Ждать дольше.',
    modeNotApplied: 'Сервис распознал всю страницу (мелодию выделить не удалось)',
    restMeasures: 'Такты, где флейта молчит, оставлены паузами ({list}) — иначе минус сдвинулся бы',
    elapsed: 'Время распознавания',
    warnings: 'Замечания распознавания',
    retake: 'Переснять',
    appendToCurrent: 'Приклеить страницу к текущей пьесе',
    currentPiece: 'Открыта пьеса',
    appendDone: 'Страница добавлена',
    appendedPages: 'Страниц в пьесе',
    newPiece: 'Открыть как новую пьесу',
    appendHint: 'Сборник снимают по страницам: включите галочку — следующая страница приклеится к той же пьесе.',
    serverSettings: 'Сервис распознавания',
    serverSettingsHint: 'Пусто — сервис рядом с приложением (адрес /api). Если приложение на статическом хостинге, а сервис на другом — укажите его адрес: https://ваш-сервис.example.com',
    serverPlaceholder: 'https://ваш-сервис.example.com',
    serverCheck: 'Проверить связь',
    serverSaved: 'Адрес сервиса сохранён',
    serverLocal: 'свой адрес приложения',
  },

  player: {
    title: 'Воспроизведение минуса',
    noScore: 'Пьеса не выбрана. Откройте пьесу в библиотеке.',
    instrument: 'Инструмент ученика',
    style: 'Рисунок аккомпанемента',
    tempo: 'Темп',
    metronome: 'Метроном',
    countIn: 'Счёт-ин (такт)',
    loop: 'Повтор',
    loopSet: 'Зациклить такт',
    loopClear: 'Снять повтор',
    volume: 'Громкость',
    play: 'Играть',
    pause: 'Пауза',
    stop: 'Стоп',
    exportMidi: 'Скачать MIDI',
    exportWav: 'Скачать WAV',
    exportWavBusy: 'Готовим WAV…',
    transposition: 'Тональность минуса',
    transposeAuto: 'Авто под инструмент',
    transposeManual: 'Сдвиг, полутонов',
    soundingKey: 'Звучит в',
    editHarmony: 'Аккорды по тактам',
    editHint: 'Нажмите на такт, чтобы исправить аккорд',
    chordPrompt: 'Аккорд для такта',
    realPiano: 'Реалистичное пиано (запись рояля)',
    realPianoOn: 'Загружаем банк звуков…',
    realPianoFailed: 'Не удалось загрузить банк — играем встроенным синтезом',
    sound: 'Звук фортепиано',
    bankLoading: 'загрузка банка',
    samplesLoaded: 'сэмплов',
    toneHint: 'встроенный синтез: работает без интернета, звук простой',
    peak: 'пик',
    spaceHint: 'Клавиши: пробел — играть/пауза, ←/→ — такт назад/вперёд',
    retempoNote: 'Темп и транспонирование не меняют высоту звука: минус синтезируется из нот.',
    fromOmr: 'Распознано',
    fromDemo: 'Демо',
    fromManual: 'Вручную',
  },

  common: {
    yes: 'Да',
    no: 'Нет',
    cancel: 'Отмена',
    close: 'Закрыть',
    error: 'Ошибка',
    ok: 'Готово',
    loading: 'Загрузка…',
    save: 'Сохранить',
    measure: 'такт',
    semitones: 'полутонов',
    scoreTitle: 'Название',
  },
};

export function t(path, fallback = '') {
  const parts = String(path).split('.');
  let node = S;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return fallback || path;
    node = node[p];
  }
  return typeof node === 'string' ? node : fallback || path;
}

/** Склонение: 1 полутон / 2 полутона / 5 полутонов */
export function plural(n, one, few, many) {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function semitonesText(n) {
  const v = Math.abs(Math.round(n));
  return `${v} ${plural(v, 'полутон', 'полутона', 'полутонов')}`;
}

export function measuresText(n) {
  return `${n} ${plural(n, 'такт', 'такта', 'тактов')}`;
}

export function clockText(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}