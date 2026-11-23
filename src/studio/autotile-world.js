/**
 * BitForge-80 47-Tile Gated 8-Neighbor Autotiler, Cast Depth Shadows & 3-Layer World Editor
 * Bitmask layout: [N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128]
 * Corners require both adjacent cardinal neighbors (e.g. NE requires N & E).
 */

import { getPalette } from './palettes.js';
import { bresenhamLine } from './dither-symmetry.js';

export const TERRAIN_TYPES = Object.freeze({
  EMPTY: 0,
  STONE: 1,
  MOSS: 2,
  CLIFF: 3,
  WATER: 4,
  EMBER: 5,
  REEDS: 6,
  CRYSTAL: 7,
});

export const COLLISION_FLAGS = Object.freeze({
  NONE: 0,
  SOLID: 1,
  BOUNCE: 2,
  HAZARD: 3,
});

const TERRAIN_META = Object.freeze([
  { id: 0, label: 'ERASE', short: 'CLR' },
  { id: 1, label: 'STONE', short: 'STN' },
  { id: 2, label: 'MOSS', short: 'MOS' },
  { id: 3, label: 'CLIFF', short: 'CLF' },
  { id: 4, label: 'WATER', short: 'WTR' },
  { id: 5, label: 'EMBER', short: 'EMB' },
  { id: 6, label: 'REEDS', short: 'RDS' },
  { id: 7, label: 'CRYSTAL', short: 'CRY' },
]);

const COLLISION_META = Object.freeze([
  { id: 0, label: 'NONE', short: 'CLR', rgba: 'rgba(0,0,0,0)' },
  { id: 1, label: 'SOLID', short: 'SLD', rgba: 'rgba(232,236,245,0.34)' },
  { id: 2, label: 'BOUNCE', short: 'BNC', rgba: 'rgba(56,182,255,0.40)' },
  { id: 3, label: 'HAZARD', short: 'HZD', rgba: 'rgba(255,79,110,0.44)' },
]);

const BIT_N = 1;
const BIT_NE = 2;
const BIT_E = 4;
const BIT_SE = 8;
const BIT_S = 16;
const BIT_SW = 32;
const BIT_W = 64;
const BIT_NW = 128;

/**
 * Gate an 8-neighbor bitmask so corner bits only stay active when both adjacent cardinals are set.
 * @param {number} rawMask
 * @returns {number}
 */
function gateMask(rawMask) {
  const m = rawMask & 0xff;
  let gated = m & (BIT_N | BIT_E | BIT_S | BIT_W);
  if ((gated & (BIT_N | BIT_E)) === (BIT_N | BIT_E) && (m & BIT_NE)) gated |= BIT_NE;
  if ((gated & (BIT_E | BIT_S)) === (BIT_E | BIT_S) && (m & BIT_SE)) gated |= BIT_SE;
  if ((gated & (BIT_S | BIT_W)) === (BIT_S | BIT_W) && (m & BIT_SW)) gated |= BIT_SW;
  if ((gated & (BIT_W | BIT_N)) === (BIT_W | BIT_N) && (m & BIT_NW)) gated |= BIT_NW;
  return gated;
}

const CANONICAL_MASKS = [];
const MASK_SET = new Set();
for (let m = 0; m < 256; m++) {
  const g = gateMask(m);
  if (!MASK_SET.has(g)) {
    MASK_SET.add(g);
    CANONICAL_MASKS.push(g);
  }
}
CANONICAL_MASKS.sort((a, b) => a - b);

export const AUTOTILE_47_MASKS = Object.freeze(CANONICAL_MASKS);

const CANONICAL_INDEX_MAP = new Map();
for (let i = 0; i < AUTOTILE_47_MASKS.length; i++) {
  CANONICAL_INDEX_MAP.set(AUTOTILE_47_MASKS[i], i);
}

const MASK_TO_VARIANT_LUT = new Uint8Array(256);
for (let m = 0; m < 256; m++) {
  MASK_TO_VARIANT_LUT[m] = CANONICAL_INDEX_MAP.get(gateMask(m)) ?? 0;
}

/**
 * Compute gated 8-neighbor autotile bitmask for cell (x, y) in a terrain grid.
 * Neighbors match when they contain the same non-zero terrainId.
 * @param {Uint8Array|number[]} grid
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @param {{ connectEdges?: boolean }} [opts]
 * @returns {number}
 */
export function computeAutotileMask(grid, width, height, x, y, opts = {}) {
  const w = width | 0;
  const h = height | 0;
  const cx = x | 0;
  const cy = y | 0;
  if (!grid || w <= 0 || h <= 0 || cx < 0 || cx >= w || cy < 0 || cy >= h) {
    return 0;
  }
  const self = grid[cy * w + cx];
  if (!self) return 0;

  const connectEdges = Boolean(opts && opts.connectEdges);
  const sameAt = (nx, ny) => {
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return connectEdges;
    return grid[ny * w + nx] === self;
  };

  let mask = 0;
  const n = sameAt(cx, cy - 1);
  const e = sameAt(cx + 1, cy);
  const s = sameAt(cx, cy + 1);
  const wSide = sameAt(cx - 1, cy);

  if (n) mask |= BIT_N;
  if (e) mask |= BIT_E;
  if (s) mask |= BIT_S;
  if (wSide) mask |= BIT_W;
  if (n && e && sameAt(cx + 1, cy - 1)) mask |= BIT_NE;
  if (e && s && sameAt(cx + 1, cy + 1)) mask |= BIT_SE;
  if (s && wSide && sameAt(cx - 1, cy + 1)) mask |= BIT_SW;
  if (wSide && n && sameAt(cx - 1, cy - 1)) mask |= BIT_NW;

  return mask;
}

/**
 * Resolve any 8-neighbor bitmask (0..255) into a canonical 47-tile index (0..46).
 * @param {number} mask
 * @returns {number}
 */
export function resolveAutotileIndex(mask) {
  return MASK_TO_VARIANT_LUT[mask & 0xff];
}

/**
 * Resolve every cell of a terrain layer grid into its canonical autotile index (0..46).
 * @param {Uint8Array|number[]} grid
 * @param {number} width
 * @param {number} height
 * @param {{ connectEdges?: boolean }} [opts]
 * @returns {Uint8Array}
 */
export function resolveLayerAutotiles(grid, width, height, opts = {}) {
  const w = Math.max(0, width | 0);
  const h = Math.max(0, height | 0);
  const out = new Uint8Array(w * h);
  if (!grid || grid.length < w * h) return out;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (grid[idx] === 0) {
        out[idx] = 0;
      } else {
        out[idx] = MASK_TO_VARIANT_LUT[computeAutotileMask(grid, w, h, x, y, opts)];
      }
    }
  }
  return out;
}

/**
 * Compute cast depth shadow mask across mainLayer & fgLayer.
 * Returns per-cell bitmask: bit 0 (1)=North cast, bit 1 (2)=West cast, bit 2 (4)=North-West cast.
 * @param {Uint8Array|number[]} mainLayer
 * @param {Uint8Array|number[]} fgLayer
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function computeCastShadowMask(mainLayer, fgLayer, width, height) {
  const w = Math.max(0, width | 0);
  const h = Math.max(0, height | 0);
  const out = new Uint8Array(w * h);
  const hasMain = mainLayer && mainLayer.length >= w * h;
  const hasFg = fgLayer && fgLayer.length >= w * h;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      let sMask = 0;

      if (hasMain && mainLayer[idx] === 0) {
        if (y > 0 && mainLayer[idx - w] > 0) sMask |= 1;
        if (x > 0 && mainLayer[idx - 1] > 0) sMask |= 2;
        if (x > 0 && y > 0 && mainLayer[idx - w - 1] > 0) sMask |= 4;
      }

      if (hasFg && fgLayer[idx] === 0) {
        if (y > 0 && fgLayer[idx - w] > 0) sMask |= 1;
        if (x > 0 && fgLayer[idx - 1] > 0) sMask |= 2;
        if (x > 0 && y > 0 && fgLayer[idx - w - 1] > 0) sMask |= 4;
      }

      out[idx] = sMask;
    }
  }
  return out;
}

const TERRAIN_PALETTE_ROLES = {
  [TERRAIN_TYPES.STONE]: { base: 2, hi: 3, sh: 1, accent: 4, rim: 1 },
  [TERRAIN_TYPES.MOSS]: { base: 8, hi: 4, sh: 9, accent: 2, rim: 1 },
  [TERRAIN_TYPES.CLIFF]: { base: 14, hi: 15, sh: 2, accent: 6, rim: 1 },
  [TERRAIN_TYPES.WATER]: { base: 11, hi: 10, sh: 1, accent: 4, rim: 2 },
  [TERRAIN_TYPES.EMBER]: { base: 5, hi: 6, sh: 1, accent: 7, rim: 1 },
  [TERRAIN_TYPES.REEDS]: { base: 9, hi: 8, sh: 14, accent: 7, rim: 1 },
  [TERRAIN_TYPES.CRYSTAL]: { base: 12, hi: 10, sh: 2, accent: 4, rim: 1 },
};

/**
 * Render an 8x8 tile into `outPixels` (palette indices 0..15) for a terrain ID,
 * canonical 47-tile variant index (0..46), and animation tick.
 * @param {number} terrainId
 * @param {number} variantIdx
 * @param {number} [animTick=0]
 * @param {Uint8Array|null} [outPixels=null]
 * @returns {Uint8Array}
 */
export function renderAutotile8x8(terrainId, variantIdx, animTick = 0, outPixels = null) {
  const buf = outPixels && outPixels.length >= 64 ? outPixels : new Uint8Array(64);
  const tid = terrainId | 0;
  if (tid <= 0) {
    buf.fill(0, 0, 64);
    return buf;
  }

  const normalizedTid = tid <= 7 ? tid : (((tid - 1) % 7) + 1);
  const role = TERRAIN_PALETTE_ROLES[normalizedTid];
  const vIdx = Math.max(0, Math.min(AUTOTILE_47_MASKS.length - 1, variantIdx | 0));
  const mask = AUTOTILE_47_MASKS[vIdx];
  const tick = animTick | 0;

  const hasN = (mask & BIT_N) !== 0;
  const hasNE = (mask & BIT_NE) !== 0;
  const hasE = (mask & BIT_E) !== 0;
  const hasSE = (mask & BIT_SE) !== 0;
  const hasS = (mask & BIT_S) !== 0;
  const hasSW = (mask & BIT_SW) !== 0;
  const hasW = (mask & BIT_W) !== 0;
  const hasNW = (mask & BIT_NW) !== 0;

  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      let col = role.base;
      const hash = ((px * 29 + py * 17 + normalizedTid * 13) & 15);

      if (normalizedTid === TERRAIN_TYPES.STONE) {
        if ((px === 2 && py === 2) || (px === 5 && py === 5)) col = role.hi;
        else if (hash < 3) col = role.sh;
        else if (hash === 15) col = role.hi;
      } else if (normalizedTid === TERRAIN_TYPES.MOSS) {
        if (((px + py) & 3) === 0) col = role.sh;
        if (py === 2 && (px === 2 || px === 5)) col = role.hi;
        else if (hash === 1) col = role.accent;
      } else if (normalizedTid === TERRAIN_TYPES.CLIFF) {
        if (py === 3 || py === 6) col = role.sh;
        else if (px === 2 && py === 1) col = role.hi;
        else if (hash < 2) col = role.accent;
      } else if (normalizedTid === TERRAIN_TYPES.WATER) {
        const phase = (tick >> 3) & 7;
        const crest = ((px + py * 2 + phase) & 7) === 0;
        const shimmer = ((px * 3 + py + (tick >> 4)) & 5) === 0;
        col = crest ? role.accent : (shimmer ? role.hi : role.base);
      } else if (normalizedTid === TERRAIN_TYPES.EMBER) {
        const pulse = ((tick >> 2) + px * 2 + py * 3) & 7;
        if (pulse === 0) col = role.accent;
        else if (pulse <= 2) col = role.hi;
        else if (hash < 3) col = role.sh;
      } else if (normalizedTid === TERRAIN_TYPES.REEDS) {
        const sway = ((tick >> 4) & 1) === 0 ? 0 : 1;
        if ((px === 2 + sway || px === 5 - sway) && py >= 1 && py <= 6) {
          col = py === 1 ? role.accent : role.hi;
        } else if (py >= 6) {
          col = role.sh;
        } else {
          col = role.base;
        }
      } else if (normalizedTid === TERRAIN_TYPES.CRYSTAL) {
        const dist = Math.abs(px - 3.5) + Math.abs(py - 3.5);
        if (dist < 1.6) col = role.accent;
        else if (dist < 3.1) col = role.hi;
        else if (hash < 2) col = role.sh;
      }

      // 47-tile bevels & exposed edge outlines
      const onTop = !hasN && py === 0;
      const onBottom = !hasS && py === 7;
      const onLeft = !hasW && px === 0;
      const onRight = !hasE && px === 7;

      if (onTop || onBottom || onLeft || onRight) {
        col = role.rim;
      } else {
        if (!hasN && py === 1) col = role.hi;
        else if (!hasW && px === 1) col = role.hi;
        if (!hasS && py === 6) col = role.sh;
        else if (!hasE && px === 6) col = role.sh;
      }

      // Inner concave corner notches when both adjacent cardinals exist but diagonal is open
      if (hasN && hasW && !hasNW && px === 0 && py === 0) col = role.rim;
      if (hasN && hasE && !hasNE && px === 7 && py === 0) col = role.rim;
      if (hasS && hasE && !hasSE && px === 7 && py === 7) col = role.rim;
      if (hasS && hasW && !hasSW && px === 0 && py === 7) col = role.rim;

      buf[py * 8 + px] = col;
    }
  }

  return buf;
}

function resizeLayerGrid(oldGrid, oldW, oldH, newW, newH) {
  const next = new Uint8Array(newW * newH);
  if (!oldGrid) return next;
  const copyW = Math.min(oldW, newW);
  const copyH = Math.min(oldH, newH);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      next[y * newW + x] = oldGrid[y * oldW + x];
    }
  }
  return next;
}

/**
 * Create the 3-Layer 47-Tile Autotile & Collision World Editor.
 * @param {{ container?: any, toolStrip?: any, getCart?: () => any, onMutate?: (info: any) => void, bus?: any }} [opts]
 */
export function createWorldEditor({
  container = null,
  toolStrip = null,
  getCart = null,
  onMutate = null,
  bus = null,
} = {}) {
  let mounted = false;
  let activeLayer = 'main'; // 'bg' | 'main' | 'fg' | 'collision'
  let activeTerrain = TERRAIN_TYPES.STONE;
  let activeCollision = COLLISION_FLAGS.SOLID;
  let showShadows = true;
  let showCollisionOverlay = false;
  let animatePreview = true;
  let animTick = 0;
  let rafId = null;

  let rootEl = null;
  let canvasEl = null;
  let ctx2d = null;
  let layerBtns = {};
  let paletteBarEl = null;
  let sizeBtn = null;
  let shadowBtn = null;
  let animBtn = null;
  let toolStripEl = null;

  let pointerDown = false;
  let lastCell = null;
  const scratchTile = new Uint8Array(64);
  let cachedImageData = null;

  function readCart() {
    return typeof getCart === 'function' ? getCart() : null;
  }

  function ensureWorld(cart) {
    if (!cart) return null;
    if (!cart.world) {
      cart.world = {
        width: 16,
        height: 16,
        bgLayer: new Uint8Array(256),
        mainLayer: new Uint8Array(256),
        fgLayer: new Uint8Array(256),
        collision: new Uint8Array(256),
      };
    }
    const w = cart.world.width === 32 ? 32 : 16;
    const h = cart.world.height === 32 ? 32 : w;
    cart.world.width = w;
    cart.world.height = h;
    const len = w * h;
    if (!(cart.world.bgLayer instanceof Uint8Array) || cart.world.bgLayer.length !== len) {
      cart.world.bgLayer = resizeLayerGrid(cart.world.bgLayer, w, h, w, h);
    }
    if (!(cart.world.mainLayer instanceof Uint8Array) || cart.world.mainLayer.length !== len) {
      cart.world.mainLayer = resizeLayerGrid(cart.world.mainLayer, w, h, w, h);
    }
    if (!(cart.world.fgLayer instanceof Uint8Array) || cart.world.fgLayer.length !== len) {
      cart.world.fgLayer = resizeLayerGrid(cart.world.fgLayer, w, h, w, h);
    }
    if (!(cart.world.collision instanceof Uint8Array) || cart.world.collision.length !== len) {
      cart.world.collision = resizeLayerGrid(cart.world.collision, w, h, w, h);
    }
    return cart.world;
  }

  function emitBus(eventName, payload) {
    if (bus && typeof bus.emit === 'function') {
      bus.emit(eventName, payload);
    }
  }

  function notifyMutate(reason) {
    const cart = readCart();
    if (typeof onMutate === 'function') {
      onMutate({ type: reason, source: 'world-editor', cart });
    }
  }

  function getActivePalette() {
    const cart = readCart();
    return getPalette(cart?.meta?.paletteId || 'classic16', cart?.meta?.customPalette || null);
  }

  function paintCell(tx, ty) {
    const cart = readCart();
    const world = ensureWorld(cart);
    if (!world) return false;
    const cx = Math.floor(tx);
    const cy = Math.floor(ty);
    if (cx < 0 || cx >= world.width || cy < 0 || cy >= world.height) return false;

    const idx = cy * world.width + cx;
    let changed = false;
    let mask = 0;
    let variantIdx = 0;

    if (activeLayer === 'collision') {
      if (world.collision[idx] !== activeCollision) {
        world.collision[idx] = activeCollision;
        changed = true;
      }
    } else {
      const targetGrid =
        activeLayer === 'bg'
          ? world.bgLayer
          : (activeLayer === 'fg' ? world.fgLayer : world.mainLayer);
      if (targetGrid[idx] !== activeTerrain) {
        targetGrid[idx] = activeTerrain;
        changed = true;
      }
      mask = computeAutotileMask(targetGrid, world.width, world.height, cx, cy);
      variantIdx = resolveAutotileIndex(mask);
    }

    if (changed) {
      emitBus('foley:autotile', {
        tx: cx,
        ty: cy,
        x: cx,
        y: cy,
        yRow: cy,
        layer: activeLayer,
        terrainId: activeLayer === 'collision' ? 0 : activeTerrain,
        collisionFlag: activeLayer === 'collision' ? activeCollision : world.collision[idx],
        mask,
        variantIdx,
        source: 'world-editor',
      });
      notifyMutate('world');
      renderCanvas();
    }
    return changed;
  }

  function paintSegment(x0, y0, x1, y1) {
    const pts = bresenhamLine(x0, y0, x1, y1);
    let anyChanged = false;
    for (let i = 0; i < pts.length; i++) {
      if (paintCell(pts[i].x, pts[i].y)) anyChanged = true;
    }
    return anyChanged;
  }

  function setWorldSize(nextSize) {
    const targetSize = nextSize === 32 ? 32 : 16;
    const cart = readCart();
    const world = ensureWorld(cart);
    if (!world || world.width === targetSize) return;

    const oldW = world.width;
    const oldH = world.height;
    world.bgLayer = resizeLayerGrid(world.bgLayer, oldW, oldH, targetSize, targetSize);
    world.mainLayer = resizeLayerGrid(world.mainLayer, oldW, oldH, targetSize, targetSize);
    world.fgLayer = resizeLayerGrid(world.fgLayer, oldW, oldH, targetSize, targetSize);
    world.collision = resizeLayerGrid(world.collision, oldW, oldH, targetSize, targetSize);
    world.width = targetSize;
    world.height = targetSize;

    emitBus('foley:switch', { action: 'world-size', size: targetSize, source: 'world-editor' });
    notifyMutate('world-size');
    refresh();
  }

  function selectLayer(layer) {
    if (layer === 'bg' || layer === 'main' || layer === 'fg' || layer === 'collision') {
      activeLayer = layer;
      emitBus('foley:switch', { action: 'layer', layer, source: 'world-editor' });
      syncControls();
      renderCanvas();
    }
  }

  function selectTerrain(terrainId) {
    const tid = Math.max(0, Math.min(7, terrainId | 0));
    activeTerrain = tid;
    if (activeLayer === 'collision') activeLayer = 'main';
    emitBus('foley:switch', { action: 'terrain', terrainId: tid, source: 'world-editor' });
    syncControls();
  }

  function selectCollision(flag) {
    const cFlag = Math.max(0, Math.min(3, flag | 0));
    activeCollision = cFlag;
    activeLayer = 'collision';
    emitBus('foley:switch', { action: 'collision', collisionFlag: cFlag, source: 'world-editor' });
    syncControls();
    renderCanvas();
  }

  function setAnimTick(tick) {
    animTick = tick | 0;
    renderCanvas();
  }

  function stepAnimation(ticks = 1) {
    animTick += Math.max(1, ticks | 0);
    renderCanvas();
  }

  function renderCanvas() {
    if (!canvasEl || !ctx2d) return;
    const cart = readCart();
    const world = ensureWorld(cart);
    if (!world) return;

    const tw = world.width;
    const th = world.height;
    const pxW = tw * 8;
    const pxH = th * 8;

    if (canvasEl.width !== pxW) canvasEl.width = pxW;
    if (canvasEl.height !== pxH) canvasEl.height = pxH;

    const pal = getActivePalette();
    const bgVars = resolveLayerAutotiles(world.bgLayer, tw, th);
    const mainVars = resolveLayerAutotiles(world.mainLayer, tw, th);
    const fgVars = resolveLayerAutotiles(world.fgLayer, tw, th);
    const shadowMask = showShadows
      ? computeCastShadowMask(world.mainLayer, world.fgLayer, tw, th)
      : null;

    if (!cachedImageData || cachedImageData.width !== pxW || cachedImageData.height !== pxH) {
      cachedImageData = typeof ctx2d.createImageData === 'function'
        ? ctx2d.createImageData(pxW, pxH)
        : { width: pxW, height: pxH, data: new Uint8ClampedArray(pxW * pxH * 4) };
    }

    const data = cachedImageData.data;
    const bgR = pal.rgb[0];
    const bgG = pal.rgb[1];
    const bgB = pal.rgb[2];

    for (let i = 0; i < pxW * pxH; i++) {
      const off = i * 4;
      data[off] = bgR;
      data[off + 1] = bgG;
      data[off + 2] = bgB;
      data[off + 3] = 255;
    }

    const blitLayer = (grid, vars, isLowerLayer) => {
      for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
          const cellIdx = ty * tw + tx;
          const tid = grid[cellIdx];
          if (tid === 0) continue;
          renderAutotile8x8(tid, vars[cellIdx], animTick, scratchTile);
          const cellShadow = isLowerLayer && shadowMask ? shadowMask[cellIdx] : 0;

          for (let py = 0; py < 8; py++) {
            const dstY = ty * 8 + py;
            for (let px = 0; px < 8; px++) {
              let colIdx = scratchTile[py * 8 + px];
              if (colIdx === 0) continue;
              if (cellShadow !== 0) {
                const inTop = (cellShadow & 1) && py === 0;
                const inLeft = (cellShadow & 2) && px === 0;
                const inCorner = (cellShadow & 4) && px === 0 && py === 0;
                if (inTop || inLeft || inCorner) {
                  colIdx = pal.shadeMap[colIdx];
                }
              }
              const dstOff = (dstY * pxW + (tx * 8 + px)) * 4;
              const pOff = (colIdx & 15) * 3;
              data[dstOff] = pal.rgb[pOff];
              data[dstOff + 1] = pal.rgb[pOff + 1];
              data[dstOff + 2] = pal.rgb[pOff + 2];
              data[dstOff + 3] = 255;
            }
          }
        }
      }
    };

    blitLayer(world.bgLayer, bgVars, true);
    blitLayer(world.mainLayer, mainVars, true);
    blitLayer(world.fgLayer, fgVars, false);

    if (typeof ctx2d.putImageData === 'function') {
      ctx2d.putImageData(cachedImageData, 0, 0);
    }

    if ((showCollisionOverlay || activeLayer === 'collision') && typeof ctx2d.fillRect === 'function') {
      for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
          const flag = world.collision[ty * tw + tx];
          if (!flag) continue;
          const meta = COLLISION_META[flag];
          if (!meta) continue;
          ctx2d.fillStyle = meta.rgba;
          ctx2d.fillRect(tx * 8, ty * 8, 8, 8);
        }
      }
    }
  }

  function syncControls() {
    for (const [key, btn] of Object.entries(layerBtns)) {
      if (!btn) continue;
      btn.dataset.active = key === activeLayer ? 'true' : 'false';
      btn.setAttribute('aria-pressed', String(key === activeLayer));
    }

    const cart = readCart();
    const world = ensureWorld(cart);
    if (sizeBtn && world) {
      sizeBtn.textContent = `${world.width}x${world.height}`;
    }
    if (shadowBtn) {
      shadowBtn.dataset.active = showShadows ? 'true' : 'false';
      shadowBtn.textContent = showShadows ? 'SHD ON' : 'SHD OFF';
    }
    if (animBtn) {
      animBtn.dataset.active = animatePreview ? 'true' : 'false';
      animBtn.textContent = animatePreview ? 'ANIM ON' : 'ANIM OFF';
    }

    if (paletteBarEl && paletteBarEl.ownerDocument) {
      const doc = paletteBarEl.ownerDocument;
      paletteBarEl.innerHTML = '';
      if (activeLayer === 'collision') {
        for (const c of COLLISION_META) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'bf-world-chip';
          btn.textContent = c.short;
          btn.dataset.active = c.id === activeCollision ? 'true' : 'false';
          btn.addEventListener('click', () => selectCollision(c.id));
          paletteBarEl.appendChild(btn);
        }
      } else {
        for (const t of TERRAIN_META) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'bf-world-chip';
          btn.textContent = t.short;
          btn.dataset.active = t.id === activeTerrain ? 'true' : 'false';
          btn.addEventListener('click', () => selectTerrain(t.id));
          paletteBarEl.appendChild(btn);
        }
      }
    }
  }

  function pointerToTile(ev) {
    if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') return null;
    const cart = readCart();
    const world = ensureWorld(cart);
    if (!world) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const tx = Math.floor(((ev.clientX - rect.left) / rect.width) * world.width);
    const ty = Math.floor(((ev.clientY - rect.top) / rect.height) * world.height);
    if (tx < 0 || tx >= world.width || ty < 0 || ty >= world.height) return null;
    return { tx, ty };
  }

  function startAnimLoop() {
    if (rafId !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    const step = () => {
      if (!mounted) {
        rafId = null;
        return;
      }
      if (animatePreview) {
        animTick = (animTick + 1) & 0x7fffffff;
        renderCanvas();
      }
      rafId = globalThis.requestAnimationFrame(step);
    };
    rafId = globalThis.requestAnimationFrame(step);
  }

  function stopAnimLoop() {
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function refresh() {
    syncControls();
    renderCanvas();
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    if (container && container.ownerDocument) {
      const doc = container.ownerDocument;
      rootEl = doc.createElement('div');
      rootEl.className = 'bf-world-editor';

      const header = doc.createElement('div');
      header.className = 'bf-world-header';

      for (const l of ['bg', 'main', 'fg', 'collision']) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bf-world-layer-btn';
        btn.textContent = l === 'collision' ? 'COL' : l.toUpperCase();
        btn.addEventListener('click', () => selectLayer(l));
        layerBtns[l] = btn;
        header.appendChild(btn);
      }

      sizeBtn = doc.createElement('button');
      sizeBtn.type = 'button';
      sizeBtn.className = 'bf-world-size-btn';
      sizeBtn.addEventListener('click', () => {
        const world = ensureWorld(readCart());
        setWorldSize(world && world.width === 32 ? 16 : 32);
      });
      header.appendChild(sizeBtn);

      shadowBtn = doc.createElement('button');
      shadowBtn.type = 'button';
      shadowBtn.className = 'bf-world-toggle-btn';
      shadowBtn.addEventListener('click', () => {
        showShadows = !showShadows;
        emitBus('foley:switch', { action: 'shadow', enabled: showShadows, source: 'world-editor' });
        refresh();
      });
      header.appendChild(shadowBtn);

      animBtn = doc.createElement('button');
      animBtn.type = 'button';
      animBtn.className = 'bf-world-toggle-btn';
      animBtn.addEventListener('click', () => {
        animatePreview = !animatePreview;
        emitBus('foley:switch', { action: 'anim', enabled: animatePreview, source: 'world-editor' });
        syncControls();
      });
      header.appendChild(animBtn);

      rootEl.appendChild(header);

      canvasEl = doc.createElement('canvas');
      canvasEl.className = 'bf-world-canvas';
      canvasEl.width = 128;
      canvasEl.height = 128;
      canvasEl.style.imageRendering = 'pixelated';
      ctx2d = typeof canvasEl.getContext === 'function' ? canvasEl.getContext('2d') : null;

      canvasEl.addEventListener('pointerdown', (ev) => {
        pointerDown = true;
        const cell = pointerToTile(ev);
        if (cell) {
          lastCell = cell;
          paintCell(cell.tx, cell.ty);
        }
      });
      canvasEl.addEventListener('pointermove', (ev) => {
        if (!pointerDown) return;
        const cell = pointerToTile(ev);
        if (cell) {
          if (lastCell) paintSegment(lastCell.tx, lastCell.ty, cell.tx, cell.ty);
          else paintCell(cell.tx, cell.ty);
          lastCell = cell;
        }
      });
      const endStroke = () => {
        pointerDown = false;
        lastCell = null;
      };
      canvasEl.addEventListener('pointerup', endStroke);
      canvasEl.addEventListener('pointercancel', endStroke);

      rootEl.appendChild(canvasEl);

      paletteBarEl = doc.createElement('div');
      paletteBarEl.className = 'bf-world-palette-bar';
      rootEl.appendChild(paletteBarEl);

      container.appendChild(rootEl);
    }

    if (toolStrip && toolStrip.ownerDocument) {
      const doc = toolStrip.ownerDocument;
      toolStripEl = doc.createElement('button');
      toolStripEl.type = 'button';
      toolStripEl.className = 'bf-tool-pill';
      toolStripEl.textContent = 'COL VIEW';
      toolStripEl.addEventListener('click', () => {
        showCollisionOverlay = !showCollisionOverlay;
        toolStripEl.dataset.active = showCollisionOverlay ? 'true' : 'false';
        emitBus('foley:switch', { action: 'collision-overlay', enabled: showCollisionOverlay, source: 'world-editor' });
        renderCanvas();
      });
      toolStrip.appendChild(toolStripEl);
    }

    refresh();
    startAnimLoop();
  }

  function unmount() {
    mounted = false;
    stopAnimLoop();
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    if (toolStripEl && toolStripEl.parentNode) {
      toolStripEl.parentNode.removeChild(toolStripEl);
    }
    rootEl = null;
    canvasEl = null;
    ctx2d = null;
    layerBtns = {};
    paletteBarEl = null;
    sizeBtn = null;
    shadowBtn = null;
    animBtn = null;
    toolStripEl = null;
    cachedImageData = null;
  }

  return {
    mount,
    unmount,
    destroy: unmount,
    refresh,
    selectLayer,
    selectTerrain,
    selectCollision,
    setWorldSize,
    paintCell,
    setAnimTick,
    stepAnimation,
    getState: () => {
      const world = ensureWorld(readCart());
      return {
        mounted,
        activeLayer,
        activeTerrain,
        activeCollision,
        showShadows,
        showCollisionOverlay,
        animatePreview,
        animTick,
        width: world ? world.width : 16,
        height: world ? world.height : 16,
      };
    },
  };
}
