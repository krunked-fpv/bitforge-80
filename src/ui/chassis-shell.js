/**
 * BitForge-80 Industrial Console Chassis Shell & Event Bus
 * Builds the anodized 100dvh console shell inside #app (identical across index.html and standalone .html),
 * enforces integer-locked 128x128 pixel scaling, manages mode tabs, telemetry, LED voice pips, and PWA install.
 */

export const EVENT_NAMES = Object.freeze({
  MODE_CHANGE: 'mode:change',
  CART_BOOT: 'cart:boot',
  CART_MINTED: 'cart:minted',
  PALETTE_CHANGE: 'palette:change',
  FOLEY_PIXEL: 'foley:pixel',
  FOLEY_FLOOD: 'foley:flood',
  FOLEY_ERASE: 'foley:erase',
  FOLEY_AUTOTILE: 'foley:autotile',
  FOLEY_SWITCH: 'foley:switch',
  BEZEL_SCRUB: 'bezel:scrub',
  BEZEL_DETENT: 'bezel:detent',
  TELEMETRY_FPS: 'telemetry:fps',
  PWA_INSTALL_AVAILABLE: 'pwa:install-available',
  AUDIO_STEP: 'audio:step',
  AUDIO_STOP: 'audio:stop',
  AUDIO_MUTE: 'audio:mute',
  ACTION_DAILY: 'action:daily',
  ACTION_SYNC: 'action:sync',
  ACTION_MINT: 'action:mint',
  ACTION_CRACK: 'action:crack',
  ACTION_DECK: 'action:deck',
});

const MODES = Object.freeze([
  { id: 'sprite', label: 'SPRITE' },
  { id: 'world', label: 'WORLD' },
  { id: 'audio', label: 'AUDIO' },
  { id: 'rules', label: 'RULES' },
  { id: 'play', label: 'PLAY' },
]);

/**
 * Create the shared BitForge-80 event bus and attach it to window/globalThis.__BITFORGE_BUS__.
 */
export function createEventBus() {
  const listeners = new Map();

  function on(eventName, fn) {
    if (typeof eventName !== 'string' || typeof fn !== 'function') {
      return () => {};
    }
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(fn);
    return () => off(eventName, fn);
  }

  function off(eventName, fn) {
    const set = listeners.get(eventName);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) listeners.delete(eventName);
  }

  function once(eventName, fn) {
    if (typeof fn !== 'function') return () => {};
    const wrapper = (payload) => {
      off(eventName, wrapper);
      fn(payload);
    };
    return on(eventName, wrapper);
  }

  function emit(eventName, payload) {
    const set = listeners.get(eventName);
    if (!set || set.size === 0) return;
    const snapshot = Array.from(set);
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
      } catch {
        // Isolate subscriber faults so console interaction never stalls
      }
    }
  }

  function clear(eventName) {
    if (typeof eventName === 'string') {
      listeners.delete(eventName);
    } else {
      listeners.clear();
    }
  }

  const bus = { on, off, once, emit, clear };
  try {
    globalThis.__BITFORGE_BUS__ = bus;
    if (typeof window !== 'undefined') {
      window.__BITFORGE_BUS__ = bus;
    }
  } catch {
    // Ignore locked global scopes
  }
  return bus;
}

/**
 * Compute integer pixel scale factor S >= 1 for a 128x128 logical framebuffer.
 * @param {number} availW
 * @param {number} availH
 * @returns {number}
 */
export function computeIntegerScale(availW, availH) {
  const w = Number.isFinite(availW) ? availW : 0;
  const h = Number.isFinite(availH) ? availH : 0;
  return Math.max(1, Math.floor(Math.min(w / 128, h / 128)));
}

function isStandaloneRuntime(win) {
  if (globalThis.__BITFORGE_STANDALONE__ === true) return true;
  if (!win) return false;
  try {
    if (win.navigator && win.navigator.standalone === true) return true;
    if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
  } catch {
    // Ignore restricted matchMedia checks
  }
  return false;
}

/**
 * Build and manage the BitForge-80 anodized chassis DOM inside `rootEl`.
 * @param {{ rootEl: HTMLElement, bus?: ReturnType<createEventBus> }} opts
 */
export function createChassisShell({ rootEl, bus = null } = {}) {
  const eventBus = bus || createEventBus();
  const doc = (rootEl && rootEl.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : globalThis);

  if (!rootEl || !doc || typeof doc.createElement !== 'function') {
    throw new Error('createChassisShell requires a valid rootEl and DOM document');
  }

  let activeMode = 'play';
  let currentScale = 1;
  let currentFps = 60;
  let currentCartBytes = 0;
  let noticeTimer = null;
  let shutterTimer = null;
  let deferredInstallPrompt = null;
  let activeModalCleanup = null;
  let destroyed = false;

  const actionHandlers = new Map();
  const cleanupListeners = [];

  function bind(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanupListeners.push(() => {
      if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, fn, opts);
      }
    });
  }

  rootEl.innerHTML = '';

  const chassisEl = doc.createElement('div');
  chassisEl.className = 'bf-chassis';

  // 1. Top Header Bar: Brand, Active Cartridge Title, CRT/PAL Toggles & 4 CH1-CH4 LED Pips
  const topBar = doc.createElement('header');
  topBar.className = 'bf-top-bar';

  const brandCluster = doc.createElement('div');
  brandCluster.className = 'bf-brand-cluster';

  const brandMark = doc.createElement('span');
  brandMark.className = 'bf-brand-mark';
  brandMark.textContent = 'BITFORGE-80';
  brandCluster.appendChild(brandMark);

  const cartTitleEl = doc.createElement('span');
  cartTitleEl.id = 'bf-cart-title';
  cartTitleEl.className = 'bf-cart-title';
  cartTitleEl.textContent = 'SLING-SLIME 80';
  brandCluster.appendChild(cartTitleEl);

  topBar.appendChild(brandCluster);

  const headerControls = doc.createElement('div');
  headerControls.className = 'bf-header-controls';

  const crtBtn = doc.createElement('button');
  crtBtn.id = 'bf-btn-crt';
  crtBtn.type = 'button';
  crtBtn.className = 'bf-mini-toggle';
  crtBtn.textContent = 'CRT';
  crtBtn.dataset.active = 'false';
  crtBtn.setAttribute('aria-pressed', 'false');
  bind(crtBtn, 'click', () => triggerAction('toggle-crt'));
  headerControls.appendChild(crtBtn);

  const palBtn = doc.createElement('button');
  palBtn.id = 'bf-btn-pal';
  palBtn.type = 'button';
  palBtn.className = 'bf-mini-toggle';
  palBtn.textContent = 'PAL';
  bind(palBtn, 'click', () => triggerAction('cycle-palette'));
  headerControls.appendChild(palBtn);

  const ledPipsWrap = doc.createElement('div');
  ledPipsWrap.id = 'bf-led-pips';
  ledPipsWrap.className = 'bf-led-pips';
  ledPipsWrap.setAttribute('aria-label', 'Audio Channels CH1 to CH4');
  const ledPips = [];
  for (let i = 0; i < 4; i++) {
    const pip = doc.createElement('span');
    pip.className = 'bf-led-pip';
    pip.dataset.ch = String(i);
    pip.setAttribute('title', `CH${i + 1}`);
    ledPips.push(pip);
    ledPipsWrap.appendChild(pip);
  }
  headerControls.appendChild(ledPipsWrap);
  topBar.appendChild(headerControls);
  chassisEl.appendChild(topBar);

  // 2. Live Telemetry Bar
  const telemetryBarEl = doc.createElement('div');
  telemetryBarEl.id = 'bf-telemetry-bar';
  telemetryBarEl.className = 'bf-telemetry-bar';
  chassisEl.appendChild(telemetryBarEl);

  // 3. Top Bezel Mechanical Switches
  const topSwitchesEl = doc.createElement('nav');
  topSwitchesEl.className = 'bf-top-switches';
  topSwitchesEl.setAttribute('aria-label', 'Cartridge Actions');

  const topActionDefs = [
    { id: 'bf-btn-daily', action: 'daily', label: '🔄 DAILY' },
    { id: 'bf-btn-sync', action: 'sync', label: '💾 SYNC' },
    { id: 'bf-btn-mint', action: 'mint', label: '📦 MINT' },
    { id: 'bf-btn-crack', action: 'crack', label: '🔧 CRACK' },
    { id: 'bf-btn-deck', action: 'deck', label: '🕹 DECK' },
  ];

  const actionButtons = new Map();
  for (const def of topActionDefs) {
    const btn = doc.createElement('button');
    btn.id = def.id;
    btn.type = 'button';
    btn.className = 'bf-keycap';
    btn.dataset.action = def.action;
    btn.textContent = def.label;
    bind(btn, 'click', () => triggerAction(def.action));
    actionButtons.set(def.action, btn);
    topSwitchesEl.appendChild(btn);
  }

  const installBtn = doc.createElement('button');
  installBtn.id = 'bf-btn-install';
  installBtn.type = 'button';
  installBtn.className = 'bf-keycap';
  installBtn.dataset.action = 'install';
  installBtn.textContent = '⬇ APP';
  installBtn.hidden = true;
  bind(installBtn, 'click', async () => {
    eventBus.emit(EVENT_NAMES.FOLEY_SWITCH, { index: 5, action: 'install' });
    if (!deferredInstallPrompt) return;
    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch {
      // Ignore canceled install prompt
    }
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });
  topSwitchesEl.appendChild(installBtn);
  chassisEl.appendChild(topSwitchesEl);

  // 4. Display Bay (#bf-screen + #bf-studio-stage)
  const displayBayEl = doc.createElement('main');
  displayBayEl.id = 'bf-display-bay';
  displayBayEl.className = 'bf-display-bay';

  const screenFrameEl = doc.createElement('div');
  screenFrameEl.id = 'bf-screen-frame';
  screenFrameEl.className = 'bf-screen-frame';

  const screenCanvas = doc.createElement('canvas');
  screenCanvas.id = 'bf-screen';
  screenCanvas.className = 'bf-pixel-canvas';
  screenCanvas.width = 128;
  screenCanvas.height = 128;
  screenFrameEl.appendChild(screenCanvas);
  displayBayEl.appendChild(screenFrameEl);

  const studioStageEl = doc.createElement('div');
  studioStageEl.id = 'bf-studio-stage';
  studioStageEl.className = 'bf-studio-stage';
  studioStageEl.hidden = true;
  displayBayEl.appendChild(studioStageEl);

  const noticeBannerEl = doc.createElement('div');
  noticeBannerEl.id = 'bf-notice-banner';
  noticeBannerEl.className = 'bf-notice-banner';
  noticeBannerEl.setAttribute('aria-live', 'polite');
  noticeBannerEl.hidden = true;
  displayBayEl.appendChild(noticeBannerEl);

  chassisEl.appendChild(displayBayEl);

  // 5. HUD & Tool Strip Dock
  const stripDockEl = doc.createElement('div');
  stripDockEl.className = 'bf-strip-dock';

  const hudStripEl = doc.createElement('div');
  hudStripEl.id = 'bf-hud-strip';
  hudStripEl.className = 'bf-hud-strip';
  const hudTextEl = doc.createElement('span');
  hudTextEl.id = 'bf-hud-text';
  hudTextEl.className = 'bf-hud-text';
  hudTextEl.textContent = 'TOUCH GLASS OR SCRUB BEZEL';
  hudStripEl.appendChild(hudTextEl);
  stripDockEl.appendChild(hudStripEl);

  const toolStripEl = doc.createElement('div');
  toolStripEl.id = 'bf-tool-strip';
  toolStripEl.className = 'bf-tool-strip';
  stripDockEl.appendChild(toolStripEl);

  chassisEl.appendChild(stripDockEl);

  // 6. Bottom Mode Tabs (SPRITE, WORLD, AUDIO, RULES, PLAY)
  const modeTabsEl = doc.createElement('div');
  modeTabsEl.className = 'bf-mode-tabs';
  modeTabsEl.setAttribute('role', 'tablist');
  modeTabsEl.setAttribute('aria-label', 'Console Modes');

  const modeButtons = new Map();
  for (const m of MODES) {
    const tab = doc.createElement('button');
    tab.id = `bf-tab-${m.id}`;
    tab.type = 'button';
    tab.className = 'bf-mode-tab';
    tab.dataset.mode = m.id;
    tab.dataset.active = m.id === activeMode ? 'true' : 'false';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(m.id === activeMode));
    tab.textContent = m.label;
    bind(tab, 'click', () => setMode(m.id));
    modeButtons.set(m.id, tab);
    modeTabsEl.appendChild(tab);
  }
  chassisEl.appendChild(modeTabsEl);

  // 7. Bottom 48-Detent Bezel Thumb-Wheel Mount
  const bezelWheelEl = doc.createElement('div');
  bezelWheelEl.id = 'bf-bezel-wheel';
  bezelWheelEl.className = 'bf-bezel-wheel';
  chassisEl.appendChild(bezelWheelEl);

  // 8. Modal Root
  const modalRootEl = doc.createElement('div');
  modalRootEl.id = 'bf-modal-root';
  modalRootEl.className = 'bf-modal-root';

  rootEl.appendChild(chassisEl);
  rootEl.appendChild(modalRootEl);

  function renderTelemetry() {
    const fps = Math.max(0, Math.round(Number(currentFps) || 60));
    const bytes = Math.max(0, Math.round(Number(currentCartBytes) || 0));
    telemetryBarEl.textContent = `STATUS: CDN_CACHED // DB_CALLS: 0 // ${fps} FPS // CART: ${bytes}B`;
  }

  function setTelemetry({ fps, cartBytes } = {}) {
    if (fps !== undefined && Number.isFinite(fps)) currentFps = fps;
    if (cartBytes !== undefined && Number.isFinite(cartBytes)) currentCartBytes = cartBytes;
    renderTelemetry();
  }

  function setCartMeta(rom, byteLength) {
    if (rom && rom.meta) {
      cartTitleEl.textContent = String(rom.meta.title || 'UNTITLED').slice(0, 24);
      setCrtOptics(Boolean(rom.meta.crtOptics));
      palBtn.textContent = `PAL:${String(rom.meta.paletteId || 'classic16').slice(0, 4).toUpperCase()}`;
    }
    if (byteLength !== undefined) {
      setTelemetry({ cartBytes: byteLength });
    }
  }

  function setLedLevels(levels) {
    for (let i = 0; i < 4; i++) {
      const raw = Array.isArray(levels) ? Number(levels[i]) : 0;
      const lvl = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      ledPips[i].style.setProperty('--level', lvl.toFixed(3));
    }
  }

  function setCrtOptics(enabled) {
    const on = Boolean(enabled);
    if (on) {
      screenFrameEl.classList.add('bf-crt-on');
    } else {
      screenFrameEl.classList.remove('bf-crt-on');
    }
    crtBtn.dataset.active = on ? 'true' : 'false';
    crtBtn.setAttribute('aria-pressed', String(on));
  }

  function triggerShutterFlash() {
    screenFrameEl.classList.remove('bf-shutter-flash');
    void screenFrameEl.offsetWidth;
    screenFrameEl.classList.add('bf-shutter-flash');
    if (shutterTimer !== null) clearTimeout(shutterTimer);
    shutterTimer = setTimeout(() => {
      shutterTimer = null;
      screenFrameEl.classList.remove('bf-shutter-flash');
    }, 340);
  }

  function showNotice(message, durationMs = 2000) {
    if (!message) {
      noticeBannerEl.hidden = true;
      return;
    }
    noticeBannerEl.textContent = String(message);
    noticeBannerEl.hidden = false;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      noticeBannerEl.hidden = true;
    }, Math.max(300, durationMs));
  }

  function setCrackedState(cracked) {
    const btn = actionButtons.get('crack');
    if (btn) {
      btn.dataset.active = cracked ? 'true' : 'false';
      btn.setAttribute('aria-pressed', String(Boolean(cracked)));
    }
  }

  function updateScreenScale() {
    if (destroyed) return currentScale;
    const bayW = displayBayEl.clientWidth;
    const bayH = displayBayEl.clientHeight;
    let availW = bayW > 32 ? bayW - 24 : 0;
    let availH = bayH > 32 ? bayH - 24 : 0;

    if (availW <= 0 || availH <= 0) {
      const vw = Number(win?.innerWidth) || 390;
      const vh = Number(win?.innerHeight) || 844;
      availW = Math.max(128, vw - 36);
      availH = Math.max(128, vh - 280);
    }

    const scale = computeIntegerScale(availW, availH);
    currentScale = scale;
    const px = `${128 * scale}px`;
    screenCanvas.style.width = px;
    screenCanvas.style.height = px;
    screenCanvas.dataset.scale = String(scale);
    return scale;
  }

  function setMode(nextMode, { silent = false } = {}) {
    const normalized = String(nextMode || 'play').toLowerCase();
    const valid = MODES.some((m) => m.id === normalized) ? normalized : 'play';
    const prevMode = activeMode;
    activeMode = valid;

    for (const [modeId, btn] of modeButtons.entries()) {
      const isCurrent = modeId === valid;
      btn.dataset.active = isCurrent ? 'true' : 'false';
      btn.setAttribute('aria-selected', String(isCurrent));
    }

    const isPlay = valid === 'play';
    screenFrameEl.hidden = !isPlay;
    studioStageEl.hidden = isPlay;

    if (isPlay) {
      updateScreenScale();
    }

    if (!silent) {
      eventBus.emit(EVENT_NAMES.FOLEY_SWITCH, { index: MODES.findIndex((m) => m.id === valid), mode: valid });
      eventBus.emit(EVENT_NAMES.MODE_CHANGE, { mode: valid, prevMode });
    }
    return valid;
  }

  function triggerAction(actionName) {
    const actionIdx = topActionDefs.findIndex((d) => d.action === actionName);
    eventBus.emit(EVENT_NAMES.FOLEY_SWITCH, { index: actionIdx >= 0 ? actionIdx : 0, action: actionName });
    const handler = actionHandlers.get(actionName);
    if (typeof handler === 'function') {
      handler();
    }
    const eventKey = `action:${actionName}`;
    eventBus.emit(eventKey, { action: actionName });
  }

  function onAction(actionName, fn) {
    if (typeof fn === 'function') {
      actionHandlers.set(actionName, fn);
    }
    return () => {
      if (actionHandlers.get(actionName) === fn) {
        actionHandlers.delete(actionName);
      }
    };
  }

  function closeModal() {
    if (typeof activeModalCleanup === 'function') {
      const fn = activeModalCleanup;
      activeModalCleanup = null;
      fn();
    }
    modalRootEl.innerHTML = '';
  }

  function openModal({ title = '', render, onClose } = {}) {
    closeModal();
    const backdrop = doc.createElement('div');
    backdrop.className = 'bf-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    if (title) backdrop.setAttribute('aria-label', title);

    const panel = doc.createElement('div');
    panel.className = 'bf-modal-panel';

    const header = doc.createElement('div');
    header.className = 'bf-modal-header';

    const h2 = doc.createElement('h2');
    h2.className = 'bf-modal-title';
    h2.textContent = title;
    header.appendChild(h2);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bf-modal-close';
    closeBtn.textContent = 'CLOSE';
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = doc.createElement('div');
    body.className = 'bf-modal-body';
    panel.appendChild(body);
    backdrop.appendChild(panel);
    modalRootEl.appendChild(backdrop);

    let closed = false;
    const handleClose = () => {
      if (closed) return;
      closed = true;
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('keydown', onKeyDown);
      }
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (typeof onClose === 'function') onClose();
    };

    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') handleClose();
    };

    closeBtn.addEventListener('click', handleClose);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) handleClose();
    });
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('keydown', onKeyDown);
    }

    activeModalCleanup = handleClose;
    if (typeof render === 'function') {
      render(body, { close: handleClose, panel });
    }
    return { close: handleClose, bodyEl: body, panelEl: panel };
  }

  // Subscribe to telemetry:fps on bus
  const unsubFps = eventBus.on(EVENT_NAMES.TELEMETRY_FPS, (tel = {}) => {
    if (typeof tel.fps === 'number') {
      setTelemetry({ fps: tel.fps });
    }
  });

  // PWA install prompt wiring (always hidden in standalone exports or installed apps)
  if (!isStandaloneRuntime(win) && win) {
    bind(win, 'beforeinstallprompt', (ev) => {
      if (typeof ev?.preventDefault === 'function') ev.preventDefault();
      deferredInstallPrompt = ev;
      installBtn.hidden = false;
      eventBus.emit(EVENT_NAMES.PWA_INSTALL_AVAILABLE, { available: true });
    });

    bind(win, 'appinstalled', () => {
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      eventBus.emit(EVENT_NAMES.PWA_INSTALL_AVAILABLE, { available: false, installed: true });
    });
  }

  // Dynamic integer scaling on ResizeObserver + window resize
  let resizeObserver = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    resizeObserver = new globalThis.ResizeObserver(() => updateScreenScale());
    resizeObserver.observe(displayBayEl);
  }
  if (win) {
    bind(win, 'resize', updateScreenScale);
  }

  renderTelemetry();
  updateScreenScale();
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => updateScreenScale());
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    closeModal();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    if (shutterTimer !== null) clearTimeout(shutterTimer);
    if (typeof unsubFps === 'function') unsubFps();
    if (resizeObserver && typeof resizeObserver.disconnect === 'function') {
      resizeObserver.disconnect();
    }
    for (const off of cleanupListeners) off();
    cleanupListeners.length = 0;
    actionHandlers.clear();
    rootEl.innerHTML = '';
  }

  return {
    rootEl,
    chassisEl,
    bus: eventBus,
    screenCanvas,
    screenFrameEl,
    studioStageEl,
    hudStripEl,
    hudTextEl,
    toolStripEl,
    bezelWheelEl,
    modalRootEl,
    installBtn,
    setMode,
    getMode: () => activeMode,
    getScale: () => currentScale,
    setCartMeta,
    setTelemetry,
    setLedLevels,
    setCrtOptics,
    setCrackedState,
    triggerShutterFlash,
    showNotice,
    openModal,
    closeModal,
    updateScreenScale,
    onAction,
    destroy,
  };
}
