/**
 * BitForge-80 Tactile Pixel Studio Editor
 * Supports 32 sprite slots (8x8 & 16x16, 1..4 frames), toggleable 24px Offset Magnetic Reticle,
 * 2-finger pinch-zoom & pan, Bresenham pencil + lazy-rope stabilizer, 4-step luminance Shade/Highlight,
 * 8 Bayer dither rollers, X/Y/Quad/Radial symmetry, 1-tap 1px outline, dual-tint onion-skinning,
 * magnetic crumble eraser particles, and 120Hz Domino Flood-Fill.
 */

import { getPalette } from './palettes.js';
import {
  BAYER_ROLLERS,
  sampleDitherRoller,
  getSymmetryCoords,
  bresenhamLine,
  applyOutline1px,
  createDominoFloodJob,
  stepDominoFloodJob,
} from './dither-symmetry.js';

const SYMMETRY_MODES = Object.freeze(['none', 'x', 'y', 'quad', 'radial']);
const TOOLS = Object.freeze(['pencil', 'dither', 'shade', 'highlight', 'fill', 'erase', 'pan']);

function resizeFrame(oldFrame, oldSize, newSize) {
  const next = new Uint8Array(newSize * newSize);
  if (!oldFrame) return next;
  const copy = Math.min(oldSize, newSize);
  for (let y = 0; y < copy; y++) {
    for (let x = 0; x < copy; x++) {
      next[y * newSize + x] = oldFrame[y * oldSize + x] & 15;
    }
  }
  return next;
}

/**
 * Create the BitForge-80 Tactile Sprite Studio Editor.
 * @param {{ container?: any, toolStrip?: any, getCart?: () => any, onMutate?: (info: any) => void, bus?: any }} [opts]
 */
export function createSpriteEditor({
  container = null,
  toolStrip = null,
  getCart = null,
  onMutate = null,
  bus = null,
} = {}) {
  let mounted = false;
  let slotIdx = 0;
  let frameIdx = 0;
  let activeTool = 'pencil';
  let fgColor = 4;
  let bgColor = 0;
  let symmetryMode = 'none';
  let ditherRollerIdx = 3; // default 50% Bayer
  let offsetReticle = true; // 24px vertical finger offset reticle
  let stabilizerEnabled = false; // lazy-rope stabilizer
  let onionSkin = true;
  let previewPlaying = false;

  // Viewport transform (pinch-zoom & pan)
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // Active gesture & stroke state
  const activePointers = new Map();
  let isPinching = false;
  let pinchStartDist = 1;
  let pinchStartZoom = 1;
  let pinchLastMidX = 0;
  let pinchLastMidY = 0;
  let drawingPointerId = null;
  let strokeMoved = false;
  let lastDrawPixel = null;
  let panLastClientX = 0;
  let panLastClientY = 0;
  let ropeX = 0;
  let ropeY = 0;
  let hoverPixel = null;
  let strokeVisited = new Set();

  // Animations (120Hz Domino flood-fill + magnetic crumble dust + frame preview)
  let activeFloodJob = null;
  const dustParticles = [];
  let previewTick = 0;
  let rafId = null;

  // Undo / Redo stacks
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 32;

  // DOM refs
  let rootEl = null;
  let canvasEl = null;
  let ctx2d = null;
  let swatchGridEl = null;
  let slotSelectEl = null;
  let frameBarEl = null;
  let toolBtns = {};
  let toggleBtns = {};
  let symmetryBtn = null;
  let ditherBtn = null;
  let sizeBtn = null;
  let toolStripWrap = null;
  let unsubPalette = null;

  function readCart() {
    return typeof getCart === 'function' ? getCart() : null;
  }

  function ensureSprites(cart) {
    if (!cart) return null;
    if (!Array.isArray(cart.sprites)) {
      cart.sprites = [];
    }
    while (cart.sprites.length < 32) {
      cart.sprites.push({ size: 8, frames: [new Uint8Array(64)] });
    }
    const sp = cart.sprites[slotIdx];
    if (!sp || typeof sp !== 'object') {
      cart.sprites[slotIdx] = { size: 8, frames: [new Uint8Array(64)] };
    } else {
      sp.size = sp.size === 16 ? 16 : 8;
      const pxLen = sp.size * sp.size;
      if (!Array.isArray(sp.frames) || sp.frames.length === 0) {
        sp.frames = [new Uint8Array(pxLen)];
      } else {
        for (let f = 0; f < sp.frames.length; f++) {
          if (!(sp.frames[f] instanceof Uint8Array) || sp.frames[f].length !== pxLen) {
            sp.frames[f] = resizeFrame(sp.frames[f], sp.size, sp.size);
          }
        }
      }
      if (sp.frames.length > 4) sp.frames.length = 4;
    }
    const curSlot = cart.sprites[slotIdx];
    if (frameIdx >= curSlot.frames.length) {
      frameIdx = Math.max(0, curSlot.frames.length - 1);
    }
    return curSlot;
  }

  function getActivePalette() {
    const cart = readCart();
    return getPalette(cart?.meta?.paletteId || 'classic16', cart?.meta?.customPalette || null);
  }

  function emitBus(name, payload) {
    if (bus && typeof bus.emit === 'function') {
      bus.emit(name, payload);
    }
  }

  function notifyMutate(reason) {
    const cart = readCart();
    if (typeof onMutate === 'function') {
      onMutate({ type: reason, slotIdx, frameIdx, source: 'sprite-editor', cart });
    }
  }

  function pushUndoSnapshot() {
    const slot = ensureSprites(readCart());
    if (!slot) return;
    const frame = slot.frames[frameIdx];
    undoStack.push({
      slotIdx,
      frameIdx,
      size: slot.size,
      pixels: new Uint8Array(frame),
    });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (undoStack.length === 0) return false;
    const snap = undoStack.pop();
    const cart = readCart();
    if (!cart || !cart.sprites?.[snap.slotIdx]) return false;
    const slot = cart.sprites[snap.slotIdx];
    const curFrame = slot.frames[snap.frameIdx];
    if (curFrame) {
      redoStack.push({
        slotIdx: snap.slotIdx,
        frameIdx: snap.frameIdx,
        size: slot.size,
        pixels: new Uint8Array(curFrame),
      });
    }
    slotIdx = snap.slotIdx;
    frameIdx = Math.min(snap.frameIdx, slot.frames.length - 1);
    if (slot.size !== snap.size) {
      slot.size = snap.size;
      slot.frames = slot.frames.map((f) => resizeFrame(f, slot.size, snap.size));
    }
    slot.frames[frameIdx] = new Uint8Array(snap.pixels);
    emitBus('foley:switch', { action: 'undo', slotIdx, frameIdx, source: 'sprite-editor' });
    notifyMutate('sprite-undo');
    refresh();
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    const snap = redoStack.pop();
    const cart = readCart();
    if (!cart || !cart.sprites?.[snap.slotIdx]) return false;
    const slot = cart.sprites[snap.slotIdx];
    const curFrame = slot.frames[snap.frameIdx];
    if (curFrame) {
      undoStack.push({
        slotIdx: snap.slotIdx,
        frameIdx: snap.frameIdx,
        size: slot.size,
        pixels: new Uint8Array(curFrame),
      });
    }
    slotIdx = snap.slotIdx;
    frameIdx = Math.min(snap.frameIdx, slot.frames.length - 1);
    slot.frames[frameIdx] = new Uint8Array(snap.pixels);
    emitBus('foley:switch', { action: 'redo', slotIdx, frameIdx, source: 'sprite-editor' });
    notifyMutate('sprite-redo');
    refresh();
    return true;
  }

  function spawnCrumbleDust(px, py, colorIdx) {
    const count = 3;
    for (let i = 0; i < count; i++) {
      dustParticles.push({
        x: px + 0.5,
        y: py + 0.5,
        vx: (i - 1) * 0.14 + (Math.random() - 0.5) * 0.08,
        vy: -0.18 - Math.random() * 0.12,
        colorIdx: colorIdx || 4,
        life: 1.0,
      });
    }
    if (dustParticles.length > 96) {
      dustParticles.splice(0, dustParticles.length - 96);
    }
  }

  function paintPixel(x, y, opts = {}) {
    const cart = readCart();
    const slot = ensureSprites(cart);
    if (!slot) return false;
    const size = slot.size;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || px >= size || py < 0 || py >= size) return false;

    const frame = slot.frames[frameIdx];
    const pal = getActivePalette();
    const scaleId = cart?.audio?.scaleId || 'pentatonic';
    const tool = opts.tool || activeTool;
    const coords = getSymmetryCoords(opts.symmetry || symmetryMode, px, py, size);

    let changedCount = 0;
    let erasedCount = 0;
    let lastColorWritten = fgColor;

    for (let i = 0; i < coords.length; i++) {
      const pt = coords[i];
      const idx = pt.y * size + pt.x;
      const prev = frame[idx] & 15;
      let next = prev;

      if (tool === 'pencil') {
        next = fgColor & 15;
      } else if (tool === 'dither') {
        next = sampleDitherRoller(ditherRollerIdx, pt.x, pt.y, fgColor, bgColor) & 15;
      } else if (tool === 'shade') {
        if (strokeVisited.has(idx)) continue;
        strokeVisited.add(idx);
        if (prev > 0) next = pal.shadeMap[prev];
      } else if (tool === 'highlight') {
        if (strokeVisited.has(idx)) continue;
        strokeVisited.add(idx);
        if (prev > 0) next = pal.highlightMap[prev];
      } else if (tool === 'erase') {
        next = 0;
      }

      if (next !== prev) {
        frame[idx] = next;
        changedCount++;
        lastColorWritten = next;
        if (tool === 'erase' && prev > 0) {
          erasedCount++;
          spawnCrumbleDust(pt.x, pt.y, prev);
        }
      }
    }

    if (erasedCount > 0) {
      emitBus('foley:erase', {
        x: px,
        y: py,
        yRow: py,
        count: erasedCount,
        luminance: pal.luminance[0],
        scaleId,
        source: 'sprite-editor',
      });
    } else if (changedCount > 0) {
      emitBus('foley:pixel', {
        x: px,
        y: py,
        yRow: py,
        colorIdx: lastColorWritten,
        luminance: pal.luminance[lastColorWritten & 15],
        scaleId,
        velocity: Math.min(1, 0.55 + changedCount * 0.1),
        source: 'sprite-editor',
      });
    }

    if (changedCount > 0) {
      notifyMutate('sprite-pixel');
      renderCanvas();
      return true;
    }
    return false;
  }

  function paintStroke(x0, y0, x1, y1, opts = {}) {
    const pts = bresenhamLine(x0, y0, x1, y1);
    let any = false;
    for (let i = 0; i < pts.length; i++) {
      if (paintPixel(pts[i].x, pts[i].y, opts)) any = true;
    }
    return any;
  }

  function triggerFloodFill(x, y, fillCol = fgColor) {
    const cart = readCart();
    const slot = ensureSprites(cart);
    if (!slot) return null;
    pushUndoSnapshot();
    activeFloodJob = createDominoFloodJob(slot.frames[frameIdx], slot.size, x, y, fillCol);
    if (activeFloodJob.totalPixels === 0) {
      activeFloodJob = null;
      return { done: true, totalPixels: 0 };
    }
    // Step first 2 concentric rings immediately (120Hz = 2 rings/tick)
    const stepRes = stepDominoFloodJob(activeFloodJob, 2);
    emitBus('foley:flood', {
      ringIdx: stepRes.ringStart,
      ringIndex: stepRes.ringStart,
      count: stepRes.filledInStep,
      x: Math.floor(x),
      y: Math.floor(y),
      colorIdx: fillCol & 15,
      scaleId: cart?.audio?.scaleId || 'pentatonic',
      done: stepRes.done,
      source: 'sprite-editor',
    });
    if (stepRes.done) {
      notifyMutate('sprite-flood');
    }
    renderCanvas();
    return activeFloodJob;
  }

  function applyOutline(outlineColor = fgColor || 1) {
    const cart = readCart();
    const slot = ensureSprites(cart);
    if (!slot) return false;
    const col = (outlineColor & 15) || 1;
    pushUndoSnapshot();
    const outlined = applyOutline1px(slot.frames[frameIdx], slot.size, col);
    slot.frames[frameIdx].set(outlined);
    emitBus('foley:pixel', {
      x: 0,
      y: 0,
      yRow: 0,
      colorIdx: col,
      luminance: getActivePalette().luminance[col],
      scaleId: cart?.audio?.scaleId || 'pentatonic',
      velocity: 0.8,
      source: 'sprite-editor',
    });
    notifyMutate('sprite-outline');
    renderCanvas();
    return true;
  }

  function stepAnimations() {
    let dirty = false;

    if (activeFloodJob) {
      const cart = readCart();
      const stepRes = stepDominoFloodJob(activeFloodJob, 2);
      if (stepRes.filledInStep > 0) {
        emitBus('foley:flood', {
          ringIdx: stepRes.ringStart,
          ringIndex: stepRes.ringStart,
          count: stepRes.filledInStep,
          x: activeFloodJob.startX,
          y: activeFloodJob.startY,
          colorIdx: activeFloodJob.fillColor,
          scaleId: cart?.audio?.scaleId || 'pentatonic',
          done: stepRes.done,
          source: 'sprite-editor',
        });
      }
      if (stepRes.done && stepRes.filledInStep > 0) {
        notifyMutate('sprite-flood');
      }
      if (stepRes.wetDone) {
        activeFloodJob = null;
      }
      dirty = true;
    }

    if (dustParticles.length > 0) {
      for (let i = dustParticles.length - 1; i >= 0; i--) {
        const p = dustParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.025;
        p.life -= 0.06;
        if (p.life <= 0) dustParticles.splice(i, 1);
      }
      dirty = true;
    }

    if (previewPlaying) {
      previewTick++;
      if (previewTick % 12 === 0) {
        const slot = ensureSprites(readCart());
        if (slot && slot.frames.length > 1) {
          frameIdx = (frameIdx + 1) % slot.frames.length;
          syncControls();
          dirty = true;
        }
      }
    }

    if (dirty) renderCanvas();
    return dirty;
  }

  function startAnimLoop() {
    if (rafId !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (!mounted) {
        rafId = null;
        return;
      }
      stepAnimations();
      rafId = globalThis.requestAnimationFrame(tick);
    };
    rafId = globalThis.requestAnimationFrame(tick);
  }

  function stopAnimLoop() {
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function selectSlot(i) {
    const next = Math.max(0, Math.min(31, i | 0));
    if (slotIdx !== next) {
      slotIdx = next;
      frameIdx = 0;
      activeFloodJob = null;
      emitBus('foley:switch', { action: 'slot', slotIdx, frameIdx, source: 'sprite-editor' });
    }
    ensureSprites(readCart());
    refresh();
  }

  function selectFrame(i) {
    const slot = ensureSprites(readCart());
    if (!slot) return;
    const next = Math.max(0, Math.min(slot.frames.length - 1, i | 0));
    if (frameIdx !== next) {
      frameIdx = next;
      activeFloodJob = null;
      emitBus('foley:switch', { action: 'frame', slotIdx, frameIdx, source: 'sprite-editor' });
    }
    refresh();
  }

  function addFrame() {
    const slot = ensureSprites(readCart());
    if (!slot || slot.frames.length >= 4) return false;
    const copy = new Uint8Array(slot.frames[frameIdx]);
    slot.frames.splice(frameIdx + 1, 0, copy);
    frameIdx = frameIdx + 1;
    emitBus('foley:switch', { action: 'add-frame', slotIdx, frameIdx, source: 'sprite-editor' });
    notifyMutate('sprite-frame-add');
    refresh();
    return true;
  }

  function removeFrame() {
    const slot = ensureSprites(readCart());
    if (!slot || slot.frames.length <= 1) return false;
    slot.frames.splice(frameIdx, 1);
    frameIdx = Math.max(0, Math.min(frameIdx, slot.frames.length - 1));
    emitBus('foley:erase', { x: 0, y: 0, yRow: 0, count: 1, source: 'sprite-editor' });
    notifyMutate('sprite-frame-remove');
    refresh();
    return true;
  }

  function setSize(newSize) {
    const target = newSize === 16 ? 16 : 8;
    const slot = ensureSprites(readCart());
    if (!slot || slot.size === target) return;
    const oldSize = slot.size;
    slot.size = target;
    slot.frames = slot.frames.map((f) => resizeFrame(f, oldSize, target));
    emitBus('foley:switch', { action: 'sprite-size', size: target, slotIdx, source: 'sprite-editor' });
    notifyMutate('sprite-size');
    refresh();
  }

  function setTool(tool) {
    if (TOOLS.includes(tool)) {
      activeTool = tool;
      emitBus('foley:switch', { action: 'tool', tool, source: 'sprite-editor' });
      syncControls();
    }
  }

  function setColor(colorIdx) {
    fgColor = colorIdx & 15;
    emitBus('foley:switch', { action: 'color', colorIdx: fgColor, source: 'sprite-editor' });
    syncControls();
  }

  function setBgColor(colorIdx) {
    bgColor = colorIdx & 15;
    syncControls();
  }

  function setSymmetry(mode) {
    if (SYMMETRY_MODES.includes(mode)) {
      symmetryMode = mode;
      emitBus('foley:switch', { action: 'symmetry', symmetry: mode, source: 'sprite-editor' });
      syncControls();
      renderCanvas();
    }
  }

  function setDitherRoller(idx) {
    ditherRollerIdx = ((idx | 0) % BAYER_ROLLERS.length + BAYER_ROLLERS.length) % BAYER_ROLLERS.length;
    emitBus('foley:switch', { action: 'dither-roller', rollerIdx: ditherRollerIdx, source: 'sprite-editor' });
    syncControls();
  }

  function setOffsetReticle(enabled) {
    offsetReticle = Boolean(enabled);
    emitBus('foley:switch', { action: 'offset-reticle', enabled: offsetReticle, source: 'sprite-editor' });
    syncControls();
    renderCanvas();
  }

  function setStabilizer(enabled) {
    stabilizerEnabled = Boolean(enabled);
    emitBus('foley:switch', { action: 'stabilizer', enabled: stabilizerEnabled, source: 'sprite-editor' });
    syncControls();
  }

  function setOnionSkin(enabled) {
    onionSkin = Boolean(enabled);
    emitBus('foley:switch', { action: 'onion-skin', enabled: onionSkin, source: 'sprite-editor' });
    syncControls();
    renderCanvas();
  }

  function setViewport({ zoom: z, panX: px, panY: py } = {}) {
    if (typeof z === 'number' && Number.isFinite(z)) {
      zoom = Math.max(1, Math.min(6, z));
    }
    if (typeof px === 'number' && Number.isFinite(px)) panX = px;
    if (typeof py === 'number' && Number.isFinite(py)) panY = py;
    renderCanvas();
  }

  function pointerToCanvasPixel(clientX, clientY, applyVerticalOffset = true) {
    if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') return null;
    const slot = ensureSprites(readCart());
    if (!slot) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;

    const adjClientY = applyVerticalOffset && offsetReticle ? clientY - 24 : clientY;
    const normX = (clientX - rect.left) / rect.width;
    const normY = (adjClientY - rect.top) / rect.height;
    const canvasX = normX * canvasEl.width;
    const canvasY = normY * canvasEl.height;

    const viewW = canvasEl.width;
    const viewH = canvasEl.height;
    const cellSize = (Math.min(viewW, viewH) * zoom) / slot.size;
    const originX = (viewW - slot.size * cellSize) * 0.5 + panX;
    const originY = (viewH - slot.size * cellSize) * 0.5 + panY;

    const fx = (canvasX - originX) / cellSize;
    const fy = (canvasY - originY) / cellSize;
    return {
      fx,
      fy,
      px: Math.floor(fx),
      py: Math.floor(fy),
      inBounds: fx >= 0 && fx < slot.size && fy >= 0 && fy < slot.size,
    };
  }

  function renderCanvas() {
    if (!canvasEl || !ctx2d || typeof ctx2d.fillRect !== 'function') return;
    const cart = readCart();
    const slot = ensureSprites(cart);
    if (!slot) return;

    const pal = getActivePalette();
    const size = slot.size;
    const cw = canvasEl.width || 128;
    const ch = canvasEl.height || 128;
    const cellSize = (Math.min(cw, ch) * zoom) / size;
    const originX = (cw - size * cellSize) * 0.5 + panX;
    const originY = (ch - size * cellSize) * 0.5 + panY;

    ctx2d.fillStyle = pal.hex[0];
    ctx2d.fillRect(0, 0, cw, ch);

    // Subtle pixel checkerboard backing
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        ctx2d.fillStyle = ((x + y) & 1) === 0 ? '#181a24' : '#14161f';
        ctx2d.fillRect(originX + x * cellSize, originY + y * cellSize, cellSize, cellSize);
      }
    }

    // Dual-tint onion-skinning: previous frame in cyan, next frame in coral
    if (onionSkin && slot.frames.length > 1) {
      const prevFrame = frameIdx > 0 ? slot.frames[frameIdx - 1] : null;
      const nextFrame = frameIdx + 1 < slot.frames.length ? slot.frames[frameIdx + 1] : null;
      if (prevFrame) {
        ctx2d.fillStyle = 'rgba(56, 182, 255, 0.34)';
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (prevFrame[y * size + x] > 0) {
              ctx2d.fillRect(originX + x * cellSize, originY + y * cellSize, cellSize, cellSize);
            }
          }
        }
      }
      if (nextFrame) {
        ctx2d.fillStyle = 'rgba(255, 79, 110, 0.34)';
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (nextFrame[y * size + x] > 0) {
              ctx2d.fillRect(originX + x * cellSize, originY + y * cellSize, cellSize, cellSize);
            }
          }
        }
      }
    }

    // Active frame pixels + wet-ink lookup for 120Hz Domino flood pop
    const frame = slot.frames[frameIdx];
    const wetScaleByIdx = new Map();
    if (activeFloodJob && activeFloodJob.wetPixels.length > 0) {
      for (let i = 0; i < activeFloodJob.wetPixels.length; i++) {
        const wp = activeFloodJob.wetPixels[i];
        wetScaleByIdx.set(wp.idx, wp.scale);
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const col = frame[idx] & 15;
        if (col === 0) continue;
        const wetScale = wetScaleByIdx.get(idx) || 1.0;
        const drawSize = cellSize * wetScale;
        const pad = (cellSize - drawSize) * 0.5;
        ctx2d.fillStyle = pal.hex[col];
        ctx2d.fillRect(originX + x * cellSize + pad, originY + y * cellSize + pad, drawSize, drawSize);
      }
    }

    // Crumble dust particles from magnetic eraser
    for (let i = 0; i < dustParticles.length; i++) {
      const p = dustParticles[i];
      ctx2d.fillStyle = pal.hex[p.colorIdx & 15];
      const ps = Math.max(2, cellSize * 0.32 * p.life);
      ctx2d.fillRect(originX + p.x * cellSize - ps * 0.5, originY + p.y * cellSize - ps * 0.5, ps, ps);
    }

    // Symmetry guide hairlines
    if (symmetryMode === 'x' || symmetryMode === 'quad') {
      ctx2d.fillStyle = 'rgba(246, 196, 83, 0.45)';
      ctx2d.fillRect(originX + size * cellSize * 0.5 - 0.5, originY, 1, size * cellSize);
    }
    if (symmetryMode === 'y' || symmetryMode === 'quad') {
      ctx2d.fillStyle = 'rgba(246, 196, 83, 0.45)';
      ctx2d.fillRect(originX, originY + size * cellSize * 0.5 - 0.5, size * cellSize, 1);
    }
    if (symmetryMode === 'radial') {
      ctx2d.fillStyle = 'rgba(156, 92, 255, 0.45)';
      ctx2d.fillRect(originX + size * cellSize * 0.5 - 0.5, originY, 1, size * cellSize);
      ctx2d.fillRect(originX, originY + size * cellSize * 0.5 - 0.5, size * cellSize, 1);
    }

    // Offset Magnetic Pixel Reticle crosshair laser
    if (hoverPixel && hoverPixel.inBounds) {
      const rx = originX + hoverPixel.px * cellSize;
      const ry = originY + hoverPixel.py * cellSize;
      ctx2d.fillStyle = 'rgba(56, 182, 255, 0.28)';
      ctx2d.fillRect(originX, ry + cellSize * 0.5 - 0.5, size * cellSize, 1);
      ctx2d.fillRect(rx + cellSize * 0.5 - 0.5, originY, 1, size * cellSize);
      if (typeof ctx2d.strokeRect === 'function') {
        ctx2d.strokeStyle = '#f6c453';
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, cellSize - 1), Math.max(1, cellSize - 1));
      }
    }
  }

  function syncControls() {
    const slot = ensureSprites(readCart());
    const pal = getActivePalette();

    if (slotSelectEl && slotSelectEl.value !== String(slotIdx)) {
      slotSelectEl.value = String(slotIdx);
    }
    if (sizeBtn && slot) {
      sizeBtn.textContent = `${slot.size}x${slot.size}`;
    }
    if (symmetryBtn) {
      symmetryBtn.textContent = `SYM:${symmetryMode.toUpperCase()}`;
    }
    if (ditherBtn) {
      ditherBtn.textContent = `DTH:${BAYER_ROLLERS[ditherRollerIdx].name}`;
    }

    for (const [t, btn] of Object.entries(toolBtns)) {
      if (!btn) continue;
      btn.dataset.active = t === activeTool ? 'true' : 'false';
      btn.setAttribute('aria-pressed', String(t === activeTool));
    }

    if (toggleBtns.reticle) {
      toggleBtns.reticle.dataset.active = offsetReticle ? 'true' : 'false';
      toggleBtns.reticle.textContent = offsetReticle ? 'RET -24' : 'RET 0';
    }
    if (toggleBtns.stabilizer) {
      toggleBtns.stabilizer.dataset.active = stabilizerEnabled ? 'true' : 'false';
      toggleBtns.stabilizer.textContent = stabilizerEnabled ? 'ROPE ON' : 'ROPE OFF';
    }
    if (toggleBtns.onion) {
      toggleBtns.onion.dataset.active = onionSkin ? 'true' : 'false';
      toggleBtns.onion.textContent = onionSkin ? 'ONION ON' : 'ONION OFF';
    }
    if (toggleBtns.play) {
      toggleBtns.play.dataset.active = previewPlaying ? 'true' : 'false';
      toggleBtns.play.textContent = previewPlaying ? 'STOP' : 'PLAY';
    }

    if (swatchGridEl && swatchGridEl.ownerDocument) {
      const doc = swatchGridEl.ownerDocument;
      swatchGridEl.innerHTML = '';
      for (let i = 0; i < 16; i++) {
        const sw = doc.createElement('button');
        sw.type = 'button';
        sw.className = 'bf-sprite-swatch';
        sw.style.backgroundColor = pal.hex[i];
        sw.dataset.colorIdx = String(i);
        sw.dataset.active = i === fgColor ? 'true' : 'false';
        sw.textContent = i === 0 ? '·' : String(i);
        sw.setAttribute('aria-label', `Color ${i}`);
        sw.addEventListener('click', () => setColor(i));
        swatchGridEl.appendChild(sw);
      }
    }

    if (frameBarEl && frameBarEl.ownerDocument && slot) {
      const doc = frameBarEl.ownerDocument;
      frameBarEl.innerHTML = '';
      for (let f = 0; f < slot.frames.length; f++) {
        const fBtn = doc.createElement('button');
        fBtn.type = 'button';
        fBtn.className = 'bf-frame-pill';
        fBtn.textContent = `F${f + 1}`;
        fBtn.dataset.active = f === frameIdx ? 'true' : 'false';
        fBtn.addEventListener('click', () => selectFrame(f));
        frameBarEl.appendChild(fBtn);
      }
      if (slot.frames.length < 4) {
        const addBtn = doc.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'bf-frame-pill bf-frame-add';
        addBtn.textContent = '+F';
        addBtn.addEventListener('click', () => addFrame());
        frameBarEl.appendChild(addBtn);
      }
      if (slot.frames.length > 1) {
        const delBtn = doc.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'bf-frame-pill bf-frame-del';
        delBtn.textContent = '-F';
        delBtn.addEventListener('click', () => removeFrame());
        frameBarEl.appendChild(delBtn);
      }
    }
  }

  function handlePointerDown(ev) {
    activePointers.set(ev.pointerId ?? 1, { clientX: ev.clientX, clientY: ev.clientY });

    if (activePointers.size >= 2) {
      // Transition cleanly into 2-finger pinch-zoom & pan, reverting single-tap dot if no drag occurred
      if (drawingPointerId !== null && !strokeMoved && undoStack.length > 0) {
        const snap = undoStack.pop();
        const slot = ensureSprites(readCart());
        if (slot && snap && snap.slotIdx === slotIdx && snap.frameIdx === frameIdx) {
          slot.frames[frameIdx] = new Uint8Array(snap.pixels);
        }
      }
      isPinching = true;
      drawingPointerId = null;
      lastDrawPixel = null;
      strokeVisited.clear();
      const pts = Array.from(activePointers.values());
      pinchStartDist = Math.max(1, Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY));
      pinchStartZoom = zoom;
      pinchLastMidX = (pts[0].clientX + pts[1].clientX) * 0.5;
      pinchLastMidY = (pts[0].clientY + pts[1].clientY) * 0.5;
      renderCanvas();
      return;
    }

    if (activeTool === 'pan') {
      drawingPointerId = ev.pointerId ?? 1;
      panLastClientX = ev.clientX;
      panLastClientY = ev.clientY;
      return;
    }

    const hit = pointerToCanvasPixel(ev.clientX, ev.clientY, true);
    hoverPixel = hit;
    if (!hit || !hit.inBounds) return;

    if (activeTool === 'fill') {
      triggerFloodFill(hit.px, hit.py, fgColor);
      return;
    }

    pushUndoSnapshot();
    drawingPointerId = ev.pointerId ?? 1;
    strokeMoved = false;
    strokeVisited.clear();
    ropeX = hit.fx;
    ropeY = hit.fy;
    lastDrawPixel = { x: hit.px, y: hit.py };
    paintPixel(hit.px, hit.py);
  }

  function handlePointerMove(ev) {
    const pid = ev.pointerId ?? 1;
    if (activePointers.has(pid)) {
      activePointers.set(pid, { clientX: ev.clientX, clientY: ev.clientY });
    }

    if (isPinching && activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.max(1, Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY));
      const midX = (pts[0].clientX + pts[1].clientX) * 0.5;
      const midY = (pts[0].clientY + pts[1].clientY) * 0.5;
      zoom = Math.max(1, Math.min(6, pinchStartZoom * (dist / pinchStartDist)));
      panX += midX - pinchLastMidX;
      panY += midY - pinchLastMidY;
      pinchLastMidX = midX;
      pinchLastMidY = midY;
      renderCanvas();
      return;
    }

    if (activeTool === 'pan' && drawingPointerId === pid) {
      panX += ev.clientX - panLastClientX;
      panY += ev.clientY - panLastClientY;
      panLastClientX = ev.clientX;
      panLastClientY = ev.clientY;
      renderCanvas();
      return;
    }

    const hit = pointerToCanvasPixel(ev.clientX, ev.clientY, true);
    hoverPixel = hit;
    if (drawingPointerId !== pid || !hit) {
      renderCanvas();
      return;
    }
    strokeMoved = true;

    let targetPx = hit.px;
    let targetPy = hit.py;
    if (stabilizerEnabled && (activeTool === 'pencil' || activeTool === 'dither' || activeTool === 'erase')) {
      const dx = hit.fx - ropeX;
      const dy = hit.fy - ropeY;
      const dist = Math.hypot(dx, dy);
      const ropeRadius = 1.4;
      if (dist > ropeRadius) {
        const pull = (dist - ropeRadius) / dist;
        ropeX += dx * pull;
        ropeY += dy * pull;
      }
      targetPx = Math.floor(ropeX);
      targetPy = Math.floor(ropeY);
    }

    if (lastDrawPixel) {
      paintStroke(lastDrawPixel.x, lastDrawPixel.y, targetPx, targetPy);
    } else {
      paintPixel(targetPx, targetPy);
    }
    lastDrawPixel = { x: targetPx, y: targetPy };
  }

  function handlePointerUp(ev) {
    const pid = ev.pointerId ?? 1;
    activePointers.delete(pid);
    if (activePointers.size < 2) {
      isPinching = false;
    }
    if (drawingPointerId === pid) {
      drawingPointerId = null;
      lastDrawPixel = null;
      strokeVisited.clear();
    }
  }

  function refresh() {
    ensureSprites(readCart());
    syncControls();
    renderCanvas();
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    if (bus && typeof bus.on === 'function') {
      const handler = () => renderCanvas();
      const res = bus.on('palette:change', handler);
      if (typeof res === 'function') unsubPalette = res;
      else if (typeof bus.off === 'function') unsubPalette = () => bus.off('palette:change', handler);
    }

    if (container && container.ownerDocument) {
      const doc = container.ownerDocument;
      rootEl = doc.createElement('div');
      rootEl.className = 'bf-sprite-editor';

      const topBar = doc.createElement('div');
      topBar.className = 'bf-sprite-topbar';

      slotSelectEl = doc.createElement('select');
      slotSelectEl.className = 'bf-sprite-slot-select';
      slotSelectEl.setAttribute('aria-label', 'Sprite Slot');
      for (let i = 0; i < 32; i++) {
        const opt = doc.createElement('option');
        opt.value = String(i);
        opt.textContent = `SPR ${String(i).padStart(2, '0')}`;
        slotSelectEl.appendChild(opt);
      }
      slotSelectEl.addEventListener('change', () => selectSlot(Number(slotSelectEl.value)));
      topBar.appendChild(slotSelectEl);

      sizeBtn = doc.createElement('button');
      sizeBtn.type = 'button';
      sizeBtn.className = 'bf-sprite-size-btn';
      sizeBtn.addEventListener('click', () => {
        const slot = ensureSprites(readCart());
        setSize(slot && slot.size === 16 ? 8 : 16);
      });
      topBar.appendChild(sizeBtn);

      frameBarEl = doc.createElement('div');
      frameBarEl.className = 'bf-sprite-frames';
      topBar.appendChild(frameBarEl);

      toggleBtns.play = doc.createElement('button');
      toggleBtns.play.type = 'button';
      toggleBtns.play.className = 'bf-sprite-toggle';
      toggleBtns.play.addEventListener('click', () => {
        previewPlaying = !previewPlaying;
        emitBus('foley:switch', { action: 'preview', playing: previewPlaying, source: 'sprite-editor' });
        syncControls();
      });
      topBar.appendChild(toggleBtns.play);

      rootEl.appendChild(topBar);

      const toolBar = doc.createElement('div');
      toolBar.className = 'bf-sprite-toolbar';
      const toolLabels = {
        pencil: 'PEN',
        dither: 'DTH',
        shade: 'SHD',
        highlight: 'HIL',
        fill: 'FILL',
        erase: 'ERS',
        pan: 'PAN',
      };
      for (const t of TOOLS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bf-sprite-tool-btn';
        btn.textContent = toolLabels[t];
        btn.addEventListener('click', () => setTool(t));
        toolBtns[t] = btn;
        toolBar.appendChild(btn);
      }

      const outlineBtn = doc.createElement('button');
      outlineBtn.type = 'button';
      outlineBtn.className = 'bf-sprite-tool-btn';
      outlineBtn.textContent = 'OUTLINE';
      outlineBtn.addEventListener('click', () => applyOutline());
      toolBar.appendChild(outlineBtn);

      const undoBtn = doc.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'bf-sprite-tool-btn';
      undoBtn.textContent = 'UNDO';
      undoBtn.addEventListener('click', () => undo());
      toolBar.appendChild(undoBtn);

      rootEl.appendChild(toolBar);

      const optionBar = doc.createElement('div');
      optionBar.className = 'bf-sprite-options';

      symmetryBtn = doc.createElement('button');
      symmetryBtn.type = 'button';
      symmetryBtn.className = 'bf-sprite-opt-btn';
      symmetryBtn.addEventListener('click', () => {
        const nextIdx = (SYMMETRY_MODES.indexOf(symmetryMode) + 1) % SYMMETRY_MODES.length;
        setSymmetry(SYMMETRY_MODES[nextIdx]);
      });
      optionBar.appendChild(symmetryBtn);

      ditherBtn = doc.createElement('button');
      ditherBtn.type = 'button';
      ditherBtn.className = 'bf-sprite-opt-btn';
      ditherBtn.addEventListener('click', () => setDitherRoller(ditherRollerIdx + 1));
      optionBar.appendChild(ditherBtn);

      toggleBtns.reticle = doc.createElement('button');
      toggleBtns.reticle.type = 'button';
      toggleBtns.reticle.className = 'bf-sprite-opt-btn';
      toggleBtns.reticle.addEventListener('click', () => setOffsetReticle(!offsetReticle));
      optionBar.appendChild(toggleBtns.reticle);

      toggleBtns.stabilizer = doc.createElement('button');
      toggleBtns.stabilizer.type = 'button';
      toggleBtns.stabilizer.className = 'bf-sprite-opt-btn';
      toggleBtns.stabilizer.addEventListener('click', () => setStabilizer(!stabilizerEnabled));
      optionBar.appendChild(toggleBtns.stabilizer);

      toggleBtns.onion = doc.createElement('button');
      toggleBtns.onion.type = 'button';
      toggleBtns.onion.className = 'bf-sprite-opt-btn';
      toggleBtns.onion.addEventListener('click', () => setOnionSkin(!onionSkin));
      optionBar.appendChild(toggleBtns.onion);

      rootEl.appendChild(optionBar);

      canvasEl = doc.createElement('canvas');
      canvasEl.className = 'bf-sprite-canvas';
      canvasEl.width = 128;
      canvasEl.height = 128;
      canvasEl.style.imageRendering = 'pixelated';
      ctx2d = typeof canvasEl.getContext === 'function' ? canvasEl.getContext('2d') : null;

      canvasEl.addEventListener('pointerdown', handlePointerDown);
      canvasEl.addEventListener('pointermove', handlePointerMove);
      canvasEl.addEventListener('pointerup', handlePointerUp);
      canvasEl.addEventListener('pointercancel', handlePointerUp);

      rootEl.appendChild(canvasEl);

      swatchGridEl = doc.createElement('div');
      swatchGridEl.className = 'bf-sprite-swatches';
      rootEl.appendChild(swatchGridEl);

      container.appendChild(rootEl);
    }

    if (toolStrip && toolStrip.ownerDocument) {
      const doc = toolStrip.ownerDocument;
      toolStripWrap = doc.createElement('button');
      toolStripWrap.type = 'button';
      toolStripWrap.className = 'bf-tool-pill';
      toolStripWrap.textContent = '1PX OUTLINE';
      toolStripWrap.addEventListener('click', () => applyOutline());
      toolStrip.appendChild(toolStripWrap);
    }

    refresh();
    startAnimLoop();
  }

  function unmount() {
    mounted = false;
    stopAnimLoop();
    if (typeof unsubPalette === 'function') {
      unsubPalette();
      unsubPalette = null;
    }
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    if (toolStripWrap && toolStripWrap.parentNode) {
      toolStripWrap.parentNode.removeChild(toolStripWrap);
    }
    rootEl = null;
    canvasEl = null;
    ctx2d = null;
    swatchGridEl = null;
    slotSelectEl = null;
    frameBarEl = null;
    toolBtns = {};
    toggleBtns = {};
    symmetryBtn = null;
    ditherBtn = null;
    sizeBtn = null;
    toolStripWrap = null;
    activePointers.clear();
  }

  return {
    mount,
    unmount,
    destroy: unmount,
    refresh,
    selectSlot,
    selectFrame,
    addFrame,
    removeFrame,
    setSize,
    setTool,
    setColor,
    setBgColor,
    setSymmetry,
    setDitherRoller,
    setOffsetReticle,
    setStabilizer,
    setOnionSkin,
    setViewport,
    applyOutline,
    triggerFloodFill,
    paintPixel,
    paintStroke,
    undo,
    redo,
    stepAnimations,
    getState: () => {
      const slot = ensureSprites(readCart());
      return {
        mounted,
        slotIdx,
        frameIdx,
        size: slot ? slot.size : 8,
        frameCount: slot ? slot.frames.length : 1,
        activeTool,
        fgColor,
        bgColor,
        symmetryMode,
        ditherRollerIdx,
        offsetReticle,
        stabilizerEnabled,
        onionSkin,
        previewPlaying,
        zoom,
        panX,
        panY,
        hasActiveFlood: Boolean(activeFloodJob && !activeFloodJob.done),
        dustParticleCount: dustParticles.length,
      };
    },
  };
}
