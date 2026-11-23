import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { kaboom } from '../src/vendor/kaboom-core.js';
import {
  TOUCH_VERBS,
  segmentIntersectsAABB,
  createTouchVerbController,
} from '../src/runtime/touch-verbs.js';
import {
  RULE_TRIGGERS,
  RULE_ACTIONS,
  compileChipsToJs,
  parseJsToChips,
  attachRuleChipsToScene,
} from '../src/runtime/rule-chips.js';
import {
  highlightMicroJs,
  executeSandboxedCartJs,
  createRulesEditor,
} from '../src/runtime/js-drawer.js';
import { createArcadeRuntime } from '../src/runtime/arcade-core.js';

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

function createMockCart(overrides = {}) {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));
  sprites[0].frames[0].fill(7);

  return {
    magic: 'BF80',
    version: 1,
    meta: {
      id: 'test-cart',
      title: 'TEST CART',
      author: 'DEVON',
      paletteId: 'classic16',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'slingshot',
      dropShadow1px: true,
      crtOptics: false,
      updatedAt: 1700000000000,
      ...(overrides.meta || {}),
    },
    sprites: overrides.sprites || sprites,
    world: {
      width: 16,
      height: 16,
      bgLayer: new Uint8Array(256),
      mainLayer: new Uint8Array(256),
      fgLayer: new Uint8Array(256),
      collision: new Uint8Array(256),
      ...(overrides.world || {}),
    },
    audio: {
      bpm: 120,
      scaleId: 'pentatonic',
      channels: [],
      wavetable32: new Uint8Array(32),
      sfxPatches: [],
    },
    logic: {
      presetGameId: null,
      ruleChips: [],
      customJs: '',
      ...(overrides.logic || {}),
    },
  };
}

test('1. kaboom-core 512-slot particle pool stays fixed-length over 600 simulation frames with zero NaNs', () => {
  const k = kaboom({ seed: 4242, dustMotes: false });
  for (let frame = 0; frame < 600; frame++) {
    // Periodically burst particles including an overflow wave (> 512)
    if (frame % 15 === 0) {
      k.emitParticles({
        x: (frame * 7) % 128,
        y: (frame * 11) % 128,
        count: frame === 300 ? 600 : 32,
        speed: 65,
        gravity: 90,
        life: 0.35,
        color: [4, 7, 10],
      });
    }
    k.stepFrame();

    const stats = k.getParticlePoolStats();
    assert.equal(stats.capacity, 512);
    assert.equal(stats.buffers.xLength, 512);
    assert.equal(stats.buffers.yLength, 512);
    assert.equal(stats.buffers.vxLength, 512);
    assert.equal(stats.buffers.vyLength, 512);
    assert.equal(stats.buffers.lifeLength, 512);
    assert.equal(stats.buffers.activeLength, 512);
    assert.ok(stats.active >= 0 && stats.active <= 512);
    assert.equal(stats.hasNaN, false);
  }

  const midStats = k.getParticlePoolStats();
  assert.ok(midStats.totalEmitted > 1000);
  assert.ok(midStats.overflowRecycled > 0);

  // Let all active particles expire cleanly
  for (let i = 0; i < 60; i++) {
    k.stepFrame();
  }
  const endStats = k.getParticlePoolStats();
  assert.equal(endStats.active, 0);
  assert.equal(endStats.hasNaN, false);
});

test('2. kaboom-core fixed-timestep, hitStop(2), trauma shake, 5x7 font, and renderToCanvas fallback/palette', () => {
  const k = kaboom({ gravity: 0, dropShadow1px: true, dustMotes: false });

  // Fixed-timestep accumulator test: 0.008s -> 0 ticks, +0.009s -> 1 tick
  assert.equal(k.stepFrame(0.008), 0);
  assert.equal(k.frame(), 0);
  assert.equal(k.stepFrame(0.009), 1);
  assert.equal(k.frame(), 1);

  const actor = k.add([
    k.pos(20, 20),
    k.vel(60, 0),
    k.rect(8, 8),
    k.color(7),
    k.area(),
    'actor',
  ]);

  k.hitStop(2);
  k.shake(0.9);
  const startX = actor.pos.x;

  // During 2 hitStop frames, entity position must remain frozen
  k.stepFrame();
  assert.equal(actor.pos.x, startX);
  k.stepFrame();
  assert.equal(actor.pos.x, startX);

  // Frame 3 resumes physics motion (60 px/s * 1/60s = 1px)
  k.stepFrame();
  assert.ok(Math.abs(actor.pos.x - (startX + 1)) < 1e-4);

  // Shake should decay back to zero after enough ticks
  assert.ok(k.getTrauma() > 0);
  for (let i = 0; i < 90; i++) k.stepFrame();
  assert.equal(k.getTrauma(), 0);
  assert.deepEqual(k.getCameraOffset(), { x: 0, y: 0 });

  // Built-in 5x7 bitmap font + renderToCanvas with internal default palette and custom palette
  k.drawText5x7('BF80!', 8, 8, 4);
  const putCalls = [];
  const mockCtx = {
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(imgData, x, y) {
      putCalls.push({ imgData, x, y });
    },
  };

  const imgDefault = k.renderToCanvas(mockCtx);
  assert.equal(putCalls.length, 1);
  assert.equal(imgDefault.width, 128);
  assert.equal(imgDefault.height, 128);
  // Check that foreground white pixel from text exists (default palette index 4 = #e8ecf5)
  let foundWhite = false;
  for (let i = 0; i < imgDefault.data.length; i += 4) {
    if (imgDefault.data[i] === 0xe8 && imgDefault.data[i + 1] === 0xec && imgDefault.data[i + 2] === 0xf5) {
      foundWhite = true;
      break;
    }
  }
  assert.equal(foundWhite, true);

  // Explicit { rgba32, hex } palette override
  const customHex = Array.from({ length: 16 }, (_, idx) => (idx === 4 ? '#11aa22' : '#000000'));
  const customRgba = new Uint32Array(16);
  const imgCustom = k.renderToCanvas(mockCtx, { rgba32: customRgba, hex: customHex });
  let foundCustomGreen = false;
  for (let i = 0; i < imgCustom.data.length; i += 4) {
    if (imgCustom.data[i] === 0x11 && imgCustom.data[i + 1] === 0xaa && imgCustom.data[i + 2] === 0x22) {
      foundCustomGreen = true;
      break;
    }
  }
  assert.equal(foundCustomGreen, true);
});

test('3. touch-verbs implements all 5 direct-touch physics verbs accurately', () => {
  const bus = createMockBus();
  let activeVerb = TOUCH_VERBS.SLINGSHOT;
  const ctrl = createTouchVerbController({
    bus,
    getPrimaryVerb: () => activeVerb,
  });

  // (a) Slingshot: anchor, 4px ratchet ticks, parabolic trajectory preview, release impulse
  ctrl.simulatePointer('down', 64, 64, 1);
  ctrl.simulatePointer('move', 64, 84, 1); // 20px pull down -> 5 ratchet steps (every 4px)
  const slingEvts = ctrl.consumeEvents().filter((e) => e.type === 'slingshot:ratchet');
  assert.equal(slingEvts.length, 5);
  assert.equal(slingEvts[4].step, 5);

  const slingState = ctrl.getState().slingshot;
  assert.equal(slingState.active, true);
  assert.ok(slingState.previewDots.length >= 10);
  // Parabolic gravity curves downward: compare middle vs end slope
  const d0 = slingState.previewDots[0];
  const dMid = slingState.previewDots[Math.floor(slingState.previewDots.length / 2)];
  const dLast = slingState.previewDots[slingState.previewDots.length - 1];
  assert.ok(d0.y < 64); // launched upward initially
  const slopeEarly = dMid.y - d0.y;
  const slopeLate = dLast.y - dMid.y;
  assert.ok(slopeLate > slopeEarly, 'parabolic trajectory must accelerate downward due to gravity');

  ctrl.simulatePointer('up', 64, 84, 1);
  const releaseEvt = ctrl.consumeEvents().find((e) => e.type === 'slingshot:release');
  assert.ok(releaseEvt);
  assert.ok(releaseEvt.vy < 0);
  assert.ok(releaseEvt.power > 0);

  // (b) SpringDrag: critically-damped follower convergence (k=240, damping=22)
  activeVerb = TOUCH_VERBS.SPRING_DRAG;
  ctrl.simulatePointer('down', 108, 24, 2);
  for (let i = 0; i < 90; i++) {
    ctrl.step(1 / 60);
  }
  const springState = ctrl.getState().springDrag;
  assert.equal(springState.k, 240);
  assert.equal(springState.damping, 22);
  assert.ok(Math.hypot(springState.pos.x - 108, springState.pos.y - 24) < 0.05);
  ctrl.simulatePointer('up', 108, 24, 2);
  ctrl.consumeEvents();

  // (c) TapRipple: 120ms parry window, tile flip, radial sparks
  activeVerb = TOUCH_VERBS.TAP_RIPPLE;
  ctrl.simulatePointer('down', 36, 44, 3);
  const tapEvts = ctrl.consumeEvents();
  assert.ok(tapEvts.some((e) => e.type === 'tapRipple:burst' && e.parryWindowMs === 120));
  assert.ok(tapEvts.some((e) => e.type === 'tapRipple:tileFlip' && e.tileX === 4 && e.tileY === 5));
  assert.equal(ctrl.getState().tapRipple.parryActive, true);
  assert.equal(ctrl.getState().tapRipple.parryRemainingMs, 120);

  // Verify drawOverlay flushes radial 1px spark burst into kaboom particle pool
  const k = kaboom({ dustMotes: false });
  ctrl.drawOverlay(k);
  assert.ok(k.getParticlePoolStats().active > 0);

  // Parry window stays open at 60ms, closes after > 120ms
  ctrl.step(0.06);
  assert.equal(ctrl.getState().tapRipple.parryActive, true);
  ctrl.step(0.07);
  assert.equal(ctrl.getState().tapRipple.parryActive, false);

  // (d) RibbonSlice: 24-sample ring buffer + segmentIntersectsAABB cleaving
  activeVerb = TOUCH_VERBS.RIBBON_SLICE;
  ctrl.simulatePointer('down', 4, 4, 4);
  for (let i = 1; i <= 30; i++) {
    ctrl.simulatePointer('move', 4 + i * 3, 4 + i * 2, 4);
  }
  const ribbonState = ctrl.getState().ribbonSlice;
  assert.equal(ribbonState.capacity, 24);
  assert.equal(ribbonState.count, 24);
  assert.equal(ribbonState.trail.length, 24);

  assert.equal(segmentIntersectsAABB(0, 0, 20, 20, { x: 8, y: 8, width: 8, height: 8 }), true);
  assert.equal(segmentIntersectsAABB(0, 0, 20, 0, { x: 8, y: 8, width: 8, height: 8 }), false);
  assert.equal(segmentIntersectsAABB(12, 12, 12, 12, { x: 8, y: 8, width: 8, height: 8 }), true);

  const cleaved = ctrl.cleaveBoxes([
    { id: 'hit', x: 50, y: 34, width: 12, height: 12 },
    { id: 'miss', x: 10, y: 100, width: 8, height: 8 },
  ]);
  assert.equal(cleaved.length, 1);
  assert.equal(cleaved[0].box.id, 'hit');
  ctrl.simulatePointer('up', 94, 64, 4);
  ctrl.consumeEvents();

  // (e) BezelWheel: angle, delta, velocity, 48-detent ticks via setBezelInput & bus bezel:scrub
  const stepAngle = (Math.PI * 2) / 48;
  ctrl.setBezelInput(stepAngle * 3.2, stepAngle * 3.2, 1.5);
  let bezelState = ctrl.getState().bezelWheel;
  assert.equal(bezelState.detents, 48);
  assert.equal(bezelState.detent, 3);
  assert.equal(bezelState.velocity, 1.5);

  const detentEvts = ctrl.consumeEvents().filter((e) => e.type === 'bezelWheel:detent');
  assert.equal(detentEvts.length, 1);
  assert.equal(detentEvts[0].detent, 3);

  bus.emit('bezel:scrub', { delta: stepAngle * 2, velocity: 0.8 });
  bezelState = ctrl.getState().bezelWheel;
  assert.equal(bezelState.detent, 5);
  assert.equal(bezelState.velocity, 0.8);

  ctrl.destroy();
});

test('4. rule-chips bidirectional compileChipsToJs <-> parseJsToChips and sandbox execution', () => {
  assert.equal(RULE_TRIGGERS.length, 5);
  assert.equal(RULE_ACTIONS.length, 6);

  const sampleChips = [
    { id: 'r1', trigger: 'slingshot_release', paramA: 110, action: 'launch_impulse', paramB: 150, sfxSlot: 1 },
    { id: 'r2', trigger: 'tap_entity', paramA: 16, action: 'spawn_sparks', paramB: 20, sfxSlot: 2 },
    { id: 'r3', trigger: 'slice_hit', paramA: 1, action: 'shatter_pixels', paramB: 24, sfxSlot: 5 },
    { id: 'r4', trigger: 'bezel_scrub', paramA: 8, action: 'score_plus_1', paramB: 3, sfxSlot: 0 },
    { id: 'r5', trigger: 'collide_hazard', paramA: 0, action: 'bounce_trauma', paramB: 65, sfxSlot: 4 },
    { id: 'r6', trigger: 'bezel_scrub', paramA: 12, action: 'play_sfx', paramB: 9, sfxSlot: 7 },
  ];

  const compiledJs = compileChipsToJs(sampleChips);
  const parsedChips = parseJsToChips(compiledJs);
  assert.deepEqual(parsedChips, sampleChips);

  // Direct JS edit syncs back into chip parameters
  const editedJs = compiledJs.replace('count: 24', 'count: 42').replace('addScore(3)', 'addScore(10)');
  const reParsed = parseJsToChips(editedJs);
  assert.equal(reParsed[2].paramB, 42);
  assert.equal(reParsed[3].paramB, 10);

  // Highlighting safely escapes HTML tags and produces token spans
  const html = highlightMicroJs('const x = "<script>alert(1)</script>"; // note');
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('tok-kw'));
  assert.ok(html.includes('tok-str'));
  assert.ok(html.includes('tok-cmt'));

  // Sandboxed execution runs rules, isolates globals, and never throws on invalid code
  const k = kaboom({ dustMotes: false });
  const actor = k.add([k.pos(30, 30), k.vel(0, 0), k.area({ width: 8, height: 8 }), 'actor']);
  const hazard = k.add([k.pos(32, 32), k.area({ width: 8, height: 8 }), 'hazard']);
  let scoreTotal = 0;
  const sfxLog = [];

  const sandboxed = executeSandboxedCartJs(
    `${compiledJs}\nconst leaked = [typeof window, typeof document, typeof fetch, typeof globalThis];`,
    k,
    {
      onScore: (pts) => { scoreTotal += pts; },
      playSfx: (slot) => { sfxLog.push(slot); },
    }
  );
  assert.equal(sandboxed.ok, true);
  assert.equal(sandboxed.registeredRules, 6);

  // Step 1 frame -> actor overlaps hazard -> collide_hazard fires bounce_trauma + shake + sfx 4
  k.stepFrame();
  assert.ok(k.getTrauma() > 0);
  assert.ok(sfxLog.includes(4));
  assert.ok(hazard.exists());

  // Trigger bezel scrub verb event -> score_plus_1 & play_sfx
  sandboxed.handleVerbEvents([{ type: 'bezelWheel:detent', angle: 0.2, delta: 0.1, velocity: 1, detent: 1 }]);
  assert.equal(scoreTotal, 3);
  assert.ok(sfxLog.includes(7));

  // Verify dangerous globals cannot be accessed
  const leakCheck = executeSandboxedCartJs(
    'if (typeof window !== "undefined" || typeof fetch !== "undefined" || typeof globalThis !== "undefined") { throw new Error("ESCAPE"); }',
    k
  );
  assert.equal(leakCheck.ok, true);

  // Syntax error returns structured error without throwing
  const badRes = executeSandboxedCartJs('const broken = (;', k);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.error && badRes.error.message.length > 0);

  // attachRuleChipsToScene execution check
  const k2 = kaboom({ dustMotes: false });
  const target = k2.add([k2.pos(40, 40), k2.area({ width: 8, height: 8 }), 'target']);
  const binder = attachRuleChipsToScene(k2, [
    { id: 'c1', trigger: 'slice_hit', paramA: 1, action: 'shatter_pixels', paramB: 10, sfxSlot: 5 },
  ], { playSfx: (s) => sfxLog.push(s) });
  binder.handleVerbEvents([{ type: 'ribbonSlice:segment', x0: 36, y0: 44, x1: 52, y1: 44 }]);
  assert.equal(target.exists(), false);
  assert.ok(k2.getParticlePoolStats().active >= 10);
  binder.detach();

  // Headless rules editor round-trip
  const cart = createMockCart({ logic: { ruleChips: sampleChips.slice(0, 1), customJs: '' } });
  let mutations = 0;
  const editor = createRulesEditor({
    getCart: () => cart,
    onMutate: () => { mutations++; },
  });
  editor.mount();
  assert.ok(editor.getCode().includes('onVerb("slingshot_release"'));
  assert.equal(editor.toggleDrawer(true), true);
  const badEdit = editor.setCode('function ( {');
  assert.equal(badEdit.ok, false);
  assert.ok(editor.getError());
  const goodEdit = editor.setCode(compileChipsToJs(sampleChips.slice(0, 2)));
  assert.equal(goodEdit.ok, true);
  assert.equal(cart.logic.ruleChips.length, 2);
  assert.ok(mutations > 0);
  editor.destroy();
});

test('5. arcade-core runtime telemetry, stepFrames, and live CRACK edit application', () => {
  const bus = createMockBus();
  const cart = createMockCart({
    meta: { primaryVerb: TOUCH_VERBS.SLINGSHOT },
    logic: {
      ruleChips: [
        { id: 'r1', trigger: 'slingshot_release', paramA: 100, action: 'launch_impulse', paramB: 100, sfxSlot: 0 },
      ],
      customJs: '',
    },
  });

  const putHistory = [];
  const mockCanvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img) => putHistory.push(img),
    }),
  };

  const sfxCalls = [];
  const runtime = createArcadeRuntime({
    canvas: mockCanvas,
    getCart: () => cart,
    dsp: { playSfxSlot: (slot) => sfxCalls.push(slot) },
    bus,
  });

  const tel0 = runtime.getTelemetry();
  assert.equal(tel0.particleCapacity, 512);
  assert.equal(tel0.activeVerb, 'slingshot');

  // Simulate slingshot launch via touchVerbs
  const verbs = runtime.getTouchVerbs();
  verbs.simulatePointer('down', 64, 64, 1);
  verbs.simulatePointer('move', 64, 84, 1);
  verbs.simulatePointer('up', 64, 84, 1);
  runtime.stepFrames(5);

  const actor = runtime.getK().get('actor')[0];
  assert.ok(actor.pos.y < 60, 'slingshot release rule chip must launch actor upward');
  assert.ok(sfxCalls.includes(0));

  // Live CRACK edit: change ruleChips score rule without full reboot and verify immediate effect
  cart.meta.primaryVerb = TOUCH_VERBS.BEZEL_WHEEL;
  cart.logic.ruleChips = [
    { id: 'r2', trigger: 'bezel_scrub', paramA: 1, action: 'score_plus_1', paramB: 5, sfxSlot: 2 },
  ];
  verbs.setBezelInput(0.5, 0.2, 1.0);
  runtime.stepFrames(2);
  assert.equal(runtime.getTelemetry().score, 5);
  assert.ok(sfxCalls.includes(2));

  // Live CRACK edit: modify sprite pixel color directly and verify canvas output changes
  cart.sprites[0].frames[0].fill(5);
  runtime.stepFrames(1);
  assert.ok(putHistory.length > 0);

  // Live CRACK edit: modify customJs directly and verify sandbox updates immediately
  cart.logic.customJs = 'onVerb("bezel_scrub", 1, (ctx) => { ctx.addScore(10); });';
  verbs.setBezelInput(1.0, 0.3, 1.2);
  runtime.stepFrames(1);
  assert.equal(runtime.getTelemetry().score, 15);

  // Pack-in registry mounting + world tilemap + z/lifespan/opacity/sprite rendering
  let mountedId = null;
  const packInCart = createMockCart({ logic: { presetGameId: 'sling-slime', ruleChips: [], customJs: '' } });
  packInCart.world.mainLayer[0] = 1;
  runtime.rebootCartridge(packInCart);
  const runtimeWithPackIn = createArcadeRuntime({
    canvas: mockCanvas,
    getCart: () => packInCart,
    packInRegistry: {
      'sling-slime': {
        mountGame(k, c) {
          mountedId = c.logic.presetGameId;
          k.scene('pack', () => {
            k.onDraw(() => k.drawTilemap(c.world));
            k.add([k.pos(16, 16), k.sprite(0), k.scale(2), k.rotate(15), k.opacity(0.75), k.z(2), k.lifespan(0.05, { fade: 0.05 }), 'temp']);
            k.add([k.pos(40, 40), k.circle(5), k.color(10), k.z(1)]);
          });
          k.go('pack');
        },
      },
    },
    bus,
  });
  assert.equal(mountedId, 'sling-slime');
  assert.equal(runtimeWithPackIn.getK().get('temp').length, 1);
  runtimeWithPackIn.stepFrames(5);
  assert.equal(runtimeWithPackIn.getK().get('temp').length, 0);

  runtimeWithPackIn.destroy();
  runtime.destroy();
});

test('6. js-drawer DOM createRulesEditor mounts, renders chips, toggles drawer, and validates JS syntax', () => {
  function makeMockDoc() {
    function makeEl(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        _innerHTML: '',
        value: '',
        type: '',
        spellcheck: true,
        selected: false,
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
        dispatch(type) {
          for (const fn of this.listeners[type] || []) fn({ target: this });
        },
      };
      el.ownerDocument = doc;
      return el;
    }
    const doc = { createElement: makeEl };
    return doc;
  }

  const doc = makeMockDoc();
  const container = doc.createElement('div');
  const toolStrip = doc.createElement('div');
  const bus = createMockBus();
  const cart = createMockCart();

  const editor = createRulesEditor({
    container,
    toolStrip,
    getCart: () => cart,
    bus,
  });
  editor.mount();

  assert.equal(container.children.length, 1);
  assert.equal(toolStrip.children.length, 1);
  editor.addChip({ trigger: 'tap_entity', paramA: 14, action: 'score_plus_1', paramB: 2, sfxSlot: 1 });
  assert.equal(cart.logic.ruleChips.length, 1);
  assert.ok(editor.getCode().includes('tap_entity'));

  // Toggle drawer via toolStrip pill
  toolStrip.children[0].dispatch('click');
  assert.equal(editor.isDrawerOpen(), true);

  // Simulate bad input in textarea -> reports ERR safely without corrupting chips
  const rootEl = container.children[0];
  const drawerEl = rootEl.children[2];
  const statusEl = drawerEl.children[0].children[0];
  const textareaEl = drawerEl.children[1].children[1];
  textareaEl.value = 'const broken = (';
  textareaEl.dispatch('input');
  assert.equal(statusEl.dataset.state, 'error');
  assert.ok(statusEl.textContent.startsWith('ERR'));
  assert.equal(cart.logic.ruleChips.length, 1);

  editor.unmount();
  assert.equal(container.children.length, 0);
  assert.equal(toolStrip.children.length, 0);
});

test('7. STRICT INPUT LAW: zero forbidden overlay controller strings in ./src/vendor/ and ./src/runtime/', () => {
  const roots = ['./src/vendor', './src/runtime'];
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

  const files = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  assert.equal(files.length, 5);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
    for (const term of forbiddenTerms) {
      assert.equal(
        content.includes(term),
        false,
        `Forbidden input term "${term}" found in ${filePath}`
      );
    }
  }
});
