import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  HARMONIC_SCALES,
  quantizeRowToFreq,
  generateLfsr15Noise,
  buildPulseWavePeriodic,
  buildCustomWavetable32Periodic,
  softClipSample,
  createDspEngine,
} from '../src/audio/dsp-engine.js';
import {
  SFX_ARCHETYPES,
  computeSfxPatchParameters,
  packSfxPatch6Bytes,
  unpackSfxPatch6Bytes,
  createSfxXyPad,
} from '../src/audio/sfx-xy-pad.js';
import { createAudioStudio } from '../src/audio/tenori-sequencer.js';
import {
  computeKalimbaPluckParams,
  computeDominoHarpFreq,
  createAsmrFoley,
} from '../src/audio/asmr-foley.js';
import { createEmptyCartridgeROM } from '../src/cart/bitpack-rom.js';
import { bundleModulesInline } from '../src/vault/local-sync-baker.js';

function createMockBus() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      emitted.push({ evt, payload });
      const set = listeners.get(evt);
      if (set) {
        for (const fn of set) fn(payload);
      }
    },
  };
}

function makeMockDocument() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      _innerHTML: '',
      value: '',
      type: '',
      min: '',
      max: '',
      width: 128,
      height: 128,
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
      removeEventListener(type, fn) {
        const arr = this.listeners[type];
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatch(type, extraEvent = {}) {
        for (const fn of [...(this.listeners[type] || [])]) {
          fn({ target: this, ...extraEvent });
        }
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: this.width || 160, height: this.height || 160 };
      },
      getContext(kind) {
        if (kind !== '2d') return null;
        return {
          fillStyle: '#000',
          strokeStyle: '#000',
          lineWidth: 1,
          fillRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          arc() {},
          fill() {},
          stroke() {},
        };
      },
    };
    el.ownerDocument = doc;
    return el;
  }
  const doc = { createElement: makeEl };
  return doc;
}

test('1. all 5 harmonic scales quantize rows 0..15 strictly monotonically to valid frequencies', () => {
  const expectedScales = ['pentatonic', 'dorian', 'lydian', 'hirajoshi', 'lofiMaj9'];
  assert.deepEqual(Object.keys(HARMONIC_SCALES), expectedScales);

  for (const scaleId of expectedScales) {
    let prevFreq = 0;
    for (let row = 0; row <= 15; row++) {
      const freq = quantizeRowToFreq(scaleId, row, 3);
      assert.equal(Number.isFinite(freq), true, `${scaleId} row ${row} must be finite`);
      assert.ok(freq > 100 && freq < 5000, `${scaleId} row ${row} freq=${freq} in audible band`);
      assert.ok(freq > prevFreq, `${scaleId} row ${row} (${freq}) must strictly exceed row ${row - 1} (${prevFreq})`);
      prevFreq = freq;
    }
  }

  // Fallback for unknown scale & clamped boundary rows
  assert.equal(quantizeRowToFreq('unknown-scale', 0, 3), quantizeRowToFreq('pentatonic', 0, 3));
  assert.equal(quantizeRowToFreq('pentatonic', -5, 3), quantizeRowToFreq('pentatonic', 0, 3));
});

test('2. 15-bit LFSR noise determinism, zero-clipping softClipSample(x), and PeriodicWave builders', () => {
  const noiseA = generateLfsr15Noise(1024, 0x7FFF);
  const noiseB = generateLfsr15Noise(1024, 0x7FFF);
  const noiseC = generateLfsr15Noise(1024, 0x1234);

  assert.ok(noiseA instanceof Float32Array);
  assert.equal(noiseA.length, 1024);
  assert.deepEqual(noiseA, noiseB);
  assert.notDeepEqual(noiseA, noiseC);

  let posCount = 0;
  let negCount = 0;
  for (let i = 0; i < noiseA.length; i++) {
    assert.ok(Number.isFinite(noiseA[i]) && Math.abs(noiseA[i]) <= 1);
    if (noiseA[i] > 0) posCount++;
    else negCount++;
  }
  assert.ok(posCount > 400 && negCount > 400, 'LFSR output must stay well balanced');

  // Seed 0 guard must not lock up at constant output
  const zeroSeedNoise = generateLfsr15Noise(128, 0);
  assert.ok(zeroSeedNoise.some((v) => v !== zeroSeedNoise[0]));

  // Zero-clipping softClipSample across extremes including ±100, ±1e6, ±Infinity, NaN
  const probes = [-1e6, -100, -10, -2, -1, -0.25, 0, 0.25, 1, 2, 10, 100, 1e6, Infinity, -Infinity, NaN];
  for (const x of probes) {
    const y = softClipSample(x);
    assert.equal(Number.isFinite(y), true);
    assert.ok(Math.abs(y) <= 1.0, `softClipSample(${x}) = ${y} exceeded [-1, 1]`);
  }
  assert.equal(softClipSample(0), 0);
  assert.ok(softClipSample(100) <= 1 && softClipSample(100) > 0.99);
  assert.ok(softClipSample(-100) >= -1 && softClipSample(-100) < -0.99);

  // Pulse & custom 32-step wavetable builders work both headless and with Web Audio mock
  const pulseHeadless = buildPulseWavePeriodic(null, 0.25);
  assert.ok(pulseHeadless.real instanceof Float32Array);
  assert.ok(pulseHeadless.imag instanceof Float32Array);

  const customNibbles = new Uint8Array(32).map((_, i) => (i < 16 ? 15 : 0));
  const waveHeadless = buildCustomWavetable32Periodic(null, customNibbles);
  assert.equal(waveHeadless.real.length, 17);
  assert.ok(Math.abs(waveHeadless.imag[1]) > 0.5);
});

test('3. 6-byte packSfxPatch6Bytes / unpackSfxPatch6Bytes lossless round-trip across all 8 archetypes and X/Y 0..255', () => {
  assert.deepEqual(SFX_ARCHETYPES, ['Coin', 'Pop', 'Thock', 'Laser', 'Bubble', 'Shatter', 'Bloom', 'Chime']);

  // Exhaustively verify all 8 * 256 * 256 = 524,288 combinations
  for (let archetype = 0; archetype < 8; archetype++) {
    for (let x = 0; x <= 255; x++) {
      for (let y = 0; y <= 255; y++) {
        const packed = packSfxPatch6Bytes({ archetype, x, y });
        assert.equal(packed.byteLength, 6);
        const unpacked = unpackSfxPatch6Bytes(packed);
        assert.equal(unpacked.archetype, archetype);
        assert.equal(unpacked.x, x);
        assert.equal(unpacked.y, y);
      }
    }
    const params = computeSfxPatchParameters({ archetype, x: 180, y: 90 });
    assert.equal(params.name, SFX_ARCHETYPES[archetype]);
    assert.ok(params.freqStart > 0 && params.freqEnd > 0);
    assert.ok(params.decayMs > 0 && params.filterHz > 0);
    assert.ok(params.crunch >= 0 && params.crunch <= 1);
  }

  assert.throws(() => unpackSfxPatch6Bytes(new Uint8Array(5)), RangeError);
});

test('4. computeKalimbaPluckParams & computeDominoHarpFreq ascending scale correctness', () => {
  for (const scaleId of Object.keys(HARMONIC_SCALES)) {
    let prevKalimba = 0;
    for (let yRow = 0; yRow <= 15; yRow++) {
      const pDark = computeKalimbaPluckParams(yRow, 0.1, scaleId, 0.8);
      const pBright = computeKalimbaPluckParams(yRow, 0.95, scaleId, 0.8);
      assert.equal(pDark.freq, pBright.freq);
      assert.ok(pBright.freq > prevKalimba, `${scaleId} kalimba row ${yRow} must ascend`);
      assert.ok(pBright.filterHz > pDark.filterHz, 'higher luminance yields brighter timbre');
      assert.ok(pBright.dutyOrTimbre > pDark.dutyOrTimbre);
      prevKalimba = pBright.freq;
    }

    let prevDomino = 0;
    for (let ring = 0; ring <= 20; ring++) {
      const f = computeDominoHarpFreq(ring, scaleId);
      assert.ok(Number.isFinite(f) && f > prevDomino, `${scaleId} domino ring ${ring} must ascend`);
      prevDomino = f;
    }
  }
});

test('5. createDspEngine & createAsmrFoley operate safely headless without Web Audio globals', () => {
  const bus = createMockBus();
  const cart = createEmptyCartridgeROM();
  cart.audio.channels[0].steps[0] = 0b0000000000100001;

  const dsp = createDspEngine({ bus });
  assert.equal(dsp.unlock(), false);
  dsp.syncCart(cart);
  dsp.playNote(0, 440, 0.15, 0.8);
  dsp.playNote(1, 330, 0.12, 0.7);
  dsp.playNote(2, 1200, 0.08, 0.5);
  dsp.playNote(3, 523.25, 0.2, 0.6);
  dsp.playSfxSlot(0, 1);
  dsp.triggerSfx(5, 0.75);
  dsp.playBootChord('hirajoshi');

  const levels = dsp.getChannelLevels();
  assert.equal(levels.length, 4);
  for (const lv of levels) {
    assert.ok(lv >= 0 && lv <= 1);
  }

  const osc = new Float32Array(128);
  dsp.getOscilloscopeData(osc);
  assert.equal(osc.length, 128);
  for (const s of osc) {
    assert.ok(Number.isFinite(s) && Math.abs(s) <= 1);
  }

  dsp.setMuted(true);
  assert.equal(dsp.isMuted(), true);
  assert.deepEqual(dsp.getChannelLevels(), [0, 0, 0, 0]);
  dsp.setMuted(false);
  assert.equal(dsp.isMuted(), false);

  dsp.startSequencer(cart);
  assert.equal(dsp.isRunning(), true);
  dsp.stopSequencer();
  assert.equal(dsp.isRunning(), false);

  // ASMR Foley bus bridge without navigator.vibrate
  const foley = createAsmrFoley({ dsp, bus, getCart: () => cart });
  bus.emit('foley:pixel', { y: 10, luminance: 0.75 });
  bus.emit('foley:flood', { ringIdx: 4 });
  bus.emit('foley:erase', { y: 3 });
  bus.emit('foley:autotile', { terrainId: 2 });
  bus.emit('foley:switch', { index: 1 });
  bus.emit('bezel:detent', { detent: 12, velocity: 2.5 });

  assert.ok(dsp.getChannelLevels().some((v) => v > 0));

  foley.destroy();
  dsp.destroy();
  dsp.destroy(); // Idempotent destroy
});

test('6. Mocked Web Audio chain builds tape saturator -> brickwall limiter -> analyser and unlocks on gesture', () => {
  const prevAudioContext = globalThis.AudioContext;
  const prevAddListener = globalThis.addEventListener;
  const prevRemoveListener = globalThis.removeEventListener;
  const prevNav = globalThis.navigator;

  const createdNodes = [];
  const docListeners = new Map();
  let vibrateCalls = [];

  class MockParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    exponentialRampToValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }
  }
  class MockNode {
    constructor(kind) {
      this.kind = kind;
      this.connectedTo = [];
      createdNodes.push(this);
    }
    connect(dest) { this.connectedTo.push(dest); return dest; }
    disconnect() {}
  }
  class MockAudioContext {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.destination = new MockNode('Destination');
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const n = new MockNode('Gain'); n.gain = new MockParam(1); return n; }
    createWaveShaper() { return new MockNode('WaveShaper'); }
    createDynamicsCompressor() {
      const n = new MockNode('Compressor');
      n.threshold = new MockParam();
      n.knee = new MockParam();
      n.ratio = new MockParam();
      n.attack = new MockParam();
      n.release = new MockParam();
      return n;
    }
    createAnalyser() {
      const n = new MockNode('Analyser');
      n.fftSize = 2048;
      n.getFloatTimeDomainData = (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = 0.25 * Math.sin(i * 0.2);
      };
      return n;
    }
    createOscillator() {
      const n = new MockNode('Oscillator');
      n.frequency = new MockParam(440);
      n.setPeriodicWave = () => {};
      n.start = () => {};
      n.stop = () => {};
      return n;
    }
    createBiquadFilter() {
      const n = new MockNode('Filter');
      n.frequency = new MockParam(1000);
      n.Q = new MockParam(1);
      return n;
    }
    createBuffer(ch, len) {
      const data = new Float32Array(len);
      return {
        getChannelData: () => data,
        copyToChannel: (src) => data.set(src.subarray(0, len)),
      };
    }
    createBufferSource() {
      const n = new MockNode('BufferSource');
      n.playbackRate = new MockParam(1);
      n.start = () => {};
      n.stop = () => {};
      return n;
    }
    createPeriodicWave(real, imag) {
      return { real, imag };
    }
  }

  try {
    globalThis.AudioContext = MockAudioContext;
    globalThis.addEventListener = (evt, fn) => {
      if (!docListeners.has(evt)) docListeners.set(evt, new Set());
      docListeners.get(evt).add(fn);
    };
    globalThis.removeEventListener = (evt, fn) => {
      docListeners.get(evt)?.delete(fn);
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { vibrate: (p) => { vibrateCalls.push(p); return true; } },
    });

    const bus = createMockBus();
    const cart = createEmptyCartridgeROM();
    const dsp = createDspEngine({ bus });

    // Trigger synchronous unlock via pointerdown gesture
    assert.ok(docListeners.has('pointerdown'));
    for (const fn of docListeners.get('pointerdown')) fn();

    const shaper = createdNodes.find((n) => n.kind === 'WaveShaper');
    const comp = createdNodes.find((n) => n.kind === 'Compressor');
    const analyser = createdNodes.find((n) => n.kind === 'Analyser');
    assert.ok(shaper && shaper.curve instanceof Float32Array);
    assert.ok(comp && comp.ratio.value >= 12);
    assert.ok(analyser && analyser.fftSize === 128);
    assert.ok(shaper.connectedTo.includes(comp), 'WaveShaper must feed brickwall Compressor');

    dsp.syncCart(cart);
    dsp.playNote(0, 440, 0.1, 0.7);
    dsp.playNote(1, 330, 0.1, 0.7);
    dsp.playNote(2, 880, 0.08, 0.5);
    dsp.playNote(3, 523.25, 0.15, 0.6);
    dsp.playSfxSlot(3, 1);

    const osc = new Float32Array(128);
    dsp.getOscilloscopeData(osc);
    assert.ok(Math.abs(osc[5] - 0.25 * Math.sin(5 * 0.2)) < 1e-4);

    const foley = createAsmrFoley({ dsp, bus, getCart: () => cart });
    bus.emit('foley:pixel', { y: 4, luminance: 0.6 });
    bus.emit('bezel:detent', { detent: 2 });
    assert.equal(vibrateCalls.length, 2);

    foley.destroy();
    dsp.destroy();
  } finally {
    globalThis.AudioContext = prevAudioContext;
    globalThis.addEventListener = prevAddListener;
    globalThis.removeEventListener = prevRemoveListener;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: prevNav,
    });
  }
});

test('7. Tenori-On Audio Studio and SFX XY Pad mount, switch inline, mutate cart, and unmount cleanly', () => {
  const doc = makeMockDocument();
  const container = doc.createElement('div');
  const toolStrip = doc.createElement('div');
  const bus = createMockBus();
  const cart = createEmptyCartridgeROM();
  const dsp = createDspEngine({ bus });
  const mutations = [];

  const studio = createAudioStudio({
    container,
    toolStrip,
    getCart: () => cart,
    onMutate: (m) => mutations.push(m),
    dsp,
    bus,
  });

  studio.mount();
  assert.equal(container.children.length, 1);
  assert.equal(toolStrip.children.length, 3);

  // Interactive pointer paint on 16x16 Tenori-On matrix & 32-step wavetable ribbon
  const rootEl = container.children[0];
  const matrixPane = rootEl.children[1];
  const matrixCanvas = matrixPane.children[3];
  const waveScopeRow = matrixPane.children[4];
  const waveCanvas = waveScopeRow.children[0];
  matrixCanvas.dispatch('pointerdown', { clientX: 8, clientY: 248, pointerId: 1 });
  matrixCanvas.dispatch('pointermove', { clientX: 24, clientY: 232, pointerId: 1 });
  matrixCanvas.dispatch('pointerup', { pointerId: 1 });
  assert.notEqual(cart.audio.channels[0].steps[0], 0);
  assert.ok(mutations.some((m) => m.type === 'sequencerStep'));

  waveCanvas.dispatch('pointerdown', { clientX: 2, clientY: 4, pointerId: 2 });
  waveCanvas.dispatch('pointermove', { clientX: 40, clientY: 40, pointerId: 2 });
  waveCanvas.dispatch('pointerup', { pointerId: 2 });
  assert.ok(mutations.some((m) => m.type === 'wavetable32'));

  // Switch inline to SFX XY Pad and adjust patch
  studio.setSubView('sfx');
  assert.equal(studio.getSubView(), 'sfx');
  const pad = studio.getSfxPad();
  pad.selectSlot(2);
  pad.setPatch({ archetype: 4, x: 200, y: 150 });
  assert.equal(cart.audio.sfxPatches[2].archetype, 4);
  assert.equal(cart.audio.sfxPatches[2].x, 200);
  assert.equal(cart.audio.sfxPatches[2].y, 150);
  assert.ok(mutations.some((m) => m.type === 'sfxPatch'));

  // Standalone createSfxXyPad mount/unmount test
  const padHost = doc.createElement('div');
  const standalonePad = createSfxXyPad({ container: padHost, getCart: () => cart, dsp, bus });
  standalonePad.mount();
  assert.equal(padHost.children.length, 1);
  standalonePad.unmount();
  assert.equal(padHost.children.length, 0);

  studio.unmount();
  assert.equal(container.children.length, 0);
  assert.equal(toolStrip.children.length, 0);
  dsp.destroy();
});

test('8. Audio module hygiene: zero export *, static node: imports, external CDNs, forbidden terms, and baker bundling', () => {
  const dir = './src/audio';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
  assert.equal(files.length, 4);

  const forbiddenTerms = [
    'd-' + 'pad',
    'd' + 'pad',
    'joy' + 'stick',
    'thumb' + 'stick',
    'thumb-' + 'stick',
    'virtual' + 'pad',
    'virtual ' + 'pad',
    'game' + 'pad',
    'a/b ' + 'button',
    'button-' + 'a',
    'button-' + 'b',
  ];

  const fileMap = {
    './src/main.js': [
      'import { createDspEngine } from "./audio/dsp-engine.js";',
      'import { createAudioStudio } from "./audio/tenori-sequencer.js";',
      'import { createAsmrFoley } from "./audio/asmr-foley.js";',
      'export { createDspEngine, createAudioStudio, createAsmrFoley };',
    ].join('\n'),
  };

  for (const filePath of files) {
    const src = fs.readFileSync(filePath, 'utf8');
    fileMap['./' + filePath.replace(/\\/g, '/')] = src;
    assert.equal(/\bexport\s*\*/.test(src), false, `export * forbidden in ${filePath}`);
    assert.equal(/['"]node:/.test(src), false, `static node: import forbidden in ${filePath}`);
    assert.equal(/https?:\/\//i.test(src), false, `external URL forbidden in ${filePath}`);

    const lower = src.toLowerCase();
    for (const term of forbiddenTerms) {
      assert.equal(lower.includes(term), false, `Forbidden input term "${term}" found in ${filePath}`);
    }
  }

  // Verify standalone baker inlines all 4 audio modules into syntactically valid JS
  const bundled = bundleModulesInline(fileMap, './src/main.js');
  assert.doesNotThrow(() => new Function(bundled));
});
