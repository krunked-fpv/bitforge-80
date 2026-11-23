/**
 * BitForge-80 ASMR Micro-Foley Luthiery & Haptic Bridge
 * Maps pixel strokes, domino flood ripples, crumble erasures, ceramic autotile snaps,
 * PBT switch clicks, and bezel mechanical detents onto scale-quantized DSP voices.
 */

import { HARMONIC_SCALES, quantizeRowToFreq } from './dsp-engine.js';

function clampInt(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clamp01(val, fallback = 0.5) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function resolveScale(scaleId) {
  return typeof scaleId === 'string' && HARMONIC_SCALES[scaleId]
    ? scaleId
    : 'pentatonic';
}

function safeVibrate(pattern) {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : globalThis.navigator;
    if (nav && typeof nav.vibrate === 'function') {
      nav.vibrate(pattern);
    }
  } catch {
    // Ignore locked WebViews or unsupported environments
  }
}

/**
 * Compute gentle kalimba pluck parameters from pixel Y row and color luminance.
 * Frequency strictly ascends with `yRow` (`0..15`) quantized to `scaleId`.
 * @param {number} [yRow=0]
 * @param {number} [luminance=0.5]
 * @param {string} [scaleId='pentatonic']
 * @param {number} [velocity=0.75]
 * @returns {{ freq: number, row: number, scaleId: string, durationSec: number, velocity: number, brightness: number, dutyOrTimbre: number, filterHz: number, chIdx: number }}
 */
export function computeKalimbaPluckParams(
  yRow = 0,
  luminance = 0.5,
  scaleId = 'pentatonic',
  velocity = 0.75
) {
  const row = clampInt(yRow, 0, 15, 0);
  const lum = clamp01(luminance, 0.5);
  const vel = clamp01(velocity, 0.75);
  const resolvedScale = resolveScale(scaleId);
  const freq = quantizeRowToFreq(resolvedScale, row, 3);

  return {
    freq,
    row,
    scaleId: resolvedScale,
    durationSec: Number((0.16 - lum * 0.045).toFixed(4)),
    velocity: Number((0.18 + vel * 0.42).toFixed(4)),
    brightness: lum,
    dutyOrTimbre: Math.round(48 + lum * 180),
    filterHz: Math.round(1100 + lum * 4200),
    chIdx: 1,
  };
}

/**
 * Compute ascending domino-flood harp frequency for radial BFS ring index.
 * @param {number} [ringIdx=0]
 * @param {string} [scaleId='pentatonic']
 * @returns {number}
 */
export function computeDominoHarpFreq(ringIdx = 0, scaleId = 'pentatonic') {
  const idx = clampInt(ringIdx, 0, 30, 0);
  return quantizeRowToFreq(resolveScale(scaleId), idx, 3);
}

/**
 * Subscribe to BitForge-80 Studio/Chassis foley events on `bus` and drive `dsp` + safe haptics.
 * @param {{ dsp?: any, bus?: any, getCart?: () => any }} [opts]
 */
export function createAsmrFoley({ dsp = null, bus = null, getCart = null } = {}) {
  let enabled = true;
  let destroyed = false;
  const unsubs = [];

  function resolveEventScale(payload) {
    if (payload && typeof payload.scaleId === 'string' && HARMONIC_SCALES[payload.scaleId]) {
      return payload.scaleId;
    }
    const cartScale = typeof getCart === 'function' ? getCart()?.audio?.scaleId : null;
    return resolveScale(cartScale);
  }

  function triggerPixel(payload = {}) {
    if (!enabled || destroyed) return;
    const yRow = payload?.y ?? payload?.yRow ?? payload?.row ?? 7;
    const lum = payload?.luminance !== undefined
      ? payload.luminance
      : (typeof payload?.colorIdx === 'number' ? (payload.colorIdx % 16) / 15 : 0.5);
    const vel = payload?.velocity ?? 0.72;
    const params = computeKalimbaPluckParams(yRow, lum, resolveEventScale(payload), vel);

    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(params.chIdx, params.freq, params.durationSec, params.velocity, {
        dutyOrTimbre: params.dutyOrTimbre,
      });
    }
    safeVibrate(4);
  }

  function triggerFlood(payload = {}) {
    if (!enabled || destroyed) return;
    const ringIdx = payload?.ringIdx ?? payload?.ring ?? payload?.step ?? 0;
    const freq = computeDominoHarpFreq(ringIdx, resolveEventScale(payload));
    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(3, freq, 0.22, 0.52);
    }
    safeVibrate(6);
  }

  function triggerErase(payload = {}) {
    if (!enabled || destroyed) return;
    const yRow = clampInt(payload?.y ?? payload?.row ?? 6, 0, 15, 6);
    const freq = 750 + yRow * 75;
    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(2, freq, 0.065, 0.32, { dutyOrTimbre: 110 });
    }
    safeVibrate(5);
  }

  function triggerAutotile(payload = {}) {
    if (!enabled || destroyed) return;
    const scaleId = resolveEventScale(payload);
    const terrainId = clampInt(payload?.terrainId ?? payload?.variantIdx ?? 1, 0, 15, 1);
    const freq = quantizeRowToFreq(scaleId, terrainId % 8, 3);
    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(1, freq, 0.075, 0.50, { dutyOrTimbre: 96 });
      dsp.playNote(2, 1900, 0.025, 0.20, { dutyOrTimbre: 180 });
    }
    safeVibrate(8);
  }

  function triggerSwitch(payload = {}) {
    if (!enabled || destroyed) return;
    const idx = clampInt(payload?.index ?? payload?.slot ?? 0, 0, 7, 0);
    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(1, 220 + idx * 14, 0.035, 0.44, { dutyOrTimbre: 160 });
      dsp.playNote(2, 2600, 0.018, 0.16, { dutyOrTimbre: 200 });
    }
    safeVibrate(7);
  }

  function triggerDetent(payload = {}) {
    if (!enabled || destroyed) return;
    const detent = Math.abs(Number(payload?.detent ?? payload?.step ?? 0) || 0);
    const vel = Math.abs(Number(payload?.velocity ?? 1) || 1);
    const freq = 340 + (detent % 12) * 22;
    const gain = Math.min(0.55, 0.26 + Math.min(vel, 6) * 0.04);
    if (dsp && typeof dsp.playNote === 'function') {
      dsp.playNote(1, freq, 0.025, gain, { dutyOrTimbre: 180 });
      dsp.playNote(2, 3100, 0.015, 0.14, { dutyOrTimbre: 210 });
    }
    safeVibrate(3);
  }

  const subscriptions = [
    ['foley:pixel', triggerPixel],
    ['foley:flood', triggerFlood],
    ['foley:erase', triggerErase],
    ['foley:autotile', triggerAutotile],
    ['foley:switch', triggerSwitch],
    ['bezel:detent', triggerDetent],
  ];

  if (bus && typeof bus.on === 'function') {
    for (const [evt, fn] of subscriptions) {
      const res = bus.on(evt, fn);
      if (typeof res === 'function') {
        unsubs.push(res);
      } else if (typeof bus.off === 'function') {
        unsubs.push(() => bus.off(evt, fn));
      }
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of unsubs) off();
    unsubs.length = 0;
  }

  return {
    triggerPixel,
    triggerFlood,
    triggerErase,
    triggerAutotile,
    triggerSwitch,
    triggerDetent,
    setEnabled: (flag) => { enabled = Boolean(flag); },
    isEnabled: () => enabled,
    destroy,
  };
}
