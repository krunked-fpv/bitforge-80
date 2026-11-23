const KEY_STR_URI_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';

const BASE_REVERSE = new Map();
for (let i = 0; i < KEY_STR_URI_SAFE.length; i++) {
  BASE_REVERSE.set(KEY_STR_URI_SAFE.charAt(i), i);
}

/**
 * Compress an arbitrary UTF-16 string using LZ-String into the URI-safe 65-char alphabet.
 * @param {string | null | undefined} input
 * @returns {string}
 */
export function compressToEncodedURIComponent(input) {
  if (input == null) return '';
  if (typeof input !== 'string') {
    throw new TypeError('compressToEncodedURIComponent expected a string');
  }
  return compressCore(input, 6, (code) => KEY_STR_URI_SAFE.charAt(code));
}

/**
 * Decompress a URI-safe LZ-String payload back to a UTF-16 string, or null on invalid/corrupt input.
 * @param {string} encoded
 * @returns {string | null}
 */
export function decompressFromEncodedURIComponent(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return null;
  }
  const normalized = encoded.replace(/ /g, '+');
  for (let i = 0; i < normalized.length; i++) {
    if (!BASE_REVERSE.has(normalized.charAt(i))) {
      return null;
    }
  }
  return decompressCore(normalized.length, 32, (idx) => {
    const v = BASE_REVERSE.get(normalized.charAt(idx));
    return v === undefined ? -2 : v;
  });
}

/**
 * Compress arbitrary bytes (0..255) into a URI-safe LZ string via 1:1 Latin-1 mapping,
 * preventing UTF-16 lone surrogates (0xD800..0xDFFF) while preserving bit-exact bytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function compressBytesToUri(bytes) {
  let u8;
  if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (ArrayBuffer.isView(bytes)) {
    u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (Array.isArray(bytes)) {
    u8 = Uint8Array.from(bytes);
  } else {
    throw new TypeError('compressBytesToUri expected a Uint8Array');
  }

  const chars = new Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    chars[i] = String.fromCharCode(u8[i]);
  }
  return compressToEncodedURIComponent(chars.join(''));
}

/**
 * Decompress a URI-safe LZ string produced by compressBytesToUri back to Uint8Array,
 * returning null gracefully on corrupt, truncated, or non-byte payloads.
 * @param {string} encoded
 * @returns {Uint8Array | null}
 */
export function decompressBytesFromUri(encoded) {
  const str = decompressFromEncodedURIComponent(encoded);
  if (str === null) return null;

  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 255) {
      return null;
    }
    out[i] = code;
  }
  return out;
}

function compressCore(uncompressed, bitsPerChar, getCharFromInt) {
  const dictionary = new Map();
  const dictionaryToCreate = new Set();
  const data = [];
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  let dataVal = 0;
  let dataPos = 0;
  let w = '';

  function writeBits(bitCount, value) {
    let v = value;
    for (let i = 0; i < bitCount; i++) {
      dataVal = (dataVal << 1) | (v & 1);
      if (dataPos === bitsPerChar - 1) {
        dataPos = 0;
        data.push(getCharFromInt(dataVal));
        dataVal = 0;
      } else {
        dataPos += 1;
      }
      v >>= 1;
    }
  }

  function stepEnlarge() {
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }
  }

  function emitToken(token) {
    if (dictionaryToCreate.has(token)) {
      const code = token.charCodeAt(0);
      if (code < 256) {
        writeBits(numBits, 0);
        writeBits(8, code);
      } else {
        writeBits(numBits, 1);
        writeBits(16, code);
      }
      stepEnlarge();
      dictionaryToCreate.delete(token);
    } else {
      writeBits(numBits, dictionary.get(token));
    }
    stepEnlarge();
  }

  for (let i = 0; i < uncompressed.length; i++) {
    const c = uncompressed.charAt(i);
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      dictionaryToCreate.add(c);
    }

    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
    } else {
      emitToken(w);
      dictionary.set(wc, dictSize++);
      w = c;
    }
  }

  if (w !== '') {
    emitToken(w);
  }

  // End-of-stream marker (2)
  writeBits(numBits, 2);

  // Flush final character bits
  while (true) {
    dataVal <<= 1;
    if (dataPos === bitsPerChar - 1) {
      data.push(getCharFromInt(dataVal));
      break;
    }
    dataPos += 1;
  }

  return data.join('');
}

function decompressCore(length, resetValue, getNextValue) {
  const firstVal = getNextValue(0);
  if (firstVal < 0) return null;

  const dictionary = ['', '', ''];
  const result = [];
  const data = { val: firstVal, position: resetValue, index: 1 };
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;

  function readBits(bitCount) {
    let bits = 0;
    const maxpower = Math.pow(2, bitCount);
    let power = 1;
    while (power !== maxpower) {
      if (data.val < 0) return null;
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = data.index < length ? getNextValue(data.index++) : -1;
        if (data.val === -2) return null;
      }
      if (resb > 0) bits |= power;
      power <<= 1;
    }
    return bits;
  }

  const next = readBits(2);
  if (next === null) return null;

  let firstSym;
  if (next === 0) {
    const ch = readBits(8);
    if (ch === null) return null;
    firstSym = String.fromCharCode(ch);
  } else if (next === 1) {
    const ch = readBits(16);
    if (ch === null) return null;
    firstSym = String.fromCharCode(ch);
  } else if (next === 2) {
    return data.index < length ? null : '';
  } else {
    return null;
  }

  dictionary[3] = firstSym;
  let w = firstSym;
  result.push(firstSym);

  while (true) {
    if (numBits > 28) return null;
    let sym = readBits(numBits);
    if (sym === null) return null;

    if (sym === 0) {
      const ch = readBits(8);
      if (ch === null) return null;
      dictionary[dictSize++] = String.fromCharCode(ch);
      sym = dictSize - 1;
      enlargeIn -= 1;
    } else if (sym === 1) {
      const ch = readBits(16);
      if (ch === null) return null;
      dictionary[dictSize++] = String.fromCharCode(ch);
      sym = dictSize - 1;
      enlargeIn -= 1;
    } else if (sym === 2) {
      return data.index < length ? null : result.join('');
    }

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }

    if (sym < 3 || sym > dictSize) {
      return null;
    }

    let entry;
    if (sym < dictionary.length && dictionary[sym] !== undefined) {
      entry = dictionary[sym];
    } else if (sym === dictSize) {
      entry = w + w.charAt(0);
    } else {
      return null;
    }

    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn -= 1;
    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }
  }
}
