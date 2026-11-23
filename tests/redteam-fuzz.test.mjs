import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import '../src/vault/cookie-vault-head.js';
import {
  initVaultCoordinator,
  getSnapshots,
  snapshotToRingBuffer,
  commitActiveCart,
} from '../src/vault/storage-coordinator.js';
import {
  MODULE_MANIFEST,
  bakeStandaloneHtml,
} from '../src/vault/local-sync-baker.js';
import {
  createEmptyCartridgeROM,
  validateCartridgeROM,
  encodeCartridgeToBytes,
  decodeCartridgeFromBytes,
  encodeCartToHash,
  decodeCartFromHash,
} from '../src/cart/bitpack-rom.js';
import { encodeQrMatrix } from '../src/cart/qr-matrix.js';
import {
  PACK_IN_ORDER,
  PACK_IN_GAMES,
  getDefaultPackInROM,
  listPackInMetadata,
} from '../src/cartridges/pack-in-index.js';
import { runE2eBrowserSuite } from './e2e-browser-suite.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PALETTE_IDS = ['classic16', 'sakura', 'matcha', 'amber', 'frost80'];
const PRIMARY_VERBS = ['slingshot', 'springDrag', 'tapRipple', 'ribbonSlice', 'bezelWheel'];
const SCALE_IDS = ['pentatonic', 'dorian', 'lydian', 'hirajoshi', 'lofiMaj9'];
const PRESET_IDS = [null, 'sling-slime', 'zen-rake', 'bezel-orbit', 'alchemist-glass', 'chroma-chisel'];
const KNOWN_TRIGGERS = ['Slingshot Release', 'Tap Entity', 'Slice Hit', 'Bezel Scrub', 'Collide Hazard'];
const KNOWN_ACTIONS = ['Launch Impulse', 'Shatter Pixels', 'Bounce + Trauma', 'Spawn Sparks', 'Score +1', 'Play SFX'];

const ALIGNMENT_PATTERNS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

function createPrng(seed) {
  let a = seed >>> 0;
  return {
    nextU32() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    },
    int(min, max) {
      return min + (this.nextU32() % (max - min + 1));
    },
    pick(arr) {
      return arr[this.nextU32() % arr.length];
    },
    bool() {
      return (this.nextU32() & 1) === 1;
    },
  };
}

const UNICODE_POOL = [
  'A', 'Z', '8', '0', '-', '_', ' ',
  '★', '☆', '◆', '✨', '🎮', '⚡', '💎',
  'ネ', 'オ', 'ン', '緑', '星', '音',
  'é', 'ü', 'ñ', 'Ω', 'λ', 'Ж',
];

function randomUnicodeString(rng, minChars, maxChars) {
  const len = rng.int(minChars, maxChars);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += rng.pick(UNICODE_POOL);
  }
  return out;
}

function fillRleEdgeBytes(arr, rng, mode, maxVal) {
  const len = arr.length;
  if (mode === 0) {
    // All zeros (mode 0)
    arr.fill(0);
  } else if (mode === 1) {
    // Constant non-zero fill (forces max run boundaries: 16 for nibble-RLE, 256 for byte-RLE)
    arr.fill(rng.int(1, maxVal));
  } else if (mode === 2) {
    // Exact boundary runs (15, 16, 17, 255, 256, 257)
    let pos = 0;
    const runChoices = maxVal <= 15 ? [1, 15, 16, 17, 31] : [1, 16, 255, 256, 257];
    while (pos < len) {
      const runLen = Math.min(len - pos, rng.pick(runChoices));
      const val = rng.int(0, maxVal);
      arr.fill(val, pos, pos + runLen);
      pos += runLen;
    }
  } else if (mode === 3) {
    // High-entropy checkerboard / dense non-repeating noise (forces mode 2 raw fallback)
    for (let i = 0; i < len; i++) {
      arr[i] = (i & 1) === 0 ? rng.int(0, maxVal) : ((rng.int(1, maxVal) + i) % (maxVal + 1));
    }
  } else {
    // Mixed dense + short runs
    let pos = 0;
    while (pos < len) {
      const runLen = Math.min(len - pos, rng.int(1, 12));
      const val = rng.int(0, maxVal);
      arr.fill(val, pos, pos + runLen);
      pos += runLen;
    }
  }
}

function buildExtremeFuzzRom(rng, idx) {
  const forceMax = idx === 0;
  const worldDim = forceMax || idx % 10 !== 9 ? 32 : 16;
  const cellCount = worldDim * worldDim;

  const sprites = new Array(32);
  for (let s = 0; s < 32; s++) {
    const size = forceMax ? 16 : (rng.bool() ? 16 : 8);
    const frameCount = forceMax ? 4 : rng.int(1, 4);
    const pxCount = size * size;
    const frames = new Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      const frame = new Uint8Array(pxCount);
      const patternMode = forceMax ? ((s + f) % 4) : rng.int(0, 4);
      fillRleEdgeBytes(frame, rng, patternMode, 15);
      frames[f] = frame;
    }
    sprites[s] = { size, frames };
  }

  const bgLayer = new Uint8Array(cellCount);
  const mainLayer = new Uint8Array(cellCount);
  const fgLayer = new Uint8Array(cellCount);
  const collision = new Uint8Array(cellCount);

  fillRleEdgeBytes(bgLayer, rng, forceMax ? 3 : rng.int(0, 4), 255);
  fillRleEdgeBytes(mainLayer, rng, forceMax ? 2 : rng.int(0, 4), 255);
  fillRleEdgeBytes(fgLayer, rng, forceMax ? 4 : rng.int(0, 4), 255);
  fillRleEdgeBytes(collision, rng, forceMax ? 3 : rng.int(0, 4), 3);

  const channels = new Array(4);
  for (let c = 0; c < 4; c++) {
    const steps = new Uint16Array(16);
    for (let st = 0; st < 16; st++) {
      if (forceMax) {
        steps[st] = rng.int(1, 0xFFFF);
      } else {
        const roll = rng.int(0, 5);
        steps[st] = roll === 0 ? 0 : (roll === 1 ? 0xFFFF : rng.int(0, 0xFFFF));
      }
    }
    channels[c] = {
      steps,
      dutyOrTimbre: rng.int(0, 255),
      volume: rng.int(0, 100),
    };
  }

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    wavetable32[i] = rng.int(0, 15);
  }

  const sfxPatches = new Array(8);
  for (let p = 0; p < 8; p++) {
    sfxPatches[p] = {
      archetype: forceMax ? p : rng.int(0, 7),
      x: rng.int(0, 255),
      y: rng.int(0, 255),
    };
  }

  const chipCount = forceMax ? 10 : rng.int(0, 8);
  const ruleChips = new Array(chipCount);
  for (let r = 0; r < chipCount; r++) {
    const useCustomTrigger = rng.bool();
    const useCustomAction = rng.bool();
    const paramChoices = [-32768, -1, 0, 1, 32767, rng.int(-32768, 32767)];
    ruleChips[r] = {
      id: `ch-${idx}-${r}-${rng.int(0, 999)}`,
      trigger: useCustomTrigger ? `trig_${randomUnicodeString(rng, 2, 10)}` : rng.pick(KNOWN_TRIGGERS),
      paramA: rng.pick(paramChoices),
      action: useCustomAction ? `act_${randomUnicodeString(rng, 2, 10)}` : rng.pick(KNOWN_ACTIONS),
      paramB: rng.pick(paramChoices),
      sfxSlot: rng.int(0, 7),
    };
  }

  const hasCustomJs = forceMax || rng.int(0, 3) !== 0;
  const customJs = hasCustomJs
    ? `// ${randomUnicodeString(rng, 3, 20)}\nonVerb("bezel_scrub", ${rng.int(1, 20)}, (ctx) => {\n  ctx.addScore(${rng.int(1, 99)});\n  ctx.playSfx(${rng.int(0, 7)});\n});`
    : '';

  const hasCustomPalette = forceMax || rng.bool();
  let customPalette = null;
  if (hasCustomPalette) {
    customPalette = new Uint8Array(48);
    for (let i = 0; i < 48; i++) customPalette[i] = rng.int(0, 255);
  }

  const updatedAtChoices = [0, 1763865600000 + idx, Number.MAX_SAFE_INTEGER];

  return createEmptyCartridgeROM({
    meta: {
      id: `fuzz-${idx}-${randomUnicodeString(rng, 1, 6)}`,
      title: randomUnicodeString(rng, 1, 24),
      author: randomUnicodeString(rng, 1, 16),
      paletteId: PALETTE_IDS[idx % PALETTE_IDS.length],
      customPalette,
      coverSpriteIdx: rng.int(0, 31),
      primaryVerb: PRIMARY_VERBS[idx % PRIMARY_VERBS.length],
      dropShadow1px: rng.bool(),
      crtOptics: rng.bool(),
      updatedAt: idx < 3 ? updatedAtChoices[idx] : rng.int(0, 0x7FFFFFFF) * 1000 + rng.int(0, 999),
    },
    sprites,
    world: {
      width: worldDim,
      height: worldDim,
      bgLayer,
      mainLayer,
      fgLayer,
      collision,
    },
    audio: {
      bpm: idx === 0 ? 180 : (idx === 1 ? 70 : rng.int(70, 180)),
      scaleId: SCALE_IDS[idx % SCALE_IDS.length],
      channels,
      wavetable32,
      sfxPatches,
    },
    logic: {
      presetGameId: PRESET_IDS[idx % PRESET_IDS.length],
      ruleChips,
      customJs,
    },
  });
}

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDFFF) return true;
  }
  return false;
}

function createMockWebEnv({ hash = '', bakedCart = undefined } = {}) {
  const lsMap = new Map();
  const cookieJar = new Map();
  const cookieWrites = [];

  const storage = {
    getItem(k) {
      return lsMap.has(k) ? lsMap.get(k) : null;
    },
    setItem(k, v) {
      lsMap.set(k, String(v));
    },
    removeItem(k) {
      lsMap.delete(k);
    },
    clear() {
      lsMap.clear();
    },
  };

  const getCookie = (name) => (cookieJar.has(name) ? cookieJar.get(name) : null);
  const setCookie = (name, value, attrs) => {
    cookieWrites.push({ name, value, attrs });
    if (attrs && attrs.includes('Max-Age=0')) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, value);
    }
  };

  return {
    lsMap,
    cookieJar,
    cookieWrites,
    env: { storage, getCookie, setCookie, hash, bakedCart },
  };
}

function createMockIndexedDbFactory() {
  const stores = new Map();
  let dbVersion = 0;

  return {
    stores,
    open(name, version) {
      assert.equal(name, 'bitforge80_db');
      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };

      queueMicrotask(() => {
        const db = {
          objectStoreNames: {
            contains: (storeName) => stores.has(storeName),
          },
          createObjectStore(storeName, opts) {
            stores.set(storeName, { keyPath: opts.keyPath, rows: new Map() });
            return {};
          },
          transaction(storeName) {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(targetName) {
                const storeMeta = stores.get(targetName || storeName);
                return {
                  put(record) {
                    const key = record[storeMeta.keyPath];
                    storeMeta.rows.set(key, structuredClone(record));
                    queueMicrotask(() => tx.oncomplete && tx.oncomplete());
                    return {};
                  },
                  getAll() {
                    const getReq = { result: null, onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      getReq.result = Array.from(storeMeta.rows.values()).map((r) => structuredClone(r));
                      if (getReq.onsuccess) getReq.onsuccess();
                    });
                    return getReq;
                  },
                  clear() {
                    storeMeta.rows.clear();
                    queueMicrotask(() => tx.oncomplete && tx.oncomplete());
                    return {};
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        };

        req.result = db;
        if (version > dbVersion) {
          dbVersion = version;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });

      return req;
    },
  };
}

function walkFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

test('1. Fuzz 200 deterministic extreme cartridges -> 100% bit-exact BF80 & #cart= round-trip', () => {
  const rng = createPrng(0xBF80F002);
  const uriAllowed = /^[A-Za-z0-9+\-$]+$/;

  for (let i = 0; i < 200; i++) {
    const rom = buildExtremeFuzzRom(rng, i);
    const check = validateCartridgeROM(rom);
    assert.deepEqual(check, { ok: true, errors: [] }, `Fuzz cart #${i} failed validation`);

    const bytes = encodeCartridgeToBytes(rom);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'BF80');
    const directDecoded = decodeCartridgeFromBytes(bytes);
    assert.deepStrictEqual(directDecoded, rom, `Binary round-trip mismatch at fuzz cart #${i}`);

    const hash = encodeCartToHash(rom);
    assert.ok(hash.startsWith('#cart='));
    const payload = hash.slice(6);
    assert.equal(hasLoneSurrogate(payload), false, `Lone surrogate in #cart= at fuzz cart #${i}`);
    assert.match(payload, uriAllowed, `Non-URI-safe char in #cart= at fuzz cart #${i}`);

    const res = decodeCartFromHash(hash);
    assert.equal(res.ok, true, `decodeCartFromHash failed at fuzz cart #${i}: ${res.error}`);
    assert.equal(res.byteLength, bytes.byteLength);
    assert.deepStrictEqual(res.rom, rom, `Hash round-trip mismatch at fuzz cart #${i}`);

    // Periodically bit-flip payload to prove CRC16-CCITT tamper rejection
    if (i % 20 === 0) {
      const tampered = new Uint8Array(bytes);
      tampered[Math.floor(tampered.length / 2)] ^= 0x5A;
      assert.throws(() => decodeCartridgeFromBytes(tampered), /CRC16|Invalid|Unexpected|Truncated/);
    }
  }
});

test('2. All 5 pack-in cartridges encode under 2,560 bytes and round-trip bit-identically', () => {
  const expectedIds = ['sling-slime', 'zen-rake', 'bezel-orbit', 'alchemist-glass', 'chroma-chisel'];
  assert.deepEqual([...PACK_IN_ORDER], expectedIds);

  const metaList = listPackInMetadata();
  assert.equal(metaList.length, 5);

  for (const id of expectedIds) {
    const mod = PACK_IN_GAMES[id];
    assert.ok(mod, `Missing pack-in module ${id}`);
    const rom = mod.createROM();
    const viaHelper = getDefaultPackInROM(id);
    assert.deepStrictEqual(viaHelper, rom);
    assert.deepEqual(validateCartridgeROM(rom), { ok: true, errors: [] });

    const hash = encodeCartToHash(rom);
    const byteLen = Buffer.byteLength(hash, 'utf8');
    assert.ok(hash.startsWith('#cart='), `${id} hash must start with #cart=`);
    assert.ok(hash.length < 2560, `${id} #cart= length (${hash.length}) must be < 2560`);
    assert.ok(byteLen < 2560, `${id} #cart= UTF-8 byte length (${byteLen}) must be < 2560`);

    const decoded = decodeCartFromHash(hash);
    assert.equal(decoded.ok, true, `${id} decodeCartFromHash failed: ${decoded.error}`);
    assert.deepStrictEqual(decoded.rom, rom, `${id} round-trip mismatch`);
  }
});

test('3. Red-team krunked-cookie-vault-v1 bidirectional auto-healing & IndexedDB ring buffer', async () => {
  // Also verify window.__BITFORGE_VAULT__ works identically when window is defined in a browser context
  const headSrc = await fsp.readFile(path.join(ROOT_DIR, 'src/vault/cookie-vault-head.js'), 'utf8');
  const winCtx = { location: { hash: '' } };
  winCtx.window = winCtx;
  winCtx.globalThis = winCtx;
  vm.runInNewContext(headSrc, winCtx);
  assert.equal(typeof winCtx.__BITFORGE_VAULT__._rehydrateSync, 'function');

  const vault = (typeof globalThis.window !== 'undefined' ? globalThis.window : globalThis).__BITFORGE_VAULT__;

  // Build real multi-chunk cartridge (between 4,000 and 12,000 encoded chars -> 2..4 shadow cookies)
  const heavyRom = getDefaultPackInROM('sling-slime');
  for (let s = 0; s < 16; s++) {
    heavyRom.sprites[s] = {
      size: 16,
      frames: [
        new Uint8Array(256).map((_, i) => (i * 7 + s * 3) & 15),
        new Uint8Array(256).map((_, i) => (i * 11 + s) & 15),
      ],
    };
  }
  heavyRom.world = {
    width: 32,
    height: 32,
    bgLayer: new Uint8Array(1024).map((_, i) => (i * 13) & 255),
    mainLayer: new Uint8Array(1024).map((_, i) => (i * 17) & 255),
    fgLayer: new Uint8Array(1024).map((_, i) => (i * 23) & 255),
    collision: new Uint8Array(1024).map((_, i) => i & 3),
  };
  const bigCartHash = encodeCartToHash(heavyRom);
  const encodedBigLen = encodeURIComponent(bigCartHash).length;
  assert.ok(
    encodedBigLen > 4000 && encodedBigLen <= 14000,
    `Expected multi-chunk shadow-cookie payload in (4000..14000], got ${encodedBigLen}`
  );

  const incomingHash = encodeCartToHash(getDefaultPackInROM('alchemist-glass'));

  // (a) Wiped localStorage -> heals intact from chunked shadow cookies
  const mockA = createMockWebEnv();
  const mockIdb = createMockIndexedDbFactory();
  await initVaultCoordinator({ ...mockA.env, indexedDB: mockIdb, resetStore: true });
  await commitActiveCart(bigCartHash, heavyRom);

  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_meta'));
  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_0'));
  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_1'));
  for (const [k, v] of mockA.cookieJar.entries()) {
    assert.ok(v.length <= 3500, `Cookie ${k} exceeded 3500 chars (${v.length})`);
  }

  mockA.lsMap.clear();
  const healedWinA = winCtx.__BITFORGE_VAULT__._rehydrateSync(mockA.env);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(healedWinA)), {
    source: 'shadow-cookie',
    cartHash: bigCartHash,
    healedFromCookie: true,
    regeneratedCookie: false,
  });
  mockA.lsMap.clear();
  const healedA = vault._rehydrateSync(mockA.env);
  assert.deepStrictEqual(healedA, {
    source: 'shadow-cookie',
    cartHash: bigCartHash,
    healedFromCookie: true,
    regeneratedCookie: false,
  });
  const restoredLocal = JSON.parse(mockA.env.storage.getItem('bitforge80.active'));
  assert.equal(restoredLocal.cartHash, bigCartHash);
  assert.equal(restoredLocal.crc >>> 0, vault._crc32(bigCartHash));
  const healedDecoded = decodeCartFromHash(healedA.cartHash);
  assert.equal(healedDecoded.ok, true);
  assert.deepStrictEqual(healedDecoded.rom, heavyRom);

  // (b) Wiped cookies -> regenerates krunked-cookie-vault-v1_* cookies from localStorage
  mockA.cookieJar.clear();
  mockA.cookieWrites.length = 0;
  const regenB = vault._rehydrateSync(mockA.env);
  assert.deepEqual(regenB, {
    source: 'local-storage',
    cartHash: bigCartHash,
    healedFromCookie: false,
    regeneratedCookie: true,
  });
  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_meta'));
  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_0'));
  assert.ok(mockA.cookieJar.has('krunked-cookie-vault-v1_1'));
  for (const write of mockA.cookieWrites) {
    assert.ok(write.attrs.includes('SameSite=Lax'));
    assert.ok(write.attrs.includes('Path=/'));
    assert.ok(write.attrs.includes('Max-Age=31536000'));
  }
  const cleanFollowUp = vault._rehydrateSync(mockA.env);
  assert.equal(cleanFollowUp.regeneratedCookie, false);

  // (c) Corrupt cookie CRC -> cleans safely without crash
  // Subcase c1: corrupt cookie CRC while localStorage is wiped -> clears cookies & returns pack-in safely
  const metaCorrupt = JSON.parse(decodeURIComponent(mockA.cookieJar.get('krunked-cookie-vault-v1_meta')));
  metaCorrupt.crc = (metaCorrupt.crc ^ 0xDEADBEEF) >>> 0;
  mockA.cookieJar.set('krunked-cookie-vault-v1_meta', encodeURIComponent(JSON.stringify(metaCorrupt)));
  mockA.lsMap.clear();

  const corruptRes = vault._rehydrateSync(mockA.env);
  assert.deepEqual(corruptRes, {
    source: 'pack-in',
    cartHash: null,
    healedFromCookie: false,
    regeneratedCookie: false,
  });
  assert.equal(mockA.cookieJar.has('krunked-cookie-vault-v1_meta'), false);
  assert.equal(mockA.cookieJar.has('krunked-cookie-vault-v1_0'), false);
  assert.equal(mockA.cookieJar.has('krunked-cookie-vault-v1_1'), false);

  // Subcase c2: corrupt cookie CRC while localStorage is valid -> overwrites corrupt cookies cleanly
  await commitActiveCart(bigCartHash, heavyRom);
  mockA.cookieJar.set('krunked-cookie-vault-v1_0', 'CORRUPTED_CHUNK_DATA');
  const healedFromLocal = vault._rehydrateSync(mockA.env);
  assert.equal(healedFromLocal.source, 'local-storage');
  assert.equal(healedFromLocal.regeneratedCookie, true);

  // (d) Incoming #cart= -> schedules pending snapshot of unsaved local draft into IndexedDB ring buffer
  const mockD = createMockWebEnv();
  const idbD = createMockIndexedDbFactory();
  await initVaultCoordinator({ ...mockD.env, indexedDB: idbD, resetStore: true });
  const unsavedDraftHash = encodeCartToHash(getDefaultPackInROM('zen-rake'));
  await commitActiveCart(unsavedDraftHash, getDefaultPackInROM('zen-rake'));

  mockD.env.hash = incomingHash;
  const incomingBoot = vault._rehydrateSync(mockD.env);
  assert.deepEqual(incomingBoot, {
    source: 'url-hash',
    cartHash: incomingHash,
    healedFromCookie: false,
    regeneratedCookie: false,
  });
  assert.ok(globalThis.__BITFORGE_PENDING_SNAPSHOT__);
  assert.equal(globalThis.__BITFORGE_PENDING_SNAPSHOT__.cartHash, unsavedDraftHash);

  await initVaultCoordinator({ ...mockD.env, indexedDB: idbD });
  assert.equal(globalThis.__BITFORGE_PENDING_SNAPSHOT__, null);
  const snaps = await getSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].cartHash, unsavedDraftHash);
  assert.equal(snaps[0].reason, 'incoming-url-cart');

  // Stress 32-slot circular buffer wrap-around in IndexedDB
  for (let s = 1; s <= 35; s++) {
    await snapshotToRingBuffer(`#cart=RING_${s}`, `snap-${s}`);
  }
  const wrappedSnaps = await getSnapshots();
  assert.equal(wrappedSnaps.length, 32);
  assert.equal(wrappedSnaps[0].cartHash, '#cart=RING_35');

  // Reset coordinator store cleanly
  await initVaultCoordinator({ resetStore: true, indexedDB: null });
});

test('4. Red-team ISO QR matrix across all 5 pack-in #cart= URLs', () => {
  for (const id of PACK_IN_ORDER) {
    const rom = getDefaultPackInROM(id);
    const cartUrl = `https://krunked-fpv.github.io/bitforge-80/${encodeCartToHash(rom)}`;
    const qr = encodeQrMatrix(cartUrl, 'M');

    assert.ok(qr.version >= 1 && qr.version <= 40, `${id} invalid QR version`);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.ok(qr.quietZone >= 4, `${id} quietZone (${qr.quietZone}) must be >= 4`);
    assert.equal(qr.totalSize, qr.size + qr.quietZone * 2);
    assert.equal(qr.modules.length, qr.size * qr.size);

    // 3 Finder patterns (7x7)
    for (const [fx, fy] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(qr.isSet(fx + dx, fy + dy), dist !== 2, `${id} finder mismatch at (${fx + dx},${fy + dy})`);
        }
      }
    }

    // 1-module white separators around all 3 finders
    for (let i = 0; i < 8; i++) {
      assert.equal(qr.isSet(7, i), false, `${id} TL separator col`);
      assert.equal(qr.isSet(i, 7), false, `${id} TL separator row`);
      assert.equal(qr.isSet(qr.size - 8, i), false, `${id} TR separator col`);
      assert.equal(qr.isSet(qr.size - 1 - i, 7), false, `${id} TR separator row`);
      assert.equal(qr.isSet(i, qr.size - 8), false, `${id} BL separator row`);
      assert.equal(qr.isSet(7, qr.size - 1 - i), false, `${id} BL separator col`);
    }

    // Timing strips (row 6, col 6)
    for (let i = 8; i <= qr.size - 9; i++) {
      const dark = i % 2 === 0;
      assert.equal(qr.isSet(i, 6), dark, `${id} timing row 6 at x=${i}`);
      assert.equal(qr.isSet(6, i), dark, `${id} timing col 6 at y=${i}`);
    }

    // Alignment patterns (version >= 2)
    if (qr.version >= 2) {
      const coords = ALIGNMENT_PATTERNS[qr.version];
      const last = coords.length - 1;
      for (let iy = 0; iy < coords.length; iy++) {
        for (let ix = 0; ix < coords.length; ix++) {
          if ((ix === 0 && iy === 0) || (ix === last && iy === 0) || (ix === 0 && iy === last)) continue;
          const cx = coords[ix];
          const cy = coords[iy];
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const dist = Math.max(Math.abs(dx), Math.abs(dy));
              assert.equal(qr.isSet(cx + dx, cy + dy), dist !== 1, `${id} alignment mismatch at (${cx + dx},${cy + dy})`);
            }
          }
        }
      }
    }

    // Dark module at row = 4*version + 9, col = 8 -> (x=8, y=4*version+9)
    assert.equal(qr.isSet(8, 4 * qr.version + 9), true, `${id} dark module missing at (row=${4 * qr.version + 9}, col=8)`);

    // >= 4-module quiet zone around entire matrix
    for (let y = 0; y < qr.totalSize; y++) {
      for (let x = 0; x < qr.totalSize; x++) {
        const inBorder =
          x < qr.quietZone ||
          y < qr.quietZone ||
          x >= qr.quietZone + qr.size ||
          y >= qr.quietZone + qr.size;
        if (inBorder) {
          assert.equal(qr.isQuietSet(x, y), false, `${id} quiet zone dark at (${x},${y})`);
        } else {
          assert.equal(qr.isQuietSet(x, y), qr.isSet(x - qr.quietZone, y - qr.quietZone));
        }
      }
    }
  }
});

test('5. Red-team Standalone .html Baker against REAL repo files', async () => {
  const rom = getDefaultPackInROM('chroma-chisel');
  const cartHash = encodeCartToHash(rom);

  // Use real filesystem default reader (no mocks) across all MODULE_MANIFEST entries
  const blob = await bakeStandaloneHtml(cartHash, 'Chroma <Chisel> & 80');
  assert.equal(blob.type, 'text/html;charset=utf-8');

  const html = await blob.text();
  assert.ok(html.length > 100000, 'Standalone baked HTML must contain full inline styles & bundled engine');

  // Zero external or relative <script src=...> tags
  assert.equal(/<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(html), false, 'External <script src="http..."> forbidden');
  assert.equal(/<script\b[^>]*\bsrc\s*=\s*["']?\s*\.?\//i.test(html), false, 'Relative <script src="./..."> forbidden');
  assert.equal(/<script\b[^>]*\bsrc\s*=/i.test(html), false, 'Any <script src=...> attribute forbidden');

  // Presence of baked globals
  assert.ok(html.includes('window.__BITFORGE_STANDALONE__ = true;'), 'Missing window.__BITFORGE_STANDALONE__ = true');
  assert.ok(
    html.includes(`window.__BITFORGE_BAKED_CART__ = ${JSON.stringify(cartHash)};`),
    'Missing window.__BITFORGE_BAKED_CART__ literal'
  );

  // Validate syntax of every inline <script> via new Function AND assert zero unresolved import ... from
  const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scriptMatches.length, 3, 'Expected 3 inline <script> blocks (bootstrap, head vault, bundled app)');

  for (let idx = 0; idx < scriptMatches.length; idx++) {
    const code = scriptMatches[idx][1];
    assert.doesNotThrow(() => new Function(code), `Inline <script> #${idx} failed syntax check`);
    assert.equal(
      /^\s*import\s+[\s\S]*?\bfrom\s+['"]/m.test(code),
      false,
      `Unresolved ES import statement found in inline <script> #${idx}`
    );
    assert.equal(
      /\bimport\s+[\s\S]{0,120}?\bfrom\s+['"]/g.test(code),
      false,
      `Unresolved import ... from token found in inline <script> #${idx}`
    );
  }

  // Verify every module in MODULE_MANIFEST was defined in the inline bundle
  const bundleCode = scriptMatches[2][1];
  for (const entry of MODULE_MANIFEST) {
    if (entry.type === 'module') {
      assert.ok(
        bundleCode.includes(`__BF_DEFINE__(${JSON.stringify(entry.path)},`),
        `Standalone bundle missing manifest module ${entry.path}`
      );
    }
  }

  // Execute all 3 inline scripts sequentially in a fresh VM sandbox
  const sandbox = {
    location: { hash: '', href: 'file:///bitforge-standalone.html' },
    document: { readyState: 'complete', getElementById: () => null, cookie: '' },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    Uint8ClampedArray,
    DataView,
    ArrayBuffer,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Object,
    Array,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    RegExp,
    Function,
    Promise,
    URL,
    Blob,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  for (const m of scriptMatches) {
    vm.runInNewContext(m[1], sandbox);
  }
  assert.equal(sandbox.__BITFORGE_STANDALONE__, true);
  assert.equal(sandbox.__BITFORGE_BAKED_CART__, cartHash);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.__BITFORGE_VAULT__.getInitialBootPayload())), {
    source: 'url-hash',
    cartHash,
    healedFromCookie: false,
    regeneratedCookie: false,
  });
});

test('6. Input law & LLM-reference hygiene scan across source, tests, agents, workflows, and docs', async () => {
  const inputTargets = [...walkFiles(path.join(ROOT_DIR, 'src')), path.join(ROOT_DIR, 'index.html')];
  assert.ok(inputTargets.length >= 30);

  const forbiddenUiTerms = [
    'd' + '-pad',
    'd' + 'pad',
    'directional' + ' pad',
    'joy' + 'stick',
    'thumb' + 'stick',
    'thumb' + '-stick',
    'simulated' + ' stick',
    'virtual' + ' pad',
    'virtual' + '-pad',
    'virtual' + 'pad',
    'virtual' + ' stick',
    'game' + 'pad',
    'a/b' + ' button',
    'a/b' + ' overlay',
    'button' + '-a',
    'button' + '-b',
  ];

  for (const filePath of inputTargets) {
    const lower = (await fsp.readFile(filePath, 'utf8')).toLowerCase();
    for (const term of forbiddenUiTerms) {
      assert.equal(lower.includes(term), false, `Forbidden input overlay term "${term}" found in ${filePath}`);
    }
  }

  const vendorScanTargets = [
    ...walkFiles(path.join(ROOT_DIR, 'src')),
    ...walkFiles(path.join(ROOT_DIR, 'tests')),
    ...walkFiles(path.join(ROOT_DIR, '.agents')),
    ...walkFiles(path.join(ROOT_DIR, '.github')),
    path.join(ROOT_DIR, 'ARCHITECTURE.md'),
    path.join(ROOT_DIR, 'SPEC.md'),
  ].filter((f) => fs.existsSync(f));

  const forbiddenVendorTerms = [
    'open' + 'ai',
    'anthro' + 'pic',
    'clau' + 'de',
    'chat' + 'gpt',
    'gp' + 't-3',
    'gp' + 't-4',
    'gp' + 't-5',
    'gp' + 't3',
    'gp' + 't4',
    'gem' + 'ini',
    'll' + 'ama',
    'mis' + 'tral',
    'deep' + 'seek',
    'qw' + 'en',
    'son' + 'net',
    'op' + 'us',
    'hai' + 'ku',
    'co' + 'pilot',
    'gro' + 'k',
    'per' + 'plexity',
    'co' + 'here',
  ];

  for (const filePath of vendorScanTargets) {
    const lower = (await fsp.readFile(filePath, 'utf8')).toLowerCase();
    for (const term of forbiddenVendorTerms) {
      assert.equal(lower.includes(term), false, `Forbidden vendor/model term "${term}" found in ${filePath}`);
    }
  }
});

test('7. E2E subpath browser suite imports cleanly and passes all /bitforge-80/ checks', async () => {
  const summary = await runE2eBrowserSuite({ quiet: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.basePath, '/bitforge-80/');
  assert.deepEqual(summary.brokenLinks, []);
  assert.ok(summary.manifestJsModules >= 30);
  assert.ok(summary.checkedEndpoints >= 38);
});
