/**
 * BitForge-80 60 FPS Arcade Runtime Orchestrator
 * Manages requestAnimationFrame loop, telemetry, live CRACK hot-reload, touch verbs, and rules.
 */

import { kaboom } from '../vendor/kaboom-core.js';
import { createTouchVerbController, TOUCH_VERBS } from './touch-verbs.js';
import { attachRuleChipsToScene } from './rule-chips.js';
import { executeSandboxedCartJs } from './js-drawer.js';

function resolvePackIn(packInRegistry, presetGameId) {
  if (!presetGameId || !packInRegistry) return null;
  if (typeof packInRegistry === 'function') return packInRegistry(presetGameId);
  if (typeof packInRegistry.get === 'function') return packInRegistry.get(presetGameId);
  if (typeof packInRegistry.getPackIn === 'function') return packInRegistry.getPackIn(presetGameId);
  if (packInRegistry.PACK_IN_GAMES && packInRegistry.PACK_IN_GAMES[presetGameId]) {
    return packInRegistry.PACK_IN_GAMES[presetGameId];
  }
  return packInRegistry[presetGameId] || null;
}

function hashRuleChips(ruleChips) {
  if (!Array.isArray(ruleChips) || ruleChips.length === 0) return '';
  let out = '';
  for (let i = 0; i < ruleChips.length; i++) {
    const c = ruleChips[i];
    if (!c) continue;
    out += `${c.id}|${c.trigger}|${c.paramA}|${c.action}|${c.paramB}|${c.sfxSlot};`;
  }
  return out;
}

function hasAnyWorldTiles(world) {
  if (!world) return false;
  const check = (arr) => {
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== 0) return true;
    }
    return false;
  };
  return check(world.bgLayer) || check(world.mainLayer) || check(world.fgLayer);
}

/**
 * Create the BitForge-80 arcade runtime.
 * @param {{ canvas?: any, hudStrip?: any, getCart?: () => any, packInRegistry?: any, dsp?: any, bus?: any }} [opts]
 */
export function createArcadeRuntime({
  canvas = null,
  hudStrip = null,
  getCart = null,
  packInRegistry = null,
  dsp = null,
  bus = null,
} = {}) {
  let k = kaboom({ dropShadow1px: true });
  let activeCart = typeof getCart === 'function' ? getCart() : null;
  let activePalette = null;
  let score = 0;

  let running = false;
  let destroyed = false;
  let rafId = null;
  let lastNowMs = 0;
  let fps = 60;
  let framesSinceTelemetry = 0;
  let telemetryClockMs = 0;

  let ruleBinder = null;
  let sandboxBinder = null;
  let lastRuleChipsSig = '';
  let lastCustomJs = '';
  let lastScriptError = null;
  let lastPresetId = null;

  const ctx2d = canvas && typeof canvas.getContext === 'function'
    ? canvas.getContext('2d', { alpha: false })
    : null;

  function currentCart() {
    return (typeof getCart === 'function' ? getCart() : null) || activeCart;
  }

  const touchVerbs = createTouchVerbController({
    canvas,
    bus,
    getPrimaryVerb: () => currentCart()?.meta?.primaryVerb || TOUCH_VERBS.SLINGSHOT,
  });

  function playSfx(slot, param = 0) {
    if (dsp && typeof dsp.playSfxSlot === 'function') {
      dsp.playSfxSlot(slot, param);
    } else if (dsp && typeof dsp.triggerSfx === 'function') {
      dsp.triggerSfx(slot, param);
    } else if (bus && typeof bus.emit === 'function') {
      bus.emit('foley:sfx', { slot, param });
    }
  }

  function addScore(points = 1) {
    score += Number(points) || 0;
    if (bus && typeof bus.emit === 'function') {
      bus.emit('runtime:score', { score });
    }
  }

  function buildRuleHooks() {
    return {
      bus,
      dsp,
      playSfx,
      onScore: addScore,
      getActor: () => k.get('actor')[0] || k.get('player')[0] || null,
      onRuntimeError: (err) => {
        lastScriptError = err;
        if (bus && typeof bus.emit === 'function') {
          bus.emit('runtime:error', err);
        }
      },
    };
  }

  function detachRules() {
    if (ruleBinder) {
      ruleBinder.detach();
      ruleBinder = null;
    }
    if (sandboxBinder) {
      sandboxBinder.detach();
      sandboxBinder = null;
    }
  }

  function bindLogic(cart, forceMode = null) {
    detachRules();
    lastScriptError = null;
    const logic = cart && cart.logic ? cart.logic : { ruleChips: [], customJs: '' };
    const chips = Array.isArray(logic.ruleChips) ? logic.ruleChips : [];
    const customJs = typeof logic.customJs === 'string' ? logic.customJs : '';
    const hooks = buildRuleHooks();

    lastRuleChipsSig = hashRuleChips(chips);
    lastCustomJs = customJs;

    const trimmedJs = customJs.trim();
    const hasCustomJs = trimmedJs.length > 0;
    const usesOnVerb = /\bonVerb\s*\(/.test(trimmedJs);

    if (forceMode === 'chips' || !hasCustomJs) {
      if (chips.length > 0) {
        ruleBinder = attachRuleChipsToScene(k, chips, hooks);
      }
      return;
    }

    if (usesOnVerb) {
      // customJs already encodes the chip rules (or user-edited onVerb rules)
      const res = executeSandboxedCartJs(customJs, k, hooks);
      if (res.ok) {
        sandboxBinder = res;
      } else {
        lastScriptError = res.error;
        if (chips.length > 0) {
          ruleBinder = attachRuleChipsToScene(k, chips, hooks);
        }
      }
    } else {
      // Extra micro-JS alongside chip rules
      if (chips.length > 0) {
        ruleBinder = attachRuleChipsToScene(k, chips, hooks);
      }
      const res = executeSandboxedCartJs(customJs, k, hooks);
      if (res.ok) {
        sandboxBinder = res;
      } else {
        lastScriptError = res.error;
      }
    }
  }

  function syncLiveCartEdits() {
    const cart = currentCart();
    if (!cart) return;

    if (Array.isArray(cart.sprites)) {
      k.setSprites(cart.sprites);
    }

    const logic = cart.logic || {};
    const chipsSig = hashRuleChips(logic.ruleChips);
    const jsSrc = typeof logic.customJs === 'string' ? logic.customJs : '';

    if (chipsSig !== lastRuleChipsSig || jsSrc !== lastCustomJs) {
      // Distinguish chip-only edit vs customJs edit so neither overwrites the other
      const chipsChanged = chipsSig !== lastRuleChipsSig;
      const jsChanged = jsSrc !== lastCustomJs;
      if (chipsChanged && !jsChanged) {
        bindLogic(cart, 'chips');
      } else {
        bindLogic(cart);
      }
    }
  }

  function mountDefaultCartridgeScene(cart) {
    k.scene('cart-default', () => {
      k.onDraw(() => {
        const live = currentCart() || cart;
        if (live && live.world && hasAnyWorldTiles(live.world)) {
          k.drawTilemap(live.world, { sprites: live.sprites });
        }
      });

      const actor = k.add([
        k.pos(60, 60),
        k.vel(0, 0),
        k.area({ width: 8, height: 8 }),
        k.body({ gravity: 0, drag: 2.2, bounce: 0.7, collideWorld: true }),
        'actor',
        'player',
      ]);

      actor.onDraw(() => {
        const live = currentCart() || cart;
        const slotIdx = live?.meta?.coverSpriteIdx ?? 0;
        const sp = live?.sprites?.[slotIdx];
        const hasPx = sp && sp.frames && sp.frames[0] && sp.frames[0].some((v) => v > 0);
        const cam = k.getCameraOffset();
        if (hasPx) {
          k.drawSpriteSlot(slotIdx, actor.pos.x + cam.x, actor.pos.y + cam.y, { sprites: live.sprites });
        } else {
          for (let py = 0; py < 8; py++) {
            for (let px = 0; px < 8; px++) {
              k.drawPixel(actor.pos.x + cam.x + px, actor.pos.y + cam.y + py, 7);
            }
          }
        }
      });

      k.onUpdate(() => {
        const live = currentCart() || cart;
        const verb = live?.meta?.primaryVerb || TOUCH_VERBS.SLINGSHOT;
        const state = touchVerbs.getState();
        if (verb === TOUCH_VERBS.SPRING_DRAG && state.springDrag.active && actor.exists()) {
          actor.pos.x += (state.springDrag.pos.x - 4 - actor.pos.x) * 0.25;
          actor.pos.y += (state.springDrag.pos.y - 4 - actor.pos.y) * 0.25;
        }
      });
    });
    k.go('cart-default');
  }

  function resolveEffectivePalette(cart) {
    if (activePalette) return activePalette;
    if (cart?.meta?.customPalette && cart.meta.customPalette.length >= 48) {
      return { rgb: cart.meta.customPalette };
    }
    return null;
  }

  function rebootCartridge(cartOverride = null, paletteOverride = null) {
    if (cartOverride) activeCart = cartOverride;
    if (paletteOverride) activePalette = paletteOverride;

    const cart = currentCart();
    score = 0;
    detachRules();

    k = kaboom({
      dropShadow1px: cart?.meta?.dropShadow1px !== undefined ? Boolean(cart.meta.dropShadow1px) : true,
      sprites: cart?.sprites || [],
    });

    lastPresetId = cart?.logic?.presetGameId || null;
    const packInMod = resolvePackIn(packInRegistry, lastPresetId);

    if (packInMod && typeof packInMod.mountGame === 'function') {
      packInMod.mountGame(k, cart, {
        touchVerbs,
        dsp,
        bus,
        palette: resolveEffectivePalette(cart),
        getCart: currentCart,
        addScore,
        playSfx,
      });
    } else if (cart) {
      mountDefaultCartridgeScene(cart);
    }

    if (cart) {
      bindLogic(cart);
    }

    if (dsp && typeof dsp.syncCart === 'function' && cart) {
      dsp.syncCart(cart);
    }

    if (bus && typeof bus.emit === 'function' && cart) {
      bus.emit('cart:boot', {
        id: cart.meta?.id || 'custom',
        title: cart.meta?.title || 'UNTITLED',
        primaryVerb: cart.meta?.primaryVerb || TOUCH_VERBS.SLINGSHOT,
      });
    }

    k.stepFrame(0);
    renderCurrentFrame();
    return k;
  }

  function renderCurrentFrame() {
    const cart = currentCart();
    touchVerbs.drawOverlay(k);
    const pal = resolveEffectivePalette(cart);
    const dropShadow1px = cart?.meta?.dropShadow1px !== undefined
      ? Boolean(cart.meta.dropShadow1px)
      : true;
    k.renderToCanvas(ctx2d, pal, { dropShadow1px });
  }

  function getTelemetry() {
    const pool = k.getParticlePoolStats();
    return {
      fps: Math.round(fps),
      frameCount: k.getFrameCount(),
      tickCount: k.frame(),
      particleCount: pool.active,
      particleCapacity: pool.capacity,
      hitStopFrames: k.getHitStopFrames(),
      trauma: k.getTrauma(),
      activeVerb: currentCart()?.meta?.primaryVerb || TOUCH_VERBS.SLINGSHOT,
      score,
      running,
      scriptError: lastScriptError,
    };
  }

  function updateHudAndEmitTelemetry(elapsedMs) {
    framesSinceTelemetry++;
    telemetryClockMs += elapsedMs;
    if (telemetryClockMs >= 250 || framesSinceTelemetry >= 15) {
      const tel = getTelemetry();
      if (bus && typeof bus.emit === 'function') {
        bus.emit('telemetry:fps', tel);
      }
      if (hudStrip && typeof hudStrip === 'object' && 'textContent' in hudStrip) {
        hudStrip.textContent = `${tel.fps} FPS · P:${tel.particleCount} · SCR ${tel.score}`;
      }
      framesSinceTelemetry = 0;
      telemetryClockMs = 0;
    }
  }

  function advanceOneFrame(dtSeconds) {
    syncLiveCartEdits();
    const stepDt = dtSeconds === undefined ? 1 / 60 : dtSeconds;
    touchVerbs.step(stepDt);

    const events = touchVerbs.consumeEvents();
    if (events.length > 0) {
      if (ruleBinder) ruleBinder.handleVerbEvents(events);
      if (sandboxBinder) sandboxBinder.handleVerbEvents(events);
    }

    touchVerbs.flushParticles(k);
    k.stepFrame(dtSeconds);
    renderCurrentFrame();
  }

  function stepFrames(n = 1) {
    const count = Math.max(0, Math.round(n));
    for (let i = 0; i < count; i++) {
      advanceOneFrame(undefined);
    }
    return getTelemetry();
  }

  function rafLoop(nowMs) {
    if (!running || destroyed) return;
    if (lastNowMs === 0) lastNowMs = nowMs;
    const elapsedMs = Math.max(0.5, nowMs - lastNowMs);
    lastNowMs = nowMs;

    const instFps = Math.min(120, 1000 / elapsedMs);
    fps = fps * 0.85 + instFps * 0.15;

    advanceOneFrame(elapsedMs / 1000);
    updateHudAndEmitTelemetry(elapsedMs);

    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(rafLoop);
    }
  }

  function start() {
    if (destroyed || running) return;
    running = true;
    lastNowMs = 0;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(rafLoop);
    }
  }

  function stop() {
    running = false;
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  let unsubPalette = null;
  if (bus && typeof bus.on === 'function') {
    const palHandler = (payload = {}) => {
      if (payload.palette) {
        activePalette = payload.palette;
      }
    };
    const res = bus.on('palette:change', palHandler);
    if (typeof res === 'function') unsubPalette = res;
    else if (typeof bus.off === 'function') unsubPalette = () => bus.off('palette:change', palHandler);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    detachRules();
    touchVerbs.destroy();
    if (typeof unsubPalette === 'function') unsubPalette();
  }

  // Initial boot if a cart is already available
  if (activeCart) {
    rebootCartridge(activeCart, activePalette);
  }

  return {
    rebootCartridge,
    stepFrames,
    getTelemetry,
    getK: () => k,
    getTouchVerbs: () => touchVerbs,
    setPalette: (pal) => { activePalette = pal || null; },
    getScore: () => score,
    setScore: (s) => { score = Number(s) || 0; },
    getActiveCart: currentCart,
    getLastScriptError: () => lastScriptError,
    start,
    stop,
    destroy,
  };
}
