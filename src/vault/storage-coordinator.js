import './cookie-vault-head.js';
import { getTodayUtcString, generateDailyCartridgeROM } from './daily-seed.js';
import { bakeStandaloneHtml as bakeStandaloneHtmlImpl } from './local-sync-baker.js';

const DB_NAME = 'bitforge80_db';
const DB_VERSION = 1;
const STORE_CARTRIDGES = 'cartridges';
const STORE_SNAPSHOTS = 'snapshots';
const RING_BUFFER_SIZE = 32;
const VAULT_JSON_SCHEMA = 'bitforge80.vault.v1';

const state = {
  initialized: false,
  storageMode: 'memory',
  db: null,
  memCartridges: new Map(),
  memSnapshots: new Map(),
  activeRecord: null,
  env: null,
  hooks: {
    encodeCart: null,
    decodeCart: null
  }
};

const headGetInitialBootPayload =
  typeof globalThis.__BITFORGE_VAULT__?.getInitialBootPayload === 'function' &&
  globalThis.__BITFORGE_VAULT__.getInitialBootPayload._isCoordinatorWrapper !== true
    ? globalThis.__BITFORGE_VAULT__.getInitialBootPayload
    : null;

function getVaultHead() {
  return globalThis.__BITFORGE_VAULT__ || {};
}

function createMemoryBackedInit(reason) {
  if (state.db && typeof state.db.close === 'function') {
    try {
      state.db.close();
    } catch {
      // Ignore close error
    }
  }
  state.db = null;
  state.storageMode = 'memory';
  void reason;
}

function openBitForgeDb(idbFactory) {
  return new Promise((resolve, reject) => {
    if (!idbFactory || typeof idbFactory.open !== 'function') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    let req;
    try {
      req = idbFactory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CARTRIDGES)) {
        db.createObjectStore(STORE_CARTRIDGES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'slot' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open bitforge80_db'));
    req.onblocked = () => reject(new Error('bitforge80_db open blocked'));
  });
}

function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error || new Error(`getAll failed on ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

function idbPut(db, storeName, record) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`put failed on ${storeName}`));
      tx.onabort = () => reject(tx.error || new Error(`put aborted on ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

function idbClear(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`clear failed on ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

async function storeGetAll(storeName) {
  if (state.storageMode === 'indexeddb' && state.db) {
    try {
      return await idbGetAll(state.db, storeName);
    } catch {
      createMemoryBackedInit('idb-read-fallback');
    }
  }
  const map = storeName === STORE_CARTRIDGES ? state.memCartridges : state.memSnapshots;
  return Array.from(map.values());
}

async function storePut(storeName, key, record) {
  const map = storeName === STORE_CARTRIDGES ? state.memCartridges : state.memSnapshots;
  map.set(key, record);
  if (state.storageMode === 'indexeddb' && state.db) {
    try {
      await idbPut(state.db, storeName, record);
    } catch {
      createMemoryBackedInit('idb-write-fallback');
    }
  }
}

async function storeClear(storeName) {
  const map = storeName === STORE_CARTRIDGES ? state.memCartridges : state.memSnapshots;
  map.clear();
  if (state.storageMode === 'indexeddb' && state.db) {
    try {
      await idbClear(state.db, storeName);
    } catch {
      createMemoryBackedInit('idb-clear-fallback');
    }
  }
}

async function ensureReady() {
  if (!state.initialized) {
    await initVaultCoordinator();
  }
}

function isRomObject(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.magic === 'BF80' && obj.version === 1 && obj.meta);
}

function extractSummary(romOrSummary) {
  if (!romOrSummary || typeof romOrSummary !== 'object') return null;
  if (isRomObject(romOrSummary)) {
    const m = romOrSummary.meta;
    return {
      id: String(m.id || 'active'),
      title: String(m.title || 'UNTITLED'),
      author: String(m.author || ''),
      paletteId: m.paletteId || 'classic16',
      primaryVerb: m.primaryVerb || 'slingshot',
      updatedAt: Number(m.updatedAt) || Date.now()
    };
  }
  return {
    id: romOrSummary.id ? String(romOrSummary.id) : 'active',
    title: romOrSummary.title ? String(romOrSummary.title) : undefined,
    author: romOrSummary.author ? String(romOrSummary.author) : undefined,
    paletteId: romOrSummary.paletteId,
    primaryVerb: romOrSummary.primaryVerb,
    updatedAt: typeof romOrSummary.updatedAt === 'number' ? romOrSummary.updatedAt : undefined
  };
}

function serializeRomForJson(rom) {
  if (!isRomObject(rom)) return null;
  return {
    magic: 'BF80',
    version: 1,
    meta: {
      ...rom.meta,
      customPalette: rom.meta.customPalette ? Array.from(rom.meta.customPalette) : null
    },
    sprites: Array.isArray(rom.sprites)
      ? rom.sprites.map((sp) => ({
          size: sp.size === 16 ? 16 : 8,
          frames: Array.isArray(sp.frames) ? sp.frames.map((fr) => Array.from(fr)) : []
        }))
      : [],
    world: {
      width: rom.world.width === 32 ? 32 : 16,
      height: rom.world.height === 32 ? 32 : 16,
      bgLayer: Array.from(rom.world.bgLayer || []),
      mainLayer: Array.from(rom.world.mainLayer || []),
      fgLayer: Array.from(rom.world.fgLayer || []),
      collision: Array.from(rom.world.collision || [])
    },
    audio: {
      bpm: Number(rom.audio?.bpm) || 100,
      scaleId: rom.audio?.scaleId || 'pentatonic',
      channels: Array.isArray(rom.audio?.channels)
        ? rom.audio.channels.map((ch) => ({
            steps: Array.from(ch.steps || []),
            dutyOrTimbre: Number(ch.dutyOrTimbre) || 128,
            volume: Number(ch.volume) || 60
          }))
        : [],
      wavetable32: Array.from(rom.audio?.wavetable32 || []),
      sfxPatches: Array.isArray(rom.audio?.sfxPatches)
        ? rom.audio.sfxPatches.map((p) => ({
            archetype: Number(p.archetype) || 0,
            x: Number(p.x) || 0,
            y: Number(p.y) || 0
          }))
        : []
    },
    logic: {
      presetGameId: rom.logic?.presetGameId ?? null,
      ruleChips: Array.isArray(rom.logic?.ruleChips) ? rom.logic.ruleChips.map((c) => ({ ...c })) : [],
      customJs: typeof rom.logic?.customJs === 'string' ? rom.logic.customJs : ''
    }
  };
}

function deserializeRomFromJson(raw) {
  if (!raw || typeof raw !== 'object' || raw.magic !== 'BF80' || raw.version !== 1 || !raw.meta) {
    return null;
  }
  return {
    magic: 'BF80',
    version: 1,
    meta: {
      ...raw.meta,
      customPalette: raw.meta.customPalette ? Uint8Array.from(raw.meta.customPalette) : null
    },
    sprites: Array.isArray(raw.sprites)
      ? raw.sprites.map((sp) => ({
          size: sp.size === 16 ? 16 : 8,
          frames: Array.isArray(sp.frames) ? sp.frames.map((fr) => Uint8Array.from(fr)) : []
        }))
      : [],
    world: {
      width: raw.world?.width === 32 ? 32 : 16,
      height: raw.world?.height === 32 ? 32 : 16,
      bgLayer: Uint8Array.from(raw.world?.bgLayer || []),
      mainLayer: Uint8Array.from(raw.world?.mainLayer || []),
      fgLayer: Uint8Array.from(raw.world?.fgLayer || []),
      collision: Uint8Array.from(raw.world?.collision || [])
    },
    audio: {
      bpm: Number(raw.audio?.bpm) || 100,
      scaleId: raw.audio?.scaleId || 'pentatonic',
      channels: Array.isArray(raw.audio?.channels)
        ? raw.audio.channels.map((ch) => ({
            steps: Uint16Array.from(ch.steps || []),
            dutyOrTimbre: Number(ch.dutyOrTimbre) || 128,
            volume: Number(ch.volume) || 60
          }))
        : [],
      wavetable32: Uint8Array.from(raw.audio?.wavetable32 || []),
      sfxPatches: Array.isArray(raw.audio?.sfxPatches)
        ? raw.audio.sfxPatches.map((p) => ({
            archetype: Number(p.archetype) || 0,
            x: Number(p.x) || 0,
            y: Number(p.y) || 0
          }))
        : []
    },
    logic: {
      presetGameId: raw.logic?.presetGameId ?? null,
      ruleChips: Array.isArray(raw.logic?.ruleChips) ? raw.logic.ruleChips.map((c) => ({ ...c })) : [],
      customJs: typeof raw.logic?.customJs === 'string' ? raw.logic.customJs : ''
    }
  };
}

function readActiveStorageRecord() {
  const head = getVaultHead();
  let raw = null;
  try {
    const storage = state.env && state.env.storage !== undefined
      ? state.env.storage
      : (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
    if (storage && typeof storage.getItem === 'function') {
      raw = storage.getItem('bitforge80.active');
    }
  } catch {
    raw = null;
  }

  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.v === 1 &&
        typeof parsed.cartHash === 'string' &&
        parsed.cartHash &&
        typeof head._crc32 === 'function' &&
        (parsed.crc >>> 0) === head._crc32(parsed.cartHash)
      ) {
        return parsed;
      }
    } catch {
      // Ignore corrupt localStorage
    }
  }

  return state.activeRecord;
}

/**
 * Initializes IndexedDB (bitforge80_db v1) or memory fallback and flushes any pending #cart= snapshot.
 * @param {object} [opts]
 */
export async function initVaultCoordinator(opts = {}) {
  const {
    storage,
    getCookie,
    setCookie,
    clearCookie,
    hash,
    bakedCart,
    indexedDB: customIdb,
    encodeCart,
    decodeCart,
    resetStore = false
  } = opts || {};

  if (resetStore) {
    state.memCartridges.clear();
    state.memSnapshots.clear();
    state.activeRecord = null;
    state.env = null;
    state.hooks.encodeCart = null;
    state.hooks.decodeCart = null;
    try {
      globalThis.__BITFORGE_PENDING_SNAPSHOT__ = null;
    } catch {
      // Ignore non-writable global
    }
  }

  if (
    storage !== undefined ||
    getCookie !== undefined ||
    setCookie !== undefined ||
    clearCookie !== undefined ||
    hash !== undefined ||
    bakedCart !== undefined
  ) {
    state.env = { storage, getCookie, setCookie, clearCookie, hash, bakedCart };
  } else if (opts && Object.keys(opts).length === 0) {
    state.env = null;
  }

  if (typeof encodeCart === 'function') state.hooks.encodeCart = encodeCart;
  if (typeof decodeCart === 'function') state.hooks.decodeCart = decodeCart;

  const idbFactory = customIdb !== undefined
    ? customIdb
    : (typeof globalThis.indexedDB !== 'undefined' ? globalThis.indexedDB : null);

  if (state.db && typeof state.db.close === 'function') {
    try {
      state.db.close();
    } catch {
      // Ignore close error
    }
    state.db = null;
  }

  if (idbFactory) {
    try {
      state.db = await openBitForgeDb(idbFactory);
      state.storageMode = 'indexeddb';
    } catch {
      createMemoryBackedInit('idb-open-failed');
    }
  } else {
    createMemoryBackedInit('no-idb');
  }

  state.initialized = true;

  const head = getVaultHead();
  if (state.env && typeof head._rehydrateSync === 'function') {
    head._rehydrateSync(state.env);
  }

  const pending = globalThis.__BITFORGE_PENDING_SNAPSHOT__;
  if (pending && typeof pending.cartHash === 'string' && pending.cartHash.length > 0) {
    await snapshotToRingBuffer(pending.cartHash, pending.reason || 'incoming-url-cart');
    try {
      globalThis.__BITFORGE_PENDING_SNAPSHOT__ = null;
    } catch {
      // Ignore non-writable global
    }
  }
}

/**
 * Returns the boot payload determined by cookie-vault-head.js.
 */
export function getInitialBootPayload() {
  if (typeof headGetInitialBootPayload === 'function') {
    return headGetInitialBootPayload();
  }
  const head = getVaultHead();
  if (typeof head._rehydrateSync === 'function') {
    return head._rehydrateSync();
  }
  return {
    source: 'pack-in',
    cartHash: null,
    healedFromCookie: false,
    regeneratedCookie: false
  };
}
getInitialBootPayload._isCoordinatorWrapper = true;

/**
 * Commits an active cartridge hash to localStorage, SameSite=Lax cookies, and bitforge80_db.
 * @param {string} cartHash
 * @param {object|null} [romSummary]
 */
export async function commitActiveCart(cartHash, romSummary = null) {
  if (typeof cartHash !== 'string' || !cartHash) {
    throw new TypeError('commitActiveCart requires a non-empty cartHash string');
  }
  await ensureReady();

  const head = getVaultHead();
  const summary = extractSummary(romSummary);
  const fullRom = isRomObject(romSummary)
    ? romSummary
    : (romSummary && isRomObject(romSummary.rom) ? romSummary.rom : null);

  const persisted = typeof head._persistSync === 'function'
    ? head._persistSync(cartHash, summary, state.env || undefined)
    : {
        ts: Date.now(),
        crc: typeof head._crc32 === 'function' ? head._crc32(cartHash) : 0
      };

  const ts = persisted.ts || Date.now();
  const crc = persisted.crc >>> 0;

  state.activeRecord = {
    v: 1,
    ts,
    crc,
    cartHash,
    summary,
    rom: fullRom ? serializeRomForJson(fullRom) : null
  };

  const cartId = (summary && summary.id) || 'active';
  await storePut(STORE_CARTRIDGES, cartId, {
    id: cartId,
    cartHash,
    summary,
    rom: fullRom ? serializeRomForJson(fullRom) : null,
    ts
  });
}

let snapshotMutex = Promise.resolve();

/**
 * Appends a cartridge snapshot to the 32-slot (0..31) circular ring buffer in IndexedDB.
 * @param {string} cartHash
 * @param {string} [reason='manual']
 * @returns {Promise<number>} Slot index 0..31
 */
export async function snapshotToRingBuffer(cartHash, reason = 'manual') {
  if (typeof cartHash !== 'string' || !cartHash) {
    throw new TypeError('snapshotToRingBuffer requires a non-empty cartHash string');
  }
  const run = snapshotMutex.then(async () => {
    await ensureReady();

    const existing = await storeGetAll(STORE_SNAPSHOTS);
    let maxSeq = 0;
    for (const item of existing) {
      if (item && typeof item.seq === 'number' && item.seq > maxSeq) {
        maxSeq = item.seq;
      }
    }

    const seq = maxSeq + 1;
    const slot = (seq - 1) % RING_BUFFER_SIZE;
    const record = {
      slot,
      seq,
      ts: Date.now(),
      reason: String(reason || 'manual'),
      cartHash
    };

    await storePut(STORE_SNAPSHOTS, slot, record);
    return slot;
  });
  snapshotMutex = run.catch(() => {});
  return run;
}

/**
 * Returns all ring-buffer snapshots ordered newest-first.
 * @returns {Promise<Array<{ slot: number, seq: number, ts: number, reason: string, cartHash: string }>>}
 */
export async function getSnapshots() {
  await ensureReady();
  const rows = await storeGetAll(STORE_SNAPSHOTS);
  return rows
    .filter((r) => r && typeof r.slot === 'number')
    .map((r) => ({ ...r }))
    .sort((a, b) => (b.seq || 0) - (a.seq || 0));
}

/**
 * Triggers the deterministic daily UTC seed cartridge reset, invoking optional shutter callback.
 * @param {object} [options]
 * @returns {Promise<object>} CartridgeROM
 */
export async function resetDailyRitual(options = {}) {
  await ensureReady();
  const { utcDate, onShutter, encodeCart } = options || {};
  const targetDate = typeof utcDate === 'string' && utcDate.trim() ? utcDate.trim() : getTodayUtcString();

  if (typeof onShutter === 'function') {
    try {
      onShutter();
    } catch {
      // Shutter audio/visual failure must never block cartridge reset
    }
  }

  const prev = readActiveStorageRecord();
  if (prev && typeof prev.cartHash === 'string' && prev.cartHash.length > 0) {
    await snapshotToRingBuffer(prev.cartHash, 'daily-ritual-reset');
  }

  const rom = generateDailyCartridgeROM(targetDate);
  const encoder = typeof encodeCart === 'function' ? encodeCart : state.hooks.encodeCart;
  let cartHash = null;
  if (typeof encoder === 'function') {
    cartHash = encoder(rom);
  }

  if (typeof cartHash === 'string' && cartHash.length > 0) {
    await commitActiveCart(cartHash, rom);
  } else {
    const serialized = serializeRomForJson(rom);
    const summary = extractSummary(rom);
    await storePut(STORE_CARTRIDGES, rom.meta.id, {
      id: rom.meta.id,
      cartHash: null,
      summary,
      rom: serialized,
      ts: Date.now()
    });
  }

  return rom;
}

/**
 * Exports active cartridge, stored cartridges, and 32-slot snapshot ring buffer as a JSON Blob.
 * @returns {Promise<Blob>}
 */
export async function exportVaultJson() {
  await ensureReady();
  const active = readActiveStorageRecord();
  const cartridges = await storeGetAll(STORE_CARTRIDGES);
  const snapshots = await getSnapshots();

  const payload = {
    schema: VAULT_JSON_SCHEMA,
    version: 1,
    exportedAt: Date.now(),
    active: active
      ? {
          v: 1,
          ts: Number(active.ts) || Date.now(),
          crc: Number(active.crc) >>> 0,
          cartHash: active.cartHash,
          summary: active.summary || null,
          rom: active.rom || null
        }
      : null,
    cartridges: cartridges.map((c) => ({ ...c })),
    snapshots
  };

  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/**
 * Validates and imports a .bitforge.json vault backup into storage and IndexedDB.
 * @param {string} jsonText
 * @returns {Promise<{ importedCount: number, activeCart: object }>}
 */
export async function importVaultJson(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) {
    throw new Error('Vault JSON input must be a non-empty string');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Malformed vault JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vault JSON root must be an object');
  }
  if (parsed.schema !== VAULT_JSON_SCHEMA || parsed.version !== 1) {
    throw new Error('Unsupported or missing vault schema/version');
  }
  if (parsed.cartridges !== undefined && !Array.isArray(parsed.cartridges)) {
    throw new Error('Vault JSON cartridges field must be an array');
  }
  if (parsed.snapshots !== undefined && !Array.isArray(parsed.snapshots)) {
    throw new Error('Vault JSON snapshots field must be an array');
  }

  const head = getVaultHead();
  if (parsed.active !== undefined && parsed.active !== null) {
    if (typeof parsed.active !== 'object') {
      throw new Error('Vault JSON active entry must be an object or null');
    }
    if (typeof parsed.active.cartHash !== 'string' || !parsed.active.cartHash) {
      throw new Error('Vault JSON active entry missing valid cartHash');
    }
    if (parsed.active.crc !== undefined) {
      const expected = typeof head._crc32 === 'function' ? head._crc32(parsed.active.cartHash) : 0;
      if (typeof parsed.active.crc !== 'number' || (parsed.active.crc >>> 0) !== expected) {
        throw new Error('Vault JSON active entry failed CRC32 verification');
      }
    }
  }

  const cartridges = parsed.cartridges || [];
  for (const entry of cartridges) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
      throw new Error('Vault JSON contains invalid cartridge entry');
    }
  }

  const snapshots = parsed.snapshots || [];
  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object' || typeof snap.cartHash !== 'string' || !snap.cartHash) {
      throw new Error('Vault JSON contains invalid snapshot entry');
    }
    if (snap.slot !== undefined && (!Number.isInteger(snap.slot) || snap.slot < 0 || snap.slot >= RING_BUFFER_SIZE)) {
      throw new Error('Vault JSON snapshot slot out of range 0..31');
    }
  }

  await ensureReady();
  await storeClear(STORE_CARTRIDGES);
  await storeClear(STORE_SNAPSHOTS);

  let importedCount = 0;

  for (const entry of cartridges) {
    await storePut(STORE_CARTRIDGES, entry.id, { ...entry });
    importedCount++;
  }

  // Insert snapshots oldest-first if seq missing, preserving valid slots 0..31
  const orderedSnaps = [...snapshots].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (let idx = 0; idx < orderedSnaps.length; idx++) {
    const snap = orderedSnaps[idx];
    const slot = Number.isInteger(snap.slot) ? snap.slot : (idx % RING_BUFFER_SIZE);
    const seq = typeof snap.seq === 'number' ? snap.seq : idx + 1;
    await storePut(STORE_SNAPSHOTS, slot, {
      slot,
      seq,
      ts: typeof snap.ts === 'number' ? snap.ts : Date.now(),
      reason: String(snap.reason || 'imported'),
      cartHash: snap.cartHash
    });
    importedCount++;
  }

  let activeCart = null;
  if (parsed.active && parsed.active.cartHash) {
    const matchedCart = cartridges.find(
      (c) => (parsed.active.summary?.id && c.id === parsed.active.summary.id) || c.cartHash === parsed.active.cartHash
    );
    const rawRom = parsed.active.rom || (matchedCart && matchedCart.rom) || null;
    const restoredRom = rawRom ? deserializeRomFromJson(rawRom) : null;

    await commitActiveCart(
      parsed.active.cartHash,
      restoredRom || parsed.active.summary || null
    );

    if (restoredRom) {
      activeCart = restoredRom;
    } else if (typeof state.hooks.decodeCart === 'function') {
      const decoded = state.hooks.decodeCart(parsed.active.cartHash);
      activeCart = decoded && decoded.rom ? decoded.rom : decoded;
    }

    if (!activeCart) {
      activeCart = generateDailyCartridgeROM(getTodayUtcString());
      if (parsed.active.summary) {
        if (parsed.active.summary.id) activeCart.meta.id = String(parsed.active.summary.id);
        if (parsed.active.summary.title) activeCart.meta.title = String(parsed.active.summary.title).slice(0, 24);
        if (parsed.active.summary.author) activeCart.meta.author = String(parsed.active.summary.author).slice(0, 16);
      }
    }
    if (importedCount === 0) importedCount = 1;
  } else {
    const firstWithRom = cartridges.find((c) => c.rom);
    activeCart = (firstWithRom && deserializeRomFromJson(firstWithRom.rom)) || generateDailyCartridgeROM(getTodayUtcString());
  }

  return {
    importedCount,
    activeCart
  };
}

/**
 * Bakes a 100% offline standalone HTML cartridge file.
 * @param {string} cartHash
 * @param {string} [title]
 * @param {(relPath: string, type?: string) => Promise<string>} [customReader]
 * @returns {Promise<Blob>}
 */
export async function bakeStandaloneHtml(cartHash, title, customReader) {
  return bakeStandaloneHtmlImpl(cartHash, title, customReader);
}

const vault = (globalThis.__BITFORGE_VAULT__ = globalThis.__BITFORGE_VAULT__ || {});
Object.assign(vault, {
  initVaultCoordinator,
  getInitialBootPayload,
  commitActiveCart,
  snapshotToRingBuffer,
  getSnapshots,
  resetDailyRitual,
  exportVaultJson,
  importVaultJson,
  bakeStandaloneHtml
});
