import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODULE_MANIFEST } from '../src/vault/local-sync-baker.js';

const THIS_FILE = path.resolve(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(path.dirname(THIS_FILE), '..');

export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function normalizeBasePath(basePath) {
  let clean = String(basePath || '/bitforge-80').trim();
  if (!clean.startsWith('/')) clean = `/${clean}`;
  return clean.replace(/\/+$/, '');
}

/**
 * Create an ephemeral HTTP server serving `rootDir` exclusively under `basePath/`.
 * Mimics GitHub Pages project subpath hosting (e.g. https://krunked-fpv.github.io/bitforge-80/).
 * @param {{ rootDir?: string, basePath?: string }} [opts]
 */
export function createSubpathStaticServer({ rootDir = DEFAULT_ROOT_DIR, basePath = '/bitforge-80' } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const prefix = normalizeBasePath(basePath);
  const prefixWithSlash = `${prefix}/`;

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Method Not Allowed');
        return;
      }

      const rawUrl = req.url || '/';
      const reqUrl = new URL(rawUrl, 'http://127.0.0.1');
      let pathname;
      try {
        pathname = decodeURIComponent(reqUrl.pathname);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Bad Request');
        return;
      }

      if (pathname === prefix) {
        res.writeHead(302, { Location: prefixWithSlash, Connection: 'close' });
        res.end();
        return;
      }

      if (!pathname.startsWith(prefixWithSlash)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Not Found');
        return;
      }

      let relPath = pathname.slice(prefixWithSlash.length);
      if (relPath === '' || relPath.endsWith('/')) {
        relPath = `${relPath}index.html`;
      }

      const targetPath = path.resolve(resolvedRoot, relPath);
      if (targetPath !== resolvedRoot && !targetPath.startsWith(resolvedRoot + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Forbidden');
        return;
      }

      const stat = await fsp.stat(targetPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Not Found');
        return;
      }

      const body = await fsp.readFile(targetPath);
      res.writeHead(200, {
        'Content-Type': getContentType(targetPath),
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(err?.message || 'Internal Server Error');
    }
  });
}

/**
 * Extract all relative `./` asset/link references from `index.html` (HTML attributes & inline SW script).
 * @param {string} htmlText
 * @returns {string[]}
 */
export function extractRelativeLinksFromHtml(htmlText) {
  const links = new Set();
  const attrRe = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRe.exec(htmlText)) !== null) {
    links.add(match[1].trim());
  }

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sMatch;
  while ((sMatch = scriptRe.exec(htmlText)) !== null) {
    const inlineJs = sMatch[1];
    const relLiteralRe = /['"](\.\/[^'"]*)['"]/g;
    let rMatch;
    while ((rMatch = relLiteralRe.exec(inlineJs)) !== null) {
      links.add(rMatch[1].trim());
    }
  }

  return Array.from(links);
}

/**
 * Extract all relative `./` paths declared in `manifest.json`.
 * @param {object} manifest
 * @returns {string[]}
 */
export function extractRelativeLinksFromManifest(manifest) {
  const links = [];
  for (const field of ['id', 'start_url', 'scope']) {
    if (typeof manifest[field] === 'string') {
      links.push(manifest[field]);
    }
  }
  if (Array.isArray(manifest.icons)) {
    for (const icon of manifest.icons) {
      if (icon && typeof icon.src === 'string') {
        links.push(icon.src);
      }
    }
  }
  return Array.from(new Set(links));
}

function assertContentTypeMatch(actualType, expectedKind, urlPath) {
  const normalized = String(actualType || '').toLowerCase();
  if (expectedKind === 'html') {
    assert.ok(normalized.includes('text/html'), `Expected text/html for ${urlPath}, got "${actualType}"`);
  } else if (expectedKind === 'json') {
    assert.ok(normalized.includes('application/json'), `Expected application/json for ${urlPath}, got "${actualType}"`);
  } else if (expectedKind === 'js') {
    assert.ok(
      /(application|text)\/javascript/.test(normalized),
      `Expected JavaScript Content-Type for ${urlPath}, got "${actualType}"`
    );
  } else if (expectedKind === 'css') {
    assert.ok(normalized.includes('text/css'), `Expected text/css for ${urlPath}, got "${actualType}"`);
  } else if (expectedKind === 'png') {
    assert.ok(normalized.includes('image/png'), `Expected image/png for ${urlPath}, got "${actualType}"`);
  }
}

function inferKindFromPath(urlPath) {
  if (urlPath.endsWith('/')) return 'html';
  const ext = path.extname(urlPath).toLowerCase();
  if (ext === '.html') return 'html';
  if (ext === '.json') return 'json';
  if (ext === '.js' || ext === '.mjs') return 'js';
  if (ext === '.css') return 'css';
  if (ext === '.png') return 'png';
  return 'other';
}

async function fetchAndVerify(origin, urlPath, expectedKind) {
  const targetUrl = `${origin}${urlPath}`;
  const res = await fetch(targetUrl, { headers: { Connection: 'close' } });
  assert.equal(res.status, 200, `Expected HTTP 200 for ${urlPath}, got ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  assertContentTypeMatch(contentType, expectedKind, urlPath);

  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.byteLength > 0, `Empty body returned for ${urlPath}`);

  if (expectedKind === 'png') {
    assert.deepEqual(
      Array.from(bytes.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `Invalid PNG signature for ${urlPath}`
    );
  }

  return {
    urlPath,
    status: res.status,
    contentType,
    bytes: bytes.byteLength,
    text: expectedKind === 'png' ? null : new TextDecoder('utf-8').decode(bytes),
  };
}

/**
 * Boot an ephemeral subpath HTTP server at `/bitforge-80/`, verify all core assets,
 * all `MODULE_MANIFEST` JS modules, and all relative `./` links in `index.html` and `manifest.json`.
 * Closes the server cleanly in a `finally` block.
 */
export async function runE2eBrowserSuite({
  rootDir = DEFAULT_ROOT_DIR,
  basePath = '/bitforge-80',
  quiet = false,
} = {}) {
  const startedAt = Date.now();
  const prefix = normalizeBasePath(basePath);
  const prefixWithSlash = `${prefix}/`;
  const server = createSubpathStaticServer({ rootDir, basePath: prefix });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object' && typeof addr.port === 'number');
    const origin = `http://127.0.0.1:${addr.port}`;
    const baseUrl = `${origin}${prefixWithSlash}`;

    const coreTargets = [
      { path: `${prefixWithSlash}`, kind: 'html' },
      { path: `${prefixWithSlash}index.html`, kind: 'html' },
      { path: `${prefixWithSlash}manifest.json`, kind: 'json' },
      { path: `${prefixWithSlash}sw.js`, kind: 'js' },
      { path: `${prefixWithSlash}assets/icons/icon-192.png`, kind: 'png' },
      { path: `${prefixWithSlash}assets/icons/icon-512.png`, kind: 'png' },
      { path: `${prefixWithSlash}assets/icons/apple-touch-icon.png`, kind: 'png' },
      { path: `${prefixWithSlash}styles/chassis.css`, kind: 'css' },
      { path: `${prefixWithSlash}styles/pixel-optics.css`, kind: 'css' },
      { path: `${prefixWithSlash}src/vault/cookie-vault-head.js`, kind: 'js' },
      { path: `${prefixWithSlash}src/main.js`, kind: 'js' },
    ];

    const manifestJsTargets = MODULE_MANIFEST
      .filter((entry) => entry.path.endsWith('.js'))
      .map((entry) => ({
        path: `${prefixWithSlash}${entry.path.replace(/^\.\//, '')}`,
        kind: 'js',
      }));

    const seenTargets = new Map();
    for (const target of [...coreTargets, ...manifestJsTargets]) {
      if (!seenTargets.has(target.path)) {
        seenTargets.set(target.path, target);
      }
    }

    const fetched = new Map();
    for (const target of seenTargets.values()) {
      const result = await fetchAndVerify(origin, target.path, target.kind);
      fetched.set(target.path, result);
    }

    // Verify subpath isolation (root path & missing file must 404)
    const outsideRes = await fetch(`${origin}/index.html`, { headers: { Connection: 'close' } });
    assert.equal(outsideRes.status, 404, 'Requests outside /bitforge-80/ must return 404');
    await outsideRes.arrayBuffer();

    const missingRes = await fetch(`${origin}${prefixWithSlash}__nonexistent_404_check__.js`, {
      headers: { Connection: 'close' },
    });
    assert.equal(missingRes.status, 404, 'Missing file under /bitforge-80/ must return 404');
    await missingRes.arrayBuffer();

    // Parse index.html & manifest.json and verify zero broken relative ./ links
    const indexHtml = fetched.get(`${prefixWithSlash}index.html`).text;
    const manifestRaw = fetched.get(`${prefixWithSlash}manifest.json`).text;
    const manifestObj = JSON.parse(manifestRaw);

    const indexLinks = extractRelativeLinksFromHtml(indexHtml);
    assert.ok(indexLinks.length >= 7, 'index.html must declare relative ./ assets and scripts');
    for (const expected of [
      './manifest.json',
      './assets/icons/icon-192.png',
      './assets/icons/apple-touch-icon.png',
      './styles/chassis.css',
      './styles/pixel-optics.css',
      './src/vault/cookie-vault-head.js',
      './src/main.js',
      './sw.js',
    ]) {
      assert.ok(indexLinks.includes(expected), `index.html missing expected relative link ${expected}`);
    }

    const manifestLinks = extractRelativeLinksFromManifest(manifestObj);
    assert.ok(manifestLinks.length >= 3, 'manifest.json must declare relative ./ start_url, scope, and icons');
    for (const expected of ['./', './assets/icons/icon-192.png', './assets/icons/icon-512.png']) {
      assert.ok(manifestLinks.includes(expected), `manifest.json missing expected relative link ${expected}`);
    }

    const brokenLinks = [];
    for (const rawLink of [...indexLinks, ...manifestLinks]) {
      assert.ok(
        rawLink.startsWith('./'),
        `Every link in index.html and manifest.json must be subpath-relative ./ (got "${rawLink}")`
      );
      const resolved = new URL(rawLink, baseUrl);
      assert.ok(
        resolved.pathname.startsWith(prefixWithSlash),
        `Relative link "${rawLink}" escaped subpath ${prefixWithSlash} -> ${resolved.pathname}`
      );
      const kind = inferKindFromPath(resolved.pathname);
      try {
        await fetchAndVerify(origin, resolved.pathname, kind);
      } catch (err) {
        brokenLinks.push({ link: rawLink, pathname: resolved.pathname, error: err.message });
      }
    }
    assert.deepEqual(brokenLinks, [], `Broken relative links detected: ${JSON.stringify(brokenLinks)}`);

    const summary = {
      ok: true,
      basePath: prefixWithSlash,
      origin,
      checkedEndpoints: fetched.size,
      manifestJsModules: manifestJsTargets.length,
      indexRelativeLinks: indexLinks,
      manifestRelativeLinks: manifestLinks,
      brokenLinks,
      durationMs: Date.now() - startedAt,
    };

    if (!quiet) {
      console.log(JSON.stringify(summary, null, 2));
    }
    return summary;
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(THIS_FILE);
  } catch {
    return path.resolve(process.argv[1]) === THIS_FILE;
  }
}

if (isMainEntry()) {
  runE2eBrowserSuite().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
