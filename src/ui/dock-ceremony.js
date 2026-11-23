/**
 * BitForge-80 Hardware Cartridge Dock Ceremony
 * 850ms crisp 128x128 pixel insertion animation:
 *   0-320ms   pixel cartridge slides down into brass connector slot
 *   320ms     mechanical clack-thock trigger + safe haptics
 *   420ms     16-color brass pin sparks
 *   500-850ms scanline phosphor bloom + boot chord
 */

const DEFAULT_HEX_16 = [
  '#12131a', '#1f2436', '#3b4363', '#7c86a8',
  '#e8ecf5', '#ff4f6e', '#ff944d', '#f6c453',
  '#a6e25a', '#3ac98c', '#38b6ff', '#4f6eff',
  '#9c5cff', '#ff7ad9', '#9e5a47', '#f2c6a0',
];

let cancelActiveCeremony = null;

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function easeOutCubic(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

function resolveHexPalette(palette) {
  if (palette && Array.isArray(palette.hex) && palette.hex.length >= 16) {
    return palette.hex;
  }
  if (palette && palette.rgb && palette.rgb.length >= 48) {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const r = palette.rgb[i * 3].toString(16).padStart(2, '0');
      const g = palette.rgb[i * 3 + 1].toString(16).padStart(2, '0');
      const b = palette.rgb[i * 3 + 2].toString(16).padStart(2, '0');
      out.push(`#${r}${g}${b}`);
    }
    return out;
  }
  return DEFAULT_HEX_16;
}

function buildSparks() {
  const sparks = [];
  for (let i = 0; i < 24; i++) {
    const pinIdx = i % 16;
    const px = 34 + pinIdx * 4;
    const spread = ((i % 7) - 3) * 11;
    const upward = -18 - ((i * 13) % 28);
    sparks.push({
      x0: px,
      y0: 93,
      vx: spread,
      vy: upward,
      colorIdx: 1 + (i % 15),
    });
  }
  return sparks;
}

function drawCoverSprite(ctx, rom, hex16, cartX, cartY) {
  const sprites = rom && Array.isArray(rom.sprites) ? rom.sprites : null;
  if (!sprites || sprites.length === 0) return;
  const coverIdx = Math.max(0, Math.min(sprites.length - 1, rom?.meta?.coverSpriteIdx ?? 0));
  const slot = sprites[coverIdx];
  const frame = slot && Array.isArray(slot.frames) ? slot.frames[0] : null;
  if (!frame) return;

  const size = slot.size === 16 ? 16 : 8;
  const pxScale = size === 16 ? 2 : 4; // 32x32 target preview area
  const ox = Math.round(cartX + 18);
  const oy = Math.round(cartY + 14);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cIdx = frame[y * size + x] & 15;
      if (cIdx === 0) continue;
      ctx.fillStyle = hex16[cIdx] || DEFAULT_HEX_16[cIdx];
      ctx.fillRect(ox + x * pxScale, oy + y * pxScale, pxScale, pxScale);
    }
  }
}

function renderCeremonyFrame(ctx, elapsedMs, durationMs, rom, hex16, sparks) {
  if (!ctx) return;
  if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;

  const tTotal = durationMs > 0 ? clamp01(elapsedMs / durationMs) : 1;
  const slideMs = (elapsedMs / Math.max(1, durationMs)) * 850;

  // Background anodized chassis bay
  ctx.fillStyle = hex16[0] || '#12131a';
  ctx.fillRect(0, 0, 128, 128);

  // Subtle vertical pin guide rails
  ctx.fillStyle = '#191c26';
  ctx.fillRect(22, 0, 84, 102);
  ctx.fillStyle = '#0c0d13';
  ctx.fillRect(26, 92, 76, 10);

  // Brass dock connector bed
  for (let p = 0; p < 16; p++) {
    ctx.fillStyle = slideMs >= 320 ? '#f6c453' : '#7d632c';
    ctx.fillRect(32 + p * 4, 94, 2, 5);
  }

  // Sliding cartridge shell (0..320ms travel)
  const slideT = easeOutCubic(slideMs / 320);
  const impactOffset = slideMs >= 320 && slideMs < 410 ? Math.round(Math.sin((slideMs - 320) * 0.25) * 1.5) : 0;
  const cartX = 30;
  const cartY = Math.round(-56 + slideT * 78) + impactOffset;

  // Outer cartridge body
  ctx.fillStyle = '#1f2332';
  ctx.fillRect(cartX, cartY, 68, 70);
  ctx.fillStyle = '#333951';
  ctx.fillRect(cartX, cartY, 68, 2);
  ctx.fillRect(cartX, cartY, 2, 70);
  ctx.fillStyle = '#0d0f16';
  ctx.fillRect(cartX + 66, cartY, 2, 70);

  // Cartridge grip ribs
  for (let r = 0; r < 3; r++) {
    ctx.fillStyle = '#2d3347';
    ctx.fillRect(cartX + 6, cartY + 4 + r * 3, 16, 1);
    ctx.fillRect(cartX + 46, cartY + 4 + r * 3, 16, 1);
  }

  // Cartridge sticker bay + 16-color cover sprite
  ctx.fillStyle = '#11131b';
  ctx.fillRect(cartX + 8, cartY + 11, 52, 44);
  drawCoverSprite(ctx, rom, hex16, cartX, cartY);

  // 16-color palette DNA strip along sticker bottom
  for (let c = 0; c < 16; c++) {
    ctx.fillStyle = hex16[c] || DEFAULT_HEX_16[c];
    ctx.fillRect(cartX + 10 + c * 3, cartY + 49, 3, 4);
  }

  // Gold edge connector pins at bottom of cart
  for (let p = 0; p < 16; p++) {
    ctx.fillStyle = '#f6c453';
    ctx.fillRect(cartX + 2 + p * 4, cartY + 62, 2, 8);
  }

  // 420ms+: 16-color brass pin sparks
  if (slideMs >= 400) {
    const sparkAge = (slideMs - 400) / 450;
    if (sparkAge < 1) {
      for (let i = 0; i < sparks.length; i++) {
        const sp = sparks[i];
        const sx = Math.round(sp.x0 + sp.vx * sparkAge);
        const sy = Math.round(sp.y0 + sp.vy * sparkAge + 48 * sparkAge * sparkAge);
        if (sx >= 0 && sx < 128 && sy >= 0 && sy < 128) {
          ctx.fillStyle = hex16[sp.colorIdx] || DEFAULT_HEX_16[sp.colorIdx];
          ctx.fillRect(sx, sy, 2, 2);
        }
      }
    }
  }

  // 500-850ms: Scanline phosphor bloom + ready bar
  if (slideMs >= 500) {
    const bloomT = clamp01((slideMs - 500) / 350);
    const sweepY = Math.round(bloomT * 128);
    ctx.fillStyle = `rgba(246, 196, 83, ${(1 - bloomT) * 0.45})`;
    ctx.fillRect(0, sweepY - 3, 128, 6);

    ctx.fillStyle = `rgba(232, 236, 245, ${(1 - bloomT) * 0.22})`;
    for (let y = 0; y < 128; y += 2) {
      if (y <= sweepY) {
        ctx.fillRect(0, y, 128, 1);
      }
    }

    // Minimal boot status bar at bottom
    ctx.fillStyle = '#f6c453';
    const barW = Math.round(tTotal * 76);
    ctx.fillRect(26, 112, barW, 3);
  }
}

function triggerHapticClack() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : globalThis.navigator;
    if (nav && nav.userActivation && !nav.userActivation.hasBeenActive) {
      return;
    }
    if (nav && typeof nav.vibrate === 'function') {
      nav.vibrate([8, 18, 5]);
    }
  } catch {
    // Ignore locked WebViews
  }
}

/**
 * Run the 850ms BitForge-80 cartridge dock insertion ceremony.
 * Resolves gracefully in headless or shortened durationMs modes.
 * @param {{
 *   canvas?: HTMLCanvasElement|null,
 *   rom?: object|null,
 *   palette?: { hex?: string[], rgb?: Uint8Array }|null,
 *   dsp?: object|null,
 *   bus?: { emit?: Function }|null,
 *   durationMs?: number,
 * }} [opts]
 * @returns {Promise<{ completed: boolean, cancelled: boolean, durationMs: number }>}
 */
export function runDockCeremony({
  canvas = null,
  rom = null,
  palette = null,
  dsp = null,
  bus = null,
  durationMs = 850,
} = {}) {
  if (typeof cancelActiveCeremony === 'function') {
    cancelActiveCeremony();
    cancelActiveCeremony = null;
  }

  const totalDuration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 850);
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const hex16 = resolveHexPalette(palette);
  const sparks = buildSparks();
  const scaleId = rom?.audio?.scaleId || 'pentatonic';

  let clackFired = false;
  let chordFired = false;
  let finished = false;
  let rafId = null;
  let timerId = null;

  const fireClack = () => {
    if (clackFired) return;
    clackFired = true;
    if (bus && typeof bus.emit === 'function') {
      bus.emit('foley:switch', { index: 2, phase: 'dock-clack', title: rom?.meta?.title || '' });
    }
    if (dsp && typeof dsp.playSfxSlot === 'function') {
      dsp.playSfxSlot(2, 0.5);
    }
    triggerHapticClack();
  };

  const fireBootChord = () => {
    if (chordFired) return;
    chordFired = true;
    if (dsp && typeof dsp.playBootChord === 'function') {
      dsp.playBootChord(scaleId);
    }
  };

  return new Promise((resolve) => {
    const cleanup = (cancelled) => {
      if (finished) return;
      finished = true;
      if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
      }
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      if (cancelActiveCeremony === cancel) {
        cancelActiveCeremony = null;
      }
      resolve({ completed: !cancelled, cancelled, durationMs: totalDuration });
    };

    const cancel = () => cleanup(true);
    cancelActiveCeremony = cancel;

    const hasRaf = typeof globalThis.requestAnimationFrame === 'function';
    // Fast / headless execution when durationMs is short or RAF is unavailable
    if (totalDuration <= 40 || !hasRaf) {
      const steps = [0.2, 0.4, 0.55, 0.85, 1];
      for (const s of steps) {
        const ms = totalDuration * s;
        renderCeremonyFrame(ctx, ms, totalDuration || 1, rom, hex16, sparks);
        if (s >= 0.37) fireClack();
        if (s >= 0.58) fireBootChord();
      }
      if (totalDuration === 0) {
        cleanup(false);
      } else {
        timerId = setTimeout(() => cleanup(false), totalDuration);
      }
      return;
    }

    const startNow = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

    const frame = (now) => {
      if (finished) return;
      const elapsed = Math.max(0, (now || Date.now()) - startNow);
      const normMs = (elapsed / totalDuration) * 850;

      renderCeremonyFrame(ctx, elapsed, totalDuration, rom, hex16, sparks);
      if (normMs >= 320) fireClack();
      if (normMs >= 500) fireBootChord();

      if (elapsed >= totalDuration) {
        fireClack();
        fireBootChord();
        cleanup(false);
        return;
      }
      rafId = globalThis.requestAnimationFrame(frame);
    };

    rafId = globalThis.requestAnimationFrame(frame);
    // Safety deadline so ceremony never hangs even if tab is backgrounded
    timerId = setTimeout(() => {
      fireClack();
      fireBootChord();
      cleanup(false);
    }, totalDuration + 120);
  });
}
