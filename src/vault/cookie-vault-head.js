(function (root) {
  'use strict';

  var STORAGE_KEY = 'bitforge80.active';
  var COOKIE_PREFIX = 'krunked-cookie-vault-v1_';
  var COOKIE_META_KEY = COOKIE_PREFIX + 'meta';
  var MAX_CHUNK_CHARS = 3500;
  var MAX_CHUNKS = 4;
  var COOKIE_ATTRS = 'Max-Age=31536000; Path=/; SameSite=Lax';
  var COOKIE_EXPIRE_ATTRS = 'Max-Age=0; Path=/; SameSite=Lax';

  var CRC32_TABLE = (function buildCrc32Table() {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function _utf8Bytes(str) {
    var s = String(str == null ? '' : str);
    if (typeof TextEncoder !== 'undefined') {
      try {
        return new TextEncoder().encode(s);
      } catch (_err) {
        // Fall through to pure JS UTF-8 encoder
      }
    }
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        var next = s.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          var cp = 0x10000 + (((code - 0xD800) << 10) | (next - 0xDC00));
          bytes.push(
            0xF0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F),
            0x80 | (cp & 0x3F)
          );
          i++;
          continue;
        }
        bytes.push(0xEF, 0xBF, 0xBD);
      } else if (code >= 0xD800 && code <= 0xDFFF) {
        bytes.push(0xEF, 0xBF, 0xBD);
      } else {
        bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return bytes;
  }

  /**
   * Computes standard IEEE 802.3 CRC32 over UTF-8 bytes of a string.
   * @param {string} str
   * @returns {number} Unsigned 32-bit integer checksum
   */
  function _crc32(str) {
    var bytes = _utf8Bytes(str);
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function _parseCookieHeader(cookieStr) {
    var map = Object.create(null);
    if (typeof cookieStr !== 'string' || !cookieStr) return map;
    var parts = cookieStr.split(';');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var eq = part.indexOf('=');
      if (eq <= 0) continue;
      var key = part.slice(0, eq).trim();
      var val = part.slice(eq + 1).trim();
      if (key) map[key] = val;
    }
    return map;
  }

  function _createIoAdapter(env) {
    var customEnv = env || {};

    function getStorage() {
      if (customEnv.storage !== undefined) return customEnv.storage;
      try {
        return root && root.localStorage ? root.localStorage : null;
      } catch (_err) {
        return null;
      }
    }

    function getStorageItem(key) {
      try {
        var st = getStorage();
        if (!st || typeof st.getItem !== 'function') return null;
        return st.getItem(key);
      } catch (_err) {
        return null;
      }
    }

    function setStorageItem(key, value) {
      try {
        var st = getStorage();
        if (!st || typeof st.setItem !== 'function') return false;
        st.setItem(key, value);
        return true;
      } catch (_err) {
        return false;
      }
    }

    function getCookie(name) {
      try {
        if (typeof customEnv.getCookie === 'function') {
          var res = customEnv.getCookie(name);
          if (typeof res === 'string' && customEnv.getCookie.length === 0 && res.indexOf('=') !== -1) {
            var parsed = _parseCookieHeader(res);
            return parsed[name] !== undefined ? parsed[name] : null;
          }
          return res === undefined || res === null ? null : String(res);
        }
        var doc = customEnv.document !== undefined ? customEnv.document : (root && root.document ? root.document : null);
        if (!doc) return null;
        var raw = doc.cookie;
        if (typeof raw !== 'string' || !raw) return null;
        var map = _parseCookieHeader(raw);
        return map[name] !== undefined ? map[name] : null;
      } catch (_err) {
        return null;
      }
    }

    function setCookie(name, value, attrs) {
      var suffix = attrs || COOKIE_ATTRS;
      try {
        if (typeof customEnv.setCookie === 'function') {
          if (customEnv.setCookie.length === 1) {
            customEnv.setCookie(name + '=' + value + '; ' + suffix);
          } else {
            customEnv.setCookie(name, value, suffix);
          }
          return true;
        }
        var doc = customEnv.document !== undefined ? customEnv.document : (root && root.document ? root.document : null);
        if (!doc) return false;
        doc.cookie = name + '=' + value + '; ' + suffix;
        return true;
      } catch (_err) {
        return false;
      }
    }

    function clearCookie(name) {
      try {
        if (typeof customEnv.clearCookie === 'function') {
          customEnv.clearCookie(name);
          return true;
        }
      } catch (_err) {
        return false;
      }
      return setCookie(name, '', COOKIE_EXPIRE_ATTRS);
    }

    function getHash() {
      if (customEnv.hash !== undefined) return String(customEnv.hash || '');
      try {
        var loc = customEnv.location !== undefined ? customEnv.location : (root && root.location ? root.location : null);
        return loc && typeof loc.hash === 'string' ? loc.hash : '';
      } catch (_err) {
        return '';
      }
    }

    function getBakedCart() {
      if (customEnv.bakedCart !== undefined) return customEnv.bakedCart;
      try {
        return root ? root.__BITFORGE_BAKED_CART__ : undefined;
      } catch (_err) {
        return undefined;
      }
    }

    return {
      getStorageItem: getStorageItem,
      setStorageItem: setStorageItem,
      getCookie: getCookie,
      setCookie: setCookie,
      clearCookie: clearCookie,
      getHash: getHash,
      getBakedCart: getBakedCart
    };
  }

  function _readLocalState(io) {
    var raw = io.getStorageItem(STORAGE_KEY);
    if (typeof raw !== 'string' || !raw) return { ok: false };
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return { ok: false };
      if (typeof parsed.cartHash !== 'string' || !parsed.cartHash) return { ok: false };
      if (typeof parsed.crc !== 'number' || !isFinite(parsed.crc)) return { ok: false };
      var expectedCrc = _crc32(parsed.cartHash);
      if ((parsed.crc >>> 0) !== expectedCrc) return { ok: false };
      return {
        ok: true,
        ts: typeof parsed.ts === 'number' && isFinite(parsed.ts) ? parsed.ts : 0,
        crc: expectedCrc,
        cartHash: parsed.cartHash,
        summary: parsed.summary || null
      };
    } catch (_err) {
      return { ok: false };
    }
  }

  function _writeLocalState(cartHash, ts, crc, summary, io) {
    try {
      var payload = JSON.stringify({
        v: 1,
        ts: ts,
        crc: crc >>> 0,
        cartHash: cartHash,
        summary: summary || null
      });
      return io.setStorageItem(STORAGE_KEY, payload);
    } catch (_err) {
      return false;
    }
  }

  function _splitSafeChunks(encoded) {
    var chunks = [];
    var idx = 0;
    while (idx < encoded.length) {
      var end = Math.min(idx + MAX_CHUNK_CHARS, encoded.length);
      if (end < encoded.length) {
        // Avoid cutting inside a %XX percent-encoded byte sequence
        if (encoded.charAt(end - 1) === '%') {
          end -= 1;
        } else if (end >= idx + 2 && encoded.charAt(end - 2) === '%') {
          end -= 2;
        }
      }
      if (end <= idx) return null;
      chunks.push(encoded.slice(idx, end));
      idx = end;
      if (chunks.length > MAX_CHUNKS) return null;
    }
    return chunks;
  }

  function _clearShadowCookies(io) {
    io.clearCookie(COOKIE_META_KEY);
    for (var i = 0; i < MAX_CHUNKS; i++) {
      io.clearCookie(COOKIE_PREFIX + i);
    }
  }

  function _writeShadowCookies(cartHash, ts, crc, io) {
    try {
      var encoded = encodeURIComponent(cartHash);
      var chunks = _splitSafeChunks(encoded);
      if (!chunks || chunks.length === 0 || chunks.length > MAX_CHUNKS) {
        return false;
      }
      var metaStr = encodeURIComponent(JSON.stringify({
        v: 1,
        ts: ts,
        crc: crc >>> 0,
        chunks: chunks.length
      }));
      if (metaStr.length > MAX_CHUNK_CHARS) return false;

      io.setCookie(COOKIE_META_KEY, metaStr, COOKIE_ATTRS);
      for (var i = 0; i < MAX_CHUNKS; i++) {
        if (i < chunks.length) {
          io.setCookie(COOKIE_PREFIX + i, chunks[i], COOKIE_ATTRS);
        } else if (io.getCookie(COOKIE_PREFIX + i) !== null) {
          io.clearCookie(COOKIE_PREFIX + i);
        }
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  function _readShadowCookies(io) {
    var metaRaw = io.getCookie(COOKIE_META_KEY);
    var hadAnyCookie = metaRaw !== null && metaRaw !== '';
    for (var probe = 0; !hadAnyCookie && probe < MAX_CHUNKS; probe++) {
      var probeVal = io.getCookie(COOKIE_PREFIX + probe);
      if (probeVal !== null && probeVal !== '') hadAnyCookie = true;
    }

    if (typeof metaRaw !== 'string' || !metaRaw) {
      return { ok: false, hadAnyCookie: hadAnyCookie };
    }

    try {
      var meta = JSON.parse(decodeURIComponent(metaRaw));
      if (!meta || typeof meta !== 'object' || meta.v !== 1) {
        return { ok: false, hadAnyCookie: true };
      }
      if (typeof meta.crc !== 'number' || !isFinite(meta.crc)) {
        return { ok: false, hadAnyCookie: true };
      }
      if (typeof meta.chunks !== 'number' || (meta.chunks | 0) !== meta.chunks || meta.chunks < 1 || meta.chunks > MAX_CHUNKS) {
        return { ok: false, hadAnyCookie: true };
      }

      var joined = '';
      for (var i = 0; i < meta.chunks; i++) {
        var chunk = io.getCookie(COOKIE_PREFIX + i);
        if (typeof chunk !== 'string' || !chunk || chunk.length > MAX_CHUNK_CHARS) {
          return { ok: false, hadAnyCookie: true };
        }
        joined += chunk;
      }

      var cartHash = decodeURIComponent(joined);
      if (typeof cartHash !== 'string' || !cartHash) {
        return { ok: false, hadAnyCookie: true };
      }
      var expectedCrc = _crc32(cartHash);
      if ((meta.crc >>> 0) !== expectedCrc) {
        return { ok: false, hadAnyCookie: true };
      }

      return {
        ok: true,
        hadAnyCookie: true,
        ts: typeof meta.ts === 'number' && isFinite(meta.ts) ? meta.ts : 0,
        crc: expectedCrc,
        cartHash: cartHash
      };
    } catch (_err) {
      return { ok: false, hadAnyCookie: true };
    }
  }

  var vault = (root.__BITFORGE_VAULT__ = root.__BITFORGE_VAULT__ || {});

  function _setBootResult(result) {
    vault._bootPayload = result;
    return {
      source: result.source,
      cartHash: result.cartHash,
      healedFromCookie: result.healedFromCookie,
      regeneratedCookie: result.regeneratedCookie
    };
  }

  /**
   * Synchronously reconciles baked cart, #cart= URL hash, localStorage, and shadow cookies.
   * @param {object} [env]
   * @returns {{ source: string, cartHash: string|null, healedFromCookie: boolean, regeneratedCookie: boolean }}
   */
  function _rehydrateSync(env) {
    var io = _createIoAdapter(env);
    var hash = io.getHash();
    var bakedCart = io.getBakedCart();
    var hasHashCart = typeof hash === 'string' && hash.indexOf('#cart=') === 0 && hash.length > 6;
    var hasBakedCart = typeof bakedCart === 'string' && bakedCart.length > 0;

    if (hasBakedCart && !hasHashCart) {
      return _setBootResult({
        source: 'url-hash',
        cartHash: bakedCart,
        healedFromCookie: false,
        regeneratedCookie: false
      });
    }

    var localState = _readLocalState(io);
    var cookieState = _readShadowCookies(io);

    if (hasHashCart) {
      var prior = localState.ok ? localState : (cookieState.ok ? cookieState : null);
      try {
        if (prior && prior.cartHash !== hash) {
          root.__BITFORGE_PENDING_SNAPSHOT__ = {
            cartHash: prior.cartHash,
            ts: prior.ts || Date.now(),
            reason: 'incoming-url-cart',
            newCartHash: hash
          };
        } else {
          root.__BITFORGE_PENDING_SNAPSHOT__ = null;
        }
      } catch (_err) {
        // Ignore non-writable root edge case
      }
      return _setBootResult({
        source: 'url-hash',
        cartHash: hash,
        healedFromCookie: false,
        regeneratedCookie: false
      });
    }

    if (!localState.ok && cookieState.ok) {
      var restoredTs = cookieState.ts || Date.now();
      _writeLocalState(cookieState.cartHash, restoredTs, cookieState.crc, null, io);
      return _setBootResult({
        source: 'shadow-cookie',
        cartHash: cookieState.cartHash,
        healedFromCookie: true,
        regeneratedCookie: false
      });
    }

    if (localState.ok) {
      var needsCookieRegen = !cookieState.ok ||
        cookieState.crc !== localState.crc ||
        cookieState.cartHash !== localState.cartHash ||
        localState.ts > cookieState.ts;

      if (needsCookieRegen) {
        _writeShadowCookies(localState.cartHash, localState.ts || Date.now(), localState.crc, io);
        return _setBootResult({
          source: 'local-storage',
          cartHash: localState.cartHash,
          healedFromCookie: false,
          regeneratedCookie: true
        });
      }

      return _setBootResult({
        source: 'local-storage',
        cartHash: localState.cartHash,
        healedFromCookie: false,
        regeneratedCookie: false
      });
    }

    if (cookieState.hadAnyCookie) {
      _clearShadowCookies(io);
    }

    return _setBootResult({
      source: 'pack-in',
      cartHash: null,
      healedFromCookie: false,
      regeneratedCookie: false
    });
  }

  /**
   * Writes an active cartridge hash to both localStorage and chunked SameSite=Lax shadow cookies.
   * @param {string} cartHash
   * @param {object|null} [summary]
   * @param {object} [env]
   */
  function _persistSync(cartHash, summary, env) {
    if (typeof cartHash !== 'string' || !cartHash) return { ok: false };
    var io = _createIoAdapter(env);
    var ts = Date.now();
    var crc = _crc32(cartHash);
    var wroteLocal = _writeLocalState(cartHash, ts, crc, summary || null, io);
    var wroteCookie = _writeShadowCookies(cartHash, ts, crc, io);
    return { ok: wroteLocal || wroteCookie, ts: ts, crc: crc, wroteLocal: wroteLocal, wroteCookie: wroteCookie };
  }

  function getInitialBootPayload() {
    if (!vault._bootPayload) {
      return _rehydrateSync();
    }
    return {
      source: vault._bootPayload.source,
      cartHash: vault._bootPayload.cartHash,
      healedFromCookie: vault._bootPayload.healedFromCookie,
      regeneratedCookie: vault._bootPayload.regeneratedCookie
    };
  }

  vault._crc32 = _crc32;
  vault._rehydrateSync = _rehydrateSync;
  vault._persistSync = _persistSync;
  vault.getInitialBootPayload = getInitialBootPayload;

  if (!vault._headExecuted) {
    vault._headExecuted = true;
    _rehydrateSync();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
