import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function parseAndVerifyPng(filePath, expectedWidth, expectedHeight) {
  const buf = fs.readFileSync(filePath);
  assert.ok(buf.length > 33, `${filePath} must be larger than minimal PNG header`);
  assert.deepEqual(
    buf.subarray(0, 8),
    PNG_SIGNATURE,
    `${filePath} must begin with PNG magic signature 89 50 4E 47 0D 0A 1A 0A`
  );

  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    assert.ok(offset + 12 <= buf.length, `${filePath} truncated chunk header at offset ${offset}`);
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `${filePath} truncated chunk ${type} payload`);

    const data = buf.subarray(dataStart, dataEnd);
    const actualCrc = buf.readUInt32BE(dataEnd);
    const expectedCrc = crc32(buf.subarray(offset + 4, dataEnd));
    assert.equal(
      actualCrc,
      expectedCrc,
      `${filePath} chunk ${type} CRC32 mismatch (got 0x${actualCrc.toString(16)}, expected 0x${expectedCrc.toString(16)})`
    );

    chunks.push({ type, data });
    offset = dataEnd + 4;
  }

  assert.equal(offset, buf.length, `${filePath} has trailing bytes after IEND`);
  assert.ok(chunks.length >= 3, `${filePath} must contain at least IHDR, IDAT, IEND`);

  // Validate IHDR
  const ihdr = chunks[0];
  assert.equal(ihdr.type, 'IHDR', `${filePath} first chunk must be IHDR`);
  assert.equal(ihdr.data.length, 13, `${filePath} IHDR must be 13 bytes`);
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];

  assert.equal(width, expectedWidth, `${filePath} width must be ${expectedWidth}`);
  assert.equal(height, expectedHeight, `${filePath} height must be ${expectedHeight}`);
  assert.equal(bitDepth, 8, `${filePath} bitDepth must be 8`);
  assert.equal(colorType, 6, `${filePath} colorType must be 6 (RGBA)`);
  assert.equal(compression, 0, `${filePath} compression method must be 0`);
  assert.equal(filterMethod, 0, `${filePath} filter method must be 0`);
  assert.equal(interlace, 0, `${filePath} interlace method must be 0`);

  // Validate IDAT zlib payload
  const idatChunks = chunks.filter((c) => c.type === 'IDAT');
  assert.ok(idatChunks.length >= 1, `${filePath} must contain at least one IDAT chunk`);
  const compressed = Buffer.concat(idatChunks.map((c) => c.data));
  const rawScanlines = zlib.inflateSync(compressed);
  const expectedRawLength = height * (1 + width * 4);
  assert.equal(
    rawScanlines.length,
    expectedRawLength,
    `${filePath} inflated IDAT size must equal height * (1 + width * 4)`
  );

  // Validate IEND
  const iend = chunks[chunks.length - 1];
  assert.equal(iend.type, 'IEND', `${filePath} last chunk must be IEND`);
  assert.equal(iend.data.length, 0, `${filePath} IEND chunk must have 0 bytes`);

  // Inspect pixel colors across raw scanlines (filter 0 expected)
  const colorSet = new Set();
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    assert.equal(rawScanlines[rowOffset], 0, `${filePath} scanline ${y} filter byte must be 0`);
    for (let x = 0; x < width; x++) {
      const p = rowOffset + 1 + x * 4;
      const hex =
        rawScanlines[p].toString(16).padStart(2, '0') +
        rawScanlines[p + 1].toString(16).padStart(2, '0') +
        rawScanlines[p + 2].toString(16).padStart(2, '0') +
        rawScanlines[p + 3].toString(16).padStart(2, '0');
      colorSet.add(hex);
    }
  }

  return { chunks, rawScanlines, colorSet };
}

test('PNG icons: valid magic bytes, IHDR dimensions, CRC32, zlib IDAT, IEND, and cartridge palette', () => {
  const iconSpecs = [
    { rel: 'assets/icons/icon-192.png', width: 192, height: 192 },
    { rel: 'assets/icons/icon-512.png', width: 512, height: 512 },
    { rel: 'assets/icons/apple-touch-icon.png', width: 180, height: 180 },
  ];

  for (const spec of iconSpecs) {
    const fullPath = path.join(ROOT_DIR, spec.rel);
    assert.ok(fs.existsSync(fullPath), `${spec.rel} must exist`);
    const { colorSet } = parseAndVerifyPng(fullPath, spec.width, spec.height);

    // Must contain anodized #12131a, cartridge #1a1d27, gold #f6c453, plus 16+ vibrant colors
    assert.ok(colorSet.has('12131aff'), `${spec.rel} must contain #12131a anodized backdrop`);
    assert.ok(colorSet.has('1a1d27ff'), `${spec.rel} must contain #1a1d27 cartridge housing`);
    assert.ok(colorSet.has('f6c453ff'), `${spec.rel} must contain #f6c453 gold contact pins`);
    assert.ok(
      colorSet.size >= 16,
      `${spec.rel} must include at least 16 distinct RGBA colors (found ${colorSet.size})`
    );
  }
});

test('manifest.json: relative ./ paths, BitForge-80 metadata, and maskable icons', () => {
  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'BitForge-80: Tactile Pixel ASMR Console');
  assert.equal(manifest.short_name, 'BitForge-80');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.trim().length > 0, 'manifest description must be non-empty');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#12131a');
  assert.equal(manifest.theme_color, '#12131a');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');

  assert.ok(Array.isArray(manifest.icons), 'manifest.icons must be an array');
  const icon192 = manifest.icons.find((i) => i.src === './assets/icons/icon-192.png');
  const icon512 = manifest.icons.find((i) => i.src === './assets/icons/icon-512.png');
  assert.ok(icon192, 'manifest must include ./assets/icons/icon-192.png');
  assert.equal(icon192.sizes, '192x192');
  assert.equal(icon192.type, 'image/png');
  assert.equal(icon192.purpose, 'any maskable');

  assert.ok(icon512, 'manifest must include ./assets/icons/icon-512.png');
  assert.equal(icon512.sizes, '512x512');
  assert.equal(icon512.type, 'image/png');
  assert.equal(icon512.purpose, 'any maskable');

  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `icon src ${icon.src} must be relative ./`);
    const resolved = path.join(ROOT_DIR, icon.src);
    assert.ok(fs.existsSync(resolved), `manifest icon target ${icon.src} must exist`);
  }
});

test('sw.js: valid syntax, BITFORGE_PWA_CACHE_V1, precache install, cache cleanup activate, and network-first fetch', async () => {
  const swPath = path.join(ROOT_DIR, 'sw.js');
  const swSource = fs.readFileSync(swPath, 'utf8');

  assert.match(swSource, /const\s+BITFORGE_PWA_CACHE_V1\s*=\s*['"]bitforge-80-pwa-v1['"]/);
  assert.doesNotMatch(swSource, /^\s*(import|export)\b/m, 'sw.js must be classic SW script without ES import/export');

  // Verify syntax compiles cleanly
  const script = new vm.Script(`${swSource}\n;globalThis.__CACHE_CONST__ = BITFORGE_PWA_CACHE_V1;`, {
    filename: 'sw.js',
  });

  // Build isolated Service Worker runtime mock
  const listeners = new Map();
  const cacheStore = new Map([
    ['bitforge-80-stale-v0', new Map()],
    ['bitforge-80-pwa-v1', new Map()],
  ]);
  const addedUrls = [];
  const deletedKeys = [];
  let skipWaitingCalled = false;
  let clientsClaimCalled = false;
  let fetchMode = 'online';
  const networkPayload = { ok: true, status: 200, body: 'live-response', clone() { return { ...this }; } };

  const cachesMock = {
    async open(name) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const bucket = cacheStore.get(name);
      return {
        async addAll(urls) {
          addedUrls.push(...urls);
          for (const u of urls) bucket.set(u, { url: u, ok: true });
        },
        async put(req, res) {
          const key = typeof req === 'string' ? req : req.url;
          bucket.set(key, res);
        },
      };
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(key) {
      deletedKeys.push(key);
      return cacheStore.delete(key);
    },
    async match(req) {
      const key = typeof req === 'string' ? req : req.url;
      for (const bucket of cacheStore.values()) {
        if (bucket.has(key)) return bucket.get(key);
      }
      return undefined;
    },
  };

  const sandbox = {
    URL,
    Response,
    caches: cachesMock,
    async fetch() {
      if (fetchMode === 'offline') {
        throw new Error('Network offline');
      }
      return networkPayload;
    },
  };
  sandbox.self = {
    location: {
      origin: 'https://krunked-fpv.github.io',
      href: 'https://krunked-fpv.github.io/bitforge-80/sw.js',
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    async skipWaiting() {
      skipWaitingCalled = true;
    },
    clients: {
      async claim() {
        clientsClaimCalled = true;
      },
    },
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  assert.equal(sandbox.__CACHE_CONST__, 'bitforge-80-pwa-v1');
  assert.ok(listeners.has('install'), 'sw.js must register install listener');
  assert.ok(listeners.has('activate'), 'sw.js must register activate listener');
  assert.ok(listeners.has('fetch'), 'sw.js must register fetch listener');

  // 1. Test install precache + skipWaiting
  let installWaitPromise;
  listeners.get('install')({
    waitUntil(p) {
      installWaitPromise = p;
    },
  });
  await installWaitPromise;

  const expectedPrecache = [
    './',
    './index.html',
    './manifest.json',
    './styles/chassis.css',
    './styles/pixel-optics.css',
    './src/main.js',
    './src/vault/cookie-vault-head.js',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
  ];
  assert.deepEqual(addedUrls, expectedPrecache);
  assert.equal(skipWaitingCalled, true, 'install must invoke self.skipWaiting()');

  // 2. Test activate deletes stale caches and calls clients.claim()
  let activateWaitPromise;
  listeners.get('activate')({
    waitUntil(p) {
      activateWaitPromise = p;
    },
  });
  await activateWaitPromise;

  assert.deepEqual(deletedKeys, ['bitforge-80-stale-v0']);
  assert.equal(cacheStore.has('bitforge-80-pwa-v1'), true);
  assert.equal(clientsClaimCalled, true, 'activate must invoke self.clients.claim()');

  // 3. Test fetch: online same-origin GET updates cache and returns live response
  const sameOriginReq = {
    method: 'GET',
    url: 'https://krunked-fpv.github.io/bitforge-80/src/main.js',
  };
  let onlineResponsePromise;
  listeners.get('fetch')({
    request: sameOriginReq,
    respondWith(p) {
      onlineResponsePromise = p;
    },
  });
  const liveRes = await onlineResponsePromise;
  assert.equal(liveRes, networkPayload);
  assert.equal(
    cacheStore.get('bitforge-80-pwa-v1').get(sameOriginReq.url)?.body,
    'live-response',
    'network-first fetch must update cache when res.ok'
  );

  // 4. Test fetch: offline falls back to caches.match(event.request)
  fetchMode = 'offline';
  let offlineResponsePromise;
  listeners.get('fetch')({
    request: sameOriginReq,
    respondWith(p) {
      offlineResponsePromise = p;
    },
  });
  const cachedRes = await offlineResponsePromise;
  assert.equal(cachedRes?.body, 'live-response', 'offline fetch must fall back to cached response');

  // 5. Test fetch ignores cross-origin & non-GET requests
  let crossOriginIntercepted = false;
  listeners.get('fetch')({
    request: { method: 'GET', url: 'https://example.org/other.js' },
    respondWith() {
      crossOriginIntercepted = true;
    },
  });
  assert.equal(crossOriginIntercepted, false, 'cross-origin GET must not be intercepted');

  let postIntercepted = false;
  listeners.get('fetch')({
    request: { method: 'POST', url: 'https://krunked-fpv.github.io/bitforge-80/api' },
    respondWith() {
      postIntercepted = true;
    },
  });
  assert.equal(postIntercepted, false, 'non-GET request must not be intercepted');
});

test('.gitignore and .github/workflows/deploy-pages.yml contain required contracts', () => {
  const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  for (const pattern of [
    '*.bak',
    '*.cookie_bak',
    '.DS_Store',
    'node_modules/',
    '.tmp/',
    '.worktrees/',
    'coverage/',
    '*.log',
  ]) {
    assert.ok(
      gitignore.split(/\r?\n/).includes(pattern),
      `.gitignore must include ${pattern}`
    );
  }

  const workflow = fs.readFileSync(
    path.join(ROOT_DIR, '.github/workflows/deploy-pages.yml'),
    'utf8'
  );
  for (const snippet of [
    'push:',
    'main',
    'workflow_dispatch:',
    'contents: read',
    'pages: write',
    'id-token: write',
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'node-version: 22',
    'node --test tests/*.test.mjs',
    'actions/configure-pages@v5',
    'actions/upload-pages-artifact@v3',
    'actions/deploy-pages@v4',
  ]) {
    assert.ok(workflow.includes(snippet), `deploy-pages.yml must contain '${snippet}'`);
  }
});
