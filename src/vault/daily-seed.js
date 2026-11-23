const PALETTE_IDS = ['classic16', 'sakura', 'matcha', 'amber', 'frost80'];
const SCALE_IDS = ['pentatonic', 'dorian', 'lydian', 'hirajoshi', 'lofiMaj9'];
const PRIMARY_VERBS = ['slingshot', 'springDrag', 'tapRipple', 'ribbonSlice', 'bezelWheel'];

/**
 * Deterministic 32-bit Mulberry32 PRNG returning floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Formats a Date (or timestamp) into a canonical UTC YYYY-MM-DD string.
 * @param {Date|number|string} [date]
 * @returns {string}
 */
export function getTodayUtcString(date) {
  const d = date === undefined || date === null
    ? new Date()
    : (date instanceof Date ? date : new Date(date));
  if (Number.isNaN(d.getTime())) {
    throw new RangeError('Invalid date passed to getTodayUtcString');
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Deterministically hashes a UTC YYYY-MM-DD string into an unsigned 32-bit integer seed.
 * Uses FNV-1a with avalanche mixing so consecutive dates diverge cleanly.
 * @param {string} [utcDateStr]
 * @returns {number}
 */
export function hashDateSeed(utcDateStr) {
  const normalized = typeof utcDateStr === 'string' && utcDateStr.trim()
    ? utcDateStr.trim()
    : getTodayUtcString();
  const key = `BITFORGE80:${normalized}`;
  let h = 0x811C9DC5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Murmur3 fmix32 finalizer for strong bit dispersion
  h ^= h >>> 16;
  h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function hslToRgb(hDeg, sat, light) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sat));
  const l = Math.max(0, Math.min(1, light));
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255)
  ];
}

function generateDailyPaletteRgb(rng) {
  const rgb = new Uint8Array(48);
  const baseHue = Math.floor(rng() * 360);
  const complementHue = (baseHue + 135 + Math.floor(rng() * 70)) % 360;
  const accentHue = (baseHue + 240 + Math.floor(rng() * 45)) % 360;

  const setColor = (idx, r, g, b) => {
    const off = idx * 3;
    rgb[off] = Math.max(0, Math.min(255, r | 0));
    rgb[off + 1] = Math.max(0, Math.min(255, g | 0));
    rgb[off + 2] = Math.max(0, Math.min(255, b | 0));
  };

  // Index 0: deep chassis void (transparent index in sprites)
  setColor(0, 18, 19, 26);
  // Index 1: dark outline ink
  setColor(1, ...hslToRgb(baseHue, 0.28, 0.14));

  // Indices 2..5: primary 4-step luminance ramp
  const primaryLights = [0.28, 0.44, 0.62, 0.80];
  for (let i = 0; i < 4; i++) {
    setColor(2 + i, ...hslToRgb(baseHue + (i - 1) * 4, 0.68 - i * 0.04, primaryLights[i]));
  }

  // Indices 6..9: secondary complementary 4-step ramp
  const secLights = [0.26, 0.42, 0.60, 0.78];
  for (let i = 0; i < 4; i++) {
    setColor(6 + i, ...hslToRgb(complementHue + i * 5, 0.64, secLights[i]));
  }

  // Indices 10..13: vibrant accent ramp
  const accLights = [0.32, 0.50, 0.68, 0.84];
  for (let i = 0; i < 4; i++) {
    setColor(10 + i, ...hslToRgb(accentHue - i * 4, 0.78, accLights[i]));
  }

  // Index 14 & 15: cool mist & warm cream specular highlights
  setColor(14, ...hslToRgb(complementHue, 0.25, 0.87));
  setColor(15, ...hslToRgb((baseHue + 40) % 360, 0.35, 0.94));

  return rgb;
}

function generateSymmetricMysterySprite8x8(rng, variantIdx) {
  const px = new Uint8Array(64);
  const darkCol = 1;
  const bodyBase = variantIdx === 0 ? 3 : (variantIdx === 1 ? 7 : 11);
  const bodyHi = bodyBase + 2;
  const eyeCol = 15;
  const accentCol = variantIdx === 0 ? 12 : (variantIdx === 1 ? 4 : 8);

  // Build symmetric silhouette inside rows 1..6, cols 1..3 (mirrored to 4..6)
  for (let y = 1; y <= 6; y++) {
    const rowBias = y >= 2 && y <= 5 ? 0.68 : 0.35;
    for (let x = 1; x <= 3; x++) {
      const centerBias = x >= 2 ? 0.18 : 0;
      if (rng() < rowBias + centerBias) {
        const col = y <= 2 ? bodyHi : (rng() < 0.22 ? accentCol : bodyBase);
        px[y * 8 + x] = col;
        px[y * 8 + (7 - x)] = col;
      }
    }
  }

  // Guarantee non-empty core body so sprites are never degenerate
  for (let y = 2; y <= 5; y++) {
    px[y * 8 + 3] = px[y * 8 + 3] || bodyBase;
    px[y * 8 + 4] = px[y * 8 + 4] || bodyBase;
  }
  px[3 * 8 + 2] = px[3 * 8 + 2] || bodyBase;
  px[3 * 8 + 5] = px[3 * 8 + 5] || bodyBase;

  // Apply symmetric dark outline on empty cardinal neighbors
  const outline = new Uint8Array(px);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      if (px[y * 8 + x] !== 0) continue;
      const hasNeighbor =
        (x > 0 && px[y * 8 + (x - 1)] !== 0) ||
        (x < 7 && px[y * 8 + (x + 1)] !== 0) ||
        (y > 0 && px[(y - 1) * 8 + x] !== 0) ||
        (y < 7 && px[(y + 1) * 8 + x] !== 0);
      if (hasNeighbor) {
        outline[y * 8 + x] = darkCol;
        outline[y * 8 + (7 - x)] = darkCol;
      }
    }
  }

  // Crisp bright eye/core pair on row 3
  outline[3 * 8 + 2] = eyeCol;
  outline[3 * 8 + 5] = eyeCol;
  return outline;
}

/**
 * Generates the deterministic daily visual/audio specification for a UTC date.
 * @param {string} [utcDateStr]
 * @returns {{ utcDate: string, seed: number, paletteRgb: Uint8Array, scaleId: string, sprites8x8: Uint8Array[] }}
 */
export function generateDailySeedSpec(utcDateStr) {
  const utcDate = typeof utcDateStr === 'string' && utcDateStr.trim()
    ? utcDateStr.trim()
    : getTodayUtcString();
  const seed = hashDateSeed(utcDate);
  const rng = mulberry32(seed);
  const paletteRgb = generateDailyPaletteRgb(rng);
  const scaleId = SCALE_IDS[Math.floor(rng() * SCALE_IDS.length)];
  const sprites8x8 = [
    generateSymmetricMysterySprite8x8(rng, 0),
    generateSymmetricMysterySprite8x8(rng, 1),
    generateSymmetricMysterySprite8x8(rng, 2)
  ];

  return {
    utcDate,
    seed,
    paletteRgb,
    scaleId,
    sprites8x8
  };
}

function parseDeterministicUtcEpoch(utcDate, seed) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) {
    const parsed = Date.parse(`${utcDate}T00:00:00.000Z`);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 1700000000000 + (seed % 86400000);
}

/**
 * Generates a complete, schema-valid daily CartridgeROM from a UTC YYYY-MM-DD date.
 * @param {string} [utcDateStr]
 * @returns {object} CartridgeROM matching SPEC.md Section 2
 */
export function generateDailyCartridgeROM(utcDateStr) {
  const spec = generateDailySeedSpec(utcDateStr);
  const rng = mulberry32(spec.seed ^ 0x9E3779B9);

  const paletteId = PALETTE_IDS[Math.floor(rng() * PALETTE_IDS.length)];
  const primaryVerb = PRIMARY_VERBS[Math.floor(rng() * PRIMARY_VERBS.length)];
  const updatedAt = parseDeterministicUtcEpoch(spec.utcDate, spec.seed);

  const sprites = Array.from({ length: 32 }, (_, idx) => {
    if (idx < 3) {
      return {
        size: 8,
        frames: [new Uint8Array(spec.sprites8x8[idx])]
      };
    }
    return {
      size: 8,
      frames: [new Uint8Array(64)]
    };
  });

  // Build 16x16 starter world (0=empty, 1=stone, 2=moss, 3=cliff, 4=water, 5=ember, 6=reeds, 7=crystal)
  const w = 16;
  const h = 16;
  const total = w * h;
  const bgLayer = new Uint8Array(total);
  const mainLayer = new Uint8Array(total);
  const fgLayer = new Uint8Array(total);
  const collision = new Uint8Array(total);

  const floorTerrain = rng() < 0.5 ? 2 : 4; // Moss or Water backdrop
  const borderTerrain = rng() < 0.5 ? 1 : 3; // Stone or Cliff frame
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const isBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if ((x + y) % 3 === 0 || rng() < 0.25) {
        bgLayer[idx] = floorTerrain;
      }
      if (isBorder) {
        mainLayer[idx] = borderTerrain;
        collision[idx] = 1; // solid
      } else if (x > 2 && x < w - 3 && y > 2 && y < h - 3 && rng() < 0.10) {
        const isBounce = rng() < 0.5;
        mainLayer[idx] = isBounce ? 7 : 1; // crystal bounce or stone pillar
        collision[idx] = isBounce ? 2 : 1;
      } else if (!isBorder && rng() < 0.06) {
        fgLayer[idx] = rng() < 0.5 ? 6 : 5; // reeds or ember accent
      }
    }
  }

  // Gentle 4-channel 16-step starter audio
  const bpm = 86 + Math.floor(rng() * 34); // 86..119 (within 70..180)
  const ch1 = new Uint16Array(16);
  const ch2 = new Uint16Array(16);
  const ch3 = new Uint16Array(16);
  const ch4 = new Uint16Array(16);

  const melodySteps = [0, 2, 4, 7, 8, 10, 12, 14];
  for (const step of melodySteps) {
    if (rng() < 0.78) {
      const row = 4 + Math.floor(rng() * 8); // rows 4..11
      ch1[step] = 1 << row;
    }
  }
  for (let step = 0; step < 16; step += 4) {
    const bassRow = Math.floor(rng() * 4);
    ch2[step] = 1 << bassRow;
  }
  for (let step = 2; step < 16; step += 4) {
    ch3[step] = 1 << (12 + Math.floor(rng() * 3));
  }
  ch4[0] = 1 << (6 + Math.floor(rng() * 5));
  ch4[8] = 1 << (6 + Math.floor(rng() * 5));

  const channels = [
    { steps: ch1, dutyOrTimbre: 128, volume: 65 },
    { steps: ch2, dutyOrTimbre: 64, volume: 70 },
    { steps: ch3, dutyOrTimbre: 96, volume: 32 },
    { steps: ch4, dutyOrTimbre: 160, volume: 55 }
  ];

  // Smooth 32-sample custom wavetable (values 0..15)
  const wavetable32 = new Uint8Array(32);
  const harmonic = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < 32; i++) {
    const phase = (i / 32) * Math.PI * 2;
    const sample = 0.5 + 0.36 * Math.sin(phase) + 0.14 * Math.sin(phase * harmonic);
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(sample * 15)));
  }

  const sfxPatches = Array.from({ length: 8 }, (_, archetype) => ({
    archetype,
    x: 64 + Math.floor(rng() * 140),
    y: 56 + Math.floor(rng() * 140)
  }));

  return {
    magic: 'BF80',
    version: 1,
    meta: {
      id: `daily-${spec.utcDate}`,
      title: `DAILY ${spec.utcDate}`.slice(0, 24),
      author: 'BITFORGE-80',
      paletteId,
      customPalette: new Uint8Array(spec.paletteRgb),
      coverSpriteIdx: 0,
      primaryVerb,
      dropShadow1px: true,
      crtOptics: false,
      updatedAt
    },
    sprites,
    world: {
      width: w,
      height: h,
      bgLayer,
      mainLayer,
      fgLayer,
      collision
    },
    audio: {
      bpm,
      scaleId: spec.scaleId,
      channels,
      wavetable32,
      sfxPatches
    },
    logic: {
      presetGameId: null,
      ruleChips: [
        {
          id: 'daily-tap',
          trigger: 'onTap',
          paramA: 0,
          action: 'playSfx',
          paramB: 0,
          sfxSlot: 0
        },
        {
          id: 'daily-bounce',
          trigger: 'onBounce',
          paramA: 1,
          action: 'emitParticles',
          paramB: 6,
          sfxSlot: 1
        }
      ],
      customJs: ''
    }
  };
}
