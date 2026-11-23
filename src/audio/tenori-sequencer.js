/**
 * BitForge-80 Illuminated 16x16 Tenori-On Sequencer, 32-Step Wavetable Ribbon,
 * Live 128px Oscilloscope & Inline SFX XY Switcher.
 */

import { HARMONIC_SCALES, quantizeRowToFreq } from './dsp-engine.js';
import { createSfxXyPad } from './sfx-xy-pad.js';

const CHANNEL_META = Object.freeze([
  { id: 0, label: 'CH1 PULSE', color: '#f6c453', dim: 'rgba(246, 196, 83, 0.20)' },
  { id: 1, label: 'CH2 MARIMBA', color: '#6cf5c2', dim: 'rgba(108, 245, 194, 0.20)' },
  { id: 2, label: 'CH3 LFSR', color: '#ff7b89', dim: 'rgba(255, 123, 137, 0.20)' },
  { id: 3, label: 'CH4 WAVE', color: '#7aa6ff', dim: 'rgba(122, 166, 255, 0.20)' },
]);

function clampInt(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function ensureAudioShape(cart) {
  if (!cart || typeof cart !== 'object') return null;
  if (!cart.audio || typeof cart.audio !== 'object') {
    cart.audio = {};
  }
  if (!Number.isFinite(cart.audio.bpm)) cart.audio.bpm = 120;
  cart.audio.bpm = clampInt(cart.audio.bpm, 70, 180, 120);

  if (typeof cart.audio.scaleId !== 'string' || !HARMONIC_SCALES[cart.audio.scaleId]) {
    cart.audio.scaleId = 'pentatonic';
  }

  if (!Array.isArray(cart.audio.channels)) {
    cart.audio.channels = [];
  }
  for (let c = 0; c < 4; c++) {
    let ch = cart.audio.channels[c];
    if (!ch || typeof ch !== 'object') {
      ch = { steps: new Uint16Array(16), dutyOrTimbre: 128, volume: 75 };
      cart.audio.channels[c] = ch;
    }
    if (!(ch.steps instanceof Uint16Array) || ch.steps.length !== 16) {
      const next = new Uint16Array(16);
      if (ch.steps && typeof ch.steps.length === 'number') {
        for (let s = 0; s < Math.min(16, ch.steps.length); s++) {
          next[s] = Number(ch.steps[s]) & 0xFFFF;
        }
      }
      ch.steps = next;
    }
    ch.dutyOrTimbre = clampInt(ch.dutyOrTimbre, 0, 255, 128);
    ch.volume = clampInt(ch.volume, 0, 100, 75);
  }

  if (!(cart.audio.wavetable32 instanceof Uint8Array) || cart.audio.wavetable32.length !== 32) {
    const nextWave = new Uint8Array(32);
    if (cart.audio.wavetable32 && typeof cart.audio.wavetable32.length === 'number') {
      for (let i = 0; i < Math.min(32, cart.audio.wavetable32.length); i++) {
        nextWave[i] = clampInt(cart.audio.wavetable32[i], 0, 15, 0);
      }
    }
    cart.audio.wavetable32 = nextWave;
  }

  if (!Array.isArray(cart.audio.sfxPatches)) {
    cart.audio.sfxPatches = [];
  }
  while (cart.audio.sfxPatches.length < 8) {
    const idx = cart.audio.sfxPatches.length;
    cart.audio.sfxPatches.push({ archetype: idx, x: 128, y: 128 });
  }

  return cart.audio;
}

/**
 * Create the BitForge-80 Audio Studio (16x16 Tenori-On Sequencer + 32-Step Wavetable +
 * 128px Live Oscilloscope + Inline SFX XY Pad Switcher).
 * @param {{ container?: any, toolStrip?: any, getCart?: () => any, onMutate?: (info: any) => void, dsp?: any, bus?: any }} [opts]
 */
export function createAudioStudio({
  container = null,
  toolStrip = null,
  getCart = null,
  onMutate = null,
  dsp = null,
  bus = null,
} = {}) {
  let mounted = false;
  let activeSubView = 'matrix'; // 'matrix' | 'sfx'
  let activeChannel = 0;
  let playheadStep = -1;
  let rafId = null;

  // Pointer drag state for matrix & wavetable ribbon
  let matrixDragging = false;
  let matrixPaintVal = 1;
  let lastMatrixCell = '';
  let waveDragging = false;
  let lastWaveIdx = -1;
  let lastWaveVal = 8;

  const ripples = []; // { col, row, age, maxAge, color }
  const oscBuffer128 = new Float32Array(128);
  let cleanupListeners = [];
  let unsubBus = [];
  let xyPad = null;

  // DOM handles
  let rootEl = null;
  let matrixViewBtn = null;
  let sfxViewBtn = null;
  let playBtn = null;
  let muteBtn = null;
  let bpmRangeEl = null;
  let bpmValEl = null;
  let scaleSelEl = null;
  let channelBtns = [];
  let timbreRangeEl = null;
  let volRangeEl = null;
  let dutyBarEl = null;
  let matrixPaneEl = null;
  let xyPaneEl = null;
  let matrixCanvas = null;
  let waveCanvas = null;
  let oscCanvas = null;
  let stripPlayBtn = null;
  let stripModeBtn = null;
  let stripMuteBtn = null;

  function readCart() {
    return typeof getCart === 'function' ? getCart() : null;
  }

  function emitFoleySwitch(extra = {}) {
    if (bus && typeof bus.emit === 'function') {
      bus.emit('foley:switch', { source: 'audio-studio', ...extra });
    }
  }

  function notifyMutate(type, extra = {}) {
    const cart = readCart();
    if (dsp && typeof dsp.syncCart === 'function' && cart) {
      dsp.syncCart(cart);
    }
    if (typeof onMutate === 'function') {
      onMutate({ type, cart, ...extra });
    }
  }

  function spawnRipple(col, row, color) {
    if (ripples.length >= 48) ripples.shift();
    ripples.push({ col, row, age: 0, maxAge: 26, color });
  }

  function bindDom(el, type, fn) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, fn);
    cleanupListeners.push(() => {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener(type, fn);
      }
    });
  }

  function bindBus(evt, fn) {
    if (!bus || typeof bus.on !== 'function') return;
    const res = bus.on(evt, fn);
    if (typeof res === 'function') {
      unsubBus.push(res);
    } else if (typeof bus.off === 'function') {
      unsubBus.push(() => bus.off(evt, fn));
    }
  }

  function renderControls() {
    const cart = readCart();
    const audio = ensureAudioShape(cart);
    const isPlaying = dsp && typeof dsp.isRunning === 'function' ? dsp.isRunning() : false;
    const isMuted = dsp && typeof dsp.isMuted === 'function' ? dsp.isMuted() : false;

    if (matrixViewBtn) matrixViewBtn.dataset.active = activeSubView === 'matrix' ? 'true' : 'false';
    if (sfxViewBtn) sfxViewBtn.dataset.active = activeSubView === 'sfx' ? 'true' : 'false';
    if (matrixPaneEl && matrixPaneEl.style) {
      matrixPaneEl.style.display = activeSubView === 'matrix' ? 'flex' : 'none';
    }
    if (xyPaneEl && xyPaneEl.style) {
      xyPaneEl.style.display = activeSubView === 'sfx' ? 'flex' : 'none';
    }

    if (playBtn) {
      playBtn.textContent = isPlaying ? 'STOP' : 'PLAY';
      playBtn.dataset.active = isPlaying ? 'true' : 'false';
    }
    if (stripPlayBtn) {
      stripPlayBtn.textContent = isPlaying ? '■ SEQ' : '▶ SEQ';
      stripPlayBtn.dataset.active = isPlaying ? 'true' : 'false';
    }
    if (muteBtn) {
      muteBtn.textContent = isMuted ? 'MUTED' : 'AUDIO';
      muteBtn.dataset.active = isMuted ? 'true' : 'false';
    }
    if (stripMuteBtn) {
      stripMuteBtn.textContent = isMuted ? 'MUTE' : 'VOL';
      stripMuteBtn.dataset.active = isMuted ? 'true' : 'false';
    }
    if (stripModeBtn) {
      stripModeBtn.textContent = activeSubView === 'matrix' ? 'SFX XY' : '16×16';
    }

    if (audio) {
      if (bpmRangeEl) bpmRangeEl.value = String(audio.bpm);
      if (bpmValEl) bpmValEl.textContent = `${audio.bpm} BPM`;
      if (scaleSelEl) scaleSelEl.value = audio.scaleId;

      const ch = audio.channels[activeChannel];
      if (timbreRangeEl) timbreRangeEl.value = String(ch.dutyOrTimbre);
      if (volRangeEl) volRangeEl.value = String(ch.volume);
    }

    if (dutyBarEl && dutyBarEl.style) {
      dutyBarEl.style.display = activeChannel === 0 ? 'flex' : 'none';
    }

    const levels = dsp && typeof dsp.getChannelLevels === 'function' ? dsp.getChannelLevels() : [0, 0, 0, 0];
    for (let i = 0; i < channelBtns.length; i++) {
      const btn = channelBtns[i];
      if (!btn) continue;
      btn.dataset.active = i === activeChannel ? 'true' : 'false';
      if (btn.setAttribute) btn.setAttribute('aria-pressed', String(i === activeChannel));
      const pip = btn._pipEl;
      if (pip && pip.style) {
        const lvl = levels[i] || 0;
        pip.style.opacity = String(0.25 + lvl * 0.75);
      }
    }
  }

  function renderMatrixCanvas() {
    if (!matrixCanvas || typeof matrixCanvas.getContext !== 'function') return;
    const ctx = matrixCanvas.getContext('2d');
    if (!ctx) return;

    const cart = readCart();
    const audio = ensureAudioShape(cart);
    const w = matrixCanvas.width || 256;
    const h = matrixCanvas.height || 256;
    const cellW = w / 16;
    const cellH = h / 16;

    ctx.fillStyle = '#12131a';
    ctx.fillRect(0, 0, w, h);

    // Subtle 4-beat bar column markers
    for (let col = 0; col < 16; col++) {
      if (col % 4 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fillRect(col * cellW, 0, cellW, h);
      }
      if (col === playheadStep) {
        ctx.fillStyle = 'rgba(246, 196, 83, 0.16)';
        ctx.fillRect(col * cellW, 0, cellW, h);
      }
    }

    // Advance & accumulate sweeping Tenori-On light ripples
    const rippleBoost = new Float32Array(256);
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      const progress = rp.age / rp.maxAge;
      const radius = progress * 4.2;
      const intensity = (1 - progress) * 0.75;
      for (let row = 0; row < 16; row++) {
        const dy = row - rp.row;
        for (let col = 0; col < 16; col++) {
          const dx = col - rp.col;
          const dist = Math.hypot(dx, dy);
          if (Math.abs(dist - radius) < 1.15) {
            const boost = intensity * (1 - Math.abs(dist - radius) / 1.15);
            const idx = row * 16 + col;
            if (boost > rippleBoost[idx]) rippleBoost[idx] = boost;
          }
        }
      }
      rp.age++;
      if (rp.age >= rp.maxAge) ripples.splice(i, 1);
    }

    const activeMeta = CHANNEL_META[activeChannel];
    const activeSteps = audio ? audio.channels[activeChannel].steps : null;

    // Draw 16x16 illuminated LEDs (vy=0 top -> row=15 treble, vy=15 bottom -> row=0 bass)
    for (let vy = 0; vy < 16; vy++) {
      const row = 15 - vy;
      for (let col = 0; col < 16; col++) {
        const cx = col * cellW + 1.5;
        const cy = vy * cellH + 1.5;
        const cw = Math.max(2, cellW - 3);
        const ch = Math.max(2, cellH - 3);
        const bit = 1 << row;

        // Check ghost activity on inactive channels
        let ghostColor = null;
        if (audio) {
          for (let c = 0; c < 4; c++) {
            if (c !== activeChannel && (audio.channels[c].steps[col] & bit) !== 0) {
              ghostColor = CHANNEL_META[c].dim;
              break;
            }
          }
        }

        const isActive = activeSteps ? (activeSteps[col] & bit) !== 0 : false;
        const rBoost = rippleBoost[row * 16 + col];

        if (isActive) {
          ctx.fillStyle = activeMeta.color;
          ctx.fillRect(cx, cy, cw, ch);
          if (col === playheadStep) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.fillRect(cx + 1, cy + 1, Math.max(1, cw - 2), Math.max(1, ch - 2));
          }
        } else {
          ctx.fillStyle = ghostColor || '#1b1f2b';
          ctx.fillRect(cx, cy, cw, ch);
          if (rBoost > 0.02) {
            ctx.fillStyle = `rgba(246, 196, 83, ${Math.min(0.65, rBoost).toFixed(3)})`;
            ctx.fillRect(cx, cy, cw, ch);
          }
        }
      }
    }
  }

  function renderWaveCanvas() {
    if (!waveCanvas || typeof waveCanvas.getContext !== 'function') return;
    const ctx = waveCanvas.getContext('2d');
    if (!ctx) return;

    const cart = readCart();
    const audio = ensureAudioShape(cart);
    const wave = audio ? audio.wavetable32 : null;
    const w = waveCanvas.width || 192;
    const h = waveCanvas.height || 48;
    const stepW = w / 32;

    ctx.fillStyle = '#12131a';
    ctx.fillRect(0, 0, w, h);

    // Center zero-crossing reference line
    ctx.strokeStyle = 'rgba(130, 146, 178, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    if (!wave) return;
    for (let i = 0; i < 32; i++) {
      const val = wave[i] & 0x0F;
      const barH = ((val + 1) / 16) * (h - 6);
      const x = i * stepW + 1;
      const y = h - 3 - barH;
      ctx.fillStyle = 'rgba(122, 166, 255, 0.35)';
      ctx.fillRect(x, y, Math.max(2, stepW - 2), barH);
      ctx.fillStyle = '#7aa6ff';
      ctx.fillRect(x, y, Math.max(2, stepW - 2), 2);
    }
  }

  function renderOscCanvas() {
    if (!oscCanvas || typeof oscCanvas.getContext !== 'function') return;
    const ctx = oscCanvas.getContext('2d');
    if (!ctx) return;

    const w = oscCanvas.width || 128;
    const h = oscCanvas.height || 40;

    if (dsp && typeof dsp.getOscilloscopeData === 'function') {
      dsp.getOscilloscopeData(oscBuffer128);
    } else {
      oscBuffer128.fill(0);
    }

    ctx.fillStyle = '#0e1017';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(108, 245, 194, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    const drawTrace = (strokeStyle, lineWidth) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (let i = 0; i < 128; i++) {
        const px = (i / 127) * w;
        const py = h * 0.5 - oscBuffer128[i] * (h * 0.42);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };

    drawTrace('rgba(108, 245, 194, 0.35)', 3);
    drawTrace('#6cf5c2', 1.25);
  }

  function renderFrame() {
    if (!mounted) return;
    if (activeSubView === 'matrix') {
      renderMatrixCanvas();
      renderWaveCanvas();
      renderOscCanvas();
    }
    const levels = dsp && typeof dsp.getChannelLevels === 'function' ? dsp.getChannelLevels() : null;
    if (levels) {
      for (let i = 0; i < channelBtns.length; i++) {
        const pip = channelBtns[i]?._pipEl;
        if (pip && pip.style) {
          pip.style.opacity = String(0.25 + (levels[i] || 0) * 0.75);
        }
      }
    }
  }

  function startAnimationLoop() {
    if (rafId !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    const loop = () => {
      if (!mounted) {
        rafId = null;
        return;
      }
      renderFrame();
      rafId = globalThis.requestAnimationFrame(loop);
    };
    rafId = globalThis.requestAnimationFrame(loop);
  }

  function stopAnimationLoop() {
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function resolveCanvasCell(canvas, ev, cols, rows) {
    let rect = { left: 0, top: 0, width: canvas.width || 256, height: canvas.height || 256 };
    if (typeof canvas.getBoundingClientRect === 'function') {
      const r = canvas.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) rect = r;
    }
    const cx = typeof ev?.clientX === 'number' ? ev.clientX : rect.left;
    const cy = typeof ev?.clientY === 'number' ? ev.clientY : rect.top;
    const col = clampInt(Math.floor(((cx - rect.left) / rect.width) * cols), 0, cols - 1, 0);
    const vy = clampInt(Math.floor(((cy - rect.top) / rect.height) * rows), 0, rows - 1, 0);
    return { col, vy };
  }

  function applyMatrixCell(col, row, targetVal) {
    const cart = readCart();
    const audio = ensureAudioShape(cart);
    if (!audio) return;
    const ch = audio.channels[activeChannel];
    const bit = 1 << row;
    const wasSet = (ch.steps[col] & bit) !== 0;
    const nextSet = Boolean(targetVal);
    if (wasSet === nextSet) return;

    if (nextSet) ch.steps[col] |= bit;
    else ch.steps[col] &= ~bit;

    notifyMutate('sequencerStep', { channel: activeChannel, col, row });

    if (nextSet) {
      spawnRipple(col, row, CHANNEL_META[activeChannel].color);
      if (dsp) {
        dsp.unlock?.();
        const freq = quantizeRowToFreq(audio.scaleId, row, 3);
        dsp.playNote?.(activeChannel, freq, 0.14, (ch.volume / 100) * 0.85);
      }
    }
    renderMatrixCanvas();
  }

  function applyWavetableStroke(ev, isStart) {
    const cart = readCart();
    const audio = ensureAudioShape(cart);
    if (!audio || !waveCanvas) return;

    const { col, vy } = resolveCanvasCell(waveCanvas, ev, 32, 16);
    const val = 15 - vy;

    if (isStart || lastWaveIdx === -1) {
      audio.wavetable32[col] = val;
    } else {
      const dist = Math.abs(col - lastWaveIdx);
      if (dist <= 1) {
        audio.wavetable32[col] = val;
      } else {
        const dir = col > lastWaveIdx ? 1 : -1;
        for (let step = 1; step <= dist; step++) {
          const idx = lastWaveIdx + step * dir;
          const interp = Math.round(lastWaveVal + ((val - lastWaveVal) * step) / dist);
          audio.wavetable32[idx] = clampInt(interp, 0, 15, val);
        }
      }
    }
    lastWaveIdx = col;
    lastWaveVal = val;

    notifyMutate('wavetable32');
    renderWaveCanvas();
  }

  function setSubView(view) {
    const next = view === 'sfx' ? 'sfx' : 'matrix';
    if (activeSubView === next) return;
    activeSubView = next;
    emitFoleySwitch({ subView: next });
    renderControls();
    if (next === 'sfx' && xyPad) {
      xyPad.refresh();
    } else {
      renderFrame();
    }
  }

  function refresh() {
    const cart = readCart();
    ensureAudioShape(cart);
    if (dsp && typeof dsp.syncCart === 'function' && cart) {
      dsp.syncCart(cart);
    }
    renderControls();
    renderFrame();
    if (xyPad) xyPad.refresh();
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    if (container && container.ownerDocument) {
      const doc = container.ownerDocument;
      rootEl = doc.createElement('div');
      rootEl.className = 'bf-audio-studio';

      // Top bar: Matrix <-> SFX XY Switcher + Transport + Mute
      const topBar = doc.createElement('div');
      topBar.className = 'bf-audio-topbar';

      matrixViewBtn = doc.createElement('button');
      matrixViewBtn.type = 'button';
      matrixViewBtn.className = 'bf-audio-tab';
      matrixViewBtn.textContent = '16×16 MATRIX';
      bindDom(matrixViewBtn, 'click', () => setSubView('matrix'));
      topBar.appendChild(matrixViewBtn);

      sfxViewBtn = doc.createElement('button');
      sfxViewBtn.type = 'button';
      sfxViewBtn.className = 'bf-audio-tab';
      sfxViewBtn.textContent = 'SFX XY PAD';
      bindDom(sfxViewBtn, 'click', () => setSubView('sfx'));
      topBar.appendChild(sfxViewBtn);

      playBtn = doc.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'bf-audio-play-btn';
      playBtn.textContent = 'PLAY';
      bindDom(playBtn, 'click', () => {
        if (!dsp) return;
        dsp.unlock?.();
        const cart = readCart();
        if (dsp.isRunning?.()) {
          dsp.stopSequencer?.();
        } else {
          dsp.startSequencer?.(cart);
        }
        emitFoleySwitch({ action: 'transport' });
        renderControls();
      });
      topBar.appendChild(playBtn);

      muteBtn = doc.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'bf-audio-mute-btn';
      muteBtn.textContent = 'AUDIO';
      bindDom(muteBtn, 'click', () => {
        if (!dsp) return;
        dsp.setMuted?.(!dsp.isMuted?.());
        emitFoleySwitch({ action: 'mute' });
        renderControls();
      });
      topBar.appendChild(muteBtn);

      rootEl.appendChild(topBar);

      // Matrix Pane
      matrixPaneEl = doc.createElement('div');
      matrixPaneEl.className = 'bf-audio-matrix-pane';
      matrixPaneEl.style.display = 'flex';
      matrixPaneEl.style.flexDirection = 'column';

      // Tempo + Scale bar
      const metaBar = doc.createElement('div');
      metaBar.className = 'bf-audio-metabar';

      bpmRangeEl = doc.createElement('input');
      bpmRangeEl.type = 'range';
      bpmRangeEl.min = '70';
      bpmRangeEl.max = '180';
      bpmRangeEl.className = 'bf-audio-bpm-slider';
      bpmRangeEl.setAttribute('aria-label', 'Tempo BPM');
      bindDom(bpmRangeEl, 'input', () => {
        const cart = readCart();
        const audio = ensureAudioShape(cart);
        if (!audio) return;
        audio.bpm = clampInt(bpmRangeEl.value, 70, 180, 120);
        notifyMutate('bpm');
        renderControls();
      });
      metaBar.appendChild(bpmRangeEl);

      bpmValEl = doc.createElement('span');
      bpmValEl.className = 'bf-audio-bpm-val';
      metaBar.appendChild(bpmValEl);

      scaleSelEl = doc.createElement('select');
      scaleSelEl.className = 'bf-audio-scale-select';
      scaleSelEl.setAttribute('aria-label', 'Harmonic Scale');
      for (const scale of Object.values(HARMONIC_SCALES)) {
        const opt = doc.createElement('option');
        opt.value = scale.id;
        opt.textContent = scale.name;
        scaleSelEl.appendChild(opt);
      }
      bindDom(scaleSelEl, 'change', () => {
        const cart = readCart();
        const audio = ensureAudioShape(cart);
        if (!audio) return;
        audio.scaleId = HARMONIC_SCALES[scaleSelEl.value] ? scaleSelEl.value : 'pentatonic';
        notifyMutate('scaleId');
        emitFoleySwitch({ scaleId: audio.scaleId });
        renderControls();
      });
      metaBar.appendChild(scaleSelEl);

      matrixPaneEl.appendChild(metaBar);

      // CH1 - CH4 selector bar
      const chBar = doc.createElement('div');
      chBar.className = 'bf-audio-ch-bar';
      channelBtns = [];
      for (let c = 0; c < 4; c++) {
        const meta = CHANNEL_META[c];
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bf-audio-ch-btn';
        btn.dataset.channel = String(c);

        const pip = doc.createElement('span');
        pip.className = 'bf-audio-ch-pip';
        pip.style.background = meta.color;
        btn.appendChild(pip);

        const lbl = doc.createElement('span');
        lbl.textContent = meta.label;
        btn.appendChild(lbl);
        btn._pipEl = pip;

        bindDom(btn, 'click', () => {
          activeChannel = c;
          emitFoleySwitch({ channel: c });
          renderControls();
          renderMatrixCanvas();
        });
        channelBtns.push(btn);
        chBar.appendChild(btn);
      }
      matrixPaneEl.appendChild(chBar);

      // Channel duty / timbre & volume controls
      const chCtlBar = doc.createElement('div');
      chCtlBar.className = 'bf-audio-ch-ctl';

      dutyBarEl = doc.createElement('div');
      dutyBarEl.className = 'bf-audio-duty-pills';
      const duties = [
        { label: '12.5%', val: 0 },
        { label: '25%', val: 128 },
        { label: '50%', val: 255 },
      ];
      for (const d of duties) {
        const dBtn = doc.createElement('button');
        dBtn.type = 'button';
        dBtn.className = 'bf-audio-duty-btn';
        dBtn.textContent = d.label;
        bindDom(dBtn, 'click', () => {
          const cart = readCart();
          const audio = ensureAudioShape(cart);
          if (!audio) return;
          audio.channels[0].dutyOrTimbre = d.val;
          notifyMutate('dutyOrTimbre');
          emitFoleySwitch({ duty: d.label });
          renderControls();
        });
        dutyBarEl.appendChild(dBtn);
      }
      chCtlBar.appendChild(dutyBarEl);

      timbreRangeEl = doc.createElement('input');
      timbreRangeEl.type = 'range';
      timbreRangeEl.min = '0';
      timbreRangeEl.max = '255';
      timbreRangeEl.className = 'bf-audio-timbre-slider';
      timbreRangeEl.setAttribute('aria-label', 'Channel Timbre');
      bindDom(timbreRangeEl, 'input', () => {
        const cart = readCart();
        const audio = ensureAudioShape(cart);
        if (!audio) return;
        audio.channels[activeChannel].dutyOrTimbre = clampInt(timbreRangeEl.value, 0, 255, 128);
        notifyMutate('dutyOrTimbre');
      });
      chCtlBar.appendChild(timbreRangeEl);

      volRangeEl = doc.createElement('input');
      volRangeEl.type = 'range';
      volRangeEl.min = '0';
      volRangeEl.max = '100';
      volRangeEl.className = 'bf-audio-vol-slider';
      volRangeEl.setAttribute('aria-label', 'Channel Volume');
      bindDom(volRangeEl, 'input', () => {
        const cart = readCart();
        const audio = ensureAudioShape(cart);
        if (!audio) return;
        audio.channels[activeChannel].volume = clampInt(volRangeEl.value, 0, 100, 75);
        notifyMutate('volume');
      });
      chCtlBar.appendChild(volRangeEl);

      matrixPaneEl.appendChild(chCtlBar);

      // 16x16 Tenori-On Touch Canvas
      matrixCanvas = doc.createElement('canvas');
      matrixCanvas.className = 'bf-tenori-matrix-canvas';
      matrixCanvas.width = 256;
      matrixCanvas.height = 256;
      matrixCanvas.style.touchAction = 'none';

      bindDom(matrixCanvas, 'pointerdown', (ev) => {
        const cart = readCart();
        const audio = ensureAudioShape(cart);
        if (!audio) return;
        matrixDragging = true;
        try {
          if (typeof matrixCanvas.setPointerCapture === 'function' && ev?.pointerId !== undefined) {
            matrixCanvas.setPointerCapture(ev.pointerId);
          }
        } catch {}
        const { col, vy } = resolveCanvasCell(matrixCanvas, ev, 16, 16);
        const row = 15 - vy;
        const isSet = (audio.channels[activeChannel].steps[col] & (1 << row)) !== 0;
        matrixPaintVal = isSet ? 0 : 1;
        lastMatrixCell = `${col}:${row}`;
        applyMatrixCell(col, row, matrixPaintVal);
      });

      bindDom(matrixCanvas, 'pointermove', (ev) => {
        if (!matrixDragging) return;
        const { col, vy } = resolveCanvasCell(matrixCanvas, ev, 16, 16);
        const row = 15 - vy;
        const key = `${col}:${row}`;
        if (key === lastMatrixCell) return;
        lastMatrixCell = key;
        applyMatrixCell(col, row, matrixPaintVal);
      });

      const endMatrixDrag = () => {
        matrixDragging = false;
        lastMatrixCell = '';
      };
      bindDom(matrixCanvas, 'pointerup', endMatrixDrag);
      bindDom(matrixCanvas, 'pointercancel', endMatrixDrag);

      matrixPaneEl.appendChild(matrixCanvas);

      // Bottom strip: 32-step Drawable Wavetable Ribbon + Live 128px Oscilloscope
      const waveScopeRow = doc.createElement('div');
      waveScopeRow.className = 'bf-audio-wavescope-row';

      waveCanvas = doc.createElement('canvas');
      waveCanvas.className = 'bf-wavetable-ribbon-canvas';
      waveCanvas.width = 192;
      waveCanvas.height = 48;
      waveCanvas.style.touchAction = 'none';
      waveCanvas.setAttribute('aria-label', '32-Step Drawable Wavetable');

      bindDom(waveCanvas, 'pointerdown', (ev) => {
        waveDragging = true;
        lastWaveIdx = -1;
        try {
          if (typeof waveCanvas.setPointerCapture === 'function' && ev?.pointerId !== undefined) {
            waveCanvas.setPointerCapture(ev.pointerId);
          }
        } catch {}
        applyWavetableStroke(ev, true);
        if (dsp) {
          dsp.unlock?.();
          const cart = readCart();
          const scaleId = cart?.audio?.scaleId || 'pentatonic';
          dsp.playNote?.(3, quantizeRowToFreq(scaleId, 5, 3), 0.16, 0.55);
        }
      });

      bindDom(waveCanvas, 'pointermove', (ev) => {
        if (!waveDragging) return;
        applyWavetableStroke(ev, false);
      });

      const endWaveDrag = () => {
        if (waveDragging && dsp) {
          const cart = readCart();
          const scaleId = cart?.audio?.scaleId || 'pentatonic';
          dsp.playNote?.(3, quantizeRowToFreq(scaleId, 7, 3), 0.16, 0.50);
        }
        waveDragging = false;
        lastWaveIdx = -1;
      };
      bindDom(waveCanvas, 'pointerup', endWaveDrag);
      bindDom(waveCanvas, 'pointercancel', endWaveDrag);

      waveScopeRow.appendChild(waveCanvas);

      oscCanvas = doc.createElement('canvas');
      oscCanvas.className = 'bf-oscilloscope-canvas';
      oscCanvas.width = 128;
      oscCanvas.height = 48;
      oscCanvas.setAttribute('aria-label', '128-Sample Live Oscilloscope');
      waveScopeRow.appendChild(oscCanvas);

      matrixPaneEl.appendChild(waveScopeRow);
      rootEl.appendChild(matrixPaneEl);

      // Inline SFX XY Pad Pane
      xyPaneEl = doc.createElement('div');
      xyPaneEl.className = 'bf-audio-xy-pane';
      xyPaneEl.style.display = 'none';
      xyPaneEl.style.flexDirection = 'column';
      rootEl.appendChild(xyPaneEl);

      xyPad = createSfxXyPad({
        container: xyPaneEl,
        getCart,
        onMutate,
        dsp,
        bus,
      });
      xyPad.mount();

      container.appendChild(rootEl);
    }

    if (toolStrip && toolStrip.ownerDocument) {
      const doc = toolStrip.ownerDocument;

      stripPlayBtn = doc.createElement('button');
      stripPlayBtn.type = 'button';
      stripPlayBtn.className = 'bf-tool-pill';
      stripPlayBtn.textContent = '▶ SEQ';
      bindDom(stripPlayBtn, 'click', () => {
        if (!dsp) return;
        dsp.unlock?.();
        if (dsp.isRunning?.()) dsp.stopSequencer?.();
        else dsp.startSequencer?.(readCart());
        emitFoleySwitch({ action: 'transport' });
        renderControls();
      });
      toolStrip.appendChild(stripPlayBtn);

      stripModeBtn = doc.createElement('button');
      stripModeBtn.type = 'button';
      stripModeBtn.className = 'bf-tool-pill';
      stripModeBtn.textContent = 'SFX XY';
      bindDom(stripModeBtn, 'click', () => {
        setSubView(activeSubView === 'matrix' ? 'sfx' : 'matrix');
      });
      toolStrip.appendChild(stripModeBtn);

      stripMuteBtn = doc.createElement('button');
      stripMuteBtn.type = 'button';
      stripMuteBtn.className = 'bf-tool-pill';
      stripMuteBtn.textContent = 'VOL';
      bindDom(stripMuteBtn, 'click', () => {
        if (!dsp) return;
        dsp.setMuted?.(!dsp.isMuted?.());
        emitFoleySwitch({ action: 'mute' });
        renderControls();
      });
      toolStrip.appendChild(stripMuteBtn);
    }

    bindBus('audio:step', (payload = {}) => {
      playheadStep = Number.isInteger(payload.step) ? payload.step : playheadStep;
      const rowsByCh = payload.activeRowsByChannel;
      if (Array.isArray(rowsByCh) && Array.isArray(rowsByCh[activeChannel])) {
        for (const r of rowsByCh[activeChannel]) {
          spawnRipple(playheadStep, r, CHANNEL_META[activeChannel].color);
        }
      }
      renderMatrixCanvas();
    });

    bindBus('audio:stop', () => {
      playheadStep = -1;
      renderControls();
      renderMatrixCanvas();
    });

    bindBus('audio:mute', () => {
      renderControls();
    });

    bindBus('cart:boot', () => {
      refresh();
    });

    refresh();
    startAnimationLoop();
  }

  function unmount() {
    mounted = false;
    matrixDragging = false;
    waveDragging = false;
    stopAnimationLoop();

    for (const off of cleanupListeners) off();
    cleanupListeners = [];
    for (const off of unsubBus) off();
    unsubBus = [];

    if (xyPad) {
      xyPad.unmount();
      xyPad = null;
    }

    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    for (const pill of [stripPlayBtn, stripModeBtn, stripMuteBtn]) {
      if (pill && pill.parentNode) {
        pill.parentNode.removeChild(pill);
      }
    }

    rootEl = null;
    matrixViewBtn = null;
    sfxViewBtn = null;
    playBtn = null;
    muteBtn = null;
    bpmRangeEl = null;
    bpmValEl = null;
    scaleSelEl = null;
    channelBtns = [];
    timbreRangeEl = null;
    volRangeEl = null;
    dutyBarEl = null;
    matrixPaneEl = null;
    xyPaneEl = null;
    matrixCanvas = null;
    waveCanvas = null;
    oscCanvas = null;
    stripPlayBtn = null;
    stripModeBtn = null;
    stripMuteBtn = null;
  }

  return {
    mount,
    unmount,
    destroy: unmount,
    refresh,
    setSubView,
    getSubView: () => activeSubView,
    selectChannel: (c) => {
      activeChannel = clampInt(c, 0, 3, 0);
      renderControls();
      renderMatrixCanvas();
    },
    getSelectedChannel: () => activeChannel,
    getSfxPad: () => xyPad,
  };
}
