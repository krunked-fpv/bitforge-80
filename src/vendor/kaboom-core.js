/**
 * BitForge-80 Self-Contained 60 FPS 128x128 Kaboom-Compatible Kernel
 * Zero external dependencies, fixed-timestep accumulator, 512-slot TypedArray particle pool.
 */

const WIDTH = 128;
const HEIGHT = 128;
const PIXEL_COUNT = WIDTH * HEIGHT;
const FIXED_DT = 1 / 60;
const PARTICLE_POOL_SIZE = 512;
const DUST_MOTE_COUNT = 16;

// 4x4 Bayer threshold matrix (0..15) for crisp ordered dither opacity
const BAYER_4X4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

// Default 16-color palette fallback (classic16) so zero external imports are required
const DEFAULT_PALETTE_HEX = Object.freeze([
  '#12131a', '#1f2436', '#3b4363', '#7c86a8',
  '#e8ecf5', '#ff4f6e', '#ff944d', '#f6c453',
  '#a6e25a', '#3ac98c', '#38b6ff', '#4f6eff',
  '#9c5cff', '#ff7ad9', '#9e5a47', '#f2c6a0',
]);

// Compact crisp 5x7 bitmap pixel font covering ASCII 32..126 (5 bits wide per row, 7 rows)
const FONT_5X7 = Object.freeze({
  32: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // ' '
  33: [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04], // '!'
  34: [0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00], // '"'
  35: [0x0A, 0x1F, 0x0A, 0x0A, 0x1F, 0x0A, 0x00], // '#'
  36: [0x04, 0x0F, 0x14, 0x0E, 0x05, 0x1E, 0x04], // '$'
  37: [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03], // '%'
  38: [0x08, 0x14, 0x14, 0x08, 0x15, 0x12, 0x0D], // '&'
  39: [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00], // "'"
  40: [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], // '('
  41: [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], // ')'
  42: [0x04, 0x15, 0x0E, 0x1F, 0x0E, 0x15, 0x04], // '*'
  43: [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00], // '+'
  44: [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08], // ','
  45: [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00], // '-'
  46: [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x04], // '.'
  47: [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10], // '/'
  48: [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], // '0'
  49: [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E], // '1'
  50: [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], // '2'
  51: [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E], // '3'
  52: [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], // '4'
  53: [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E], // '5'
  54: [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], // '6'
  55: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], // '7'
  56: [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], // '8'
  57: [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C], // '9'
  58: [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00], // ':'
  59: [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x08], // ';'
  60: [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02], // '<'
  61: [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00], // '='
  62: [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], // '>'
  63: [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04], // '?'
  64: [0x0E, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0E], // '@'
  65: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], // 'A'
  66: [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E], // 'B'
  67: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], // 'C'
  68: [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E], // 'D'
  69: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], // 'E'
  70: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10], // 'F'
  71: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F], // 'G'
  72: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], // 'H'
  73: [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], // 'I'
  74: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C], // 'J'
  75: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], // 'K'
  76: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F], // 'L'
  77: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], // 'M'
  78: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11], // 'N'
  79: [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], // 'O'
  80: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10], // 'P'
  81: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D], // 'Q'
  82: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11], // 'R'
  83: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E], // 'S'
  84: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], // 'T'
  85: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], // 'U'
  86: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04], // 'V'
  87: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11], // 'W'
  88: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11], // 'X'
  89: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04], // 'Y'
  90: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F], // 'Z'
  91: [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E], // '['
  92: [0x10, 0x10, 0x08, 0x04, 0x02, 0x01, 0x01], // '\'
  93: [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E], // ']'
  94: [0x04, 0x0A, 0x11, 0x00, 0x00, 0x00, 0x00], // '^'
  95: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F], // '_'
  96: [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00], // '`'
  97: [0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F], // 'a'
  98: [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x1E], // 'b'
  99: [0x00, 0x00, 0x0E, 0x10, 0x10, 0x11, 0x0E], // 'c'
  100: [0x01, 0x01, 0x0F, 0x11, 0x11, 0x11, 0x0F], // 'd'
  101: [0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E], // 'e'
  102: [0x06, 0x08, 0x1C, 0x08, 0x08, 0x08, 0x08], // 'f'
  103: [0x00, 0x0F, 0x11, 0x11, 0x0F, 0x01, 0x0E], // 'g'
  104: [0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x11], // 'h'
  105: [0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E], // 'i'
  106: [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C], // 'j'
  107: [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12], // 'k'
  108: [0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], // 'l'
  109: [0x00, 0x00, 0x1A, 0x15, 0x15, 0x11, 0x11], // 'm'
  110: [0x00, 0x00, 0x1E, 0x11, 0x11, 0x11, 0x11], // 'n'
  111: [0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E], // 'o'
  112: [0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10], // 'p'
  113: [0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x01], // 'q'
  114: [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10], // 'r'
  115: [0x00, 0x00, 0x0F, 0x10, 0x0E, 0x01, 0x1E], // 's'
  116: [0x08, 0x08, 0x1C, 0x08, 0x08, 0x09, 0x06], // 't'
  117: [0x00, 0x00, 0x11, 0x11, 0x11, 0x11, 0x0F], // 'u'
  118: [0x00, 0x00, 0x11, 0x11, 0x11, 0x0A, 0x04], // 'v'
  119: [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0A], // 'w'
  120: [0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11], // 'x'
  121: [0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E], // 'y'
  122: [0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F], // 'z'
  123: [0x06, 0x08, 0x08, 0x10, 0x08, 0x08, 0x06], // '{'
  124: [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], // '|'
  125: [0x0C, 0x02, 0x02, 0x01, 0x02, 0x02, 0x0C], // '}'
  126: [0x08, 0x15, 0x02, 0x00, 0x00, 0x00, 0x00], // '~'
});

function parseHexColor(hex) {
  if (typeof hex !== 'string') return null;
  let clean = hex.trim();
  if (clean.startsWith('#')) clean = clean.slice(1);
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return Number.isNaN(r + g + b) ? null : [r, g, b];
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : [r, g, b];
  }
  return null;
}

function packColorDescriptor(c, g, b) {
  if (typeof c === 'number' && g === undefined) {
    const idx = Math.max(0, Math.min(15, c | 0));
    return { kind: 'index', index: idx, r: 0, g: 0, b: 0, customPacked: 0 };
  }
  if (typeof c === 'string') {
    const parsed = parseHexColor(c);
    if (parsed) {
      const [pr, pg, pb] = parsed;
      return {
        kind: 'rgb',
        index: -1,
        r: pr,
        g: pg,
        b: pb,
        customPacked: (0xff << 24) | (pb << 16) | (pg << 8) | pr,
      };
    }
  }
  if (typeof c === 'number' && typeof g === 'number' && typeof b === 'number') {
    const cr = Math.max(0, Math.min(255, c | 0));
    const cg = Math.max(0, Math.min(255, g | 0));
    const cb = Math.max(0, Math.min(255, b | 0));
    return {
      kind: 'rgb',
      index: -1,
      r: cr,
      g: cg,
      b: cb,
      customPacked: (0xff << 24) | (cb << 16) | (cg << 8) | cr,
    };
  }
  if (c && typeof c === 'object') {
    if (c.kind === 'index' || c.kind === 'rgb') return c;
    if (typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
      return packColorDescriptor(c.r, c.g, c.b);
    }
  }
  return { kind: 'index', index: 4, r: 0, g: 0, b: 0, customPacked: 0 };
}

function aabbOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function drawDefaultTerrainTile(terrainId, tx, ty, animTick, drawFn) {
  // Crisp built-in 8x8 fallback patterns for terrain IDs 1..7 when no external autotiler is supplied
  const baseX = tx * 8;
  const baseY = ty * 8;
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      let col = 0;
      const hash = ((tx * 7 + px) * 31 + (ty * 13 + py) * 17) & 15;
      if (terrainId === 1) {
        // STONE
        const edge = px === 0 || py === 0 || px === 7 || py === 7;
        col = edge ? 2 : (hash < 3 ? 3 : 2);
        if (py === 0 && px < 7) col = 3;
      } else if (terrainId === 2) {
        // MOSS
        col = py < 2 ? 8 : (hash < 4 ? 9 : 8);
        if (py === 7) col = 2;
      } else if (terrainId === 3) {
        // CLIFF
        col = py < 2 ? 15 : (px % 4 === 0 ? 2 : 14);
      } else if (terrainId === 4) {
        // WATER (animated ripple)
        const wave = ((px + py + ((animTick >> 3) & 7)) & 7) === 0;
        col = wave ? 4 : (((px + ((animTick >> 4) & 3)) & 3) === 0 ? 10 : 11);
      } else if (terrainId === 5) {
        // EMBER (animated glow)
        const pulse = ((px * 3 + py * 5 + (animTick >> 2)) & 7) === 0;
        col = pulse ? 7 : ((hash & 1) ? 5 : 6);
      } else if (terrainId === 6) {
        // REEDS
        const sway = ((animTick >> 4) & 1) === 0 ? 0 : 1;
        col = (px === (2 + sway) || px === (5 - sway)) && py > 1 ? 8 : 9;
        if (py > 5) col = 14;
      } else if (terrainId === 7) {
        // CRYSTAL
        const diag = Math.abs(px - 3.5) + Math.abs(py - 3.5);
        col = diag < 2 ? 4 : (diag < 3.5 ? 10 : 12);
      } else {
        col = ((terrainId % 15) + 1);
      }
      if (col > 0) drawFn(baseX + px, baseY + py, col);
    }
  }
}

/**
 * Create a 60 FPS Kaboom-compatible 128x128 runtime kernel.
 * @param {object} [opts]
 */
export function kaboom(opts = {}) {
  const dropShadowDefault = opts.dropShadow1px !== undefined ? Boolean(opts.dropShadow1px) : true;
  const dustMotesEnabled = opts.dustMotes !== undefined ? Boolean(opts.dustMotes) : true;
  let globalGravity = typeof opts.gravity === 'number' ? opts.gravity : 0;
  let clearColorIndex = typeof opts.clearColor === 'number' ? (opts.clearColor & 15) : 0;

  // Framebuffer layers: zero per-frame allocations
  const fbIndex = new Uint8Array(PIXEL_COUNT);
  const fbLayer = new Uint8Array(PIXEL_COUNT); // 0=bg, 1=world-bg, 2=fg/entity
  const fbCustomRgb = new Uint32Array(PIXEL_COUNT);
  const renderBuffer = new Uint8ClampedArray(PIXEL_COUNT * 4);

  // Palette cache (48 bytes RGB + 16 shadow indices)
  const defaultRgb = new Uint8Array(48);
  for (let i = 0; i < 16; i++) {
    const parsed = parseHexColor(DEFAULT_PALETTE_HEX[i]) || [0, 0, 0];
    defaultRgb[i * 3] = parsed[0];
    defaultRgb[i * 3 + 1] = parsed[1];
    defaultRgb[i * 3 + 2] = parsed[2];
  }
  let cachedPaletteRef = null;
  const activePaletteRgb = new Uint8Array(defaultRgb);

  // ImageData cache keyed to canvas 2D context reference
  let cachedCtx = null;
  let cachedImageData = null;
  const fallbackImageData = { width: WIDTH, height: HEIGHT, data: renderBuffer };

  // Pre-allocated 512-slot TypedArray particle pool (struct of arrays)
  const pActive = new Uint8Array(PARTICLE_POOL_SIZE);
  const pX = new Float32Array(PARTICLE_POOL_SIZE);
  const pY = new Float32Array(PARTICLE_POOL_SIZE);
  const pVx = new Float32Array(PARTICLE_POOL_SIZE);
  const pVy = new Float32Array(PARTICLE_POOL_SIZE);
  const pAx = new Float32Array(PARTICLE_POOL_SIZE);
  const pAy = new Float32Array(PARTICLE_POOL_SIZE);
  const pLife = new Float32Array(PARTICLE_POOL_SIZE);
  const pMaxLife = new Float32Array(PARTICLE_POOL_SIZE);
  const pColor = new Uint8Array(PARTICLE_POOL_SIZE);
  const pSize = new Uint8Array(PARTICLE_POOL_SIZE);
  const pDrag = new Float32Array(PARTICLE_POOL_SIZE);
  let pRingCursor = 0;
  let pActiveCount = 0;
  let pPeakActive = 0;
  let pTotalEmitted = 0;
  let pOverflowRecycled = 0;

  // Pre-allocated floating 1px ambient dust motes
  const dustX = new Float32Array(DUST_MOTE_COUNT);
  const dustY = new Float32Array(DUST_MOTE_COUNT);
  const dustVx = new Float32Array(DUST_MOTE_COUNT);
  const dustVy = new Float32Array(DUST_MOTE_COUNT);
  const dustPhase = new Float32Array(DUST_MOTE_COUNT);
  let rngState = (typeof opts.seed === 'number' && (opts.seed >>> 0) !== 0)
    ? (opts.seed >>> 0)
    : 0x5f3759df;

  function nextRand() {
    let x = rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    rngState = x >>> 0;
    return rngState / 4294967296;
  }

  for (let i = 0; i < DUST_MOTE_COUNT; i++) {
    dustX[i] = nextRand() * WIDTH;
    dustY[i] = nextRand() * HEIGHT;
    dustVx[i] = (nextRand() - 0.5) * 4;
    dustVy[i] = -1.5 - nextRand() * 3.5;
    dustPhase[i] = nextRand() * Math.PI * 2;
  }

  // Simulation state
  let accumulator = 0;
  let tickCount = 0;
  let frameCount = 0;
  let simTime = 0;
  let trauma = 0;
  let shakeOffsetX = 0;
  let shakeOffsetY = 0;
  let hitStopFrames = 0;
  let nextEntityId = 1;
  let spriteBank = Array.isArray(opts.sprites) ? opts.sprites : [];

  // Scene & entity registries
  const scenes = new Map();
  let currentSceneName = 'main';
  const entities = [];
  const updateHandlers = []; // { tag, fn, active }
  const drawHandlers = [];   // { tag, fn, active }
  const collideHandlers = []; // { tagA, tagB, fn, active }

  // Reusable scratch lists to eliminate per-frame allocations
  const scratchUpdate = [];
  const scratchDraw = [];
  const scratchCollide = [];

  function resolvePaletteCache(palette) {
    if (!palette) {
      if (cachedPaletteRef !== null) {
        activePaletteRgb.set(defaultRgb);
        cachedPaletteRef = null;
      }
      return;
    }
    if (palette === cachedPaletteRef) return;
    cachedPaletteRef = palette;
    if (palette.rgb && palette.rgb.length >= 48) {
      activePaletteRgb.set(palette.rgb.subarray(0, 48));
      return;
    }
    if (Array.isArray(palette.hex) && palette.hex.length >= 16) {
      for (let i = 0; i < 16; i++) {
        const parsed = parseHexColor(palette.hex[i]);
        if (parsed) {
          activePaletteRgb[i * 3] = parsed[0];
          activePaletteRgb[i * 3 + 1] = parsed[1];
          activePaletteRgb[i * 3 + 2] = parsed[2];
        } else {
          activePaletteRgb[i * 3] = defaultRgb[i * 3];
          activePaletteRgb[i * 3 + 1] = defaultRgb[i * 3 + 1];
          activePaletteRgb[i * 3 + 2] = defaultRgb[i * 3 + 2];
        }
      }
      return;
    }
    if (palette.rgba32 && palette.rgba32.length >= 16) {
      for (let i = 0; i < 16; i++) {
        const v = palette.rgba32[i] >>> 0;
        activePaletteRgb[i * 3] = v & 0xff;
        activePaletteRgb[i * 3 + 1] = (v >>> 8) & 0xff;
        activePaletteRgb[i * 3 + 2] = (v >>> 16) & 0xff;
      }
    }
  }

  function clear(colIdx = clearColorIndex) {
    const c = colIdx & 15;
    fbIndex.fill(c);
    fbLayer.fill(0);
    fbCustomRgb.fill(0);
  }

  function setPixelRaw(ix, iy, colDesc, layer = 2) {
    if (ix < 0 || ix >= WIDTH || iy < 0 || iy >= HEIGHT) return;
    const idx = iy * WIDTH + ix;
    if (colDesc.kind === 'rgb') {
      fbCustomRgb[idx] = colDesc.customPacked;
      fbIndex[idx] = 255;
      fbLayer[idx] = layer;
    } else {
      fbCustomRgb[idx] = 0;
      fbIndex[idx] = colDesc.index & 15;
      fbLayer[idx] = layer;
    }
  }

  function setPixelFast(ix, iy, palIdx, layer = 2) {
    if (ix < 0 || ix >= WIDTH || iy < 0 || iy >= HEIGHT) return;
    const idx = iy * WIDTH + ix;
    fbCustomRgb[idx] = 0;
    fbIndex[idx] = palIdx & 15;
    fbLayer[idx] = layer;
  }

  function drawPixel(x, y, colorVal = 4, layer = 2) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (typeof colorVal === 'number') {
      setPixelFast(ix, iy, colorVal, layer);
    } else {
      setPixelRaw(ix, iy, packColorDescriptor(colorVal), layer);
    }
  }

  function drawLine(x0, y0, x1, y1, colorVal = 4, layer = 2) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return;
    let ix0 = Math.round(x0);
    let iy0 = Math.round(y0);
    const ix1 = Math.round(x1);
    const iy1 = Math.round(y1);
    const colDesc = typeof colorVal === 'number' ? null : packColorDescriptor(colorVal);
    const dx = Math.abs(ix1 - ix0);
    const dy = -Math.abs(iy1 - iy0);
    const sx = ix0 < ix1 ? 1 : -1;
    const sy = iy0 < iy1 ? 1 : -1;
    let err = dx + dy;
    let guard = 512;
    while (guard-- > 0) {
      if (colDesc === null) {
        setPixelFast(ix0, iy0, colorVal, layer);
      } else {
        setPixelRaw(ix0, iy0, colDesc, layer);
      }
      if (ix0 === ix1 && iy0 === iy1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ix0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        iy0 += sy;
      }
    }
  }

  function drawRectInternal(x, y, w, h, colorVal, fill = true, opacityVal = 1, layer = 2) {
    if (opacityVal <= 0 || w <= 0 || h <= 0) return;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.floor(x + w);
    const y1 = Math.floor(y + h);
    const colDesc = typeof colorVal === 'number' ? null : packColorDescriptor(colorVal);
    const checkOpacity = opacityVal < 1;
    const minX = Math.max(0, x0);
    const maxX = Math.min(WIDTH, x1);
    const minY = Math.max(0, y0);
    const maxY = Math.min(HEIGHT, y1);
    for (let py = minY; py < maxY; py++) {
      for (let px = minX; px < maxX; px++) {
        if (!fill && px !== x0 && px !== x1 - 1 && py !== y0 && py !== y1 - 1) continue;
        if (checkOpacity) {
          const threshold = (BAYER_4X4[((py & 3) << 2) | (px & 3)] + 0.5) / 16;
          if (opacityVal <= threshold) continue;
        }
        if (colDesc === null) {
          setPixelFast(px, py, colorVal, layer);
        } else {
          setPixelRaw(px, py, colDesc, layer);
        }
      }
    }
  }

  function drawCircleInternal(cx, cy, r, colorVal, fill = true, opacityVal = 1, layer = 2) {
    if (opacityVal <= 0 || r <= 0) return;
    const icx = Math.round(cx);
    const icy = Math.round(cy);
    const ir = Math.max(1, Math.round(r));
    const r2 = ir * ir;
    const innerR2 = fill ? -1 : Math.max(0, (ir - 1) * (ir - 1));
    const colDesc = typeof colorVal === 'number' ? null : packColorDescriptor(colorVal);
    const checkOpacity = opacityVal < 1;
    const minX = Math.max(0, icx - ir);
    const maxX = Math.min(WIDTH - 1, icx + ir);
    const minY = Math.max(0, icy - ir);
    const maxY = Math.min(HEIGHT - 1, icy + ir);
    for (let py = minY; py <= maxY; py++) {
      const dy = py - icy;
      for (let px = minX; px <= maxX; px++) {
        const dx = px - icx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || (!fill && d2 < innerR2)) continue;
        if (checkOpacity) {
          const threshold = (BAYER_4X4[((py & 3) << 2) | (px & 3)] + 0.5) / 16;
          if (opacityVal <= threshold) continue;
        }
        if (colDesc === null) {
          setPixelFast(px, py, colorVal, layer);
        } else {
          setPixelRaw(px, py, colDesc, layer);
        }
      }
    }
  }

  function drawSpriteSlot(slotIdx, x, y, drawOpts = {}) {
    const bank = drawOpts.sprites || spriteBank;
    if (!bank || slotIdx < 0 || slotIdx >= bank.length) return;
    const sp = bank[slotIdx];
    if (!sp || !sp.frames || sp.frames.length === 0) return;
    const size = sp.size === 16 ? 16 : 8;
    const frameIdx = Math.abs(drawOpts.frame | 0) % sp.frames.length;
    const pixels = sp.frames[frameIdx];
    if (!pixels || pixels.length < size * size) return;

    const op = drawOpts.opacity !== undefined ? drawOpts.opacity : 1;
    if (op <= 0) return;
    const sx = typeof drawOpts.scaleX === 'number' ? drawOpts.scaleX : (typeof drawOpts.scale === 'number' ? drawOpts.scale : 1);
    const sy = typeof drawOpts.scaleY === 'number' ? drawOpts.scaleY : (typeof drawOpts.scale === 'number' ? drawOpts.scale : 1);
    if (sx <= 0 || sy <= 0) return;
    const flipX = Boolean(drawOpts.flipX);
    const flipY = Boolean(drawOpts.flipY);
    const angleDeg = drawOpts.rotate || 0;
    const layer = drawOpts.layer !== undefined ? drawOpts.layer : 2;
    const checkOpacity = op < 1;

    const ox = Math.round(x);
    const oy = Math.round(y);

    // Fast path for unscaled, unrotated sprites
    if (sx === 1 && sy === 1 && angleDeg === 0) {
      for (let py = 0; py < size; py++) {
        const syIdx = flipY ? (size - 1 - py) : py;
        const dstY = oy + py;
        if (dstY < 0 || dstY >= HEIGHT) continue;
        for (let px = 0; px < size; px++) {
          const sxIdx = flipX ? (size - 1 - px) : px;
          const col = pixels[syIdx * size + sxIdx];
          if (col === 0) continue;
          const dstX = ox + px;
          if (dstX < 0 || dstX >= WIDTH) continue;
          if (checkOpacity) {
            const threshold = (BAYER_4X4[((dstY & 3) << 2) | (dstX & 3)] + 0.5) / 16;
            if (op <= threshold) continue;
          }
          setPixelFast(dstX, dstY, col, layer);
        }
      }
      return;
    }

    const outW = Math.max(1, Math.round(size * sx));
    const outH = Math.max(1, Math.round(size * sy));
    const rad = (-angleDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const halfW = outW * 0.5;
    const halfH = outH * 0.5;
    const bound = angleDeg === 0 ? Math.max(outW, outH) : Math.ceil(Math.hypot(outW, outH));
    const minDx = angleDeg === 0 ? 0 : Math.floor(halfW - bound * 0.5);
    const maxDx = angleDeg === 0 ? outW - 1 : Math.ceil(halfW + bound * 0.5);
    const minDy = angleDeg === 0 ? 0 : Math.floor(halfH - bound * 0.5);
    const maxDy = angleDeg === 0 ? outH - 1 : Math.ceil(halfH + bound * 0.5);

    for (let dy = minDy; dy <= maxDy; dy++) {
      const dstY = oy + dy;
      if (dstY < 0 || dstY >= HEIGHT) continue;
      for (let dx = minDx; dx <= maxDx; dx++) {
        const dstX = ox + dx;
        if (dstX < 0 || dstX >= WIDTH) continue;
        let lx = dx + 0.5 - halfW;
        let ly = dy + 0.5 - halfH;
        if (angleDeg !== 0) {
          const rx = lx * cosA - ly * sinA;
          const ry = lx * sinA + ly * cosA;
          lx = rx;
          ly = ry;
        }
        const ux = (lx + halfW) / sx;
        const uy = (ly + halfH) / sy;
        const srcX = Math.floor(ux);
        const srcY = Math.floor(uy);
        if (srcX < 0 || srcX >= size || srcY < 0 || srcY >= size) continue;
        const fx = flipX ? (size - 1 - srcX) : srcX;
        const fy = flipY ? (size - 1 - srcY) : srcY;
        const col = pixels[fy * size + fx];
        if (col === 0) continue;
        if (checkOpacity) {
          const threshold = (BAYER_4X4[((dstY & 3) << 2) | (dstX & 3)] + 0.5) / 16;
          if (op <= threshold) continue;
        }
        setPixelFast(dstX, dstY, col, layer);
      }
    }
  }

  function drawTilemap(worldOrOpts, offsetX = 0, offsetY = 0) {
    if (!worldOrOpts) return;
    let camX = 0;
    let camY = 0;
    let fixed = false;
    let animTick = tickCount;
    let tileRenderer = null;
    let customSprites = spriteBank;

    if (typeof offsetX === 'object' && offsetX !== null) {
      camX = offsetX.camX || 0;
      camY = offsetX.camY || 0;
      fixed = Boolean(offsetX.fixed);
      if (typeof offsetX.animTick === 'number') animTick = offsetX.animTick;
      if (typeof offsetX.tileRenderer === 'function') tileRenderer = offsetX.tileRenderer;
      if (Array.isArray(offsetX.sprites)) customSprites = offsetX.sprites;
    } else {
      camX = Number(offsetX) || 0;
      camY = Number(offsetY) || 0;
    }

    const sxOff = fixed ? 0 : shakeOffsetX;
    const syOff = fixed ? 0 : shakeOffsetY;
    const world = worldOrOpts;
    const tw = world.width === 32 ? 32 : (world.width || 16);
    const th = world.height === 32 ? 32 : (world.height || 16);

    const drawLayerGrid = (grid, fbLayerId) => {
      if (!grid || grid.length < tw * th) return;
      for (let ty = 0; ty < th; ty++) {
        const pyBase = Math.round(ty * 8 - camY + syOff);
        if (pyBase >= HEIGHT || pyBase + 8 <= 0) continue;
        for (let tx = 0; tx < tw; tx++) {
          const tileId = grid[ty * tw + tx];
          if (!tileId) continue;
          const pxBase = Math.round(tx * 8 - camX + sxOff);
          if (pxBase >= WIDTH || pxBase + 8 <= 0) continue;

          if (tileRenderer) {
            const tilePixels = tileRenderer(tileId, tx, ty, animTick);
            if (tilePixels && tilePixels.length >= 64) {
              for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px++) {
                  const c = tilePixels[py * 8 + px];
                  if (c > 0) setPixelFast(pxBase + px, pyBase + py, c, fbLayerId);
                }
              }
              continue;
            }
          }

          // If tileId >= 8 and corresponds to a sprite slot, render sprite slot; otherwise built-in terrain tile
          if (tileId >= 8 && customSprites && customSprites[tileId - 8]) {
            drawSpriteSlot(tileId - 8, pxBase, pyBase, { sprites: customSprites, layer: fbLayerId });
          } else {
            drawDefaultTerrainTile(tileId, 0, 0, animTick, (lx, ly, c) => {
              setPixelFast(pxBase + lx, pyBase + ly, c, fbLayerId);
            });
          }
        }
      }
    };

    if (world.grid) {
      drawLayerGrid(world.grid, 1);
    } else {
      drawLayerGrid(world.bgLayer, 1);
      drawLayerGrid(world.mainLayer, 2);
      drawLayerGrid(world.fgLayer, 2);
    }
  }

  function drawText5x7(text, x, y, colorVal = 4, textOpts = {}) {
    const str = String(text ?? '');
    if (!str.length) return;
    const scaleVal = Math.max(1, Math.round(textOpts.scale || 1));
    const spacing = textOpts.spacing !== undefined ? textOpts.spacing : 1;
    const advance = (5 + spacing) * scaleVal;
    const totalW = str.length * advance - spacing * scaleVal;

    let startX = Math.round(x);
    if (textOpts.align === 'center') startX = Math.round(x - totalW * 0.5);
    else if (textOpts.align === 'right') startX = Math.round(x - totalW);
    const startY = Math.round(y);

    const drawStrPass = (ox, oy, col) => {
      const desc = typeof col === 'number' ? null : packColorDescriptor(col);
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        const glyph = FONT_5X7[code] || FONT_5X7[63];
        const gx = ox + i * advance;
        for (let row = 0; row < 7; row++) {
          const rowBits = glyph[row];
          if (rowBits === 0) continue;
          for (let colBit = 0; colBit < 5; colBit++) {
            if ((rowBits & (0x10 >> colBit)) === 0) continue;
            if (scaleVal === 1) {
              if (desc === null) setPixelFast(gx + colBit, oy + row, col, 2);
              else setPixelRaw(gx + colBit, oy + row, desc, 2);
            } else {
              for (let sy = 0; sy < scaleVal; sy++) {
                for (let sx = 0; sx < scaleVal; sx++) {
                  const px = gx + colBit * scaleVal + sx;
                  const py = oy + row * scaleVal + sy;
                  if (desc === null) setPixelFast(px, py, col, 2);
                  else setPixelRaw(px, py, desc, 2);
                }
              }
            }
          }
        }
      }
    };

    if (textOpts.shadow !== undefined && textOpts.shadow !== null) {
      drawStrPass(startX + scaleVal, startY + scaleVal, textOpts.shadow);
    }
    drawStrPass(startX, startY, colorVal);
  }

  function shake(amount = 0.5) {
    if (!Number.isFinite(amount)) return;
    trauma = Math.min(1.5, Math.max(0, trauma + Math.max(0, amount)));
  }

  function hitStop(frames = 2) {
    if (!Number.isFinite(frames)) return;
    const count = Math.max(0, Math.round(frames));
    if (count > hitStopFrames) hitStopFrames = count;
  }

  function emitParticles(emitOpts = {}) {
    const ox = Number.isFinite(emitOpts.x) ? emitOpts.x : 64;
    const oy = Number.isFinite(emitOpts.y) ? emitOpts.y : 64;
    const count = Math.max(1, Math.min(PARTICLE_POOL_SIZE, (emitOpts.count ?? 8) | 0));
    const baseAngle = Number.isFinite(emitOpts.angle) ? emitOpts.angle : 0;
    const spread = Number.isFinite(emitOpts.spread) ? emitOpts.spread : Math.PI * 2;
    const gravity = Number.isFinite(emitOpts.gravity) ? emitOpts.gravity : 90;
    const ax = Number.isFinite(emitOpts.ax) ? emitOpts.ax : 0;
    const baseLife = Number.isFinite(emitOpts.life ?? emitOpts.lifespan)
      ? Math.max(0.02, emitOpts.life ?? emitOpts.lifespan)
      : 0.45;
    const drag = Number.isFinite(emitOpts.drag) ? Math.max(0.5, Math.min(1, emitOpts.drag)) : 0.96;
    const size = emitOpts.size === 2 ? 2 : 1;

    let speedMin = 24;
    let speedMax = 64;
    if (Array.isArray(emitOpts.speed)) {
      speedMin = Number.isFinite(emitOpts.speed[0]) ? emitOpts.speed[0] : 24;
      speedMax = Number.isFinite(emitOpts.speed[1]) ? emitOpts.speed[1] : speedMin;
    } else if (Number.isFinite(emitOpts.speed)) {
      speedMin = emitOpts.speed * 0.6;
      speedMax = emitOpts.speed * 1.15;
    }

    const colors = Array.isArray(emitOpts.color) && emitOpts.color.length > 0
      ? emitOpts.color
      : [typeof emitOpts.color === 'number' ? emitOpts.color : 7];

    for (let i = 0; i < count; i++) {
      // Find next free slot or overwrite cursor slot
      let slot = -1;
      for (let probe = 0; probe < PARTICLE_POOL_SIZE; probe++) {
        const idx = (pRingCursor + probe) % PARTICLE_POOL_SIZE;
        if (pActive[idx] === 0) {
          slot = idx;
          pRingCursor = (idx + 1) % PARTICLE_POOL_SIZE;
          break;
        }
      }
      if (slot === -1) {
        slot = pRingCursor;
        pRingCursor = (pRingCursor + 1) % PARTICLE_POOL_SIZE;
        pOverflowRecycled++;
      } else {
        pActiveCount++;
        if (pActiveCount > pPeakActive) pPeakActive = pActiveCount;
      }

      const ang = baseAngle + (nextRand() - 0.5) * spread;
      const spd = speedMin + nextRand() * (speedMax - speedMin);
      const vx = Number.isFinite(emitOpts.vx)
        ? emitOpts.vx + Math.cos(ang) * spd * 0.35
        : Math.cos(ang) * spd;
      const vy = Number.isFinite(emitOpts.vy)
        ? emitOpts.vy + Math.sin(ang) * spd * 0.35
        : Math.sin(ang) * spd;
      const life = baseLife * (0.7 + nextRand() * 0.6);
      const col = colors[i % colors.length] & 15;

      pActive[slot] = 1;
      pX[slot] = Number.isFinite(ox) ? ox : 64;
      pY[slot] = Number.isFinite(oy) ? oy : 64;
      pVx[slot] = Number.isFinite(vx) ? vx : 0;
      pVy[slot] = Number.isFinite(vy) ? vy : 0;
      pAx[slot] = ax;
      pAy[slot] = gravity;
      pLife[slot] = life;
      pMaxLife[slot] = life;
      pColor[slot] = col === 0 ? 4 : col;
      pSize[slot] = size;
      pDrag[slot] = drag;
      pTotalEmitted++;
    }
  }

  // Kaboom-style component factories
  function pos(x = 0, y = 0) {
    const px = typeof x === 'object' && x !== null ? (x.x ?? 0) : x;
    const py = typeof x === 'object' && x !== null ? (x.y ?? 0) : y;
    return {
      id: 'pos',
      pos: { x: Number(px) || 0, y: Number(py) || 0 },
      move(vx, vy) {
        this.pos.x += (Number(vx) || 0) * FIXED_DT;
        this.pos.y += (Number(vy) || 0) * FIXED_DT;
      },
      moveBy(dx, dy) {
        this.pos.x += Number(dx) || 0;
        this.pos.y += Number(dy) || 0;
      },
      moveTo(nx, ny) {
        this.pos.x = Number(nx) || 0;
        this.pos.y = Number(ny) || 0;
      },
    };
  }

  function vel(vx = 0, vy = 0) {
    const ivx = typeof vx === 'object' && vx !== null ? (vx.x ?? 0) : vx;
    const ivy = typeof vx === 'object' && vx !== null ? (vx.y ?? 0) : vy;
    return {
      id: 'vel',
      vel: { x: Number(ivx) || 0, y: Number(ivy) || 0 },
      _hasVel: true,
    };
  }

  function area(areaOpts = {}) {
    const offset = areaOpts.offset || { x: 0, y: 0 };
    return {
      id: 'area',
      area: {
        width: areaOpts.width ?? areaOpts.w ?? null,
        height: areaOpts.height ?? areaOpts.h ?? null,
        offsetX: offset.x || 0,
        offsetY: offset.y || 0,
      },
      worldArea() {
        const px = this.pos ? this.pos.x : 0;
        const py = this.pos ? this.pos.y : 0;
        const sx = this.scale ? this.scale.x : 1;
        const sy = this.scale ? this.scale.y : 1;
        let w = this.area.width;
        let h = this.area.height;
        if (w === null || h === null) {
          if (typeof this.spriteSlot === 'number') {
            const sp = spriteBank[this.spriteSlot];
            const sz = sp && sp.size === 16 ? 16 : 8;
            w = w ?? sz;
            h = h ?? sz;
          } else if (typeof this.radius === 'number') {
            w = w ?? this.radius * 2;
            h = h ?? this.radius * 2;
          } else {
            w = w ?? (this.width ?? 8);
            h = h ?? (this.height ?? 8);
          }
        }
        const scaledW = w * sx;
        const scaledH = h * sy;
        const isCenteredCircle = typeof this.radius === 'number' && !this.widthExplicit;
        const ax = isCenteredCircle
          ? px - scaledW * 0.5 + this.area.offsetX
          : px + this.area.offsetX;
        const ay = isCenteredCircle
          ? py - scaledH * 0.5 + this.area.offsetY
          : py + this.area.offsetY;
        return { x: ax, y: ay, width: scaledW, height: scaledH };
      },
      hasPoint(tx, ty) {
        const a = this.worldArea();
        return tx >= a.x && tx <= a.x + a.width && ty >= a.y && ty <= a.y + a.height;
      },
    };
  }

  function body(bodyOpts = {}) {
    return {
      id: 'body',
      _hasBody: true,
      body: {
        gravity: bodyOpts.gravity !== undefined ? bodyOpts.gravity : null,
        gravityScale: bodyOpts.gravityScale !== undefined ? bodyOpts.gravityScale : 1,
        isStatic: Boolean(bodyOpts.isStatic),
        bounce: Number(bodyOpts.bounce) || 0,
        drag: Number(bodyOpts.drag) || 0,
        maxVel: Number(bodyOpts.maxVel) || 600,
        collideWorld: Boolean(bodyOpts.collideWorld),
      },
      add() {
        if (!this.vel) this.vel = { x: 0, y: 0 };
        if (!this.pos) this.pos = { x: 0, y: 0 };
      },
      applyImpulse(ix, iy) {
        if (this.body.isStatic) return;
        if (!this.vel) this.vel = { x: 0, y: 0 };
        this.vel.x += Number(ix) || 0;
        this.vel.y += Number(iy) || 0;
      },
      jump(force = 120) {
        if (this.body.isStatic) return;
        if (!this.vel) this.vel = { x: 0, y: 0 };
        this.vel.y = -(Number(force) || 120);
      },
    };
  }

  function sprite(slot, spriteOpts = {}) {
    return {
      id: 'sprite',
      spriteSlot: typeof slot === 'number' ? slot : 0,
      frame: spriteOpts.frame || 0,
      animSpeed: spriteOpts.animSpeed || 0,
      flipX: Boolean(spriteOpts.flipX),
      flipY: Boolean(spriteOpts.flipY),
      _spriteTime: 0,
      draw() {
        const sp = spriteBank[this.spriteSlot];
        let f = this.frame | 0;
        if (sp && sp.frames && sp.frames.length > 1 && this.animSpeed > 0) {
          f = Math.floor(simTime * this.animSpeed) % sp.frames.length;
        }
        const px = (this.pos ? this.pos.x : 0) + shakeOffsetX;
        const py = (this.pos ? this.pos.y : 0) + shakeOffsetY;
        drawSpriteSlot(this.spriteSlot, px, py, {
          frame: f,
          flipX: this.flipX,
          flipY: this.flipY,
          scaleX: this.scale ? this.scale.x : 1,
          scaleY: this.scale ? this.scale.y : 1,
          rotate: this.angle || 0,
          opacity: this.opacity !== undefined ? this.opacity : 1,
          layer: 2,
        });
      },
    };
  }

  function rect(w = 8, h = 8, rectOpts = {}) {
    return {
      id: 'rect',
      width: Number(w) || 8,
      height: Number(h) || 8,
      widthExplicit: true,
      fill: rectOpts.fill !== false,
      draw() {
        const px = (this.pos ? this.pos.x : 0) + shakeOffsetX;
        const py = (this.pos ? this.pos.y : 0) + shakeOffsetY;
        const sx = this.scale ? this.scale.x : 1;
        const sy = this.scale ? this.scale.y : 1;
        const col = this.color !== undefined ? this.color : 4;
        const op = this.opacity !== undefined ? this.opacity : 1;
        drawRectInternal(px, py, this.width * sx, this.height * sy, col, this.fill, op, 2);
      },
    };
  }

  function circle(r = 4, circleOpts = {}) {
    return {
      id: 'circle',
      radius: Number(r) || 4,
      fill: circleOpts.fill !== false,
      draw() {
        const px = (this.pos ? this.pos.x : 0) + shakeOffsetX;
        const py = (this.pos ? this.pos.y : 0) + shakeOffsetY;
        const s = this.scale ? (this.scale.x + this.scale.y) * 0.5 : 1;
        const col = this.color !== undefined ? this.color : 4;
        const op = this.opacity !== undefined ? this.opacity : 1;
        drawCircleInternal(px, py, this.radius * s, col, this.fill, op, 2);
      },
    };
  }

  function color(c = 4, g, b) {
    return {
      id: 'color',
      color: packColorDescriptor(c, g, b),
    };
  }

  function opacity(val = 1) {
    return {
      id: 'opacity',
      opacity: Math.max(0, Math.min(1, Number(val))),
    };
  }

  function scale(sx = 1, sy) {
    if (typeof sx === 'object' && sx !== null) {
      return { id: 'scale', scale: { x: Number(sx.x) || 1, y: Number(sx.y) || 1 } };
    }
    const vx = Number(sx) || 1;
    const vy = sy !== undefined ? (Number(sy) || 1) : vx;
    return { id: 'scale', scale: { x: vx, y: vy } };
  }

  function rotate(deg = 0) {
    return {
      id: 'rotate',
      angle: Number(deg) || 0,
      rotateBy(d) {
        this.angle += Number(d) || 0;
      },
    };
  }

  function z(val = 0) {
    return {
      id: 'z',
      z: Number(val) || 0,
    };
  }

  function lifespan(seconds = 1, lifeOpts = {}) {
    const total = Math.max(0.001, Number(seconds) || 1);
    return {
      id: 'lifespan',
      _lifeRemaining: total,
      _lifeTotal: total,
      _lifeFade: lifeOpts.fade ? Number(lifeOpts.fade) : 0,
      update(dt) {
        this._lifeRemaining -= dt;
        if (this._lifeFade > 0 && this._lifeRemaining < this._lifeFade) {
          this.opacity = Math.max(0, this._lifeRemaining / this._lifeFade);
        }
        if (this._lifeRemaining <= 0) {
          this.destroy();
        }
      },
    };
  }

  function createEntity(comps = []) {
    const ent = {
      id: nextEntityId++,
      tags: new Set(),
      z: 0,
      opacity: 1,
      _destroyed: false,
      _updateCbs: [],
      _drawCbs: [],
      _destroyCbs: [],
      _collideCbs: [],
      _compDrawFns: [],
      _compUpdateFns: [],
      exists() {
        return !this._destroyed;
      },
      is(tag) {
        if (Array.isArray(tag)) return tag.some((t) => this.tags.has(t));
        return this.tags.has(tag);
      },
      tag(t) {
        this.tags.add(String(t));
        return this;
      },
      untag(t) {
        this.tags.delete(String(t));
        return this;
      },
      destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (let i = 0; i < this._destroyCbs.length; i++) {
          this._destroyCbs[i](this);
        }
      },
      onUpdate(fn) {
        if (typeof fn === 'function') this._updateCbs.push(fn);
        return this;
      },
      onDraw(fn) {
        if (typeof fn === 'function') this._drawCbs.push(fn);
        return this;
      },
      onDestroy(fn) {
        if (typeof fn === 'function') this._destroyCbs.push(fn);
        return this;
      },
      onCollide(tagOrFn, maybeFn) {
        if (typeof tagOrFn === 'function') {
          this._collideCbs.push({ tag: null, fn: tagOrFn });
        } else if (typeof maybeFn === 'function') {
          this._collideCbs.push({ tag: tagOrFn, fn: maybeFn });
        }
        return this;
      },
      use(comp) {
        if (typeof comp === 'string') {
          this.tags.add(comp);
          return this;
        }
        if (!comp || typeof comp !== 'object') return this;
        if (comp.id) this.tags.add(comp.id);
        for (const key of Object.keys(comp)) {
          if (key === 'id' || key === 'require' || key === 'add' || key === 'update' || key === 'draw') {
            continue;
          }
          const val = comp[key];
          if (typeof val === 'function') {
            this[key] = comp.id ? val.bind(this) : val;
          } else if (comp.id && val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Uint8Array)) {
            this[key] = { ...val };
          } else {
            this[key] = val;
          }
        }
        if (typeof comp.update === 'function') this._compUpdateFns.push(comp.update.bind(this));
        if (typeof comp.draw === 'function') this._compDrawFns.push(comp.draw.bind(this));
        if (typeof comp.add === 'function') comp.add.call(this);
        return this;
      },
    };

    for (let i = 0; i < comps.length; i++) {
      ent.use(comps[i]);
    }
    return ent;
  }

  function add(comps = []) {
    const ent = createEntity(comps);
    entities.push(ent);
    return ent;
  }

  function destroy(ent) {
    if (ent && typeof ent.destroy === 'function') {
      ent.destroy();
    }
  }

  function destroyAll(tag) {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e._destroyed && (!tag || e.is(tag))) {
        e.destroy();
      }
    }
  }

  function get(tag) {
    const out = [];
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (e._destroyed) continue;
      if (!tag || tag === '*' || e.is(tag)) out.push(e);
    }
    return out;
  }

  function scene(name, fn) {
    scenes.set(name, fn);
  }

  function go(name, ...args) {
    currentSceneName = name;
    destroyAll();
    entities.length = 0;
    updateHandlers.length = 0;
    drawHandlers.length = 0;
    collideHandlers.length = 0;
    hitStopFrames = 0;
    trauma = 0;
    shakeOffsetX = 0;
    shakeOffsetY = 0;
    const fn = scenes.get(name);
    if (typeof fn === 'function') {
      fn(...args);
    }
  }

  function onUpdate(tagOrFn, maybeFn) {
    const entry = typeof tagOrFn === 'function'
      ? { tag: null, fn: tagOrFn, active: true }
      : { tag: tagOrFn, fn: maybeFn, active: true };
    updateHandlers.push(entry);
    return { cancel: () => { entry.active = false; } };
  }

  function onDraw(tagOrFn, maybeFn) {
    const entry = typeof tagOrFn === 'function'
      ? { tag: null, fn: tagOrFn, active: true }
      : { tag: tagOrFn, fn: maybeFn, active: true };
    drawHandlers.push(entry);
    return { cancel: () => { entry.active = false; } };
  }

  function onCollide(tagA, tagBOrFn, maybeFn) {
    let entry;
    if (typeof tagBOrFn === 'function') {
      entry = { tagA, tagB: null, fn: tagBOrFn, active: true };
    } else {
      entry = { tagA, tagB: tagBOrFn, fn: maybeFn, active: true };
    }
    collideHandlers.push(entry);
    return { cancel: () => { entry.active = false; } };
  }

  function pruneDestroyedEntities() {
    let writeIdx = 0;
    for (let i = 0; i < entities.length; i++) {
      if (!entities[i]._destroyed) {
        entities[writeIdx++] = entities[i];
      }
    }
    entities.length = writeIdx;
  }

  function stepFixedTick(dt) {
    tickCount++;
    simTime += dt;

    // Trauma decay & shake offset (continues decaying during hitStop for tactile crunch)
    if (trauma > 0) {
      trauma = Math.max(0, trauma - 2.6 * dt);
      const t2 = trauma * trauma;
      const maxPx = 5;
      shakeOffsetX = Math.round(maxPx * t2 * Math.sin(simTime * 67.3));
      shakeOffsetY = Math.round(maxPx * t2 * Math.cos(simTime * 83.1));
    } else {
      shakeOffsetX = 0;
      shakeOffsetY = 0;
    }

    // Floating 1px ambient dust motes
    if (dustMotesEnabled) {
      for (let i = 0; i < DUST_MOTE_COUNT; i++) {
        dustPhase[i] += dt * 1.4;
        dustX[i] += (dustVx[i] + Math.sin(dustPhase[i]) * 2.2) * dt;
        dustY[i] += dustVy[i] * dt;
        if (dustX[i] < 0) dustX[i] += WIDTH;
        else if (dustX[i] >= WIDTH) dustX[i] -= WIDTH;
        if (dustY[i] < 0) dustY[i] += HEIGHT;
        else if (dustY[i] >= HEIGHT) dustY[i] -= HEIGHT;
      }
    }

    // Hit-stop freezes simulation physics/entities for crisp impact frames
    if (hitStopFrames > 0) {
      hitStopFrames--;
      return;
    }

    // 1. Update pre-allocated 512-slot particle pool (zero allocations)
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      if (pActive[i] === 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0 || !Number.isFinite(pLife[i])) {
        pActive[i] = 0;
        pActiveCount = Math.max(0, pActiveCount - 1);
        continue;
      }
      pVx[i] = (pVx[i] + pAx[i] * dt) * pDrag[i];
      pVy[i] = (pVy[i] + pAy[i] * dt) * pDrag[i];
      pX[i] += pVx[i] * dt;
      pY[i] += pVy[i] * dt;
      if (!Number.isFinite(pX[i]) || !Number.isFinite(pY[i]) || !Number.isFinite(pVx[i]) || !Number.isFinite(pVy[i])) {
        pActive[i] = 0;
        pX[i] = 0;
        pY[i] = 0;
        pVx[i] = 0;
        pVy[i] = 0;
        pActiveCount = Math.max(0, pActiveCount - 1);
      }
    }

    // 2. Snapshot current active entities into reusable scratch array
    scratchUpdate.length = 0;
    for (let i = 0; i < entities.length; i++) {
      if (!entities[i]._destroyed) scratchUpdate.push(entities[i]);
    }

    // 3. Entity physics integration & component updates
    for (let i = 0; i < scratchUpdate.length; i++) {
      const ent = scratchUpdate[i];
      if (ent._destroyed) continue;

      if ((ent._hasBody || ent._hasVel) && ent.pos && ent.vel) {
        if (ent._hasBody && ent.body && !ent.body.isStatic) {
          const g = ent.body.gravity !== null ? ent.body.gravity : globalGravity;
          ent.vel.y += g * ent.body.gravityScale * dt;
          if (ent.body.drag > 0) {
            const damp = Math.max(0, 1 - ent.body.drag * dt);
            ent.vel.x *= damp;
            ent.vel.y *= damp;
          }
          const maxV = ent.body.maxVel;
          if (maxV > 0) {
            if (ent.vel.x > maxV) ent.vel.x = maxV;
            else if (ent.vel.x < -maxV) ent.vel.x = -maxV;
            if (ent.vel.y > maxV) ent.vel.y = maxV;
            else if (ent.vel.y < -maxV) ent.vel.y = -maxV;
          }
        }
        ent.pos.x += ent.vel.x * dt;
        ent.pos.y += ent.vel.y * dt;

        if (ent._hasBody && ent.body && ent.body.collideWorld) {
          const box = ent.worldArea ? ent.worldArea() : { x: ent.pos.x, y: ent.pos.y, width: 8, height: 8 };
          const b = ent.body.bounce;
          if (box.x < 0) {
            ent.pos.x -= box.x;
            if (ent.vel.x < 0) ent.vel.x = -ent.vel.x * b;
          } else if (box.x + box.width > WIDTH) {
            ent.pos.x -= (box.x + box.width - WIDTH);
            if (ent.vel.x > 0) ent.vel.x = -ent.vel.x * b;
          }
          if (box.y < 0) {
            ent.pos.y -= box.y;
            if (ent.vel.y < 0) ent.vel.y = -ent.vel.y * b;
          } else if (box.y + box.height > HEIGHT) {
            ent.pos.y -= (box.y + box.height - HEIGHT);
            if (ent.vel.y > 0) ent.vel.y = -ent.vel.y * b;
          }
        }
      }

      for (let j = 0; j < ent._compUpdateFns.length; j++) {
        if (ent._destroyed) break;
        ent._compUpdateFns[j](dt);
      }
      for (let j = 0; j < ent._updateCbs.length; j++) {
        if (ent._destroyed) break;
        ent._updateCbs[j](dt);
      }
    }

    // 4. Scene-level onUpdate handlers
    for (let i = 0; i < updateHandlers.length; i++) {
      const h = updateHandlers[i];
      if (!h.active) continue;
      if (h.tag === null) {
        h.fn(dt);
      } else {
        for (let j = 0; j < scratchUpdate.length; j++) {
          const ent = scratchUpdate[j];
          if (!ent._destroyed && ent.is(h.tag)) {
            h.fn(ent, dt);
          }
        }
      }
    }

    // 5. Collision detection
    scratchCollide.length = 0;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e._destroyed && typeof e.worldArea === 'function') {
        scratchCollide.push(e);
      }
    }

    for (let i = 0; i < scratchCollide.length; i++) {
      const a = scratchCollide[i];
      if (a._destroyed) continue;
      const boxA = a.worldArea();
      for (let j = i + 1; j < scratchCollide.length; j++) {
        const b = scratchCollide[j];
        if (b._destroyed) continue;
        const boxB = b.worldArea();
        if (!aabbOverlap(boxA, boxB)) continue;

        for (let h = 0; h < collideHandlers.length; h++) {
          const ch = collideHandlers[h];
          if (!ch.active) continue;
          if (ch.tagB === null) {
            if (a.is(ch.tagA)) ch.fn(a, b);
            if (!a._destroyed && !b._destroyed && b.is(ch.tagA)) ch.fn(b, a);
          } else {
            if (a.is(ch.tagA) && b.is(ch.tagB)) {
              ch.fn(a, b);
            } else if (a.is(ch.tagB) && b.is(ch.tagA)) {
              ch.fn(b, a);
            }
          }
          if (a._destroyed || b._destroyed) break;
        }

        if (!a._destroyed && !b._destroyed) {
          for (let c = 0; c < a._collideCbs.length; c++) {
            const cb = a._collideCbs[c];
            if (cb.tag === null || b.is(cb.tag)) cb.fn(b);
            if (a._destroyed || b._destroyed) break;
          }
        }
        if (!a._destroyed && !b._destroyed) {
          for (let c = 0; c < b._collideCbs.length; c++) {
            const cb = b._collideCbs[c];
            if (cb.tag === null || a.is(cb.tag)) cb.fn(a);
            if (a._destroyed || b._destroyed) break;
          }
        }
      }
    }

    pruneDestroyedEntities();
  }

  function renderInternalFrame() {
    clear(clearColorIndex);

    // Draw subtle floating 1px ambient dust motes on bg layer 0
    if (dustMotesEnabled) {
      for (let i = 0; i < DUST_MOTE_COUNT; i++) {
        const pulse = Math.sin(dustPhase[i] * 2);
        if (pulse > -0.3) {
          setPixelFast(Math.floor(dustX[i]), Math.floor(dustY[i]), pulse > 0.55 ? 2 : 1, 0);
        }
      }
    }

    // Sort active entities by z ascending, tie-broken by creation id
    scratchDraw.length = 0;
    for (let i = 0; i < entities.length; i++) {
      if (!entities[i]._destroyed) scratchDraw.push(entities[i]);
    }
    scratchDraw.sort((a, b) => (a.z - b.z) || (a.id - b.id));

    for (let i = 0; i < scratchDraw.length; i++) {
      const ent = scratchDraw[i];
      for (let j = 0; j < ent._compDrawFns.length; j++) {
        ent._compDrawFns[j]();
      }
      for (let j = 0; j < ent._drawCbs.length; j++) {
        ent._drawCbs[j](ent);
      }
    }

    // Draw pre-allocated 512-slot particles
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      if (pActive[i] === 0) continue;
      const px = Math.round(pX[i] + shakeOffsetX);
      const py = Math.round(pY[i] + shakeOffsetY);
      const col = pColor[i];
      if (pSize[i] === 2) {
        setPixelFast(px, py, col, 2);
        setPixelFast(px + 1, py, col, 2);
        setPixelFast(px, py + 1, col, 2);
        setPixelFast(px + 1, py + 1, col, 2);
      } else {
        setPixelFast(px, py, col, 2);
      }
    }

    // Scene-level onDraw handlers
    for (let i = 0; i < drawHandlers.length; i++) {
      const h = drawHandlers[i];
      if (!h.active) continue;
      if (h.tag === null) {
        h.fn();
      } else {
        for (let j = 0; j < scratchDraw.length; j++) {
          const ent = scratchDraw[j];
          if (ent.is(h.tag)) h.fn(ent);
        }
      }
    }
  }

  function stepFrame(dtSeconds) {
    frameCount++;
    if (dtSeconds === undefined) {
      stepFixedTick(FIXED_DT);
      renderInternalFrame();
      return 1;
    }

    const clampedDt = Math.min(Math.max(Number(dtSeconds) || 0, 0), 0.1);
    accumulator += clampedDt;
    let steps = 0;
    while (accumulator >= FIXED_DT - 1e-6 && steps < 4) {
      accumulator = Math.max(0, accumulator - FIXED_DT);
      stepFixedTick(FIXED_DT);
      steps++;
    }
    renderInternalFrame();
    return steps;
  }

  function renderToCanvas(ctx, palette, renderOpts = {}) {
    resolvePaletteCache(palette);
    const useShadow = renderOpts.dropShadow1px !== undefined
      ? Boolean(renderOpts.dropShadow1px)
      : dropShadowDefault;

    const shadeMap = palette && palette.shadeMap ? palette.shadeMap : null;

    for (let i = 0; i < PIXEL_COUNT; i++) {
      const off = i * 4;
      const custom = fbCustomRgb[i];
      let r;
      let g;
      let b;
      if (custom !== 0) {
        r = custom & 0xff;
        g = (custom >>> 8) & 0xff;
        b = (custom >>> 16) & 0xff;
      } else {
        const palIdx = fbIndex[i] & 15;
        const pOff = palIdx * 3;
        r = activePaletteRgb[pOff];
        g = activePaletteRgb[pOff + 1];
        b = activePaletteRgb[pOff + 2];
      }

      if (useShadow && fbLayer[i] < 2) {
        const y = (i / WIDTH) | 0;
        const x = i - y * WIDTH;
        if (x > 0 && y > 0 && fbLayer[i - WIDTH - 1] === 2) {
          const palIdx = fbIndex[i];
          if (custom === 0 && palIdx > 0 && palIdx < 16 && shadeMap) {
            const sOff = (shadeMap[palIdx] & 15) * 3;
            r = activePaletteRgb[sOff];
            g = activePaletteRgb[sOff + 1];
            b = activePaletteRgb[sOff + 2];
          } else {
            r = (r * 115) >> 8;
            g = (g * 115) >> 8;
            b = (b * 115) >> 8;
          }
        }
      }

      renderBuffer[off] = r;
      renderBuffer[off + 1] = g;
      renderBuffer[off + 2] = b;
      renderBuffer[off + 3] = 255;
    }

    if (ctx && typeof ctx.putImageData === 'function') {
      if (ctx !== cachedCtx) {
        cachedCtx = ctx;
        cachedImageData = typeof ctx.createImageData === 'function'
          ? ctx.createImageData(WIDTH, HEIGHT)
          : fallbackImageData;
      }
      if (cachedImageData !== fallbackImageData) {
        cachedImageData.data.set(renderBuffer);
      }
      ctx.putImageData(cachedImageData, 0, 0);
      return cachedImageData;
    }
    return fallbackImageData;
  }

  function getParticlePoolStats() {
    let hasNaN = false;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      if (
        !Number.isFinite(pX[i]) ||
        !Number.isFinite(pY[i]) ||
        !Number.isFinite(pVx[i]) ||
        !Number.isFinite(pVy[i]) ||
        !Number.isFinite(pLife[i])
      ) {
        hasNaN = true;
        break;
      }
    }
    return {
      capacity: PARTICLE_POOL_SIZE,
      active: pActiveCount,
      free: PARTICLE_POOL_SIZE - pActiveCount,
      peakActive: pPeakActive,
      totalEmitted: pTotalEmitted,
      overflowRecycled: pOverflowRecycled,
      hasNaN,
      buffers: {
        xLength: pX.length,
        yLength: pY.length,
        vxLength: pVx.length,
        vyLength: pVy.length,
        lifeLength: pLife.length,
        activeLength: pActive.length,
      },
    };
  }

  return {
    scene,
    go,
    add,
    destroy,
    destroyAll,
    get,
    pos,
    vel,
    area,
    body,
    sprite,
    rect,
    circle,
    color,
    opacity,
    scale,
    rotate,
    z,
    lifespan,
    onUpdate,
    onDraw,
    onCollide,
    shake,
    hitStop,
    emitParticles,
    drawPixel,
    drawLine,
    drawSpriteSlot,
    drawTilemap,
    drawText5x7,
    stepFrame,
    renderToCanvas,
    getParticlePoolStats,
    width: () => WIDTH,
    height: () => HEIGHT,
    dt: () => FIXED_DT,
    time: () => simTime,
    frame: () => tickCount,
    getFrameCount: () => frameCount,
    getTrauma: () => trauma,
    getHitStopFrames: () => hitStopFrames,
    getCameraOffset: () => ({ x: shakeOffsetX, y: shakeOffsetY }),
    setSprites: (sprites) => { spriteBank = Array.isArray(sprites) ? sprites : []; },
    getSprites: () => spriteBank,
    setGravity: (g) => { globalGravity = Number(g) || 0; },
    getGravity: () => globalGravity,
    setClearColor: (idx) => { clearColorIndex = idx & 15; },
    clear,
    getFramebuffer: () => ({ index: fbIndex, layer: fbLayer, rgba: renderBuffer }),
  };
}
