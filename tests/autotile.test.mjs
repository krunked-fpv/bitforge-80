import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PALETTES, PALETTE_ORDER, getPalette } from '../src/studio/palettes.js';
import {
  BAYER_ROLLERS,
  sampleDitherRoller,
  getSymmetryCoords,
  bresenhamLine,
  applyOutline1px,
  createDominoFloodJob,
  stepDominoFloodJob,
} from '../src/studio/dither-symmetry.js';
import {
  AUTOTILE_47_MASKS,
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  resolveLayerAutotiles,
  computeCastShadowMask,
  renderAutotile8x8,
  createWorldEditor,
} from '../src/studio/autotile-world.js';
import { createSpriteEditor } from '../src/studio/sprite-editor.js';
import { createEmptyCartridgeROM } from '../src/cart/bitpack-rom.js';
import { kaboom } from '../src/vendor/kaboom-core.js';

function createMockBus() {
  const events = [];
  const listeners = new Map();
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
      const fns = listeners.get(name) || [];
      for (const fn of fns) fn(payload);
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const list = listeners.get(name);
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };
}

function makeMockDom() {
  function makeMockCtx() {
    return {
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      createImageData(w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData() {},
      fillRect() {},
      strokeRect() {},
    };
  }

  function makeEl(tag) {
    const isCanvas = tag.toLowerCase() === 'canvas';
    const ctx = isCanvas ? makeMockCtx() : null;
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      _innerHTML: '',
      value: '',
      type: '',
      width: isCanvas ? 128 : 0,
      height: isCanvas ? 128 : 0,
      style: {},
      dataset: {},
      attrs: {},
      children: [],
      parentNode: null,
      listeners: {},
      ownerDocument: null,
      set innerHTML(v) {
        this._innerHTML = String(v);
        if (v === '') this.children = [];
      },
      get innerHTML() {
        return this._innerHTML;
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
      },
      addEventListener(type, fn) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
      },
      dispatch(type, extra = {}) {
        const ev = { target: this, ...extra };
        for (const fn of this.listeners[type] || []) fn(ev);
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 128, height: 128 };
      },
      getContext: isCanvas ? () => ctx : undefined,
    };
    el.ownerDocument = doc;
    return el;
  }

  const doc = { createElement: makeEl };
  return doc;
}

test('1. Palettes: 5 boutique palettes, little-endian rgba32, 4-step luminance ramps, and customPalette override', () => {
  assert.deepEqual([...PALETTE_ORDER], ['classic16', 'sakura', 'matcha', 'amber', 'frost80']);

  for (const id of PALETTE_ORDER) {
    const pal = getPalette(id);
    assert.equal(pal, PALETTES[id]);
    assert.equal(pal.id, id);
    assert.equal(pal.hex.length, 16);
    assert.ok(pal.rgb instanceof Uint8Array && pal.rgb.length === 48);
    assert.ok(pal.rgba32 instanceof Uint32Array && pal.rgba32.length === 16);
    assert.ok(pal.luminance instanceof Float32Array && pal.luminance.length === 16);
    assert.ok(pal.shadeMap instanceof Uint8Array && pal.shadeMap.length === 16);
    assert.ok(pal.highlightMap instanceof Uint8Array && pal.highlightMap.length === 16);

    // Index 0 is dark chassis/transparent base
    assert.ok(pal.luminance[0] < 0.12, `${id} index 0 must be dark`);
    assert.equal(pal.shadeMap[0], 0);
    assert.equal(pal.highlightMap[0], 0);

    // Check exact little-endian rgba32 layout & luminance bounds
    for (let i = 0; i < 16; i++) {
      const r = pal.rgb[i * 3];
      const g = pal.rgb[i * 3 + 1];
      const b = pal.rgb[i * 3 + 2];
      const expectedRgba32 = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
      assert.equal(pal.rgba32[i], expectedRgba32);
      assert.equal(
        pal.hex[i],
        `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
      );
      assert.ok(pal.luminance[i] >= 0 && pal.luminance[i] <= 1);
    }

    // Verify shadeMap / highlightMap bounds, monotonicity, and <= 4-step convergence
    let darkestIdx = 1;
    let brightestIdx = 1;
    for (let i = 1; i < 16; i++) {
      if (pal.luminance[i] < pal.luminance[darkestIdx]) darkestIdx = i;
      if (pal.luminance[i] > pal.luminance[brightestIdx]) brightestIdx = i;
    }

    for (let i = 1; i < 16; i++) {
      const sh = pal.shadeMap[i];
      const hi = pal.highlightMap[i];
      assert.ok(sh >= 1 && sh <= 15);
      assert.ok(hi >= 1 && hi <= 15);
      assert.ok(pal.luminance[sh] <= pal.luminance[i]);
      assert.ok(pal.luminance[hi] >= pal.luminance[i]);

      let curSh = i;
      let curHi = i;
      for (let step = 0; step < 4; step++) {
        curSh = pal.shadeMap[curSh];
        curHi = pal.highlightMap[curHi];
      }
      assert.equal(curSh, darkestIdx, `${id}: color ${i} must converge to darkest in <=4 steps`);
      assert.equal(curHi, brightestIdx, `${id}: color ${i} must converge to brightest in <=4 steps`);
    }
  }

  // Custom 48-byte RGB override + integration with kaboom-core renderToCanvas
  const customBytes = new Uint8Array(48);
  for (let i = 0; i < 16; i++) {
    customBytes[i * 3] = i * 16;
    customBytes[i * 3 + 1] = (i * 11 + 20) & 255;
    customBytes[i * 3 + 2] = 255 - i * 15;
  }
  const customPal = getPalette('sakura', customBytes);
  assert.equal(customPal.id, 'sakura');
  assert.equal(customPal.rgb[3], 16);
  assert.equal(customPal.rgb[4], 31);
  assert.equal(customPal.rgb[5], 240);
  assert.equal(customPal.rgba32[1], ((255 << 24) | (240 << 16) | (31 << 8) | 16) >>> 0);

  const k = kaboom({ dustMotes: false, dropShadow1px: false });
  k.scene('pal', () => {
    k.onDraw(() => k.drawPixel(10, 10, 1));
  });
  k.go('pal');
  k.stepFrame();
  const img = k.renderToCanvas(null, customPal);
  const off = (10 * 128 + 10) * 4;
  assert.equal(img.data[off], 16);
  assert.equal(img.data[off + 1], 31);
  assert.equal(img.data[off + 2], 240);
});

test('2. Autotiler: all 256 neighbor configurations resolve into exact 0..46 indices across 47 canonical masks', () => {
  assert.equal(AUTOTILE_47_MASKS.length, 47);
  assert.equal(new Set(AUTOTILE_47_MASKS).size, 47);
  assert.deepEqual(TERRAIN_TYPES, {
    EMPTY: 0, STONE: 1, MOSS: 2, CLIFF: 3, WATER: 4, EMBER: 5, REEDS: 6, CRYSTAL: 7,
  });
  assert.deepEqual(COLLISION_FLAGS, { NONE: 0, SOLID: 1, BOUNCE: 2, HAZARD: 3 });

  // Verify corner gating invariant on every canonical mask
  for (const m of AUTOTILE_47_MASKS) {
    if (m & 2) assert.equal(m & 5, 5, 'NE requires N & E');
    if (m & 8) assert.equal(m & 20, 20, 'SE requires E & S');
    if (m & 32) assert.equal(m & 80, 80, 'SW requires S & W');
    if (m & 128) assert.equal(m & 65, 65, 'NW requires W & N');
  }

  // Test all 256 8-neighbor combinations on a 3x3 grid around (1, 1)
  const neighborOffsets = [
    { bit: 1, dx: 0, dy: -1 },   // N
    { bit: 2, dx: 1, dy: -1 },   // NE
    { bit: 4, dx: 1, dy: 0 },    // E
    { bit: 8, dx: 1, dy: 1 },    // SE
    { bit: 16, dx: 0, dy: 1 },   // S
    { bit: 32, dx: -1, dy: 1 },  // SW
    { bit: 64, dx: -1, dy: 0 },  // W
    { bit: 128, dx: -1, dy: -1 }, // NW
  ];

  const hitIndices = new Set();
  for (let raw = 0; raw < 256; raw++) {
    const grid = new Uint8Array(9);
    grid[4] = TERRAIN_TYPES.STONE;
    for (const n of neighborOffsets) {
      if ((raw & n.bit) !== 0) {
        grid[(1 + n.dy) * 3 + (1 + n.dx)] = TERRAIN_TYPES.STONE;
      }
    }
    const mask = computeAutotileMask(grid, 3, 3, 1, 1);
    assert.ok(AUTOTILE_47_MASKS.includes(mask), `computed mask ${mask} must be canonical`);
    const idx = resolveAutotileIndex(mask);
    assert.ok(idx >= 0 && idx <= 46);
    assert.equal(AUTOTILE_47_MASKS[idx], mask);
    assert.equal(resolveAutotileIndex(raw), idx, 'raw mask gating must match grid calculation');
    hitIndices.add(idx);
  }
  assert.equal(hitIndices.size, 47, 'all 47 canonical tile variants must be reachable');

  // Distinct terrains do not merge across borders in resolveLayerAutotiles
  const mixed = new Uint8Array(16 * 16);
  mixed[2 * 16 + 2] = TERRAIN_TYPES.STONE;
  mixed[2 * 16 + 3] = TERRAIN_TYPES.WATER;
  const resolved = resolveLayerAutotiles(mixed, 16, 16);
  assert.equal(resolved[2 * 16 + 2], 0);
  assert.equal(resolved[2 * 16 + 3], 0);
  assert.equal(resolved[0], 0);

  // Every canonical variant 0..46 renders a distinct 8x8 tile pattern, and water/ember/reeds animate
  const variantsSeen = new Set();
  for (let v = 0; v < 47; v++) {
    const tile = renderAutotile8x8(TERRAIN_TYPES.STONE, v, 0);
    assert.equal(tile.length, 64);
    variantsSeen.add(Array.from(tile).join(','));
  }
  assert.equal(variantsSeen.size, 47);

  const emptyTile = renderAutotile8x8(TERRAIN_TYPES.EMPTY, 0, 0);
  assert.equal(emptyTile.every((p) => p === 0), true);

  for (const tid of [TERRAIN_TYPES.WATER, TERRAIN_TYPES.EMBER, TERRAIN_TYPES.REEDS]) {
    const f0 = renderAutotile8x8(tid, 46, 0);
    const f1 = renderAutotile8x8(tid, 46, 16);
    assert.notDeepEqual(f0, f1, `terrain ${tid} should animate across ticks`);
  }
});

test('3. Cast shadow mask calculation across mainLayer and fgLayer', () => {
  const w = 6;
  const h = 6;
  const main = new Uint8Array(w * h);
  const fg = new Uint8Array(w * h);

  assert.equal(computeCastShadowMask(main, fg, w, h).every((v) => v === 0), true);

  // Elevated STONE block at (2, 2) casts S (1), E (2), and SE (4) shadows onto empty cells
  main[2 * w + 2] = TERRAIN_TYPES.STONE;
  // Foreground canopy at (4, 1) casts shadow onto main-layer floor at (4, 2), (5, 1), (5, 2)
  main[2 * w + 4] = TERRAIN_TYPES.MOSS;
  fg[1 * w + 4] = TERRAIN_TYPES.REEDS;

  const shadows = computeCastShadowMask(main, fg, w, h);
  assert.equal(shadows[2 * w + 2], 0, 'occluder cell does not shadow itself');
  assert.equal(shadows[3 * w + 2] & 1, 1, 'south cell gets north-cast shadow bit');
  assert.equal(shadows[2 * w + 3] & 2, 2, 'east cell gets west-cast shadow bit');
  assert.equal(shadows[3 * w + 3] & 4, 4, 'south-east cell gets NW-cast corner shadow bit');
  assert.equal(shadows[2 * w + 4] & 1, 1, 'fgLayer casts shadow onto lower mainLayer cell');
  assert.equal(shadows[0], 0);
});

test('4. Dither rollers, bresenhamLine, applyOutline1px, symmetry mirrors, and 120Hz Domino Flood-Fill', () => {
  assert.equal(BAYER_ROLLERS.length, 8);
  assert.deepEqual(
    BAYER_ROLLERS.map((r) => r.name),
    ['12.5%', '25%', '37.5%', '50%', '62.5%', '75%', '87.5%', 'diagonal-wave']
  );

  // Verify exact pixel fill counts for the 7 Bayer density rollers
  const expectedCounts = [2, 4, 6, 8, 10, 12, 14];
  for (let r = 0; r < 7; r++) {
    let fgCount = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (sampleDitherRoller(r, x, y, 7, 1) === 7) fgCount++;
      }
    }
    assert.equal(fgCount, expectedCounts[r]);
  }
  assert.equal(sampleDitherRoller('diagonal-wave', -1, -1, 9, 2), 9);

  // Bresenham line
  const diag = bresenhamLine(0, 0, 4, 2);
  assert.deepEqual(diag[0], { x: 0, y: 0 });
  assert.deepEqual(diag[diag.length - 1], { x: 4, y: 2 });
  assert.equal(diag.length, 5);
  assert.deepEqual(bresenhamLine(3, 3, 3, 3), [{ x: 3, y: 3 }]);

  // 1px outline (4-connected, preserves input frame immutably)
  const spr = new Uint8Array(64);
  spr[3 * 8 + 3] = 5;
  spr[3 * 8 + 4] = 5;
  const outlined = applyOutline1px(spr, 8, 1);
  assert.equal(spr[2 * 8 + 3], 0, 'original frame remains unmutated');
  assert.equal(outlined[3 * 8 + 3], 5);
  assert.equal(outlined[3 * 8 + 4], 5);
  assert.equal(outlined[2 * 8 + 3], 1);
  assert.equal(outlined[4 * 8 + 3], 1);
  assert.equal(outlined[3 * 8 + 2], 1);
  assert.equal(outlined[3 * 8 + 5], 1);
  assert.equal(outlined[2 * 8 + 2], 0, 'diagonal corner stays transparent on 4-connected outline');

  // Symmetry modes + diagonal deduplication
  assert.deepEqual(getSymmetryCoords('none', 2, 1, 8), [{ x: 2, y: 1 }]);
  assert.deepEqual(getSymmetryCoords('x', 1, 2, 8), [{ x: 1, y: 2 }, { x: 6, y: 2 }]);
  assert.deepEqual(getSymmetryCoords('y', 1, 2, 8), [{ x: 1, y: 2 }, { x: 1, y: 5 }]);
  assert.equal(getSymmetryCoords('quad', 1, 2, 8).length, 4);
  assert.deepEqual(getSymmetryCoords('radial', 1, 0, 8), [
    { x: 1, y: 0 },
    { x: 7, y: 1 },
    { x: 6, y: 7 },
    { x: 0, y: 6 },
  ]);
  assert.equal(getSymmetryCoords('radial', 0, 0, 8).length, 4);
  assert.equal(getSymmetryCoords('none', -1, 0, 8).length, 0);

  // 120Hz Domino Flood-Fill convergence across multiple ticks + barrier isolation + wet-ink scale
  const floodGrid = new Uint8Array(64);
  // Create a vertical wall at x=5 from y=0..7 except keep (0..4, 0..7) enclosed
  for (let y = 0; y < 8; y++) floodGrid[y * 8 + 5] = 2;
  const job = createDominoFloodJob(floodGrid, 8, 0, 0, 9);
  assert.equal(job.done, false);
  assert.equal(job.totalPixels, 40);

  const tick1 = stepDominoFloodJob(job, 2); // rings 0 and 1 (dist 0 & 1 = 1 + 2 = 3 pixels)
  assert.equal(tick1.ringStart, 0);
  assert.equal(tick1.ringEnd, 2);
  assert.equal(tick1.filledInStep, 3);
  assert.equal(tick1.wetPixels.every((w) => w.scale === 1.25), true);
  assert.equal(job.done, false);

  const tick2 = stepDominoFloodJob(job, 2);
  const settledFromTick1 = tick2.wetPixels.filter((w) => w.ring < 2);
  assert.equal(settledFromTick1.length, 3);
  assert.equal(settledFromTick1.every((w) => w.scale === 1.0), true);

  let guard = 0;
  while (!job.done && guard < 30) {
    stepDominoFloodJob(job, 2);
    guard++;
  }
  assert.equal(job.done, true);
  assert.equal(job.filledCount, 40);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const val = floodGrid[y * 8 + x];
      if (x < 5) assert.equal(val, 9);
      else if (x === 5) assert.equal(val, 2, 'barrier stays intact');
      else assert.equal(val, 0, 'region beyond barrier stays unfilled');
    }
  }
});

test('5. createSpriteEditor and createWorldEditor API surface, DOM mounting, gestures, and foley bus events', () => {
  const doc = makeMockDom();
  const bus = createMockBus();
  const cart = createEmptyCartridgeROM();
  let mutations = 0;

  // --- Sprite Editor ---
  const sprContainer = doc.createElement('div');
  const sprStrip = doc.createElement('div');
  const spriteEd = createSpriteEditor({
    container: sprContainer,
    toolStrip: sprStrip,
    getCart: () => cart,
    onMutate: () => { mutations++; },
    bus,
  });

  spriteEd.mount();
  assert.equal(sprContainer.children.length, 1);
  assert.equal(sprStrip.children.length, 1);
  assert.equal(spriteEd.getState().mounted, true);

  spriteEd.selectSlot(5);
  spriteEd.setSize(16);
  assert.equal(cart.sprites[5].size, 16);
  assert.equal(spriteEd.addFrame(), true);
  assert.equal(cart.sprites[5].frames.length, 2);
  spriteEd.selectFrame(0);

  // Offset reticle -24px verification via mock canvas pointer event
  const sprRoot = sprContainer.children[0];
  const sprCanvas = sprRoot.children.find((c) => c.tagName === 'CANVAS');
  assert.ok(sprCanvas);
  spriteEd.setColor(4);
  spriteEd.setOffsetReticle(true);
  // 128px canvas / 16px grid = 8px per cell. Pointer at clientY = 40 -> adjY = 16 -> py = 2
  sprCanvas.dispatch('pointerdown', { pointerId: 1, clientX: 20, clientY: 40 });
  sprCanvas.dispatch('pointerup', { pointerId: 1, clientX: 20, clientY: 40 });
  assert.equal(cart.sprites[5].frames[0][2 * 16 + 2], 4);
  assert.ok(bus.events.some((e) => e.name === 'foley:pixel' && e.payload.yRow === 2));

  // 2-finger pinch-zoom & pan updates viewport without drawing stray dots
  const prePinchSnap = new Uint8Array(cart.sprites[5].frames[0]);
  sprCanvas.dispatch('pointerdown', { pointerId: 10, clientX: 40, clientY: 40 });
  sprCanvas.dispatch('pointerdown', { pointerId: 11, clientX: 60, clientY: 40 });
  sprCanvas.dispatch('pointermove', { pointerId: 11, clientX: 80, clientY: 50 });
  sprCanvas.dispatch('pointerup', { pointerId: 10, clientX: 40, clientY: 40 });
  sprCanvas.dispatch('pointerup', { pointerId: 11, clientX: 80, clientY: 50 });
  assert.deepEqual(cart.sprites[5].frames[0], prePinchSnap);
  assert.ok(spriteEd.getState().zoom > 1);
  spriteEd.setViewport({ zoom: 1, panX: 0, panY: 0 });

  // Shade & Highlight ramp brushes, Bayer dither roller, quad symmetry, 1px outline, crumble erase, Domino flood
  spriteEd.setTool('shade');
  spriteEd.paintPixel(2, 2);
  const shadedVal = cart.sprites[5].frames[0][2 * 16 + 2];
  assert.notEqual(shadedVal, 4);
  spriteEd.setTool('highlight');
  spriteEd.paintPixel(2, 2);
  assert.ok(cart.sprites[5].frames[0][2 * 16 + 2] >= 1);

  spriteEd.setTool('dither');
  spriteEd.setDitherRoller(3); // 50% Bayer checkerboard
  spriteEd.setSymmetry('quad');
  spriteEd.paintPixel(0, 0);
  // Spatial 4x4 Bayer sampling: (0,0) -> B[0]=0 (<8 => fg=4); (15,0) -> B[3]=10 (>=8 => bg=0); (15,15) -> B[15]=5 (<8 => fg=4)
  assert.equal(cart.sprites[5].frames[0][0], 4);
  assert.equal(cart.sprites[5].frames[0][15], 0);
  assert.equal(cart.sprites[5].frames[0][15 * 16 + 15], 4);

  spriteEd.setTool('erase');
  spriteEd.paintPixel(0, 0);
  assert.equal(cart.sprites[5].frames[0][0], 0);
  assert.equal(cart.sprites[5].frames[0][15 * 16 + 15], 0);
  assert.ok(spriteEd.getState().dustParticleCount > 0);
  assert.ok(bus.events.some((e) => e.name === 'foley:erase'));

  spriteEd.setSymmetry('none');
  spriteEd.applyOutline(1);
  assert.equal(cart.sprites[5].frames[0][2 * 16 + 1], 1);
  assert.equal(spriteEd.undo(), true);
  assert.equal(cart.sprites[5].frames[0][2 * 16 + 1], 0);
  assert.equal(spriteEd.redo(), true);
  assert.equal(cart.sprites[5].frames[0][2 * 16 + 1], 1);

  // Lazy-rope stabilizer + Bresenham stroke
  spriteEd.setStabilizer(true);
  spriteEd.setTool('pencil');
  spriteEd.setColor(7);
  spriteEd.paintStroke(4, 4, 8, 4);
  for (let x = 4; x <= 8; x++) {
    assert.equal(cart.sprites[5].frames[0][4 * 16 + x], 7);
  }

  spriteEd.selectSlot(6); // empty 8x8 slot
  spriteEd.setColor(8);
  spriteEd.triggerFloodFill(0, 0);
  for (let i = 0; i < 12; i++) spriteEd.stepAnimations();
  assert.equal(cart.sprites[6].frames[0].every((v) => v === 8), true);
  assert.ok(bus.events.some((e) => e.name === 'foley:flood'));

  spriteEd.unmount();
  assert.equal(sprContainer.children.length, 0);
  assert.equal(sprStrip.children.length, 0);

  // --- World Editor ---
  const wldContainer = doc.createElement('div');
  const wldStrip = doc.createElement('div');
  const worldEd = createWorldEditor({
    container: wldContainer,
    toolStrip: wldStrip,
    getCart: () => cart,
    onMutate: () => { mutations++; },
    bus,
  });

  worldEd.mount();
  assert.equal(wldContainer.children.length, 1);
  assert.equal(wldStrip.children.length, 1);

  worldEd.selectLayer('main');
  worldEd.selectTerrain(TERRAIN_TYPES.MOSS);
  worldEd.paintCell(3, 4);
  assert.equal(cart.world.mainLayer[4 * 16 + 3], TERRAIN_TYPES.MOSS);
  assert.ok(bus.events.some((e) => e.name === 'foley:autotile' && e.payload.terrainId === TERRAIN_TYPES.MOSS));

  worldEd.selectCollision(COLLISION_FLAGS.BOUNCE);
  worldEd.paintCell(3, 4);
  assert.equal(cart.world.collision[4 * 16 + 3], COLLISION_FLAGS.BOUNCE);

  worldEd.setWorldSize(32);
  assert.equal(cart.world.width, 32);
  assert.equal(cart.world.height, 32);
  assert.equal(cart.world.mainLayer[4 * 32 + 3], TERRAIN_TYPES.MOSS, 'resize preserves existing tiles');

  worldEd.destroy();
  assert.equal(wldContainer.children.length, 0);
  assert.equal(wldStrip.children.length, 0);
  assert.ok(mutations > 0);
});

test('6. Module hygiene: no export *, no static node: imports, no external CDNs, no forbidden terms', () => {
  const studioFiles = [
    './src/studio/palettes.js',
    './src/studio/dither-symmetry.js',
    './src/studio/autotile-world.js',
    './src/studio/sprite-editor.js',
  ];
  const forbiddenOverlayTerms = [
    'd-' + 'pad',
    'd' + 'pad',
    'joy' + 'stick',
    'thumb' + 'stick',
    'virtual' + 'pad',
    'game' + 'pad',
    'a/b ' + 'button',
  ];

  for (const filePath of studioFiles) {
    const src = fs.readFileSync(path.resolve(filePath), 'utf8');
    assert.equal(/\bexport\s+\*/.test(src), false, `${filePath} must not use export *`);
    assert.equal(/['"]node:/.test(src), false, `${filePath} must not import node: modules`);
    assert.equal(/https?:\/\//.test(src), false, `${filePath} must not reference external URLs/CDNs`);
    const lower = src.toLowerCase();
    for (const term of forbiddenOverlayTerms) {
      assert.equal(lower.includes(term), false, `Forbidden term "${term}" in ${filePath}`);
    }
  }
});
