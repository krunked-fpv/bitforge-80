/**
 * BitForge-80 2D XY SFX Sculptor Pad & 6-Byte Patch Codec
 * 8 expressive retro-ASMR SFX archetypes mapped across X (pitch/brightness) & Y (decay/crunch).
 */

export const SFX_ARCHETYPES = Object.freeze([
  'Coin',
  'Pop',
  'Thock',
  'Laser',
  'Bubble',
  'Shatter',
  'Bloom',
  'Chime',
]);

const PATCH_MAGIC_VERSION = 0x50; // Upper nibble 0x5 identifies v1 6-byte SFX patch

function clampInt(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clamp01(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function normalizeArchetypeIndex(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    const byName = SFX_ARCHETYPES.findIndex((name) => name.toLowerCase() === trimmed);
    if (byName !== -1) return byName;
  }
  return clampInt(raw, 0, SFX_ARCHETYPES.length - 1, 0);
}

function normalizePatch(patch) {
  const src = patch && typeof patch === 'object' ? patch : {};
  return {
    archetype: normalizeArchetypeIndex(src.archetype),
    x: clampInt(src.x, 0, 255, 128),
    y: clampInt(src.y, 0, 255, 128),
  };
}

/**
 * Derive physical DSP synthesis parameters from an `{ archetype, x, y }` SFX patch.
 * @param {{ archetype?: number|string, x?: number, y?: number }} [patch]
 * @returns {{ archetype: number, name: string, freqStart: number, freqEnd: number, decayMs: number, filterHz: number, crunch: number, waveType: string }}
 */
export function computeSfxPatchParameters(patch = {}) {
  const norm = normalizePatch(patch);
  const nx = norm.x / 255;
  const ny = norm.y / 255;
  const name = SFX_ARCHETYPES[norm.archetype];

  switch (norm.archetype) {
    case 0: { // Coin: brisk two-step upward chime
      const freqStart = 520 + nx * 680;
      return {
        archetype: 0,
        name,
        freqStart,
        freqEnd: freqStart * (1.45 + ny * 0.65),
        decayMs: Math.round(110 + ny * 210),
        filterHz: Math.round(2800 + nx * 5200),
        crunch: clamp01(0.05 + ny * 0.15),
        waveType: 'square',
      };
    }
    case 1: { // Pop: tactile rubbery pop transient
      const freqStart = 180 + nx * 360;
      return {
        archetype: 1,
        name,
        freqStart,
        freqEnd: freqStart * (2.1 + ny * 1.4),
        decayMs: Math.round(45 + ny * 85),
        filterHz: Math.round(1200 + nx * 3200),
        crunch: clamp01(0.08 + ny * 0.22),
        waveType: 'sine',
      };
    }
    case 2: { // Thock: PBT keycap / warm wooden block
      const freqStart = 210 + nx * 240;
      return {
        archetype: 2,
        name,
        freqStart,
        freqEnd: 68 + nx * 55,
        decayMs: Math.round(38 + ny * 75),
        filterHz: Math.round(650 + nx * 1600),
        crunch: clamp01(0.18 + ny * 0.35),
        waveType: 'triangle',
      };
    }
    case 3: { // Laser: crisp downward arcade sweep
      const freqStart = 880 + nx * 1760;
      return {
        archetype: 3,
        name,
        freqStart,
        freqEnd: 110 + nx * 180,
        decayMs: Math.round(95 + ny * 260),
        filterHz: Math.round(2200 + nx * 5800),
        crunch: clamp01(0.15 + ny * 0.45),
        waveType: 'sawtooth',
      };
    }
    case 4: { // Bubble: resonant liquid upward chirp
      const freqStart = 240 + nx * 420;
      return {
        archetype: 4,
        name,
        freqStart,
        freqEnd: freqStart * (1.8 + ny * 1.2),
        decayMs: Math.round(70 + ny * 140),
        filterHz: Math.round(900 + nx * 2800),
        crunch: clamp01(0.02 + ny * 0.12),
        waveType: 'sine',
      };
    }
    case 5: { // Shatter: 15-bit LFSR crystal / glass burst
      const freqStart = 1200 + nx * 2400;
      return {
        archetype: 5,
        name,
        freqStart,
        freqEnd: 220 + nx * 380,
        decayMs: Math.round(120 + ny * 320),
        filterHz: Math.round(1800 + nx * 6400),
        crunch: clamp01(0.45 + ny * 0.55),
        waveType: 'noise',
      };
    }
    case 6: { // Bloom: gentle swelling pad pluck
      const freqStart = 220 + nx * 330;
      return {
        archetype: 6,
        name,
        freqStart,
        freqEnd: freqStart * (1.02 + ny * 0.25),
        decayMs: Math.round(180 + ny * 380),
        filterHz: Math.round(800 + nx * 2400),
        crunch: clamp01(0.04 + ny * 0.16),
        waveType: 'triangle',
      };
    }
    case 7:
    default: { // Chime: glassy resonant bell ping
      const freqStart = 660 + nx * 990;
      return {
        archetype: 7,
        name: SFX_ARCHETYPES[7],
        freqStart,
        freqEnd: freqStart * (0.995 + ny * 0.015),
        decayMs: Math.round(220 + ny * 440),
        filterHz: Math.round(3400 + nx * 6200),
        crunch: clamp01(0.02 + ny * 0.10),
        waveType: 'sine',
      };
    }
  }
}

/**
 * Losslessly pack an SFX patch into an exact 6-byte Uint8Array.
 * Byte layout:
 * - [0]: (0x50 | archetype[0..7])
 * - [1]: x (0..255)
 * - [2]: y (0..255)
 * - [3]: quantized start frequency code (0..255)
 * - [4]: packed decayMs nibble (high) | crunch nibble (low)
 * - [5]: 8-bit integrity tag across bytes 0..4
 * @param {{ archetype?: number|string, x?: number, y?: number }} [patch]
 * @returns {Uint8Array}
 */
export function packSfxPatch6Bytes(patch = {}) {
  const norm = normalizePatch(patch);
  const params = computeSfxPatchParameters(norm);
  const b0 = PATCH_MAGIC_VERSION | (norm.archetype & 0x07);
  const b1 = norm.x & 0xFF;
  const b2 = norm.y & 0xFF;
  const b3 = Math.max(0, Math.min(255, Math.round(params.freqStart / 16)));
  const decayNib = Math.max(0, Math.min(15, Math.round(params.decayMs / 45)));
  const crunchNib = Math.max(0, Math.min(15, Math.round(params.crunch * 15)));
  const b4 = ((decayNib & 0x0F) << 4) | (crunchNib & 0x0F);
  const b5 = ((b0 * 31) ^ (b1 * 17) ^ (b2 * 13) ^ (b3 * 7) ^ b4) & 0xFF;
  return new Uint8Array([b0, b1, b2, b3, b4, b5]);
}

/**
 * Losslessly unpack a 6-byte Uint8Array back into `{ archetype, x, y }`.
 * @param {Uint8Array|ArrayLike<number>} bytes
 * @returns {{ archetype: number, x: number, y: number }}
 */
export function unpackSfxPatch6Bytes(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length !== 6) {
    throw new RangeError('unpackSfxPatch6Bytes requires an exact 6-byte array');
  }
  const b0 = Number(bytes[0]) & 0xFF;
  const b1 = Number(bytes[1]) & 0xFF;
  const b2 = Number(bytes[2]) & 0xFF;
  return {
    archetype: b0 & 0x07,
    x: b1,
    y: b2,
  };
}

function formatPatchHex(patch) {
  const bytes = packSfxPatch6Bytes(patch);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return hex;
}

/**
 * Create the 2D XY SFX Sculptor Pad + 8 Archetype Selector UI.
 * @param {{ container?: any, getCart?: () => any, onMutate?: (info: any) => void, dsp?: any, bus?: any }} [opts]
 */
export function createSfxXyPad({
  container = null,
  getCart = null,
  onMutate = null,
  dsp = null,
  bus = null,
} = {}) {
  let mounted = false;
  let selectedSlot = 0;
  let dragging = false;
  let lastPreviewMs = 0;
  let cleanupListeners = [];

  let rootEl = null;
  let slotBarEl = null;
  let archGridEl = null;
  let padCanvas = null;
  let padBoxEl = null;
  let puckEl = null;
  let readoutEl = null;

  function readCart() {
    return typeof getCart === 'function' ? getCart() : null;
  }

  function ensurePatches(cart) {
    if (!cart) return null;
    if (!cart.audio || typeof cart.audio !== 'object') {
      cart.audio = { bpm: 120, scaleId: 'pentatonic', channels: [], wavetable32: new Uint8Array(32), sfxPatches: [] };
    }
    if (!Array.isArray(cart.audio.sfxPatches)) {
      cart.audio.sfxPatches = [];
    }
    while (cart.audio.sfxPatches.length < 8) {
      const idx = cart.audio.sfxPatches.length;
      cart.audio.sfxPatches.push({ archetype: idx, x: 128, y: 128 });
    }
    return cart.audio.sfxPatches;
  }

  function getActivePatch() {
    const cart = readCart();
    const patches = ensurePatches(cart);
    if (!patches) return { archetype: selectedSlot, x: 128, y: 128 };
    const patch = patches[selectedSlot];
    if (!patch || typeof patch !== 'object') {
      patches[selectedSlot] = { archetype: selectedSlot, x: 128, y: 128 };
      return patches[selectedSlot];
    }
    patch.archetype = normalizeArchetypeIndex(patch.archetype);
    patch.x = clampInt(patch.x, 0, 255, 128);
    patch.y = clampInt(patch.y, 0, 255, 128);
    return patch;
  }

  function emitSwitch(extra = {}) {
    if (bus && typeof bus.emit === 'function') {
      bus.emit('foley:switch', { source: 'sfx-xy-pad', slot: selectedSlot, ...extra });
    }
  }

  function notifyMutation(patch) {
    const cart = readCart();
    if (dsp && typeof dsp.syncCart === 'function' && cart) {
      dsp.syncCart(cart);
    }
    if (typeof onMutate === 'function') {
      onMutate({ type: 'sfxPatch', slotIdx: selectedSlot, patch: { ...patch }, cart });
    }
  }

  function previewSlot(force = false) {
    const now = Date.now();
    if (!force && now - lastPreviewMs < 85) return;
    lastPreviewMs = now;
    if (dsp && typeof dsp.unlock === 'function') {
      dsp.unlock();
    }
    if (dsp && typeof dsp.playSfxSlot === 'function') {
      dsp.playSfxSlot(selectedSlot);
    } else if (dsp && typeof dsp.triggerSfx === 'function') {
      dsp.triggerSfx(selectedSlot);
    }
  }

  function drawPadCanvas(patch) {
    if (!padCanvas || typeof padCanvas.getContext !== 'function') return;
    const ctx = padCanvas.getContext('2d');
    if (!ctx) return;

    const w = padCanvas.width || 160;
    const h = padCanvas.height || 160;
    ctx.fillStyle = '#12131a';
    ctx.fillRect(0, 0, w, h);

    // Subtle acoustic reticle grid
    ctx.strokeStyle = 'rgba(130, 146, 178, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = Math.round((w * i) / 4) + 0.5;
      const gy = Math.round((h * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const px = (patch.x / 255) * w;
    const py = (1 - patch.y / 255) * h;

    // Crosshairs
    ctx.strokeStyle = 'rgba(246, 196, 83, 0.55)';
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();

    // Glowing phosphor puck
    ctx.fillStyle = 'rgba(246, 196, 83, 0.25)';
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f6c453';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function renderState() {
    const patch = getActivePatch();
    const params = computeSfxPatchParameters(patch);

    if (slotBarEl && slotBarEl.children) {
      for (let i = 0; i < slotBarEl.children.length; i++) {
        const btn = slotBarEl.children[i];
        const active = i === selectedSlot;
        btn.dataset.active = active ? 'true' : 'false';
        if (btn.setAttribute) btn.setAttribute('aria-pressed', String(active));
      }
    }

    if (archGridEl && archGridEl.children) {
      for (let i = 0; i < archGridEl.children.length; i++) {
        const btn = archGridEl.children[i];
        const active = i === patch.archetype;
        btn.dataset.active = active ? 'true' : 'false';
        if (btn.setAttribute) btn.setAttribute('aria-pressed', String(active));
      }
    }

    if (puckEl && puckEl.style) {
      puckEl.style.left = `${(patch.x / 255) * 100}%`;
      puckEl.style.top = `${(1 - patch.y / 255) * 100}%`;
    }

    if (readoutEl) {
      const hex = formatPatchHex(patch);
      readoutEl.textContent = `SFX${selectedSlot} ${params.name.toUpperCase()} · ${Math.round(params.freqStart)}→${Math.round(params.freqEnd)}Hz · ${params.decayMs}ms · 6B:${hex}`;
    }

    drawPadCanvas(patch);
  }

  function updateCoordsFromEvent(ev) {
    if (!padBoxEl) return;
    let rect = { left: 0, top: 0, width: 160, height: 160 };
    if (typeof padBoxEl.getBoundingClientRect === 'function') {
      const r = padBoxEl.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) rect = r;
    }
    const clientX = typeof ev?.clientX === 'number' ? ev.clientX : rect.left + rect.width * 0.5;
    const clientY = typeof ev?.clientY === 'number' ? ev.clientY : rect.top + rect.height * 0.5;
    const nx = clamp01((clientX - rect.left) / rect.width);
    const ny = clamp01(1 - (clientY - rect.top) / rect.height);
    const patch = getActivePatch();
    patch.x = Math.round(nx * 255);
    patch.y = Math.round(ny * 255);
    notifyMutation(patch);
    renderState();
  }

  function selectSlot(idx) {
    selectedSlot = clampInt(idx, 0, 7, 0);
    renderState();
    emitSwitch({ action: 'selectSlot' });
    previewSlot(true);
  }

  function setPatch(partial = {}) {
    const patch = getActivePatch();
    if (partial.archetype !== undefined) {
      patch.archetype = normalizeArchetypeIndex(partial.archetype);
    }
    if (partial.x !== undefined) {
      patch.x = clampInt(partial.x, 0, 255, patch.x);
    }
    if (partial.y !== undefined) {
      patch.y = clampInt(partial.y, 0, 255, patch.y);
    }
    notifyMutation(patch);
    renderState();
    return { ...patch };
  }

  function bindEvent(el, type, fn) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, fn);
    cleanupListeners.push(() => {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener(type, fn);
      }
    });
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    if (container && container.ownerDocument) {
      const doc = container.ownerDocument;
      rootEl = doc.createElement('div');
      rootEl.className = 'bf-sfx-xy-pad';

      // Slot selector row (SFX 0..7)
      slotBarEl = doc.createElement('div');
      slotBarEl.className = 'bf-sfx-slot-bar';
      for (let s = 0; s < 8; s++) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bf-sfx-slot-btn';
        btn.textContent = `S${s}`;
        btn.dataset.slot = String(s);
        btn.setAttribute('aria-label', `SFX Slot ${s}`);
        bindEvent(btn, 'click', () => selectSlot(s));
        slotBarEl.appendChild(btn);
      }
      rootEl.appendChild(slotBarEl);

      // 8 Archetype buttons
      archGridEl = doc.createElement('div');
      archGridEl.className = 'bf-sfx-arch-grid';
      for (let a = 0; a < SFX_ARCHETYPES.length; a++) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bf-sfx-arch-btn';
        btn.textContent = SFX_ARCHETYPES[a];
        btn.dataset.archetype = String(a);
        bindEvent(btn, 'click', () => {
          setPatch({ archetype: a });
          emitSwitch({ archetype: a });
          previewSlot(true);
        });
        archGridEl.appendChild(btn);
      }
      rootEl.appendChild(archGridEl);

      // 2D XY Pad Surface
      padBoxEl = doc.createElement('div');
      padBoxEl.className = 'bf-sfx-pad-stage';
      padBoxEl.style.position = 'relative';
      padBoxEl.style.touchAction = 'none';

      padCanvas = doc.createElement('canvas');
      padCanvas.className = 'bf-sfx-pad-canvas';
      padCanvas.width = 160;
      padCanvas.height = 128;
      padBoxEl.appendChild(padCanvas);

      puckEl = doc.createElement('div');
      puckEl.className = 'bf-sfx-pad-puck';
      puckEl.setAttribute('aria-hidden', 'true');
      padBoxEl.appendChild(puckEl);

      const onPointerDown = (ev) => {
        dragging = true;
        try {
          if (typeof padBoxEl.setPointerCapture === 'function' && ev?.pointerId !== undefined) {
            padBoxEl.setPointerCapture(ev.pointerId);
          }
        } catch {
          // Ignore synthetic pointer capture error
        }
        updateCoordsFromEvent(ev);
        previewSlot(true);
      };
      const onPointerMove = (ev) => {
        if (!dragging) return;
        updateCoordsFromEvent(ev);
        previewSlot(false);
      };
      const onPointerUp = () => {
        dragging = false;
      };

      bindEvent(padBoxEl, 'pointerdown', onPointerDown);
      bindEvent(padBoxEl, 'pointermove', onPointerMove);
      bindEvent(padBoxEl, 'pointerup', onPointerUp);
      bindEvent(padBoxEl, 'pointercancel', onPointerUp);

      rootEl.appendChild(padBoxEl);

      // Footer readout + audition trigger
      const footer = doc.createElement('div');
      footer.className = 'bf-sfx-footer';

      readoutEl = doc.createElement('span');
      readoutEl.className = 'bf-sfx-readout';
      footer.appendChild(readoutEl);

      const testBtn = doc.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'bf-sfx-test-btn';
      testBtn.textContent = 'AUDITION';
      bindEvent(testBtn, 'click', () => previewSlot(true));
      footer.appendChild(testBtn);

      rootEl.appendChild(footer);
      container.appendChild(rootEl);
    }

    renderState();
  }

  function unmount() {
    mounted = false;
    dragging = false;
    for (const off of cleanupListeners) off();
    cleanupListeners = [];
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    rootEl = null;
    slotBarEl = null;
    archGridEl = null;
    padCanvas = null;
    padBoxEl = null;
    puckEl = null;
    readoutEl = null;
  }

  return {
    mount,
    unmount,
    destroy: unmount,
    refresh: renderState,
    selectSlot,
    setPatch,
    getSelectedSlot: () => selectedSlot,
    getActivePatch,
  };
}
