/**
 * BitForge-80 Bidirectional Rule Chips Compiler & Scene Binder
 * Compiles [WHEN] -> [DO] tactile chips to readable Kaboom-API micro-JS and parses back losslessly.
 */

import { segmentIntersectsAABB } from './touch-verbs.js';

export const RULE_TRIGGERS = Object.freeze([
  { id: 'slingshot_release', label: 'Slingshot Release', defaultParamA: 100, paramLabel: 'Force%' },
  { id: 'tap_entity', label: 'Tap Entity', defaultParamA: 12, paramLabel: 'Radius' },
  { id: 'slice_hit', label: 'Slice Hit', defaultParamA: 1, paramLabel: 'Cut' },
  { id: 'bezel_scrub', label: 'Bezel Scrub', defaultParamA: 10, paramLabel: 'Gain' },
  { id: 'collide_hazard', label: 'Collide Hazard', defaultParamA: 0, paramLabel: 'Mask' },
]);

export const RULE_ACTIONS = Object.freeze([
  { id: 'launch_impulse', label: 'Launch Impulse', defaultParamB: 100, paramLabel: 'Scale%' },
  { id: 'shatter_pixels', label: 'Shatter Pixels', defaultParamB: 16, paramLabel: 'Count' },
  { id: 'bounce_trauma', label: 'Bounce + Trauma', defaultParamB: 45, paramLabel: 'Trauma%' },
  { id: 'spawn_sparks', label: 'Spawn Sparks', defaultParamB: 12, paramLabel: 'Sparks' },
  { id: 'score_plus_1', label: 'Score +1', defaultParamB: 1, paramLabel: 'Points' },
  { id: 'play_sfx', label: 'Play SFX', defaultParamB: 0, paramLabel: 'Param' },
]);

const TRIGGER_ALIAS_MAP = new Map();
for (const t of RULE_TRIGGERS) {
  TRIGGER_ALIAS_MAP.set(t.id.toLowerCase(), t.id);
  TRIGGER_ALIAS_MAP.set(t.label.toLowerCase(), t.id);
  TRIGGER_ALIAS_MAP.set(t.id.replace(/_/g, '').toLowerCase(), t.id);
}

const ACTION_ALIAS_MAP = new Map();
for (const a of RULE_ACTIONS) {
  ACTION_ALIAS_MAP.set(a.id.toLowerCase(), a.id);
  ACTION_ALIAS_MAP.set(a.label.toLowerCase(), a.id);
  ACTION_ALIAS_MAP.set(a.id.replace(/_/g, '').toLowerCase(), a.id);
}

export function normalizeTriggerId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (TRIGGER_ALIAS_MAP.has(key)) return TRIGGER_ALIAS_MAP.get(key);
  const compact = key.replace(/[^a-z]/g, '');
  if (TRIGGER_ALIAS_MAP.has(compact)) return TRIGGER_ALIAS_MAP.get(compact);
  return 'slingshot_release';
}

export function normalizeActionId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (ACTION_ALIAS_MAP.has(key)) return ACTION_ALIAS_MAP.get(key);
  const compact = key.replace(/[^a-z0-9]/g, '');
  if (ACTION_ALIAS_MAP.has(compact)) return ACTION_ALIAS_MAP.get(compact);
  return 'spawn_sparks';
}

function sanitizeInt(n, fallback = 0, min = -32768, max = 32767) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function sanitizeId(id, idx) {
  const clean = String(id || `rule-${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '');
  return clean || `rule-${idx + 1}`;
}

/**
 * Compile tactile rule chips into clean, executable Kaboom-API micro-JS.
 * @param {Array<object>} ruleChips
 * @returns {string}
 */
export function compileChipsToJs(ruleChips) {
  if (!Array.isArray(ruleChips) || ruleChips.length === 0) {
    return '// BitForge-80 Rule Chips (empty)\n';
  }

  const lines = ['// BitForge-80 Rule Chips (Kaboom Micro-JS)'];
  for (let i = 0; i < ruleChips.length; i++) {
    const raw = ruleChips[i] || {};
    const id = sanitizeId(raw.id, i);
    const trigger = normalizeTriggerId(raw.trigger);
    const action = normalizeActionId(raw.action);
    const trigMeta = RULE_TRIGGERS.find((t) => t.id === trigger);
    const actMeta = RULE_ACTIONS.find((a) => a.id === action);

    const paramA = sanitizeInt(raw.paramA, trigMeta ? trigMeta.defaultParamA : 0);
    const paramB = sanitizeInt(raw.paramB, actMeta ? actMeta.defaultParamB : 0);
    const sfxSlot = sanitizeInt(raw.sfxSlot, 0, 0, 7);

    lines.push(`onVerb("${trigger}", ${paramA}, (ctx) => { // @id:${id}`);
    if (action === 'launch_impulse') {
      lines.push('  const target = ctx.actor || k.get("actor")[0] || k.get("player")[0];');
      lines.push(`  ctx.launchImpulse(target, ${paramB});`);
      lines.push(`  ctx.playSfx(${sfxSlot});`);
    } else if (action === 'shatter_pixels') {
      lines.push('  const target = ctx.target || ctx.actor;');
      lines.push('  if (target) k.destroy(target);');
      lines.push(`  k.emitParticles({ x: ctx.x, y: ctx.y, count: ${paramB}, color: 5, speed: 60 });`);
      lines.push('  k.hitStop(2);');
      lines.push(`  ctx.playSfx(${sfxSlot});`);
    } else if (action === 'bounce_trauma') {
      lines.push('  const target = ctx.actor || k.get("actor")[0] || k.get("player")[0];');
      lines.push(`  ctx.bounce(target, ${paramB});`);
      lines.push(`  k.shake(${(paramB / 100).toFixed(2)});`);
      lines.push(`  ctx.playSfx(${sfxSlot});`);
    } else if (action === 'spawn_sparks') {
      lines.push(`  k.emitParticles({ x: ctx.x, y: ctx.y, count: ${paramB}, color: 7, speed: 52 });`);
      lines.push(`  ctx.playSfx(${sfxSlot});`);
    } else if (action === 'score_plus_1') {
      lines.push(`  ctx.addScore(${paramB});`);
      lines.push(`  ctx.playSfx(${sfxSlot});`);
    } else {
      lines.push(`  ctx.playSfx(${sfxSlot}, ${paramB});`);
    }
    lines.push('});');
  }

  return `${lines.join('\n')}\n`;
}

function extractOnVerbBlocks(jsSource) {
  const blocks = [];
  const headRegex = /onVerb\(\s*["'`]([^"'`]+)["'`]\s*,\s*(-?\d+)\s*,\s*\([^)]*\)\s*=>\s*\{/g;
  let match;
  while ((match = headRegex.exec(jsSource)) !== null) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let pos = bodyStart;
    while (pos < jsSource.length && depth > 0) {
      const ch = jsSource[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }
    if (depth === 0) {
      blocks.push({
        rawTrigger: match[1],
        paramA: match[2],
        body: jsSource.slice(bodyStart, pos - 1),
      });
      headRegex.lastIndex = pos;
    }
  }
  return blocks;
}

/**
 * Parse Kaboom micro-JS back into tactile rule chips.
 * Extracts trigger, paramA, action, paramB, sfxSlot, and id directly from JS statements.
 * @param {string} jsSource
 * @returns {Array<object>}
 */
export function parseJsToChips(jsSource) {
  if (typeof jsSource !== 'string' || !jsSource.trim()) return [];
  const chips = [];

  const blocks = extractOnVerbBlocks(jsSource);
  for (let idx = 0; idx < blocks.length; idx++) {
    const blk = blocks[idx];
    const rawTrigger = blk.rawTrigger;
    const paramA = sanitizeInt(blk.paramA, 0);
    const body = blk.body || '';
    const idMatch = body.match(/@id:([a-zA-Z0-9_-]+)/);
    const id = idMatch ? idMatch[1] : `rule-${idx + 1}`;
    const trigger = normalizeTriggerId(rawTrigger);

    let action = 'spawn_sparks';
    let paramB = 12;
    let sfxSlot = 0;

    const sfxDualMatch = body.match(/ctx\.playSfx\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
    const sfxSingleMatch = body.match(/ctx\.playSfx\(\s*(-?\d+)\s*\)/);

    if (/ctx\.launchImpulse\(/.test(body)) {
      action = 'launch_impulse';
      const m = body.match(/ctx\.launchImpulse\(\s*[^,]+,\s*(-?\d+)\s*\)/);
      paramB = m ? sanitizeInt(m[1], 100) : 100;
    } else if (/k\.destroy\(/.test(body) && /k\.hitStop\(/.test(body)) {
      action = 'shatter_pixels';
      const m = body.match(/count:\s*(-?\d+)/);
      paramB = m ? sanitizeInt(m[1], 16) : 16;
    } else if (/ctx\.bounce\(/.test(body) || /k\.shake\(/.test(body)) {
      action = 'bounce_trauma';
      const mb = body.match(/ctx\.bounce\(\s*[^,]+,\s*(-?\d+)\s*\)/);
      const ms = body.match(/k\.shake\(\s*(-?\d+(?:\.\d+)?)\s*\)/);
      paramB = mb ? sanitizeInt(mb[1], 45) : (ms ? sanitizeInt(Number(ms[1]) * 100, 45) : 45);
    } else if (/ctx\.addScore\(/.test(body)) {
      action = 'score_plus_1';
      const m = body.match(/ctx\.addScore\(\s*(-?\d+)\s*\)/);
      paramB = m ? sanitizeInt(m[1], 1) : 1;
    } else if (/k\.emitParticles\(/.test(body)) {
      action = 'spawn_sparks';
      const m = body.match(/count:\s*(-?\d+)/);
      paramB = m ? sanitizeInt(m[1], 12) : 12;
    } else if (sfxDualMatch) {
      action = 'play_sfx';
      sfxSlot = sanitizeInt(sfxDualMatch[1], 0, 0, 7);
      paramB = sanitizeInt(sfxDualMatch[2], 0);
    }

    if (sfxDualMatch) {
      sfxSlot = sanitizeInt(sfxDualMatch[1], 0, 0, 7);
    } else if (sfxSingleMatch) {
      sfxSlot = sanitizeInt(sfxSingleMatch[1], 0, 0, 7);
    }

    chips.push({
      id,
      trigger,
      paramA,
      action,
      paramB,
      sfxSlot,
    });
  }

  // Fallback parser for hand-authored k.onCollide blocks if no onVerb blocks exist
  if (chips.length === 0) {
    const collideRegex = /k\.onCollide\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]\s*,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/g;
    let cMatch;
    while ((cMatch = collideRegex.exec(jsSource)) !== null) {
      const body = cMatch[3] || '';
      const shakeM = body.match(/k\.shake\(\s*(-?\d+(?:\.\d+)?)\s*\)/);
      const scoreM = body.match(/addScore\(\s*(-?\d+)\s*\)/);
      chips.push({
        id: `rule-${chips.length + 1}`,
        trigger: 'collide_hazard',
        paramA: 0,
        action: scoreM ? 'score_plus_1' : 'bounce_trauma',
        paramB: scoreM ? sanitizeInt(scoreM[1], 1) : (shakeM ? sanitizeInt(Number(shakeM[1]) * 100, 45) : 45),
        sfxSlot: 0,
      });
    }
  }

  return chips;
}

/**
 * Shared verb-event dispatcher for both rule chips and sandboxed micro-JS rules.
 * Matches slingshot releases, tap radii, ribbon slice AABBs, and bezel scrubs cleanly.
 */
export function dispatchVerbEvents(events, k, entries, onMatch) {
  if (!Array.isArray(events) || events.length === 0 || !Array.isArray(entries) || entries.length === 0) return;
  const hasBezelScrub = events.some((e) => e && e.type === 'bezelWheel:scrub');

  for (let eIdx = 0; eIdx < events.length; eIdx++) {
    const evt = events[eIdx];
    if (!evt) continue;

    if (evt.type === 'slingshot:release') {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].trigger === 'slingshot_release') {
          onMatch(entries[i], {
            vx: evt.vx,
            vy: evt.vy,
            power: evt.power,
            x: evt.anchorX,
            y: evt.anchorY,
          });
        }
      }
    } else if (evt.type === 'tapRipple:burst') {
      const allEnts = k.get();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.trigger !== 'tap_entity') continue;
        const radius = Math.max(6, Math.abs(Number(entry.paramA) || 12));
        let hitTarget = null;
        for (let j = 0; j < allEnts.length; j++) {
          const ent = allEnts[j];
          if (!ent.exists() || !ent.pos) continue;
          if (typeof ent.worldArea === 'function') {
            const box = ent.worldArea();
            const cx = box.x + box.width * 0.5;
            const cy = box.y + box.height * 0.5;
            if (Math.hypot(cx - evt.x, cy - evt.y) <= radius + Math.max(box.width, box.height) * 0.5) {
              hitTarget = ent;
              if (!ent.is('player') && !ent.is('actor')) break;
            }
          } else if (Math.hypot(ent.pos.x - evt.x, ent.pos.y - evt.y) <= radius) {
            hitTarget = ent;
            break;
          }
        }
        if (hitTarget) {
          onMatch(entry, {
            target: hitTarget,
            x: hitTarget.pos.x,
            y: hitTarget.pos.y,
          });
        }
      }
    } else if (evt.type === 'ribbonSlice:segment') {
      const allEnts = k.get();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.trigger !== 'slice_hit') continue;
        for (let j = 0; j < allEnts.length; j++) {
          const ent = allEnts[j];
          if (!ent.exists() || typeof ent.worldArea !== 'function') continue;
          if (ent.is('player')) continue;
          if (segmentIntersectsAABB(evt.x0, evt.y0, evt.x1, evt.y1, ent.worldArea())) {
            onMatch(entry, {
              target: ent,
              x: evt.x1,
              y: evt.y1,
            });
          }
        }
      }
    } else if (evt.type === 'bezelWheel:scrub' || (!hasBezelScrub && evt.type === 'bezelWheel:detent')) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].trigger === 'bezel_scrub') {
          onMatch(entries[i], {
            angle: evt.angle,
            delta: evt.delta,
            velocity: evt.velocity,
            detent: evt.detent,
          });
        }
      }
    }
  }
}

export function createRuleContextHelpers(k, hooks = {}) {
  function playSfx(slot, param = 0) {
    const s = sanitizeInt(slot, 0, 0, 7);
    if (typeof hooks.playSfx === 'function') {
      hooks.playSfx(s, param);
    } else if (hooks.dsp && typeof hooks.dsp.playSfxSlot === 'function') {
      hooks.dsp.playSfxSlot(s, param);
    } else if (hooks.bus && typeof hooks.bus.emit === 'function') {
      hooks.bus.emit('foley:sfx', { slot: s, param });
    }
  }

  function addScore(points = 1) {
    const p = sanitizeInt(points, 1);
    if (typeof hooks.onScore === 'function') {
      hooks.onScore(p);
    }
  }

  function launchImpulse(target, paramB = 100, ctx = {}) {
    if (!target) return;
    if (!target.vel) target.vel = { x: 0, y: 0 };
    const scale = (Number.isFinite(paramB) ? paramB : 100) / 100;
    if (Number.isFinite(ctx.vx) && Number.isFinite(ctx.vy)) {
      target.vel.x += ctx.vx * scale;
      target.vel.y += ctx.vy * scale;
    } else {
      target.vel.y -= Math.abs(paramB || 100);
    }
  }

  function bounce(target, paramB = 45) {
    if (!target) return;
    if (!target.vel) target.vel = { x: 0, y: 0 };
    target.vel.x = -target.vel.x * 0.85;
    target.vel.y = -Math.abs(target.vel.y) * 0.85 - Math.max(24, Math.abs(paramB || 45));
  }

  return {
    playSfx,
    addScore,
    launchImpulse,
    bounce,
  };
}

/**
 * Attach compiled rule chips cleanly onto an active kaboom scene.
 * @param {object} k
 * @param {Array<object>} ruleChips
 * @param {object} [hooks]
 */
export function attachRuleChipsToScene(k, ruleChips = [], hooks = {}) {
  const chips = Array.isArray(ruleChips) ? ruleChips : [];
  const helpers = createRuleContextHelpers(k, hooks);
  const subscriptions = [];
  let detached = false;

  function findDefaultActor() {
    if (typeof hooks.getActor === 'function') {
      const a = hooks.getActor();
      if (a && a.exists()) return a;
    }
    return k.get('actor')[0] || k.get('player')[0] || null;
  }

  function executeChipAction(chip, ctx = {}) {
    const action = normalizeActionId(chip.action);
    const paramB = Number(chip.paramB) || 0;
    const sfxSlot = sanitizeInt(chip.sfxSlot, 0, 0, 7);
    const actor = ctx.actor || findDefaultActor();
    const target = ctx.target || null;
    const x = Number.isFinite(ctx.x) ? ctx.x : (target?.pos?.x ?? actor?.pos?.x ?? 64);
    const y = Number.isFinite(ctx.y) ? ctx.y : (target?.pos?.y ?? actor?.pos?.y ?? 64);

    if (action === 'launch_impulse') {
      helpers.launchImpulse(actor, paramB || 100, ctx);
    } else if (action === 'shatter_pixels') {
      if (target && target.exists()) {
        k.destroy(target);
      }
      k.emitParticles({
        x,
        y,
        count: Math.max(1, Math.min(64, paramB || 16)),
        color: [5, 6, 4],
        speed: 60,
      });
      k.hitStop(2);
    } else if (action === 'bounce_trauma') {
      helpers.bounce(actor, paramB || 45);
      k.shake(Math.max(0.05, Math.min(1.5, Math.abs(paramB || 45) / 100)));
      k.hitStop(2);
    } else if (action === 'spawn_sparks') {
      k.emitParticles({
        x,
        y,
        count: Math.max(1, Math.min(64, paramB || 12)),
        color: [7, 4, 10],
        speed: 52,
      });
    } else if (action === 'score_plus_1') {
      helpers.addScore(paramB || 1);
    } else if (action === 'play_sfx') {
      helpers.playSfx(sfxSlot, paramB);
      return;
    }

    if (sfxSlot >= 0) {
      helpers.playSfx(sfxSlot, paramB);
    }
  }

  // Bind collide_hazard chips directly to kernel collision callbacks
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i];
    if (!chip) continue;
    if (normalizeTriggerId(chip.trigger) === 'collide_hazard') {
      const sub1 = k.onCollide('actor', 'hazard', (a, b) => {
        if (detached) return;
        executeChipAction(chip, { actor: a, target: b, x: a.pos?.x, y: a.pos?.y });
      });
      const sub2 = k.onCollide('player', 'hazard', (a, b) => {
        if (detached) return;
        executeChipAction(chip, { actor: a, target: b, x: a.pos?.x, y: a.pos?.y });
      });
      subscriptions.push(sub1, sub2);
    }
  }

  function trigger(triggerName, ctx = {}) {
    if (detached) return;
    const norm = normalizeTriggerId(triggerName);
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      if (!chip) continue;
      if (normalizeTriggerId(chip.trigger) === norm) {
        executeChipAction(chip, ctx);
      }
    }
  }

  const normalizedEntries = chips
    .filter(Boolean)
    .map((chip) => ({
      trigger: normalizeTriggerId(chip.trigger),
      paramA: Number(chip.paramA) || 0,
      chip,
    }));

  function handleVerbEvents(events) {
    if (detached) return;
    dispatchVerbEvents(events, k, normalizedEntries, (entry, ctx) => {
      executeChipAction(entry.chip, {
        ...ctx,
        actor: ctx.actor || findDefaultActor(),
      });
    });
  }

  function detach() {
    detached = true;
    for (let i = 0; i < subscriptions.length; i++) {
      if (subscriptions[i] && typeof subscriptions[i].cancel === 'function') {
        subscriptions[i].cancel();
      }
    }
    subscriptions.length = 0;
  }

  return {
    trigger,
    handleVerbEvents,
    detach,
  };
}
