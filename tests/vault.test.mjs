import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import '../src/vault/cookie-vault-head.js';
import {
  mulberry32,
  hashDateSeed,
  getTodayUtcString,
  generateDailySeedSpec,
  generateDailyCartridgeROM
} from '../src/vault/daily-seed.js';
import {
  MODULE_MANIFEST,
  bundleModulesInline,
  buildStandaloneHtmlString,
  bakeStandaloneHtml
} from '../src/vault/local-sync-baker.js';
import {
  initVaultCoordinator,
  getInitialBootPayload,
  commitActiveCart,
  snapshotToRingBuffer,
  getSnapshots,
  resetDailyRitual,
  exportVaultJson,
  importVaultJson,
  bakeStandaloneHtml as coordinatorBakeStandaloneHtml
} from '../src/vault/storage-coordinator.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    }
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
    env: {
      storage,
      getCookie,
      setCookie,
      hash,
      bakedCart
    }
  };
}

function createMockIndexedDbFactory() {
  const stores = new Map();
  let dbVersion = 0;

  const factory = {
    stores,
    open(name, version) {
      assert.equal(name, 'bitforge80_db');
      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };

      queueMicrotask(() => {
        const db = {
          objectStoreNames: {
            contains: (storeName) => stores.has(storeName)
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
                  }
                };
              }
            };
            return tx;
          },
          close() {}
        };

        req.result = db;
        if (version > dbVersion) {
          dbVersion = version;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });

      return req;
    }
  };

  return factory;
}

test('Static module hygiene: zero import/export in head IIFE, zero export * or static node: imports', async () => {
  const headSrc = await fs.readFile(path.join(ROOT_DIR, 'src/vault/cookie-vault-head.js'), 'utf8');
  assert.equal(/\b(import|export)\b/.test(headSrc), false, 'cookie-vault-head.js must have zero import/export tokens');
  assert.doesNotThrow(() => new Function(headSrc));

  for (const rel of [
    'src/vault/daily-seed.js',
    'src/vault/local-sync-baker.js',
    'src/vault/storage-coordinator.js'
  ]) {
    const src = await fs.readFile(path.join(ROOT_DIR, rel), 'utf8');
    assert.equal(/\bexport\s*\*/.test(src), false, `${rel} must not use export *`);
    assert.equal(/\bimport\s+[^('"]*['"]node:/.test(src), false, `${rel} must not use static node: imports`);
  }

  // IEEE CRC32 standard test vector
  assert.equal(globalThis.__BITFORGE_VAULT__._crc32('123456789'), 0xCBF43926);

  // Hostile locked WebView simulation (throwing localStorage and document.cookie getters)
  const headCode = headSrc;
  const hostileCtx = {
    globalThis: null,
    location: { hash: '' }
  };
  hostileCtx.globalThis = hostileCtx;
  Object.defineProperty(hostileCtx, 'localStorage', {
    get() {
      throw new Error('SecurityError: localStorage denied');
    }
  });
  Object.defineProperty(hostileCtx, 'document', {
    get() {
      return {
        get cookie() {
          throw new Error('SecurityError: cookie access denied');
        },
        set cookie(_v) {
          throw new Error('SecurityError: cookie write denied');
        }
      };
    }
  });

  vm.runInNewContext(headCode, hostileCtx);
  const boot = hostileCtx.__BITFORGE_VAULT__.getInitialBootPayload();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(boot)), {
    source: 'pack-in',
    cartHash: null,
    healedFromCookie: false,
    regeneratedCookie: false
  });
});

test('(1) localStorage wipe -> shadow cookie healing (single & multi-chunk cookies)', () => {
  const vault = globalThis.__BITFORGE_VAULT__;
  const mock = createMockWebEnv();
  const largeCart = `#cart=${'AbCdEf0123456789+-'.repeat(280)}`; // > 5000 chars -> 2 chunks

  const persisted = vault._persistSync(largeCart, { id: 'c-big', title: 'BigCart' }, mock.env);
  assert.equal(persisted.ok, true);
  assert.ok(mock.cookieJar.has('krunked-cookie-vault-v1_meta'));
  assert.ok(mock.cookieJar.has('krunked-cookie-vault-v1_0'));
  assert.ok(mock.cookieJar.has('krunked-cookie-vault-v1_1'));

  for (const [key, val] of mock.cookieJar.entries()) {
    assert.ok(val.length <= 3500, `Cookie ${key} exceeded 3500 chars (${val.length})`);
  }
  for (const write of mock.cookieWrites) {
    assert.ok(write.attrs.includes('Max-Age=31536000'));
    assert.ok(write.attrs.includes('Path=/'));
    assert.ok(write.attrs.includes('SameSite=Lax'));
  }

  // Wipe localStorage completely
  mock.lsMap.clear();
  assert.equal(mock.env.storage.getItem('bitforge80.active'), null);

  const boot = vault._rehydrateSync(mock.env);
  assert.deepEqual(boot, {
    source: 'shadow-cookie',
    cartHash: largeCart,
    healedFromCookie: true,
    regeneratedCookie: false
  });

  // Verify localStorage['bitforge80.active'] was restored with valid CRC32
  const restoredRaw = mock.env.storage.getItem('bitforge80.active');
  assert.ok(restoredRaw);
  const restored = JSON.parse(restoredRaw);
  assert.equal(restored.v, 1);
  assert.equal(restored.cartHash, largeCart);
  assert.equal(restored.crc >>> 0, vault._crc32(largeCart));
});

test('(2) cookie wipe -> shadow cookie regeneration from localStorage', () => {
  const vault = globalThis.__BITFORGE_VAULT__;
  const mock = createMockWebEnv();
  const cartHash = '#cart=TEST_CART_REGEN_987654321';

  vault._persistSync(cartHash, { id: 'c1', title: 'RegenTest' }, mock.env);
  mock.cookieJar.clear();
  mock.cookieWrites.length = 0;

  const boot = vault._rehydrateSync(mock.env);
  assert.deepEqual(boot, {
    source: 'local-storage',
    cartHash,
    healedFromCookie: false,
    regeneratedCookie: true
  });

  assert.ok(mock.cookieJar.has('krunked-cookie-vault-v1_meta'));
  assert.ok(mock.cookieJar.has('krunked-cookie-vault-v1_0'));
  const meta = JSON.parse(decodeURIComponent(mock.cookieJar.get('krunked-cookie-vault-v1_meta')));
  assert.equal(meta.v, 1);
  assert.equal(meta.crc >>> 0, vault._crc32(cartHash));
  assert.equal(meta.chunks, 1);

  // Subsequent boot when both match needs neither healing nor regeneration
  const cleanBoot = vault._rehydrateSync(mock.env);
  assert.deepEqual(cleanBoot, {
    source: 'local-storage',
    cartHash,
    healedFromCookie: false,
    regeneratedCookie: false
  });
});

test('(3) corrupt cookie CRC & malformed payloads fall back safely without crash', () => {
  const vault = globalThis.__BITFORGE_VAULT__;
  const mock = createMockWebEnv();
  const cartHash = '#cart=VALID_BEFORE_TAMPER_123';

  vault._persistSync(cartHash, { id: 'c2' }, mock.env);
  // Corrupt both localStorage and cookie chunk
  mock.env.storage.setItem('bitforge80.active', '{not-valid-json');
  const originalChunk = mock.cookieJar.get('krunked-cookie-vault-v1_0');
  mock.cookieJar.set('krunked-cookie-vault-v1_0', originalChunk.slice(0, -3) + 'ZZZ');

  const boot = vault._rehydrateSync(mock.env);
  assert.deepEqual(boot, {
    source: 'pack-in',
    cartHash: null,
    healedFromCookie: false,
    regeneratedCookie: false
  });

  // Corrupt cookies should be safely cleared
  assert.equal(mock.cookieJar.has('krunked-cookie-vault-v1_meta'), false);
  assert.equal(mock.cookieJar.has('krunked-cookie-vault-v1_0'), false);

  // Malformed percent-encoding in meta must also never throw
  mock.cookieJar.set('krunked-cookie-vault-v1_meta', '%E0%A4%A');
  const boot2 = vault._rehydrateSync(mock.env);
  assert.equal(boot2.source, 'pack-in');
  assert.equal(boot2.cartHash, null);
  assert.equal(mock.cookieJar.has('krunked-cookie-vault-v1_meta'), false);
});

test('(4) incoming #cart= pending snapshot, bakedCart handling, and ring-buffer flush', async () => {
  const vault = globalThis.__BITFORGE_VAULT__;
  const mock = createMockWebEnv();
  const oldCart = '#cart=OLD_USER_DRAFT_AAAA1111';
  const incomingCart = '#cart=SHARED_LINK_CART_BBBB2222';

  vault._persistSync(oldCart, { id: 'draft', title: 'Draft' }, mock.env);
  mock.env.hash = incomingCart;

  const boot = vault._rehydrateSync(mock.env);
  assert.deepEqual(boot, {
    source: 'url-hash',
    cartHash: incomingCart,
    healedFromCookie: false,
    regeneratedCookie: false
  });

  assert.ok(globalThis.__BITFORGE_PENDING_SNAPSHOT__);
  assert.equal(globalThis.__BITFORGE_PENDING_SNAPSHOT__.cartHash, oldCart);

  const mockIdb = createMockIndexedDbFactory();
  await initVaultCoordinator({
    ...mock.env,
    indexedDB: mockIdb,
    resetStore: true
  });

  assert.equal(globalThis.__BITFORGE_PENDING_SNAPSHOT__, null);
  const snaps = await getSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].cartHash, oldCart);
  assert.equal(snaps[0].slot, 0);

  // Verify same incoming hash does NOT trigger pending snapshot, and unrelated cookies do not break parsing
  mock.env.hash = incomingCart;
  vault._persistSync(incomingCart, { id: 'same' }, mock.env);
  vault._rehydrateSync(mock.env);
  assert.equal(globalThis.__BITFORGE_PENDING_SNAPSHOT__, null);

  // Raw document.cookie header string parsing via 0-arg getCookie
  const headerStr = `other_cookie=hello=world; krunked-cookie-vault-v1_meta=${mock.cookieJar.get('krunked-cookie-vault-v1_meta')}; krunked-cookie-vault-v1_0=${mock.cookieJar.get('krunked-cookie-vault-v1_0')}; theme=dark`;
  const emptyStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const headerBoot = vault._rehydrateSync({
    storage: emptyStorage,
    getCookie: () => headerStr,
    setCookie: () => {},
    hash: '',
    bakedCart: undefined
  });
  assert.equal(headerBoot.source, 'shadow-cookie');
  assert.equal(headerBoot.cartHash, incomingCart);
  assert.equal(headerBoot.healedFromCookie, true);

  // Verify bakedCart behavior when hash lacks #cart= vs when hash overrides it
  const bakedBoot = vault._rehydrateSync({
    ...mock.env,
    hash: '',
    bakedCart: '#cart=BAKED_STANDALONE_CART_777'
  });
  assert.deepEqual(bakedBoot, {
    source: 'url-hash',
    cartHash: '#cart=BAKED_STANDALONE_CART_777',
    healedFromCookie: false,
    regeneratedCookie: false
  });

  const overrideBoot = vault._rehydrateSync({
    ...mock.env,
    hash: incomingCart,
    bakedCart: '#cart=BAKED_STANDALONE_CART_777'
  });
  assert.deepEqual(overrideBoot, {
    source: 'url-hash',
    cartHash: incomingCart,
    healedFromCookie: false,
    regeneratedCookie: false
  });
  globalThis.__BITFORGE_PENDING_SNAPSHOT__ = null;
});

test('(5) deterministic UTC daily seed + resetDailyRitual + 32-slot snapshot ring-buffer rotation', async () => {
  // Date formatting & Mulberry32 determinism
  assert.equal(getTodayUtcString(new Date('2026-11-23T23:59:59.000Z')), '2026-11-23');
  const rngA = mulberry32(hashDateSeed('2026-11-23'));
  const rngB = mulberry32(hashDateSeed('2026-11-23'));
  for (let i = 0; i < 16; i++) {
    assert.equal(rngA(), rngB());
  }
  assert.notEqual(hashDateSeed('2026-11-23'), hashDateSeed('2026-11-24'));

  // Daily seed spec invariants
  const spec1 = generateDailySeedSpec('2026-11-23');
  const spec2 = generateDailySeedSpec('2026-11-23');
  assert.deepEqual(spec1, spec2);
  assert.ok(spec1.paletteRgb instanceof Uint8Array);
  assert.equal(spec1.paletteRgb.length, 48);
  assert.equal(spec1.sprites8x8.length, 3);
  for (const sprite of spec1.sprites8x8) {
    assert.ok(sprite instanceof Uint8Array);
    assert.equal(sprite.length, 64);
    let nonZero = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const px = sprite[y * 8 + x];
        assert.ok(px >= 0 && px <= 15);
        assert.equal(px, sprite[y * 8 + (7 - x)], `Sprite pixel (${x},${y}) must be horizontally symmetric`);
        if (px > 0) nonZero++;
      }
    }
    assert.ok(nonZero >= 12, 'Mystery sprite must have substantial silhouette');
  }

  // CartridgeROM schema validation
  const romA = generateDailyCartridgeROM('2026-11-23');
  const romB = generateDailyCartridgeROM('2026-11-23');
  assert.deepEqual(romA, romB);
  assert.equal(romA.magic, 'BF80');
  assert.equal(romA.version, 1);
  assert.equal(romA.meta.id, 'daily-2026-11-23');
  assert.ok(romA.meta.title.length <= 24);
  assert.ok(romA.meta.author.length <= 16);
  assert.equal(romA.meta.customPalette.length, 48);
  assert.equal(romA.sprites.length, 32);
  assert.equal(romA.world.width, 16);
  assert.equal(romA.world.height, 16);
  assert.equal(romA.world.bgLayer.length, 256);
  assert.equal(romA.world.mainLayer.length, 256);
  assert.equal(romA.world.fgLayer.length, 256);
  assert.equal(romA.world.collision.length, 256);
  assert.ok(romA.audio.bpm >= 70 && romA.audio.bpm <= 180);
  assert.equal(romA.audio.channels.length, 4);
  assert.equal(romA.audio.wavetable32.length, 32);
  assert.equal(romA.audio.sfxPatches.length, 8);
  assert.equal(romA.logic.presetGameId, null);
  assert.ok(Array.isArray(romA.logic.ruleChips));

  // resetDailyRitual + 32-slot circular snapshot rotation
  const mock = createMockWebEnv();
  await initVaultCoordinator({ ...mock.env, indexedDB: null, resetStore: true });
  await commitActiveCart('#cart=BEFORE_DAILY_RESET_001', { id: 'prev-1', title: 'Prev' });

  let shutterFired = false;
  const dailyRom = await resetDailyRitual({
    utcDate: '2026-11-23',
    onShutter: () => {
      shutterFired = true;
    },
    encodeCart: (r) => `#cart=DAILY_${r.meta.id}`
  });
  assert.equal(shutterFired, true);
  assert.equal(dailyRom.meta.id, 'daily-2026-11-23');

  // Push 34 more snapshots -> total 35 snapshots -> wraps 32->0, 33->1, 34->2
  const assignedSlots = [];
  for (let i = 1; i <= 34; i++) {
    const slot = await snapshotToRingBuffer(`#cart=SNAP_${i}`, `edit-${i}`);
    assignedSlots.push(slot);
  }
  assert.equal(assignedSlots[30], 31); // 32nd total snapshot -> slot 31
  assert.equal(assignedSlots[31], 0);  // 33rd total snapshot -> wraps to slot 0
  assert.equal(assignedSlots[32], 1);  // 34th total snapshot -> slot 1
  assert.equal(assignedSlots[33], 2);  // 35th total snapshot -> slot 2

  const snaps = await getSnapshots();
  assert.equal(snaps.length, 32);
  assert.equal(snaps[0].cartHash, '#cart=SNAP_34');
  assert.equal(snaps[0].slot, 2);
  assert.equal(new Set(snaps.map((s) => s.slot)).size, 32);
});

test('(6) .bitforge.json export/import validation and tamper rejection', async () => {
  const mock = createMockWebEnv();
  const mockIdb = createMockIndexedDbFactory();
  await initVaultCoordinator({ ...mock.env, indexedDB: mockIdb, resetStore: true });

  const dailyRom = generateDailyCartridgeROM('2026-11-23');
  const activeHash = '#cart=EXPORT_ACTIVE_ROM_12345';
  await commitActiveCart(activeHash, dailyRom);
  await snapshotToRingBuffer('#cart=HIST_SNAP_1', 'checkpoint-1');
  await snapshotToRingBuffer('#cart=HIST_SNAP_2', 'checkpoint-2');

  const blob = await exportVaultJson();
  assert.equal(blob.type, 'application/json');
  const exportedText = await blob.text();
  const exportedObj = JSON.parse(exportedText);
  assert.equal(exportedObj.schema, 'bitforge80.vault.v1');
  assert.equal(exportedObj.version, 1);
  assert.equal(exportedObj.active.cartHash, activeHash);
  assert.equal(exportedObj.snapshots.length, 2);

  // Wipe and re-import into clean store
  const freshMock = createMockWebEnv();
  await initVaultCoordinator({ ...freshMock.env, indexedDB: null, resetStore: true });
  const imported = await importVaultJson(exportedText);
  assert.ok(imported.importedCount >= 3);
  assert.equal(imported.activeCart.magic, 'BF80');
  assert.equal(imported.activeCart.meta.id, 'daily-2026-11-23');
  assert.ok(imported.activeCart.meta.customPalette instanceof Uint8Array);
  assert.ok(imported.activeCart.audio.channels[0].steps instanceof Uint16Array);
  assert.equal((await getSnapshots()).length, 2);

  // Validation rejections
  await assert.rejects(() => importVaultJson('not json'), /Malformed vault JSON/);
  await assert.rejects(() => importVaultJson(JSON.stringify({ schema: 'wrong', version: 1 })), /Unsupported/);

  const tamperedCrc = structuredClone(exportedObj);
  tamperedCrc.active.crc = (tamperedCrc.active.crc + 1) >>> 0;
  await assert.rejects(() => importVaultJson(JSON.stringify(tamperedCrc)), /CRC32/);

  const badSlot = structuredClone(exportedObj);
  badSlot.snapshots[0].slot = 99;
  await assert.rejects(() => importVaultJson(JSON.stringify(badSlot)), /0\.\.31/);
});

test('(7) bundleModulesInline + buildStandaloneHtmlString + bakeStandaloneHtml offline execution', async () => {
  // Confirm MODULE_MANIFEST lists CSS, head vault, and ARCHITECTURE.md modules
  const manifestPaths = new Set(MODULE_MANIFEST.map((m) => m.path));
  assert.ok(manifestPaths.has('./styles/chassis.css'));
  assert.ok(manifestPaths.has('./styles/pixel-optics.css'));
  assert.ok(manifestPaths.has('./src/vault/cookie-vault-head.js'));
  assert.ok(manifestPaths.has('./src/main.js'));
  assert.ok(manifestPaths.has('./src/vault/storage-coordinator.js'));

  // Stress-test tricky ES import/export syntax in bundleModulesInline
  const syntheticFiles = {
    './src/dep.js': [
      '// comment with export const fake = 1; and import x from "./nope.js";',
      'const fakeStr = "import { a } from \'./x.js\'; export default 99;";',
      'const fakeTmpl = `export function nope() {} ${1 + 2}`;',
      'const regexTest = /export\\s+const/.test("export const");',
      'export let counter = 10;',
      'export function bump(n) { counter += n; return counter; }',
      'export async function asyncGreet({ name = "world" } = {}) { return `hi ${name}`; }',
      'export const { alpha, beta: renamedBeta = 5 } = { alpha: 7 };',
      'export const arrowObj = (x = { a: 1 }) => ({ val: x.a });',
      'export function* genTwo() { yield 11; yield 22; }',
      'export class Box { constructor(v) { this.v = v; } }',
      'export default function createDefault(x) { return x * 2; }'
    ].join('\n'),
    './src/reexport.js': [
      'export { alpha, renamedBeta as betaOut } from "./dep.js";',
      'export const asiVal = {',
      '  ok: true',
      '}',
      'export default class DefaultBox { constructor(n) { this.n = n; } }'
    ].join('\n'),
    './src/main.js': [
      'import defFn, {',
      '  counter,',
      '  bump,',
      '  asyncGreet,',
      '  arrowObj,',
      '  genTwo,',
      '  Box',
      '} from "./dep.js";',
      'import * as depNs from "./dep.js";',
      'import DefaultBox, * as re from "./reexport.js";',
      'globalThis.__BUNDLE_RESULT__ = {',
      '  defVal: defFn(6),',
      '  initialCounter: counter,',
      '  bumpedCounter: bump(5),',
      '  liveCounterAfterBump: depNs.counter,',
      '  arrowVal: arrowObj().val,',
      '  genArr: [...genTwo()],',
      '  alpha: re.alpha,',
      '  betaOut: re.betaOut,',
      '  asiOk: re.asiVal.ok,',
      '  reDefaultN: new DefaultBox(99).n,',
      '  boxVal: new Box(42).v,',
      '  greetPromise: asyncGreet({ name: "BitForge" })',
      '};'
    ].join('\n')
  };

  const bundledSynthetic = bundleModulesInline(syntheticFiles, './src/main.js');
  assert.doesNotThrow(() => new Function(bundledSynthetic));
  assert.ok(bundledSynthetic.includes('__BF_DEFINE__'));
  assert.ok(bundledSynthetic.includes('__BF_REQUIRE__'));

  const synthCtx = { globalThis: null };
  synthCtx.globalThis = synthCtx;
  vm.runInNewContext(bundledSynthetic, synthCtx);
  assert.equal(synthCtx.__BUNDLE_RESULT__.defVal, 12);
  assert.equal(synthCtx.__BUNDLE_RESULT__.initialCounter, 10);
  assert.equal(synthCtx.__BUNDLE_RESULT__.bumpedCounter, 15);
  assert.equal(synthCtx.__BUNDLE_RESULT__.liveCounterAfterBump, 15);
  assert.equal(synthCtx.__BUNDLE_RESULT__.arrowVal, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(synthCtx.__BUNDLE_RESULT__.genArr)), [11, 22]);
  assert.equal(synthCtx.__BUNDLE_RESULT__.alpha, 7);
  assert.equal(synthCtx.__BUNDLE_RESULT__.betaOut, 5);
  assert.equal(synthCtx.__BUNDLE_RESULT__.asiOk, true);
  assert.equal(synthCtx.__BUNDLE_RESULT__.reDefaultN, 99);
  assert.equal(synthCtx.__BUNDLE_RESULT__.boxVal, 42);
  assert.equal(await synthCtx.__BUNDLE_RESULT__.greetPromise, 'hi BitForge');

  // Bundle real vault modules + cookie-vault-head.js + CSS via bakeStandaloneHtml
  const realFiles = new Map([
    ['./styles/chassis.css', 'body { background: #12131a; color: #eee; }'],
    ['./styles/pixel-optics.css', 'canvas { image-rendering: pixelated; }'],
    ['./src/vault/cookie-vault-head.js', await fs.readFile(path.join(ROOT_DIR, 'src/vault/cookie-vault-head.js'), 'utf8')],
    ['./src/vault/daily-seed.js', await fs.readFile(path.join(ROOT_DIR, 'src/vault/daily-seed.js'), 'utf8')],
    ['./src/vault/local-sync-baker.js', await fs.readFile(path.join(ROOT_DIR, 'src/vault/local-sync-baker.js'), 'utf8')],
    ['./src/vault/storage-coordinator.js', await fs.readFile(path.join(ROOT_DIR, 'src/vault/storage-coordinator.js'), 'utf8')],
    ['./src/main.js', [
      'import { initVaultCoordinator, getInitialBootPayload } from "./vault/storage-coordinator.js";',
      'import { generateDailyCartridgeROM } from "./vault/daily-seed.js";',
      'globalThis.__STANDALONE_BOOT__ = { payload: getInitialBootPayload(), rom: generateDailyCartridgeROM("2026-11-23"), initFn: typeof initVaultCoordinator };'
    ].join('\n')]
  ]);

  const bakedCartHash = '#cart=STANDALONE_TEST_HASH_999';
  const htmlBlob = await coordinatorBakeStandaloneHtml(
    bakedCartHash,
    'Pocket <Slime> & Co',
    async (relPath, type) => {
      if (type === 'icon') return 'iVBORw0KGgo=';
      if (realFiles.has(relPath)) return realFiles.get(relPath);
      return `// stub ${relPath}\nexport default {};\n`;
    }
  );

  const html = await htmlBlob.text();
  assert.equal(/<script[^>]+src\s*=/i.test(html), false, 'Standalone HTML must contain ZERO external <script src> tags');
  assert.ok(html.includes('window.__BITFORGE_STANDALONE__ = true;'));
  assert.ok(html.includes('window.__BITFORGE_BAKED_CART__ = "#cart=STANDALONE_TEST_HASH_999";'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('body { background: #12131a; color: #eee; }'));
  assert.ok(html.includes('<title>Pocket &lt;Slime&gt; &amp; Co</title>'));

  // Extract inline scripts and execute them in order inside a clean vm sandbox
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.equal(scripts.length, 3);
  const vmSandbox = {
    window: null,
    globalThis: null,
    location: { hash: '' },
    Blob,
    Object,
    Array,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Map,
    Set,
    JSON,
    Math,
    Date,
    Number,
    String,
    Error,
    TypeError,
    RangeError,
    TextEncoder,
    RegExp,
    Function,
    encodeURIComponent,
    decodeURIComponent
  };
  vmSandbox.window = vmSandbox;
  vmSandbox.globalThis = vmSandbox;

  for (const scriptText of scripts) {
    assert.doesNotThrow(() => new Function(scriptText));
    vm.runInNewContext(scriptText, vmSandbox);
  }

  assert.equal(vmSandbox.__BITFORGE_STANDALONE__, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vmSandbox.__STANDALONE_BOOT__.payload)), {
    source: 'url-hash',
    cartHash: bakedCartHash,
    healedFromCookie: false,
    regeneratedCookie: false
  });
  assert.equal(vmSandbox.__STANDALONE_BOOT__.rom.meta.id, 'daily-2026-11-23');
  assert.equal(vmSandbox.__STANDALONE_BOOT__.initFn, 'function');
  await vmSandbox.__BITFORGE_VAULT__.initVaultCoordinator();
  const vmSnapSlot = await vmSandbox.__BITFORGE_VAULT__.snapshotToRingBuffer(bakedCartHash, 'standalone-test');
  assert.equal(vmSnapSlot, 0);

  // Direct buildStandaloneHtmlString check
  const directHtml = buildStandaloneHtmlString({
    cartHash: '#cart=DIRECT_123',
    title: 'Direct Cart',
    cssText: '.a{color:red}',
    headVaultJs: 'window.__HEAD_RAN__=true;',
    bundledMainJs: bundleModulesInline({ './src/main.js': 'export const ok = true;' })
  });
  assert.equal(/<script[^>]+src\s*=/i.test(directHtml), false);
  assert.ok(directHtml.includes('Direct Cart'));
});

test('All globalThis.__BITFORGE_VAULT__ API methods are bound', () => {
  const expectedMethods = [
    '_crc32',
    '_rehydrateSync',
    'initVaultCoordinator',
    'getInitialBootPayload',
    'commitActiveCart',
    'snapshotToRingBuffer',
    'getSnapshots',
    'resetDailyRitual',
    'exportVaultJson',
    'importVaultJson',
    'bakeStandaloneHtml'
  ];
  for (const key of expectedMethods) {
    assert.equal(typeof globalThis.__BITFORGE_VAULT__[key], 'function', `Missing __BITFORGE_VAULT__.${key}`);
  }
});
