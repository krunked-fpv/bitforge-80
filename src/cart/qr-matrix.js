// Pure JS ISO/IEC 18004 QR Code encoder (Byte mode, Versions 1..40, EC Levels M & L)

const TEXT_ENCODER = new TextEncoder();

// Alignment pattern center coordinates for Versions 1..40 (ISO/IEC 18004 Table E.1)
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

// ISO/IEC 18004 Table 9: EC codewords per block & total block count (indexed 1..40)
const EC_CONFIG = {
  L: {
    ecPerBlock: [
      0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
      20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
      28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    numBlocks: [
      0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
      4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
      8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
      16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
    ],
  },
  M: {
    ecPerBlock: [
      0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
      30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
      26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
      28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    ],
    numBlocks: [
      0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
      5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
      17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
      31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
    ],
  },
};

const EC_FORMAT_BITS = {
  L: 1, // 0b01
  M: 0, // 0b00
};

// GF(256) log/antilog tables under primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

/**
 * Encode a UTF-8 string into an ISO/IEC 18004 QR Code matrix (Byte mode, Versions 1..40).
 * Auto-steps EC level M -> L when payload exceeds M max capacity (2331 bytes) up to 2953 bytes.
 * @param {string} text
 * @param {'L'|'M'} [preferredEcLevel='M']
 * @returns {{
 *   version: number,
 *   ecLevel: 'L'|'M',
 *   size: number,
 *   quietZone: number,
 *   totalSize: number,
 *   modules: Uint8Array,
 *   isSet(x: number, y: number): boolean,
 *   isQuietSet(x: number, y: number): boolean,
 * }}
 */
export function encodeQrMatrix(text, preferredEcLevel = 'M') {
  if (typeof text !== 'string') {
    throw new TypeError('encodeQrMatrix expected a string');
  }
  const reqLevel = String(preferredEcLevel || 'M').toUpperCase();
  if (reqLevel !== 'L' && reqLevel !== 'M') {
    throw new Error(`Unsupported EC level "${preferredEcLevel}"; expected "M" or "L"`);
  }

  const payload = TEXT_ENCODER.encode(text);
  let ecLevel = reqLevel;
  let version = findMinimumVersion(payload.length, ecLevel);

  if (version === -1 && ecLevel === 'M') {
    ecLevel = 'L';
    version = findMinimumVersion(payload.length, ecLevel);
  }
  if (version === -1) {
    throw new RangeError(`QR payload (${payload.length} bytes) exceeds Version 40-L max (2953 bytes)`);
  }

  const size = version * 4 + 17;
  const quietZone = 4;
  const totalSize = size + quietZone * 2;

  const dataCodewords = encodeByteDataCodewords(payload, version, ecLevel);
  const allCodewords = interleaveBlocksAndEc(dataCodewords, version, ecLevel);

  // Build base matrix with function patterns
  const baseModules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  placeFunctionPatterns(baseModules, isFunction, version, size);
  placeDataBits(baseModules, isFunction, allCodewords, size);

  // Evaluate all 8 masks via ISO penalty rules 1..4
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(baseModules);
    applyDataMask(candidate, isFunction, size, mask);
    writeFormatInfo(candidate, size, ecLevel, mask);
    const penalty = computePenaltyScore(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  // Keep bestMask referenced cleanly (already baked into bestModules format bits)
  void bestMask;

  return {
    version,
    ecLevel,
    size,
    quietZone,
    totalSize,
    modules: bestModules,
    isSet(x, y) {
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      return bestModules[y * size + x] === 1;
    },
    isQuietSet(x, y) {
      if (x < quietZone || y < quietZone || x >= quietZone + size || y >= quietZone + size) {
        return false;
      }
      return bestModules[(y - quietZone) * size + (x - quietZone)] === 1;
    },
  };
}

/* ── Capacity & Codeword Helpers ─────────────────────────────────────────── */

function getTotalDataModules(version) {
  const size = version * 4 + 17;
  let total = size * size;
  total -= 3 * 64; // 3 finder patterns + 1px separators
  total -= 2 * (size - 16); // timing strips outside finders
  total -= 31; // format info (15 + 15 + dark module)
  if (version >= 7) total -= 36; // 2 * 18 version info modules
  if (version >= 2) {
    const k = ALIGNMENT_PATTERNS[version].length;
    total -= (k * k - 3) * 25 - 2 * (k - 2) * 5;
  }
  return total;
}

function getTotalCodewords(version) {
  return getTotalDataModules(version) >> 3;
}

function getDataCodewordCapacity(version, ecLevel) {
  const total = getTotalCodewords(version);
  const { ecPerBlock, numBlocks } = EC_CONFIG[ecLevel];
  return total - ecPerBlock[version] * numBlocks[version];
}

function findMinimumVersion(byteLen, ecLevel) {
  for (let v = 1; v <= 40; v++) {
    const dataCap = getDataCodewordCapacity(v, ecLevel);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const availDataBytes = Math.floor((dataCap * 8 - headerBits) / 8);
    if (byteLen <= availDataBytes) {
      return v;
    }
  }
  return -1;
}

function encodeByteDataCodewords(payload, version, ecLevel) {
  const dataCap = getDataCodewordCapacity(version, ecLevel);
  const ccBits = version <= 9 ? 8 : 16;

  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(payload.length, ccBits);
  for (let i = 0; i < payload.length; i++) {
    pushBits(payload[i], 8);
  }

  const maxBits = dataCap * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCap);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) {
      b = (b << 1) | bits[i + bit];
    }
    out[byteIdx++] = b;
  }

  let padToggle = 0;
  while (byteIdx < dataCap) {
    out[byteIdx++] = padToggle === 0 ? 0xEC : 0x11;
    padToggle ^= 1;
  }

  return out;
}

/* ── GF(256) Reed-Solomon & Interleaving ─────────────────────────────────── */

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(data, gen) {
  const ecCount = gen.length - 1;
  const buf = new Uint8Array(data.length + ecCount);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor !== 0) {
      for (let j = 1; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return buf.slice(data.length);
}

function interleaveBlocksAndEc(dataCodewords, version, ecLevel) {
  const totalCodewords = getTotalCodewords(version);
  const ecPerBlock = EC_CONFIG[ecLevel].ecPerBlock[version];
  const numBlocks = EC_CONFIG[ecLevel].numBlocks[version];

  const shortBlockDataLen = Math.floor(dataCodewords.length / numBlocks);
  const numLongBlocks = dataCodewords.length % numBlocks;
  const numShortBlocks = numBlocks - numLongBlocks;
  const gen = buildGeneratorPoly(ecPerBlock);

  const dataBlocks = new Array(numBlocks);
  const ecBlocks = new Array(numBlocks);

  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = shortBlockDataLen + (b >= numShortBlocks ? 1 : 0);
    const slice = dataCodewords.subarray(offset, offset + len);
    dataBlocks[b] = slice;
    ecBlocks[b] = computeRsRemainder(slice, gen);
    offset += len;
  }

  const result = new Uint8Array(totalCodewords);
  let outPos = 0;

  // Interleave data codewords across Group 1 and Group 2
  const maxDataLen = shortBlockDataLen + (numLongBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) {
        result[outPos++] = dataBlocks[b][i];
      }
    }
  }

  // Interleave EC codewords across all blocks
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result[outPos++] = ecBlocks[b][i];
    }
  }

  return result;
}

/* ── Matrix Function Patterns, Data Placement, BCH & Masking ─────────────── */

function setFnModule(modules, isFunction, size, x, y, dark) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = y * size + x;
  modules[idx] = dark ? 1 : 0;
  isFunction[idx] = 1;
}

function drawFinderWithSeparator(modules, isFunction, size, fx, fy) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = fx + dx;
      const y = fy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const dark = dist !== 2 && dist !== 4;
      setFnModule(modules, isFunction, size, x, y, dark);
    }
  }
}

function drawAlignment(modules, isFunction, size, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFnModule(modules, isFunction, size, cx + dx, cy + dy, dist !== 1);
    }
  }
}

function placeFunctionPatterns(modules, isFunction, version, size) {
  // Timing patterns (row 6, col 6)
  for (let i = 0; i < size; i++) {
    const dark = i % 2 === 0;
    setFnModule(modules, isFunction, size, i, 6, dark);
    setFnModule(modules, isFunction, size, 6, i, dark);
  }

  // 3 Finder patterns + separators
  drawFinderWithSeparator(modules, isFunction, size, 0, 0);
  drawFinderWithSeparator(modules, isFunction, size, size - 7, 0);
  drawFinderWithSeparator(modules, isFunction, size, 0, size - 7);

  // Alignment patterns
  const alignCoords = ALIGNMENT_PATTERNS[version];
  const lastIdx = alignCoords.length - 1;
  for (let iy = 0; iy < alignCoords.length; iy++) {
    for (let ix = 0; ix < alignCoords.length; ix++) {
      const overlapsTL = ix === 0 && iy === 0;
      const overlapsTR = ix === lastIdx && iy === 0;
      const overlapsBL = ix === 0 && iy === lastIdx;
      if (!overlapsTL && !overlapsTR && !overlapsBL) {
        drawAlignment(modules, isFunction, size, alignCoords[ix], alignCoords[iy]);
      }
    }
  }

  // Reserve Format Info areas (written per-mask later) + Dark Module at (x=8, y=4*V+9)
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFnModule(modules, isFunction, size, 8, i, false);
      setFnModule(modules, isFunction, size, i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFnModule(modules, isFunction, size, i, 8, false);
  }
  for (let i = size - 7; i < size; i++) {
    setFnModule(modules, isFunction, size, 8, i, false);
  }
  // Dark module at row = 4*version + 9, col = 8
  setFnModule(modules, isFunction, size, 8, 4 * version + 9, true);

  // 18-bit BCH Version Info (version >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      setFnModule(modules, isFunction, size, size - 11 + b, a, dark);
      setFnModule(modules, isFunction, size, a, size - 11 + b, dark);
    }
  }
}

function placeDataBits(modules, isFunction, codewords, size) {
  const totalBits = codewords.length * 8;
  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip timing column 6
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        const idx = y * size + x;
        if (isFunction[idx] === 0 && bitIdx < totalBits) {
          const byteVal = codewords[bitIdx >>> 3];
          const bitVal = (byteVal >>> (7 - (bitIdx & 7))) & 1;
          modules[idx] = bitVal;
          bitIdx += 1;
        }
      }
    }
    upward = !upward;
  }
}

function shouldFlipMask(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function applyDataMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) {
    const rowOff = y * size;
    for (let x = 0; x < size; x++) {
      const idx = rowOff + x;
      if (isFunction[idx] === 0 && shouldFlipMask(mask, x, y)) {
        modules[idx] ^= 1;
      }
    }
  }
}

function writeFormatInfo(modules, size, ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  // Copy 1 (around top-left finder)
  for (let i = 0; i <= 5; i++) {
    modules[i * size + 8] = (bits >>> i) & 1;
  }
  modules[7 * size + 8] = (bits >>> 6) & 1;
  modules[8 * size + 8] = (bits >>> 7) & 1;
  modules[8 * size + 7] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) {
    modules[8 * size + (14 - i)] = (bits >>> i) & 1;
  }

  // Copy 2 (top-right + bottom-left)
  for (let i = 0; i < 8; i++) {
    modules[8 * size + (size - 1 - i)] = (bits >>> i) & 1;
  }
  for (let i = 8; i < 15; i++) {
    modules[(size - 15 + i) * size + 8] = (bits >>> i) & 1;
  }
}

function computePenaltyScore(modules, size) {
  let penalty = 0;
  let darkCount = 0;

  // Rule 1 & Rule 3 along rows and columns
  for (let a = 0; a < size; a++) {
    let rowRunColor = -1;
    let rowRunLen = 0;
    let colRunColor = -1;
    let colRunLen = 0;

    for (let b = 0; b < size; b++) {
      const rowBit = modules[a * size + b];
      darkCount += rowBit;
      if (rowBit === rowRunColor) {
        rowRunLen += 1;
        if (rowRunLen === 5) penalty += 3;
        else if (rowRunLen > 5) penalty += 1;
      } else {
        rowRunColor = rowBit;
        rowRunLen = 1;
      }

      const colBit = modules[b * size + a];
      if (colBit === colRunColor) {
        colRunLen += 1;
        if (colRunLen === 5) penalty += 3;
        else if (colRunLen > 5) penalty += 1;
      } else {
        colRunColor = colBit;
        colRunLen = 1;
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 with 4 white modules before or after
    for (let b = 0; b <= size - 11; b++) {
      if (matchesFinderRule3(modules, a * size + b, 1)) penalty += 40;
      if (matchesFinderRule3(modules, b * size + a, size)) penalty += 40;
    }
  }

  // Rule 2: 2x2 blocks of identical color
  for (let y = 0; y < size - 1; y++) {
    const r0 = y * size;
    const r1 = r0 + size;
    for (let x = 0; x < size - 1; x++) {
      const c = modules[r0 + x];
      if (c === modules[r0 + x + 1] && c === modules[r1 + x] && c === modules[r1 + x + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 4: dark module balance deviation from 50% in 5% steps
  const total = size * size;
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
  penalty += k * 10;

  return penalty;
}

const RULE3_FWD = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const RULE3_REV = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function matchesFinderRule3(modules, start, stride) {
  let fwd = true;
  let rev = true;
  for (let i = 0; i < 11; i++) {
    const bit = modules[start + i * stride];
    if (bit !== RULE3_FWD[i]) fwd = false;
    if (bit !== RULE3_REV[i]) rev = false;
    if (!fwd && !rev) return false;
  }
  return true;
}
