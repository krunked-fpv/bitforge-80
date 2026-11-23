/**
 * BitForge-80 Web Audio DSP Engine
 * 4-voice retro-ASMR synth (Pulse, Triangle/Marimba, 15-bit LFSR Noise, 32-step Wavetable)
 * routed through warm soft-knee tape saturation and a brickwall safety limiter.
 */

import { computeSfxPatchParameters } from './sfx-xy-pad.js';

export const HARMONIC_SCALES = Object.freeze({
  pentatonic: Object.freeze({
    id: 'pentatonic',
    name: 'Pentatonic',
    semitones: Object.freeze([0, 2, 4, 7, 9]),
    intervals: Object.freeze([0, 2, 4, 7, 9]),
  }),
  dorian: Object.freeze({
    id: 'dorian',
    name: 'Dorian',
    semitones: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
    intervals: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
  }),
  lydian: Object.freeze({
    id: 'lydian',
    name: 'Lydian',
    semitones: Object.freeze([0, 2, 4, 6, 7, 9, 11]),
    intervals: Object.freeze([0, 2, 4, 6, 7, 9, 11]),
  }),
  hirajoshi: Object.freeze({
    id: 'hirajoshi',
    name: 'Hirajoshi',
    semitones: Object.freeze([0, 2, 3, 7, 8]),
    intervals: Object.freeze([0, 2, 3, 7, 8]),
  }),
  lofiMaj9: Object.freeze({
    id: 'lofiMaj9',
    name: 'Lo-Fi Maj9',
    semitones: Object.freeze([0, 2, 4, 7, 11]),
    intervals: Object.freeze([0, 2, 4, 7, 11]),
  }),
});

const PULSE_HARMONICS = 48;
const LFSR_PERIOD_MAX = 32767;
const DEFAULT_WAVETABLE_NIBBLES = new Uint8Array([
  8, 10, 12, 14, 15, 15, 14, 13,
  11, 10, 9, 8, 8, 8, 7, 6,
  5, 3, 2, 1, 0, 0, 1, 2,
  4, 5, 6, 7, 7, 7, 8, 8,
]);

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Tanh soft-knee saturator / brickwall sample clipper guaranteeing |y| <= 1.0.
 * @param {number} x
 * @returns {number}
 */
export function softClipSample(x) {
  if (!Number.isFinite(x)) {
    if (x === Infinity) return 1;
    if (x === -Infinity) return -1;
    return 0;
  }
  const y = Math.tanh(x);
  if (y > 1) return 1;
  if (y < -1) return -1;
  return y;
}

/**
 * Quantize a matrix row (0..15+) monotonically onto one of the 5 harmonic scales.
 * Row 0 corresponds to the root at `octaveBase` (C3 = MIDI 48 when octaveBase = 3).
 * @param {string} scaleId
 * @param {number} row0to15
 * @param {number} [octaveBase=3]
 * @returns {number} Frequency in Hz
 */
export function quantizeRowToFreq(scaleId, row0to15, octaveBase = 3) {
  const scale = HARMONIC_SCALES[scaleId] || HARMONIC_SCALES.pentatonic;
  const intervals = scale.semitones;
  const len = intervals.length;
  const rawRow = Number.isFinite(row0to15) ? Math.floor(row0to15) : 0;
  const row = Math.max(0, Math.min(48, rawRow));
  const baseOct = Number.isFinite(octaveBase) ? Math.round(octaveBase) : 3;

  const octaveOffset = Math.floor(row / len);
  const degree = row % len;
  const midi = clamp((baseOct + 1) * 12 + octaveOffset * 12 + intervals[degree], 12, 127);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Deterministic 15-bit hardware LFSR noise generator (taps 0 & 1, maximal period 32767).
 * @param {number} numSamples
 * @param {number} [seed=0x7FFF]
 * @returns {Float32Array}
 */
export function generateLfsr15Noise(numSamples, seed = 0x7FFF) {
  const len = Number.isFinite(numSamples) && numSamples > 0 ? Math.floor(numSamples) : 0;
  const out = new Float32Array(len);
  let state = Number.isFinite(seed) ? (Math.floor(seed) & 0x7FFF) : 0x7FFF;
  if (state === 0) state = 0x7FFF;

  for (let i = 0; i < len; i++) {
    out[i] = (state & 1) !== 0 ? 1.0 : -1.0;
    const bit = (state ^ (state >> 1)) & 1;
    state = ((state >> 1) | (bit << 14)) & 0x7FFF;
    if (state === 0) state = 0x7FFF;
  }
  return out;
}

/**
 * Build a band-limited PeriodicWave for a morphing pulse wave of given duty cycle (0..1).
 * Works safely in headless environments when `ctx` is null/absent.
 * @param {AudioContext|null} ctx
 * @param {number} [dutyCycle=0.5]
 * @returns {PeriodicWave|{ real: Float32Array, imag: Float32Array, dutyCycle: number }}
 */
export function buildPulseWavePeriodic(ctx, dutyCycle = 0.5) {
  const duty = clamp(Number.isFinite(dutyCycle) ? dutyCycle : 0.5, 0.05, 0.95);
  const real = new Float32Array(PULSE_HARMONICS);
  const imag = new Float32Array(PULSE_HARMONICS);

  for (let n = 1; n < PULSE_HARMONICS; n++) {
    // Lanczos sigma attenuation suppresses Gibbs overshoot on sharp pulse transitions
    const sigma = Math.sin((Math.PI * n) / PULSE_HARMONICS) / ((Math.PI * n) / PULSE_HARMONICS);
    real[n] = (2 / (Math.PI * n)) * Math.sin(Math.PI * n * duty) * sigma;
  }

  if (ctx && typeof ctx.createPeriodicWave === 'function') {
    return ctx.createPeriodicWave(real, imag);
  }
  return { real, imag, dutyCycle: duty };
}

/**
 * Convert a 32-step 4-bit wavetable (`0..15` per step) via DFT into a PeriodicWave.
 * Works safely in headless environments when `ctx` is null/absent.
 * @param {AudioContext|null} ctx
 * @param {Uint8Array|ArrayLike<number>} nibbles32
 * @returns {PeriodicWave|{ real: Float32Array, imag: Float32Array }}
 */
export function buildCustomWavetable32Periodic(ctx, nibbles32) {
  const N = 32;
  const maxHarmonic = 16;
  const real = new Float32Array(maxHarmonic + 1);
  const imag = new Float32Array(maxHarmonic + 1);
  const samples = new Float32Array(N);

  for (let k = 0; k < N; k++) {
    const raw = nibbles32 && k < nibbles32.length ? Number(nibbles32[k]) : 8;
    const clamped = clamp(Number.isFinite(raw) ? raw : 8, 0, 15);
    samples[k] = clamped / 7.5 - 1.0;
  }

  for (let n = 1; n <= maxHarmonic; n++) {
    let sumCos = 0;
    let sumSin = 0;
    const scale = n === maxHarmonic ? 1 / N : 2 / N;
    for (let k = 0; k < N; k++) {
      const angle = (2 * Math.PI * n * k) / N;
      sumCos += samples[k] * Math.cos(angle);
      sumSin += samples[k] * Math.sin(angle);
    }
    real[n] = sumCos * scale;
    imag[n] = n === maxHarmonic ? 0 : sumSin * scale;
  }

  if (ctx && typeof ctx.createPeriodicWave === 'function') {
    return ctx.createPeriodicWave(real, imag);
  }
  return { real, imag };
}

function buildTapeSaturationCurve(samples = 1025, drive = 1.35) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = softClipSample(x * drive);
  }
  return curve;
}

function dutyFromTimbreByte(dutyOrTimbre) {
  const v = clamp(Number.isFinite(dutyOrTimbre) ? dutyOrTimbre : 128, 0, 255);
  // 0 -> 12.5%, 128 -> 25%, 255 -> 50%
  if (v <= 128) {
    return 0.125 + (v / 128) * 0.125;
  }
  return 0.25 + ((v - 128) / 127) * 0.25;
}

function hasWaveVariation(nibbles) {
  if (!nibbles || nibbles.length === 0) return false;
  const first = nibbles[0] & 0x0F;
  for (let i = 1; i < Math.min(32, nibbles.length); i++) {
    if ((nibbles[i] & 0x0F) !== first) return true;
  }
  return false;
}

/**
 * Create the BitForge-80 4-Voice Web Audio DSP Engine.
 * @param {{ bus?: any }} [opts]
 */
export function createDspEngine({ bus = null } = {}) {
  let ctx = null;
  let masterPreGain = null;
  let tapeShaper = null;
  let limiter = null;
  let masterOutGain = null;
  let analyser = null;
  let channelGains = [null, null, null, null];
  let lfsrNoiseBuffer = null;

  let destroyed = false;
  let muted = false;
  let gestureUnlocked = false;
  let gestureCleanup = null;

  // Sequencer state
  let seqRunning = false;
  let seqTimerId = null;
  let seqStep = 0;
  let seqNextNoteTime = 0;
  let lastHeadlessStepMs = 0;

  // Synced Cartridge audio state
  let syncedBpm = 120;
  let syncedScaleId = 'pentatonic';
  let syncedChannels = Array.from({ length: 4 }, () => ({
    steps: new Uint16Array(16),
    dutyOrTimbre: 128,
    volume: 75,
  }));
  let syncedWavetable = new Uint8Array(DEFAULT_WAVETABLE_NIBBLES);
  let syncedWavetableCustom = false;
  let syncedWavetableSig = '';
  let cachedCh4Wave = null;
  const pulseWaveCache = new Map();
  let syncedSfxPatches = Array.from({ length: 8 }, (_, i) => ({ archetype: i, x: 128, y: 128 }));

  // Software envelope meter levels & oscilloscope scratch buffer
  const channelPeaks = new Float32Array(4);
  const channelPeakTimes = new Float64Array(4);
  const oscScratch128 = new Float32Array(128);
  let lastTriggerFreq = 220;
  let lastTriggerAtMs = 0;

  function markChannelLevel(chIdx, velocity) {
    const ch = Math.max(0, Math.min(3, chIdx | 0));
    const v = clamp(Number.isFinite(velocity) ? velocity : 0.7, 0, 1);
    const t = nowMs();
    const dt = Math.max(0, (t - channelPeakTimes[ch]) / 1000);
    const decayed = channelPeaks[ch] * Math.exp(-dt * 6.5);
    channelPeaks[ch] = Math.max(decayed, v);
    channelPeakTimes[ch] = t;
  }

  function ensureGraph() {
    if (destroyed) return null;
    if (ctx) return ctx;

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext || null;
    if (typeof AudioCtx !== 'function') return null;

    try {
      ctx = new AudioCtx();
    } catch {
      ctx = null;
      return null;
    }

    masterPreGain = ctx.createGain();
    masterPreGain.gain.value = 0.72;

    tapeShaper = ctx.createWaveShaper();
    tapeShaper.curve = buildTapeSaturationCurve(1025, 1.35);
    tapeShaper.oversample = '2x';

    limiter = ctx.createDynamicsCompressor();
    if (limiter.threshold) limiter.threshold.value = -2.5;
    if (limiter.knee) limiter.knee.value = 3.0;
    if (limiter.ratio) limiter.ratio.value = 20;
    if (limiter.attack) limiter.attack.value = 0.001;
    if (limiter.release) limiter.release.value = 0.08;

    masterOutGain = ctx.createGain();
    masterOutGain.gain.value = muted ? 0 : 1;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.65;

    masterPreGain.connect(tapeShaper);
    tapeShaper.connect(limiter);
    limiter.connect(masterOutGain);
    masterOutGain.connect(analyser);
    analyser.connect(ctx.destination);

    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(masterPreGain);
      channelGains[i] = g;
    }

    const noiseSamples = generateLfsr15Noise(Math.min(ctx.sampleRate || 44100, LFSR_PERIOD_MAX), 0x7FFF);
    lfsrNoiseBuffer = ctx.createBuffer(1, noiseSamples.length, ctx.sampleRate || 44100);
    if (typeof lfsrNoiseBuffer.copyToChannel === 'function') {
      lfsrNoiseBuffer.copyToChannel(noiseSamples, 0);
    } else {
      lfsrNoiseBuffer.getChannelData(0).set(noiseSamples);
    }

    cachedCh4Wave = buildCustomWavetable32Periodic(ctx, syncedWavetable);
    return ctx;
  }

  function getCachedPulseWave(dutyCycle) {
    if (!ctx) return null;
    const key = Math.round(clamp(dutyCycle, 0.05, 0.95) * 100);
    if (pulseWaveCache.has(key)) return pulseWaveCache.get(key);
    const wave = buildPulseWavePeriodic(ctx, key / 100);
    pulseWaveCache.set(key, wave);
    return wave;
  }

  function removeGestureListeners() {
    if (gestureCleanup) {
      gestureCleanup();
      gestureCleanup = null;
    }
  }

  function unlock() {
    if (destroyed) return false;
    const audioCtx = ensureGraph();
    if (!audioCtx) return false;

    try {
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        const res = audioCtx.resume();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      }
      if (!gestureUnlocked && typeof audioCtx.createBuffer === 'function') {
        const silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate || 44100);
        const src = audioCtx.createBufferSource();
        src.buffer = silent;
        src.connect(audioCtx.destination);
        src.start(0);
        gestureUnlocked = true;
      }
      if (audioCtx.state === 'running') {
        removeGestureListeners();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Register synchronous unlock listeners on first pointer/touch/key interaction in browser
  function installGestureListeners() {
    const targets = [];
    if (typeof globalThis.addEventListener === 'function') targets.push(globalThis);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') targets.push(document);
    if (targets.length === 0) return;

    const events = ['pointerdown', 'touchstart', 'keydown'];
    const handler = () => {
      unlock();
      if (ctx && ctx.state === 'running') {
        removeGestureListeners();
      }
    };

    const opts = { capture: true, passive: true };
    for (const target of targets) {
      for (const evt of events) {
        target.addEventListener(evt, handler, opts);
      }
    }

    gestureCleanup = () => {
      for (const target of targets) {
        if (typeof target.removeEventListener !== 'function') continue;
        for (const evt of events) {
          target.removeEventListener(evt, handler, opts);
        }
      }
    };
  }
  installGestureListeners();

  function syncCart(cart) {
    if (!cart || typeof cart !== 'object') return;
    const audio = cart.audio;
    if (!audio || typeof audio !== 'object') return;

    if (Number.isFinite(audio.bpm)) {
      syncedBpm = clamp(Math.round(audio.bpm), 70, 180);
    }
    if (typeof audio.scaleId === 'string' && HARMONIC_SCALES[audio.scaleId]) {
      syncedScaleId = audio.scaleId;
    }

    if (Array.isArray(audio.channels)) {
      for (let c = 0; c < 4; c++) {
        const src = audio.channels[c];
        if (!src) continue;
        const steps = new Uint16Array(16);
        if (src.steps && typeof src.steps.length === 'number') {
          for (let s = 0; s < Math.min(16, src.steps.length); s++) {
            steps[s] = Number(src.steps[s]) & 0xFFFF;
          }
        }
        syncedChannels[c] = {
          steps,
          dutyOrTimbre: clamp(Math.round(Number(src.dutyOrTimbre ?? 128)), 0, 255),
          volume: clamp(Math.round(Number(src.volume ?? 75)), 0, 100),
        };
      }
    }

    if (audio.wavetable32 && typeof audio.wavetable32.length === 'number') {
      const nextWave = new Uint8Array(32);
      for (let i = 0; i < Math.min(32, audio.wavetable32.length); i++) {
        nextWave[i] = clamp(Math.round(Number(audio.wavetable32[i]) || 0), 0, 15);
      }
      syncedWavetableCustom = hasWaveVariation(nextWave);
      const effectiveWave = syncedWavetableCustom ? nextWave : DEFAULT_WAVETABLE_NIBBLES;
      const sig = Array.from(effectiveWave).join(',');
      if (sig !== syncedWavetableSig) {
        syncedWavetableSig = sig;
        syncedWavetable = new Uint8Array(effectiveWave);
        if (ctx) {
          cachedCh4Wave = buildCustomWavetable32Periodic(ctx, syncedWavetable);
        }
      }
    }

    if (Array.isArray(audio.sfxPatches)) {
      for (let p = 0; p < 8; p++) {
        const patch = audio.sfxPatches[p];
        if (!patch) continue;
        syncedSfxPatches[p] = {
          archetype: clamp(Math.round(Number(patch.archetype ?? p)), 0, 7),
          x: clamp(Math.round(Number(patch.x ?? 128)), 0, 255),
          y: clamp(Math.round(Number(patch.y ?? 128)), 0, 255),
        };
      }
    }
  }

  function playNote(chIdx = 0, freq = 440, durationSec = 0.16, velocity = 0.75, extra = null) {
    if (destroyed || muted) return;
    const ch = Math.max(0, Math.min(3, chIdx | 0));
    const hz = clamp(Number.isFinite(freq) ? freq : 440, 20, 16000);
    const dur = clamp(Number.isFinite(durationSec) ? durationSec : 0.16, 0.015, 4.0);
    const vel = clamp(Number.isFinite(velocity) ? velocity : 0.75, 0.0, 1.0);
    if (vel <= 0.001) return;

    markChannelLevel(ch, vel);
    lastTriggerFreq = hz;
    lastTriggerAtMs = nowMs();

    if (!ctx || ctx.state === 'closed') return;
    const destNode = channelGains[ch] || masterPreGain;
    if (!destNode) return;

    const startTime = extra && Number.isFinite(extra.atTime) ? Math.max(ctx.currentTime, extra.atTime) : ctx.currentTime;
    const timbre = extra && Number.isFinite(extra.dutyOrTimbre)
      ? clamp(extra.dutyOrTimbre, 0, 255)
      : syncedChannels[ch].dutyOrTimbre;

    const env = ctx.createGain();
    const peakGain = vel * 0.42;
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peakGain, startTime + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);
    env.connect(destNode);

    const stopAt = startTime + dur + 0.025;

    if (ch === 0) {
      // CH1: Morphing Pulse (12.5%, 25%, 50%)
      const osc = ctx.createOscillator();
      const duty = dutyFromTimbreByte(timbre);
      const wave = getCachedPulseWave(duty);
      if (wave && typeof osc.setPeriodicWave === 'function') {
        osc.setPeriodicWave(wave);
      } else {
        osc.type = 'square';
      }
      osc.frequency.setValueAtTime(hz, startTime);
      osc.connect(env);
      osc.start(startTime);
      osc.stop(stopAt);
      osc.onended = () => {
        try { osc.disconnect(); env.disconnect(); } catch {}
      };
    } else if (ch === 1) {
      // CH2: Triangle / Warm Wooden Marimba
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(hz, startTime);
      osc.connect(env);
      osc.start(startTime);
      osc.stop(stopAt);

      // Subtle marimba 4x harmonic mallet transient
      const woodAmount = (timbre / 255) * 0.28;
      if (woodAmount > 0.02 && hz * 4 < 16000) {
        const malletOsc = ctx.createOscillator();
        const malletGain = ctx.createGain();
        malletOsc.type = 'sine';
        malletOsc.frequency.setValueAtTime(hz * 4, startTime);
        malletGain.gain.setValueAtTime(0.0001, startTime);
        malletGain.gain.linearRampToValueAtTime(peakGain * woodAmount, startTime + 0.002);
        malletGain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.min(0.045, dur * 0.45));
        malletOsc.connect(malletGain);
        malletGain.connect(destNode);
        malletOsc.start(startTime);
        malletOsc.stop(startTime + 0.06);
        malletOsc.onended = () => {
          try { malletOsc.disconnect(); malletGain.disconnect(); } catch {}
        };
      }
      osc.onended = () => {
        try { osc.disconnect(); env.disconnect(); } catch {}
      };
    } else if (ch === 2) {
      // CH3: 15-bit LFSR Noise with pitched resonant filter
      if (!lfsrNoiseBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = lfsrNoiseBuffer;
      src.loop = true;
      src.playbackRate.setValueAtTime(clamp(hz / 440, 0.25, 4.0), startTime);

      const filter = ctx.createBiquadFilter();
      filter.type = timbre > 160 ? 'highpass' : 'bandpass';
      filter.frequency.setValueAtTime(clamp(hz * 2.2, 180, 11000), startTime);
      filter.Q.value = 1.2 + (timbre / 255) * 3.0;

      src.connect(filter);
      filter.connect(env);
      src.start(startTime);
      src.stop(stopAt);
      src.onended = () => {
        try { src.disconnect(); filter.disconnect(); env.disconnect(); } catch {}
      };
    } else {
      // CH4: 32-step Drawable Wavetable
      const osc = ctx.createOscillator();
      if (!cachedCh4Wave) {
        cachedCh4Wave = buildCustomWavetable32Periodic(ctx, syncedWavetable);
      }
      if (cachedCh4Wave && typeof osc.setPeriodicWave === 'function') {
        osc.setPeriodicWave(cachedCh4Wave);
      } else {
        osc.type = 'sine';
      }
      osc.frequency.setValueAtTime(hz, startTime);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900 + (timbre / 255) * 6500, startTime);

      osc.connect(filter);
      filter.connect(env);
      osc.start(startTime);
      osc.stop(stopAt);
      osc.onended = () => {
        try { osc.disconnect(); filter.disconnect(); env.disconnect(); } catch {}
      };
    }
  }

  function playSfxSlot(slotIdx = 0, param = 0) {
    if (destroyed || muted) return;
    const slot = Math.max(0, Math.min(7, slotIdx | 0));
    const basePatch = syncedSfxPatches[slot] || { archetype: slot, x: 128, y: 128 };
    const patch = param && typeof param === 'object'
      ? { ...basePatch, ...param }
      : basePatch;
    const spec = computeSfxPatchParameters(patch);

    let pitchMul = 1.0;
    let vel = 0.78;
    if (typeof param === 'number' && Number.isFinite(param) && param !== 0) {
      if (param > 0 && param <= 2) {
        vel = clamp(0.45 + param * 0.35, 0.2, 0.95);
      } else {
        pitchMul = clamp(0.85 + (Math.abs(param) % 16) * 0.025, 0.75, 1.35);
      }
    } else if (param && typeof param === 'object') {
      if (Number.isFinite(param.velocity)) vel = clamp(param.velocity, 0.05, 1.0);
      if (Number.isFinite(param.pitchScale)) pitchMul = clamp(param.pitchScale, 0.4, 2.5);
    }

    const dur = clamp(spec.decayMs / 1000, 0.03, 0.9);
    const fStart = clamp(spec.freqStart * pitchMul, 30, 14000);
    const fEnd = clamp(spec.freqEnd * pitchMul, 30, 14000);
    const chForLevel = spec.waveType === 'noise' ? 2 : (spec.waveType === 'triangle' ? 1 : 0);

    markChannelLevel(chForLevel, vel);
    lastTriggerFreq = fStart;
    lastTriggerAtMs = nowMs();

    if (!ctx || ctx.state === 'closed') return;
    const destNode = channelGains[chForLevel] || masterPreGain;
    if (!destNode) return;

    const t0 = ctx.currentTime;
    const stopAt = t0 + dur + 0.03;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(vel * 0.45, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(clamp(spec.filterHz, 200, 16000), t0);
    filter.Q.value = 1.0 + spec.crunch * 5.0;

    filter.connect(env);
    env.connect(destNode);

    if (spec.waveType === 'noise' && lfsrNoiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = lfsrNoiseBuffer;
      src.loop = true;
      src.playbackRate.setValueAtTime(clamp(fStart / 600, 0.3, 4.0), t0);
      src.playbackRate.exponentialRampToValueAtTime(clamp(fEnd / 600, 0.2, 4.0), t0 + dur);
      src.connect(filter);
      src.start(t0);
      src.stop(stopAt);
      src.onended = () => {
        try { src.disconnect(); filter.disconnect(); env.disconnect(); } catch {}
      };
      return;
    }

    const osc = ctx.createOscillator();
    if (spec.waveType === 'pulse') {
      const w = getCachedPulseWave(0.25);
      if (w) osc.setPeriodicWave(w);
      else osc.type = 'square';
    } else {
      osc.type = spec.waveType || 'triangle';
    }

    if (spec.archetype === 0) {
      // Coin two-tone crisp pitch jump at 38% decay
      osc.frequency.setValueAtTime(fStart, t0);
      osc.frequency.setValueAtTime(fEnd, t0 + dur * 0.36);
    } else {
      osc.frequency.setValueAtTime(fStart, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(25, fEnd), t0 + dur);
    }

    osc.connect(filter);
    osc.start(t0);
    osc.stop(stopAt);
    osc.onended = () => {
      try { osc.disconnect(); filter.disconnect(); env.disconnect(); } catch {}
    };
  }

  function triggerSfx(slotIdx = 0, param = 0) {
    playSfxSlot(slotIdx, param);
  }

  function playBootChord(scaleId) {
    if (destroyed || muted) return;
    const resolvedScale = HARMONIC_SCALES[scaleId] ? scaleId : syncedScaleId;
    const chordRows = [0, 2, 4, 7];
    const stepMs = 55;

    for (let i = 0; i < chordRows.length; i++) {
      const freq = quantizeRowToFreq(resolvedScale, chordRows[i], 3);
      const ch = i === 0 ? 1 : (i === 3 ? 3 : 0);
      if (ctx && ctx.state === 'running') {
        playNote(ch, freq, 0.28 + i * 0.04, 0.55 - i * 0.05, {
          atTime: ctx.currentTime + (i * stepMs) / 1000,
        });
      } else {
        playNote(ch, freq, 0.28 + i * 0.04, 0.55 - i * 0.05);
      }
    }
  }

  function dispatchStep(stepIdx, scheduledAudioTime) {
    const stepSec = 60 / syncedBpm / 4;
    const activeRowsByChannel = [[], [], [], []];

    for (let c = 0; c < 4; c++) {
      const ch = syncedChannels[c];
      const mask = ch.steps[stepIdx] & 0xFFFF;
      if (mask === 0) continue;

      const rows = [];
      for (let r = 0; r < 16; r++) {
        if ((mask & (1 << r)) !== 0) rows.push(r);
      }
      activeRowsByChannel[c] = rows;

      if (muted || ch.volume <= 0) continue;
      const polyScale = 1 / Math.sqrt(Math.max(1, rows.length));
      const vel = (ch.volume / 100) * 0.72 * polyScale;

      for (const row of rows) {
        const freq = quantizeRowToFreq(syncedScaleId, row, 3);
        const dur = c === 2 ? Math.min(0.11, stepSec * 0.7) : Math.max(0.08, stepSec * 0.92);
        playNote(c, freq, dur, vel, scheduledAudioTime !== null ? { atTime: scheduledAudioTime } : null);
      }
    }

    if (bus && typeof bus.emit === 'function') {
      bus.emit('audio:step', {
        step: stepIdx,
        bpm: syncedBpm,
        scaleId: syncedScaleId,
        activeRowsByChannel,
      });
    }
  }

  function tickSequencer() {
    if (!seqRunning || destroyed) return;
    const stepSec = 60 / syncedBpm / 4;

    if (ctx && ctx.state === 'running') {
      const horizon = ctx.currentTime + 0.09;
      if (seqNextNoteTime < ctx.currentTime - 0.1) {
        seqNextNoteTime = ctx.currentTime;
      }
      while (seqNextNoteTime < horizon) {
        dispatchStep(seqStep, seqNextNoteTime);
        seqStep = (seqStep + 1) & 15;
        seqNextNoteTime += stepSec;
      }
      return;
    }

    // Headless / pre-unlock fallback clock
    const t = nowMs();
    if (lastHeadlessStepMs === 0) {
      lastHeadlessStepMs = t;
      dispatchStep(seqStep, null);
      seqStep = (seqStep + 1) & 15;
      return;
    }
    if (t - lastHeadlessStepMs >= stepSec * 1000) {
      lastHeadlessStepMs += stepSec * 1000;
      if (t - lastHeadlessStepMs > stepSec * 3000) lastHeadlessStepMs = t;
      dispatchStep(seqStep, null);
      seqStep = (seqStep + 1) & 15;
    }
  }

  function startSequencer(cart = null) {
    if (destroyed) return;
    if (cart) syncCart(cart);
    if (seqRunning) return;

    seqRunning = true;
    seqStep = 0;
    lastHeadlessStepMs = 0;
    seqNextNoteTime = ctx ? ctx.currentTime + 0.02 : 0;

    seqTimerId = setInterval(tickSequencer, 24);
    if (seqTimerId && typeof seqTimerId.unref === 'function') {
      seqTimerId.unref();
    }
  }

  function stopSequencer() {
    seqRunning = false;
    if (seqTimerId !== null) {
      clearInterval(seqTimerId);
      seqTimerId = null;
    }
    seqStep = 0;
    if (bus && typeof bus.emit === 'function') {
      bus.emit('audio:stop', {});
    }
  }

  function setMuted(m) {
    muted = Boolean(m);
    if (masterOutGain && ctx) {
      try {
        if (typeof masterOutGain.gain.setTargetAtTime === 'function') {
          masterOutGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01);
        } else {
          masterOutGain.gain.value = muted ? 0 : 1;
        }
      } catch {
        masterOutGain.gain.value = muted ? 0 : 1;
      }
    }
    if (bus && typeof bus.emit === 'function') {
      bus.emit('audio:mute', { muted });
    }
  }

  function getChannelLevels() {
    const t = nowMs();
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      if (muted) {
        out[i] = 0;
        continue;
      }
      const dt = Math.max(0, (t - channelPeakTimes[i]) / 1000);
      const level = channelPeaks[i] * Math.exp(-dt * 6.5);
      out[i] = level < 0.005 ? 0 : clamp(level, 0, 1);
    }
    return out;
  }

  function getOscilloscopeData(outFloat32 = null) {
    const target = outFloat32 && typeof outFloat32.length === 'number'
      ? outFloat32
      : new Float32Array(128);
    const len = target.length;

    if (muted || destroyed) {
      for (let i = 0; i < len; i++) target[i] = 0;
      return target;
    }

    if (analyser && ctx && ctx.state === 'running' && typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(oscScratch128);
      for (let i = 0; i < len; i++) {
        const s = i < oscScratch128.length ? oscScratch128[i] : 0;
        target[i] = Number.isFinite(s) ? clamp(s, -1, 1) : 0;
      }
      return target;
    }

    // Software fallback trace when audio is active in headless/suspended mode
    const ageSec = Math.max(0, (nowMs() - lastTriggerAtMs) / 1000);
    const amp = ageSec < 0.4 ? Math.exp(-ageSec * 7.5) * 0.55 : 0;
    for (let i = 0; i < len; i++) {
      if (amp <= 0.002) {
        target[i] = 0;
      } else {
        const phase = (i / 128) * Math.PI * 2 * Math.max(1, Math.min(6, lastTriggerFreq / 180));
        target[i] = softClipSample(Math.sin(phase) * amp);
      }
    }
    return target;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopSequencer();
    removeGestureListeners();
    pulseWaveCache.clear();
    if (ctx && typeof ctx.close === 'function') {
      try {
        const p = ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        // Ignore close errors
      }
    }
    ctx = null;
    analyser = null;
    masterPreGain = null;
    tapeShaper = null;
    limiter = null;
    masterOutGain = null;
    channelGains = [null, null, null, null];
    lfsrNoiseBuffer = null;
  }

  return {
    unlock,
    syncCart,
    startSequencer,
    stopSequencer,
    setMuted,
    isMuted: () => muted,
    isRunning: () => seqRunning,
    getCurrentStep: () => seqStep,
    playNote,
    playSfxSlot,
    triggerSfx,
    playBootChord,
    getChannelLevels,
    getOscilloscopeData,
    destroy,
  };
}
