/**
 * BitForge-80 Boutique 16-Color Palettes & 4-Step Luminance Ramps
 * Index 0 is reserved for dark chassis background / transparent sprite pixels.
 */

export const PALETTE_ORDER = Object.freeze([
  'classic16',
  'sakura',
  'matcha',
  'amber',
  'frost80',
]);

const PALETTE_DEFS = {
  classic16: {
    id: 'classic16',
    name: 'BitForge Classic-16',
    hex: [
      '#12131a', '#1f2436', '#3b4363', '#7c86a8',
      '#e8ecf5', '#ff4f6e', '#ff944d', '#f6c453',
      '#a6e25a', '#3ac98c', '#38b6ff', '#4f6eff',
      '#9c5cff', '#ff7ad9', '#9e5a47', '#f2c6a0',
    ],
  },
  sakura: {
    id: 'sakura',
    name: 'Sakura Risograph',
    hex: [
      '#12131a', '#25192a', '#4a2e4d', '#8c5f7e',
      '#f7eef2', '#e63e6d', '#ff7b6b', '#f7c566',
      '#8ec96e', '#46a89b', '#6dc2e8', '#4c69b5',
      '#a46cd4', '#ff9ec4', '#9e5352', '#f8d7cb',
    ],
  },
  matcha: {
    id: 'matcha',
    name: 'Matcha Phosphor',
    hex: [
      '#111613', '#1c2921', '#304a39', '#5d8566',
      '#e7f5dc', '#e85f5c', '#f09a48', '#e8d568',
      '#9fe05a', '#4bc78e', '#6be3d4', '#3b879c',
      '#8c78c9', '#e88eb2', '#7a5c43', '#cfe0b4',
    ],
  },
  amber: {
    id: 'amber',
    name: 'Obsidian Amber',
    hex: [
      '#121110', '#241c14', '#45311c', '#7d562d',
      '#fff1cc', '#ff4d2e', '#ff881a', '#ffb833',
      '#b8c443', '#5ea373', '#78bfd1', '#47688a',
      '#b568a6', '#ff8f73', '#8a4424', '#f5d38c',
    ],
  },
  frost80: {
    id: 'frost80',
    name: 'Frost-80',
    hex: [
      '#12131a', '#1b2538', '#2e4161', '#5d7da8',
      '#eef6ff', '#ff5c7c', '#ff9b70', '#f5d76e',
      '#8ae88a', '#3ad6b8', '#5ce1ff', '#4980eb',
      '#9e8cff', '#e89cff', '#7a6473', '#c9e4ff',
    ],
  },
};

function clampByte(v) {
  const n = Number(v) | 0;
  return n < 0 ? 0 : (n > 255 ? 255 : n);
}

function byteToHex(b) {
  return clampByte(b).toString(16).padStart(2, '0');
}

function parseHexToRgb(hexStr) {
  const clean = String(hexStr || '#12131a').trim().replace(/^#/, '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16) || 0,
      parseInt(clean[1] + clean[1], 16) || 0,
      parseInt(clean[2] + clean[2], 16) || 0,
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

function computeLuminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Build a 4-step luminance-ordered shadeMap and highlightMap over paintable colors 1..15.
 * Index 0 stays mapped to 0 so shading/highlighting never corrupts transparent sprite pixels.
 * @param {Uint8Array} rgb
 * @param {Float32Array} luminance
 * @returns {{ shadeMap: Uint8Array, highlightMap: Uint8Array }}
 */
function buildLuminanceRamps(rgb, luminance) {
  const shadeMap = new Uint8Array(16);
  const highlightMap = new Uint8Array(16);
  shadeMap[0] = 0;
  highlightMap[0] = 0;

  const sorted = [];
  for (let i = 1; i < 16; i++) {
    sorted.push(i);
  }
  sorted.sort((a, b) => (luminance[a] - luminance[b]) || (a - b));

  const minLum = luminance[sorted[0]];
  const maxLum = luminance[sorted[sorted.length - 1]];
  const lumRange = maxLum - minLum;
  const stepDelta = lumRange > 1e-4 ? lumRange / 4 : 0;

  // Chroma-aware distance normalized against max Euclidean RGB distance (441.67)
  const colorDist = (a, b) => {
    const ar = rgb[a * 3];
    const ag = rgb[a * 3 + 1];
    const ab = rgb[a * 3 + 2];
    const br = rgb[b * 3];
    const bg = rgb[b * 3 + 1];
    const bb = rgb[b * 3 + 2];
    // Compare hue/chroma differences by centering each RGB triplet around its own mean
    const am = (ar + ag + ab) / 3;
    const bm = (br + bg + bb) / 3;
    const dr = (ar - am) - (br - bm);
    const dg = (ag - am) - (bg - bm);
    const db = (ab - am) - (bb - bm);
    return Math.sqrt(dr * dr + dg * dg + db * db) / 442;
  };

  // Build shadeMap bottom-up so every color converges to darkest in <= 4 steps
  const shadeDepth = new Uint8Array(16);
  shadeMap[sorted[0]] = sorted[0];
  shadeDepth[sorted[0]] = 0;

  for (let p = 1; p < sorted.length; p++) {
    const idx = sorted[p];
    const curLum = luminance[idx];
    const targetLum = Math.max(minLum, curLum - stepDelta);

    let bestCand = -1;
    let bestScore = Infinity;

    for (let q = 0; q < p; q++) {
      const cand = sorted[q];
      if (luminance[cand] >= curLum - 1e-5) continue;
      if (shadeDepth[cand] > 3) continue;
      const lumDiff = Math.abs(luminance[cand] - targetLum);
      const score = lumDiff + 0.18 * colorDist(idx, cand);
      if (score < bestScore) {
        bestScore = score;
        bestCand = cand;
      }
    }

    if (bestCand === -1) {
      shadeMap[idx] = idx;
      shadeDepth[idx] = 0;
    } else {
      shadeMap[idx] = bestCand;
      shadeDepth[idx] = shadeDepth[bestCand] + 1;
    }
  }

  // Build highlightMap top-down so every color converges to brightest in <= 4 steps
  const highlightDepth = new Uint8Array(16);
  const topIdx = sorted[sorted.length - 1];
  highlightMap[topIdx] = topIdx;
  highlightDepth[topIdx] = 0;

  for (let p = sorted.length - 2; p >= 0; p--) {
    const idx = sorted[p];
    const curLum = luminance[idx];
    const targetLum = Math.min(maxLum, curLum + stepDelta);

    let bestCand = -1;
    let bestScore = Infinity;

    for (let q = sorted.length - 1; q > p; q--) {
      const cand = sorted[q];
      if (luminance[cand] <= curLum + 1e-5) continue;
      if (highlightDepth[cand] > 3) continue;
      const lumDiff = Math.abs(luminance[cand] - targetLum);
      const score = lumDiff + 0.18 * colorDist(idx, cand);
      if (score < bestScore) {
        bestScore = score;
        bestCand = cand;
      }
    }

    if (bestCand === -1) {
      highlightMap[idx] = idx;
      highlightDepth[idx] = 0;
    } else {
      highlightMap[idx] = bestCand;
      highlightDepth[idx] = highlightDepth[bestCand] + 1;
    }
  }

  return { shadeMap, highlightMap };
}

function compilePaletteFromRgb(id, name, rgbSource) {
  const rgb = new Uint8Array(48);
  const hex = new Array(16);
  const rgba32 = new Uint32Array(16);
  const luminance = new Float32Array(16);

  for (let i = 0; i < 16; i++) {
    const r = clampByte(rgbSource[i * 3]);
    const g = clampByte(rgbSource[i * 3 + 1]);
    const b = clampByte(rgbSource[i * 3 + 2]);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    hex[i] = `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
    rgba32[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    luminance[i] = computeLuminance(r, g, b);
  }

  const { shadeMap, highlightMap } = buildLuminanceRamps(rgb, luminance);

  return Object.freeze({
    id,
    name,
    hex: Object.freeze(hex),
    rgb,
    rgba32,
    luminance,
    shadeMap,
    highlightMap,
  });
}

function compilePaletteFromHexList(def) {
  const rgb = new Uint8Array(48);
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = parseHexToRgb(def.hex[i]);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return compilePaletteFromRgb(def.id, def.name, rgb);
}

export const PALETTES = Object.freeze({
  classic16: compilePaletteFromHexList(PALETTE_DEFS.classic16),
  sakura: compilePaletteFromHexList(PALETTE_DEFS.sakura),
  matcha: compilePaletteFromHexList(PALETTE_DEFS.matcha),
  amber: compilePaletteFromHexList(PALETTE_DEFS.amber),
  frost80: compilePaletteFromHexList(PALETTE_DEFS.frost80),
});

/**
 * Retrieve a pre-computed palette by ID, optionally overridden with custom 48-byte RGB data.
 * @param {string} [paletteId='classic16']
 * @param {Uint8Array|number[]|null} [customPaletteBytes=null]
 */
export function getPalette(paletteId = 'classic16', customPaletteBytes = null) {
  const normalizedId = typeof paletteId === 'string' && Object.prototype.hasOwnProperty.call(PALETTES, paletteId)
    ? paletteId
    : 'classic16';
  const base = PALETTES[normalizedId];

  if (
    customPaletteBytes &&
    typeof customPaletteBytes.length === 'number' &&
    customPaletteBytes.length >= 48
  ) {
    return compilePaletteFromRgb(normalizedId, `${base.name} (Custom)`, customPaletteBytes);
  }

  return base;
}
