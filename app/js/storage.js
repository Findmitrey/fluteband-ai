// FluteBand AI — локальная библиотека пьес (IndexedDB) и настройки (localStorage).
// Данные не покидают устройство: на сервер уходит только изображение страницы при распознавании.

const DB_NAME = 'fluteband-ai';
const DB_VERSION = 3;
const STORE_SCORES = 'scores';
const STORE_BANK = 'bank';
const SETTINGS_KEY = 'fluteband.settings.v1';

const memory = { scores: new Map(), bank: new Map() };

function hasIdb() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const scores = db.objectStoreNames.contains(STORE_SCORES)
        ? req.transaction.objectStore(STORE_SCORES)
        : db.createObjectStore(STORE_SCORES, { keyPath: 'id' });
      if (!scores.indexNames.contains('savedAt')) scores.createIndex('savedAt', 'savedAt');
      // Теги индексируются: за год занятий в библиотеке набирается много пьес
      if (!scores.indexNames.contains('tags')) scores.createIndex('tags', 'tags', { multiEntry: true });
      if (!db.objectStoreNames.contains(STORE_BANK)) {
        db.createObjectStore(STORE_BANK, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn, storeName = STORE_SCORES) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Сохранить пьесу (и, при желании, изображение страницы) */
export async function saveScore(score, { image = null } = {}) {
  const record = { ...score, savedAt: Date.now(), image: image || score.image || null };
  if (record.tags) record.tags = [...new Set(record.tags)];
  if (!hasIdb()) {
    memory.scores.set(record.id, record);
    return record;
  }
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.put(record));
  db.close();
  return record;
}

/**
 * Обновить часть полей пьесы (теги, обложку, название) — без пересохранения всей модели.
 * Возвращает обновлённую запись или null, если пьесы нет.
 */
export async function patchScore(id, patch) {
  const clean = { ...patch };
  if (clean.tags) clean.tags = [...new Set(clean.tags.filter(Boolean))];
  if (!hasIdb()) {
    const found = memory.scores.get(id);
    if (!found) return null;
    const updated = { ...found, ...clean };
    memory.scores.set(id, updated);
    return updated;
  }
  const db = await openDb();
  const current = await tx(db, 'readonly', (store) => store.get(id));
  if (!current) {
    db.close();
    return null;
  }
  const updated = { ...current, ...clean };
  await tx(db, 'readwrite', (store) => store.put(updated));
  db.close();
  return updated;
}

/** Все пьесы с указанным тегом (по индексу, без перебора всей библиотеки). */
export async function scoresByTag(tag) {
  const clean = String(tag || '').trim().toLowerCase();
  if (!clean) return [];
  if (!hasIdb()) return [...memory.scores.values()].filter((s) => (s.tags || []).includes(clean));
  const db = await openDb();
  const found = await tx(db, 'readonly', (store) => store.index('tags').getAll(clean));
  db.close();
  return found || [];
}

export async function listScores() {
  if (!hasIdb()) return [...memory.scores.values()].sort((a, b) => b.savedAt - a.savedAt);
  const db = await openDb();
  const all = await tx(db, 'readonly', (store) => store.getAll());
  db.close();
  return (all || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function getScore(id) {
  if (!hasIdb()) return memory.scores.get(id) || null;
  const db = await openDb();
  const found = await tx(db, 'readonly', (store) => store.get(id));
  db.close();
  return found || null;
}

export async function deleteScore(id) {
  if (!hasIdb()) return memory.scores.delete(id);
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.delete(id));
  db.close();
  return true;
}

export async function clearScores() {
  if (!hasIdb()) return memory.scores.clear();
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.clear());
  db.close();
  return true;
}

// ── Кэш банка звуков: один раз скачали — дальше играем мгновенно и офлайн ──────────────

function bankKey(bankId, midi) {
  return `${bankId}:${midi}`;
}

/** Сохранить один сэмпл банка (ArrayBuffer) */
export async function saveBankSample(bankId, { midi, name, bytes, size = null }) {
  const record = {
    key: bankKey(bankId, midi),
    bankId,
    midi,
    name: name || null,
    bytes,
    size: size ?? bytes?.byteLength ?? 0,
    savedAt: Date.now(),
  };
  if (!hasIdb()) {
    memory.bank.set(record.key, record);
    return record;
  }
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.put(record), STORE_BANK);
  db.close();
  return record;
}

/** Достать один сэмпл банка: null, если его ещё нет в кэше */
export async function loadBankSample(bankId, midi) {
  const key = bankKey(bankId, midi);
  if (!hasIdb()) return memory.bank.get(key)?.bytes || null;
  const db = await openDb();
  const found = await tx(db, 'readonly', (store) => store.get(key), STORE_BANK);
  db.close();
  return found?.bytes || null;
}

/** Что уже лежит в кэше: сколько нот, сколько байт, когда сохраняли */
export async function bankCacheInfo(bankId) {
  if (!hasIdb()) {
    const rows = [...memory.bank.values()].filter((r) => !bankId || r.bankId === bankId);
    return summarizeBank(rows);
  }
  const db = await openDb();
  const all = (await tx(db, 'readonly', (store) => store.getAll(), STORE_BANK)) || [];
  db.close();
  return summarizeBank(all.filter((r) => !bankId || r.bankId === bankId));
}

function summarizeBank(rows) {
  return {
    notes: rows.length,
    bytes: rows.reduce((sum, r) => sum + (r.size || 0), 0),
    savedAt: rows.reduce((latest, r) => Math.max(latest, r.savedAt || 0), 0) || null,
  };
}

/** Убрать банк из кэша (например, чтобы освободить место на телефоне) */
export async function clearBankCache(bankId = null) {
  if (!hasIdb()) {
    for (const key of [...memory.bank.keys()]) {
      if (!bankId || key.startsWith(`${bankId}:`)) memory.bank.delete(key);
    }
    return true;
  }
  const db = await openDb();
  if (!bankId) {
    await tx(db, 'readwrite', (store) => store.clear(), STORE_BANK);
  } else {
    const all = (await tx(db, 'readonly', (store) => store.getAll(), STORE_BANK)) || [];
    await tx(db, 'readwrite', (store) => {
      for (const row of all) if (row.bankId === bankId) store.delete(row.key);
    }, STORE_BANK);
  }
  db.close();
  return true;
}

const DEFAULT_SETTINGS = {
  instrumentId: 'flute',
  style: 'auto',
  transposeMode: 'auto',
  manualSemitones: 0,
  metronome: false,
  countIn: true,
  volume: 0.85,
  realPiano: false,
  pianoBank: 'tone',
  tempoMode: 'score',
  // Адрес сервиса распознавания: пусто — сервис рядом с приложением (/api/*)
  omrUrl: '',
  // Режим распознавания: 'melody' — только мелодический стан (в разы быстрее), 'full' — вся страница
  omrMode: 'melody',
};

export function loadSettings() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_KEY);
    const merged = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    // Старая настройка «реалистичное пиано» превращается в выбор банка
    if (merged.pianoBank === 'tone' && merged.realPiano) merged.pianoBank = 'royal';
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* приватный режим — просто не сохраняем */
  }
  return settings;
}

export { DEFAULT_SETTINGS };