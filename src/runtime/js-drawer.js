/**
 * BitForge-80 Micro-JS Syntax Highlighter, Sandboxed Executor & Rules Editor
 * Supports bidirectional Chip <-> Micro-JS editing with safe syntax error reporting.
 */

import {
  RULE_TRIGGERS,
  RULE_ACTIONS,
  compileChipsToJs,
  parseJsToChips,
  normalizeTriggerId,
  createRuleContextHelpers,
  dispatchVerbEvents,
} from './rule-chips.js';

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return',
  'function', 'true', 'false', 'null', 'undefined', 'new', 'typeof',
]);

const KABOOM_IDENTIFIERS = new Set([
  'k', 'onVerb', 'ctx', 'add', 'destroy', 'destroyAll', 'get',
  'pos', 'vel', 'area', 'body', 'sprite', 'rect', 'circle',
  'color', 'opacity', 'scale', 'rotate', 'z', 'lifespan',
  'onUpdate', 'onDraw', 'onCollide', 'shake', 'hitStop',
  'emitParticles', 'drawPixel', 'drawLine', 'drawSpriteSlot',
  'drawTilemap', 'drawText5x7', 'launchImpulse', 'bounce',
  'addScore', 'playSfx',
]);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Syntax-highlight BitForge-80 micro-JS into safe, escaped HTML spans.
 * @param {string} code
 * @returns {string}
 */
export function highlightMicroJs(code) {
  const src = String(code ?? '');
  if (!src) return '';

  const tokenRe = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(-?\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][A-Za-z0-9_$]*\b)|([{}()[\].,:;+\-*/%=<>!&|?^~]+)|(\s+|.)/g;
  let out = '';
  let m;

  while ((m = tokenRe.exec(src)) !== null) {
    if (m[1]) {
      out += `<span class="tok-cmt">${escapeHtml(m[1])}</span>`;
    } else if (m[2]) {
      out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
    } else if (m[3]) {
      out += `<span class="tok-num">${escapeHtml(m[3])}</span>`;
    } else if (m[4]) {
      const ident = m[4];
      if (JS_KEYWORDS.has(ident)) {
        out += `<span class="tok-kw">${escapeHtml(ident)}</span>`;
      } else if (KABOOM_IDENTIFIERS.has(ident)) {
        out += `<span class="tok-fn">${escapeHtml(ident)}</span>`;
      } else {
        out += escapeHtml(ident);
      }
    } else if (m[5]) {
      out += `<span class="tok-op">${escapeHtml(m[5])}</span>`;
    } else if (m[6]) {
      out += escapeHtml(m[6]);
    }
  }

  return out;
}

function extractErrorLocation(err) {
  const message = err && err.message ? String(err.message) : String(err || 'Unknown script error');
  let line = 1;
  let column = 1;

  if (err && typeof err.lineNumber === 'number') {
    line = Math.max(1, err.lineNumber);
  }
  if (err && typeof err.columnNumber === 'number') {
    column = Math.max(1, err.columnNumber);
  }
  if (err && err.stack) {
    const stackMatch = String(err.stack).match(/<anonymous>:(\d+):(\d+)/);
    if (stackMatch) {
      // Offset by wrapper function header lines
      line = Math.max(1, Number(stackMatch[1]) - 2);
      column = Math.max(1, Number(stackMatch[2]));
    }
  }

  return { message, line, column };
}

function validateJsSyntax(jsSource) {
  const src = String(jsSource ?? '');
  if (!src.trim()) return { ok: true, error: null };
  if (/\b(import|eval)\s*\(/.test(src)) {
    return {
      ok: false,
      error: { message: 'Dynamic import()/eval() is disabled in micro-JS sandbox', line: 1, column: 1 },
    };
  }
  try {
    // Compile-only check with shadowed environment identifiers (never name a param eval/arguments in strict mode)
    new Function(
      'k', 'onVerb', 'ctx',
      'window', 'document', 'globalThis', 'self', 'top', 'parent',
      'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage',
      'indexedDB', 'navigator', 'location', 'history', 'Function',
      'importScripts', 'process', 'require',
      `"use strict";\n${src}`
    );
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: extractErrorLocation(err) };
  }
}

/**
 * Execute cartridge customJs in an isolated strict sandbox against a Kaboom instance.
 * Never throws; returns `{ ok, error, registeredRules, handleVerbEvents, trigger, detach }`.
 * @param {string} jsSource
 * @param {object} k
 * @param {object} [hooks]
 */
export function executeSandboxedCartJs(jsSource, k, hooks = {}) {
  const src = String(jsSource ?? '');
  const emptyResult = (ok, error = null) => ({
    ok,
    error,
    registeredRules: 0,
    handleVerbEvents: () => {},
    trigger: () => {},
    detach: () => {},
  });

  if (!src.trim()) {
    return emptyResult(true, null);
  }

  const syntax = validateJsSyntax(src);
  if (!syntax.ok) {
    return emptyResult(false, syntax.error);
  }

  const helpers = createRuleContextHelpers(k, hooks);
  const subscriptions = [];
  const verbRules = [];
  let detached = false;

  const sandboxK = {
    ...k,
    onUpdate(tagOrFn, maybeFn) {
      const sub = k.onUpdate(tagOrFn, maybeFn);
      if (sub) subscriptions.push(sub);
      return sub;
    },
    onDraw(tagOrFn, maybeFn) {
      const sub = k.onDraw(tagOrFn, maybeFn);
      if (sub) subscriptions.push(sub);
      return sub;
    },
    onCollide(tagA, tagBOrFn, maybeFn) {
      const sub = k.onCollide(tagA, tagBOrFn, maybeFn);
      if (sub) subscriptions.push(sub);
      return sub;
    },
  };

  function findActor() {
    if (typeof hooks.getActor === 'function') {
      const a = hooks.getActor();
      if (a && a.exists()) return a;
    }
    return k.get('actor')[0] || k.get('player')[0] || null;
  }

  function makeCtx(extra = {}) {
    const actor = extra.actor || findActor();
    return {
      ...helpers,
      actor,
      target: extra.target || null,
      x: Number.isFinite(extra.x) ? extra.x : (actor?.pos?.x ?? 64),
      y: Number.isFinite(extra.y) ? extra.y : (actor?.pos?.y ?? 64),
      vx: extra.vx,
      vy: extra.vy,
      power: extra.power,
      angle: extra.angle,
      delta: extra.delta,
      velocity: extra.velocity,
      detent: extra.detent,
    };
  }

  function onVerb(triggerName, paramA, handler) {
    if (typeof handler !== 'function') return;
    const norm = normalizeTriggerId(triggerName);
    const param = Number(paramA) || 0;
    verbRules.push({ trigger: norm, paramA: param, handler });

    if (norm === 'collide_hazard') {
      const wrapCollide = (a, b) => {
        if (detached) return;
        try {
          handler(makeCtx({ actor: a, target: b, x: a.pos?.x, y: a.pos?.y }));
        } catch (err) {
          if (typeof hooks.onRuntimeError === 'function') {
            hooks.onRuntimeError(extractErrorLocation(err));
          }
        }
      };
      subscriptions.push(k.onCollide('actor', 'hazard', wrapCollide));
      subscriptions.push(k.onCollide('player', 'hazard', wrapCollide));
    }
  }

  try {
    const compiled = new Function(
      'k', 'onVerb', 'ctx',
      'Math', 'Number', 'String', 'Boolean', 'Array', 'Object',
      'Uint8Array', 'Int16Array', 'Float32Array',
      'window', 'document', 'globalThis', 'self', 'top', 'parent',
      'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage',
      'indexedDB', 'navigator', 'location', 'history', 'Function',
      'importScripts', 'process', 'require',
      `"use strict";\n${src}`
    );

    compiled(
      sandboxK, onVerb, makeCtx(),
      Math, Number, String, Boolean, Array, Object,
      Uint8Array, Int16Array, Float32Array,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined
    );
  } catch (err) {
    for (let i = 0; i < subscriptions.length; i++) {
      subscriptions[i]?.cancel?.();
    }
    return emptyResult(false, extractErrorLocation(err));
  }

  function trigger(triggerName, extra = {}) {
    if (detached) return;
    const norm = normalizeTriggerId(triggerName);
    for (let i = 0; i < verbRules.length; i++) {
      const rule = verbRules[i];
      if (rule.trigger !== norm) continue;
      try {
        rule.handler(makeCtx(extra));
      } catch (err) {
        if (typeof hooks.onRuntimeError === 'function') {
          hooks.onRuntimeError(extractErrorLocation(err));
        }
      }
    }
  }

  function handleVerbEvents(events) {
    if (detached) return;
    dispatchVerbEvents(events, k, verbRules, (rule, extra) => {
      try {
        rule.handler(makeCtx(extra));
      } catch (err) {
        if (typeof hooks.onRuntimeError === 'function') {
          hooks.onRuntimeError(extractErrorLocation(err));
        }
      }
    });
  }

  function detach() {
    detached = true;
    for (let i = 0; i < subscriptions.length; i++) {
      subscriptions[i]?.cancel?.();
    }
    subscriptions.length = 0;
    verbRules.length = 0;
  }

  return {
    ok: true,
    error: null,
    registeredRules: verbRules.length,
    handleVerbEvents,
    trigger,
    detach,
  };
}

/**
 * Create the combined Rule Chips Snap Builder + Collapsible Syntax-Highlighted Micro-JS Drawer.
 * @param {{ container?: any, toolStrip?: any, getCart?: () => any, onMutate?: (info: any) => void, bus?: any }} [opts]
 */
export function createRulesEditor({ container = null, toolStrip = null, getCart = null, onMutate = null, bus = null } = {}) {
  let mounted = false;
  let drawerOpen = false;
  let lastError = null;
  let currentCode = '';

  let rootEl = null;
  let chipListEl = null;
  let drawerEl = null;
  let textareaEl = null;
  let highlightEl = null;
  let statusEl = null;
  let drawerToggleBtn = null;
  let toolStripBtn = null;

  function readCart() {
    return typeof getCart === 'function' ? getCart() : null;
  }

  function ensureLogic(cart) {
    if (!cart) return null;
    if (!cart.logic) {
      cart.logic = { presetGameId: null, ruleChips: [], customJs: '' };
    }
    if (!Array.isArray(cart.logic.ruleChips)) {
      cart.logic.ruleChips = [];
    }
    if (typeof cart.logic.customJs !== 'string') {
      cart.logic.customJs = '';
    }
    return cart.logic;
  }

  function emitFoley(kind = 'foley:switch') {
    if (bus && typeof bus.emit === 'function') {
      bus.emit(kind, { source: 'rules-editor' });
    }
  }

  function notifyMutate(reason) {
    const cart = readCart();
    if (typeof onMutate === 'function') {
      onMutate({ type: reason, cart });
    }
  }

  function updateHighlightAndStatus() {
    if (highlightEl) {
      highlightEl.innerHTML = highlightMicroJs(currentCode || ' ');
    }
    if (textareaEl && textareaEl.value !== currentCode) {
      textareaEl.value = currentCode;
    }
    if (statusEl) {
      if (lastError) {
        statusEl.textContent = `ERR L${lastError.line}: ${lastError.message}`;
        statusEl.dataset.state = 'error';
      } else {
        statusEl.textContent = 'OK';
        statusEl.dataset.state = 'ok';
      }
    }
  }

  function renderChips() {
    if (!chipListEl) return;
    const cart = readCart();
    const logic = ensureLogic(cart);
    const chips = logic ? logic.ruleChips : [];
    chipListEl.innerHTML = '';

    const doc = chipListEl.ownerDocument;
    if (!doc) return;

    if (chips.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'bf-rules-empty';
      empty.textContent = 'No rule chips yet. Tap + RULE to snap a WHEN -> DO block.';
      chipListEl.appendChild(empty);
      return;
    }

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const row = doc.createElement('div');
      row.className = 'bf-rule-chip';
      row.dataset.chipId = chip.id || `rule-${i + 1}`;

      const whenLabel = doc.createElement('span');
      whenLabel.className = 'bf-chip-badge';
      whenLabel.textContent = 'WHEN';
      row.appendChild(whenLabel);

      const trigSel = doc.createElement('select');
      trigSel.className = 'bf-chip-select';
      trigSel.setAttribute('aria-label', 'Rule Trigger');
      for (const t of RULE_TRIGGERS) {
        const opt = doc.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        if (normalizeTriggerId(chip.trigger) === t.id) opt.selected = true;
        trigSel.appendChild(opt);
      }
      trigSel.addEventListener('change', () => {
        chip.trigger = trigSel.value;
        syncChipsToJs();
        emitFoley('foley:switch');
      });
      row.appendChild(trigSel);

      const paramAIn = doc.createElement('input');
      paramAIn.type = 'number';
      paramAIn.className = 'bf-chip-num';
      paramAIn.value = String(chip.paramA ?? 0);
      paramAIn.setAttribute('aria-label', 'Trigger Parameter');
      paramAIn.addEventListener('change', () => {
        chip.paramA = Number(paramAIn.value) || 0;
        syncChipsToJs();
      });
      row.appendChild(paramAIn);

      const doLabel = doc.createElement('span');
      doLabel.className = 'bf-chip-badge bf-chip-do';
      doLabel.textContent = 'DO';
      row.appendChild(doLabel);

      const actSel = doc.createElement('select');
      actSel.className = 'bf-chip-select';
      actSel.setAttribute('aria-label', 'Rule Action');
      for (const a of RULE_ACTIONS) {
        const opt = doc.createElement('option');
        opt.value = a.id;
        opt.textContent = a.label;
        if (chip.action === a.id) opt.selected = true;
        actSel.appendChild(opt);
      }
      actSel.addEventListener('change', () => {
        chip.action = actSel.value;
        syncChipsToJs();
        emitFoley('foley:switch');
      });
      row.appendChild(actSel);

      const paramBIn = doc.createElement('input');
      paramBIn.type = 'number';
      paramBIn.className = 'bf-chip-num';
      paramBIn.value = String(chip.paramB ?? 0);
      paramBIn.setAttribute('aria-label', 'Action Parameter');
      paramBIn.addEventListener('change', () => {
        chip.paramB = Number(paramBIn.value) || 0;
        syncChipsToJs();
      });
      row.appendChild(paramBIn);

      const sfxSel = doc.createElement('select');
      sfxSel.className = 'bf-chip-sfx';
      sfxSel.setAttribute('aria-label', 'SFX Slot');
      for (let s = 0; s < 8; s++) {
        const opt = doc.createElement('option');
        opt.value = String(s);
        opt.textContent = `SFX ${s}`;
        if ((chip.sfxSlot | 0) === s) opt.selected = true;
        sfxSel.appendChild(opt);
      }
      sfxSel.addEventListener('change', () => {
        chip.sfxSlot = Number(sfxSel.value) & 7;
        syncChipsToJs();
        emitFoley('foley:switch');
      });
      row.appendChild(sfxSel);

      const delBtn = doc.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bf-chip-del';
      delBtn.textContent = '×';
      delBtn.setAttribute('aria-label', 'Delete Rule');
      delBtn.addEventListener('click', () => {
        chips.splice(i, 1);
        syncChipsToJs();
        renderChips();
        emitFoley('foley:erase');
      });
      row.appendChild(delBtn);

      chipListEl.appendChild(row);
    }
  }

  function syncChipsToJs() {
    const cart = readCart();
    const logic = ensureLogic(cart);
    if (!logic) return;
    currentCode = compileChipsToJs(logic.ruleChips);
    logic.customJs = currentCode;
    lastError = null;
    updateHighlightAndStatus();
    notifyMutate('ruleChips');
  }

  function setCode(code, opts = {}) {
    currentCode = String(code ?? '');
    const check = validateJsSyntax(currentCode);
    lastError = check.ok ? null : check.error;

    const cart = readCart();
    const logic = ensureLogic(cart);
    if (check.ok && logic) {
      logic.customJs = currentCode;
      if (opts.syncChips !== false) {
        const parsed = parseJsToChips(currentCode);
        if (parsed.length > 0 || !currentCode.trim()) {
          logic.ruleChips = parsed;
          renderChips();
        }
      }
      notifyMutate('customJs');
    }

    updateHighlightAndStatus();
    return { ok: check.ok, error: lastError };
  }

  function addChip(partial = {}) {
    const cart = readCart();
    const logic = ensureLogic(cart);
    if (!logic) return null;
    const chip = {
      id: partial.id || `rule-${logic.ruleChips.length + 1}`,
      trigger: partial.trigger || RULE_TRIGGERS[0].id,
      paramA: partial.paramA ?? RULE_TRIGGERS[0].defaultParamA,
      action: partial.action || RULE_ACTIONS[0].id,
      paramB: partial.paramB ?? RULE_ACTIONS[0].defaultParamB,
      sfxSlot: partial.sfxSlot ?? 0,
    };
    logic.ruleChips.push(chip);
    syncChipsToJs();
    renderChips();
    emitFoley('foley:switch');
    return chip;
  }

  function toggleDrawer(forceState) {
    drawerOpen = typeof forceState === 'boolean' ? forceState : !drawerOpen;
    if (drawerEl) {
      drawerEl.dataset.open = drawerOpen ? 'true' : 'false';
      drawerEl.style.display = drawerOpen ? 'flex' : 'none';
    }
    if (drawerToggleBtn) {
      drawerToggleBtn.setAttribute('aria-expanded', String(drawerOpen));
    }
    emitFoley('foley:switch');
    return drawerOpen;
  }

  function refresh() {
    const cart = readCart();
    const logic = ensureLogic(cart);
    if (logic) {
      currentCode = logic.customJs && logic.customJs.trim()
        ? logic.customJs
        : compileChipsToJs(logic.ruleChips);
      const check = validateJsSyntax(currentCode);
      lastError = check.ok ? null : check.error;
    }
    renderChips();
    updateHighlightAndStatus();
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    if (container && container.ownerDocument) {
      const doc = container.ownerDocument;
      rootEl = doc.createElement('div');
      rootEl.className = 'bf-rules-editor';

      const header = doc.createElement('div');
      header.className = 'bf-rules-header';

      const title = doc.createElement('span');
      title.className = 'bf-rules-title';
      title.textContent = 'LOGIC // RULE CHIPS';
      header.appendChild(title);

      const addBtn = doc.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'bf-btn-add-rule';
      addBtn.textContent = '+ RULE';
      addBtn.addEventListener('click', () => addChip());
      header.appendChild(addBtn);

      drawerToggleBtn = doc.createElement('button');
      drawerToggleBtn.type = 'button';
      drawerToggleBtn.className = 'bf-btn-js-drawer';
      drawerToggleBtn.textContent = '<> MICRO-JS';
      drawerToggleBtn.setAttribute('aria-expanded', 'false');
      drawerToggleBtn.addEventListener('click', () => toggleDrawer());
      header.appendChild(drawerToggleBtn);

      rootEl.appendChild(header);

      chipListEl = doc.createElement('div');
      chipListEl.className = 'bf-rule-chip-list';
      rootEl.appendChild(chipListEl);

      drawerEl = doc.createElement('div');
      drawerEl.className = 'bf-js-drawer';
      drawerEl.dataset.open = 'false';
      drawerEl.style.display = 'none';

      const drawerBar = doc.createElement('div');
      drawerBar.className = 'bf-js-drawer-bar';

      statusEl = doc.createElement('span');
      statusEl.className = 'bf-js-status';
      statusEl.textContent = 'OK';
      drawerBar.appendChild(statusEl);

      const rebuildBtn = doc.createElement('button');
      rebuildBtn.type = 'button';
      rebuildBtn.className = 'bf-btn-sync-chips';
      rebuildBtn.textContent = 'COMPILE CHIPS';
      rebuildBtn.addEventListener('click', () => {
        syncChipsToJs();
        emitFoley('foley:switch');
      });
      drawerBar.appendChild(rebuildBtn);

      drawerEl.appendChild(drawerBar);

      const codeStage = doc.createElement('div');
      codeStage.className = 'bf-js-stage';

      highlightEl = doc.createElement('pre');
      highlightEl.className = 'bf-js-highlight';
      highlightEl.setAttribute('aria-hidden', 'true');
      codeStage.appendChild(highlightEl);

      textareaEl = doc.createElement('textarea');
      textareaEl.className = 'bf-js-textarea';
      textareaEl.spellcheck = false;
      textareaEl.setAttribute('aria-label', 'Micro-JS Rule Code');
      textareaEl.addEventListener('input', () => {
        setCode(textareaEl.value);
      });
      textareaEl.addEventListener('scroll', () => {
        if (highlightEl) {
          highlightEl.scrollTop = textareaEl.scrollTop;
          highlightEl.scrollLeft = textareaEl.scrollLeft;
        }
      });
      codeStage.appendChild(textareaEl);

      drawerEl.appendChild(codeStage);
      rootEl.appendChild(drawerEl);
      container.appendChild(rootEl);
    }

    if (toolStrip && toolStrip.ownerDocument) {
      const doc = toolStrip.ownerDocument;
      toolStripBtn = doc.createElement('button');
      toolStripBtn.type = 'button';
      toolStripBtn.className = 'bf-tool-pill';
      toolStripBtn.textContent = '<> JS';
      toolStripBtn.addEventListener('click', () => toggleDrawer());
      toolStrip.appendChild(toolStripBtn);
    }

    refresh();
  }

  function unmount() {
    mounted = false;
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    if (toolStripBtn && toolStripBtn.parentNode) {
      toolStripBtn.parentNode.removeChild(toolStripBtn);
    }
    rootEl = null;
    chipListEl = null;
    drawerEl = null;
    textareaEl = null;
    highlightEl = null;
    statusEl = null;
    drawerToggleBtn = null;
    toolStripBtn = null;
  }

  return {
    mount,
    unmount,
    destroy: unmount,
    refresh,
    toggleDrawer,
    addChip,
    getCode: () => currentCode,
    setCode,
    getError: () => lastError,
    isDrawerOpen: () => drawerOpen,
  };
}
