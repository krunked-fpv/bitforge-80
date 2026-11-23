import { createEmptyCartridgeROM } from '../cart/bitpack-rom.js';
import {
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  renderAutotile8x8,
} from '../studio/autotile-world.js';
import { quantizeRowToFreq } from '../audio/dsp-engine.js';

export const id = 'bezel-orbit';
export const title = 'BEZEL ORBIT';

const FIXED_TIMESTAMP = 1735689600000;
const WORLD_SIZE = 16;
const CX = 64;
const CY = 64;
const SHIELD_RADIUS = 26;
const SHIELD_HALF_ARC = 0.64;

function parseSprite8(rows) {
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const row = rows[y] || '';
    for (let x = 0; x < 8; x++) {
      out[y * 8 + x] = parseInt(row[x] || '0', 16) || 0;
    }
  }
  return out;
}

function buildSteps(notes) {
  const steps = new Uint16Array(16);
  for (let i = 0; i < 16; i++) {
    const row = notes[i];
    if (row >= 0) steps[i] = 1 << (row & 15);
  }
  return steps;
}

function buildArenaWorld() {
  const total = WORLD_SIZE * WORLD_SIZE;
  const bgLayer = new Uint8Array(total);
  const mainLayer = new Uint8Array(total);
  const fgLayer = new Uint8Array(total);
  const collision = new Uint8Array(total);

  const corners = [
    [0, 0], [1, 0], [0, 1],
    [15, 0], [14, 0], [15, 1],
    [0, 15], [1, 15], [0, 14],
    [15, 15], [14, 15], [15, 14],
  ];
  for (const [cx, cy] of corners) {
    const idx = cy * WORLD_SIZE + cx;
    mainLayer[idx] = (cx === 0 || cx === 15) && (cy === 0 || cy === 15)
      ? TERRAIN_TYPES.CRYSTAL
      : TERRAIN_TYPES.CLIFF;
    collision[idx] = COLLISION_FLAGS.SOLID;
  }

  return { width: WORLD_SIZE, height: WORLD_SIZE, bgLayer, mainLayer, fgLayer, collision };
}

export function createROM() {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));

  // Slot 0: Pulsing orbital reactor core (2 frames)
  sprites[0] = {
    size: 8,
    frames: [
      parseSprite8([
        '00177100',
        '01644610',
        '164aa461',
        '17a44a71',
        '17a44a71',
        '164aa461',
        '01677610',
        '00177100',
      ]),
      parseSprite8([
        '001aa100',
        '01744710',
        '17477471',
        '1a7447a1',
        '1a7447a1',
        '17477471',
        '017aa710',
        '001aa100',
      ]),
    ],
  };

  // Slot 1: Neon pixel comet
  sprites[1] = {
    size: 8,
    frames: [
      parseSprite8([
        '00000000',
        '00055000',
        '00566500',
        '05674650',
        '05647650',
        '00566500',
        '00055000',
        '00000000',
      ]),
      parseSprite8([
        '00000000',
        '00066000',
        '00674600',
        '06744760',
        '06444660',
        '00676500',
        '00055000',
        '00000000',
      ]),
    ],
  };

  // Slot 2: Bonus star comet
  sprites[2] = {
    size: 8,
    frames: [
      parseSprite8([
        '00070000',
        '00747000',
        '074a4700',
        '74a4a470',
        '074a4700',
        '00747000',
        '00070000',
        '00000000',
      ]),
    ],
  };

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const p = (i / 32) * Math.PI * 2;
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(7.5 + 5.5 * Math.sin(p) + 2.0 * Math.cos(p * 4))));
  }

  return createEmptyCartridgeROM({
    meta: {
      id,
      title,
      author: 'BITFORGE-80',
      paletteId: 'amber',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'bezelWheel',
      dropShadow1px: true,
      crtOptics: true,
      updatedAt: FIXED_TIMESTAMP,
    },
    sprites,
    world: buildArenaWorld(),
    audio: {
      bpm: 128,
      scaleId: 'dorian',
      channels: [
        { steps: buildSteps([4, -1, 7, -1, 9, -1, 11, -1, 9, -1, 7, -1, 6, -1, 7, -1]), dutyOrTimbre: 64, volume: 62 },
        { steps: buildSteps([0, -1, 0, -1, 2, -1, 2, -1, 3, -1, 3, -1, 2, -1, 0, -1]), dutyOrTimbre: 80, volume: 78 },
        { steps: buildSteps([-1, -1, 13, -1, -1, -1, 13, -1, -1, -1, 13, -1, -1, 13, -1, 13]), dutyOrTimbre: 170, volume: 32 },
        { steps: buildSteps([0, -1, -1, -1, -1, -1, -1, -1, 5, -1, -1, -1, -1, -1, -1, -1]), dutyOrTimbre: 140, volume: 48 },
      ],
      wavetable32,
      sfxPatches: [
        { archetype: 0, x: 185, y: 120 }, // 0: Arpeggio deflect coin
        { archetype: 3, x: 140, y: 95 },  // 1: Plasma parry
        { archetype: 2, x: 110, y: 90 },  // 2: Rotary click
        { archetype: 7, x: 210, y: 140 }, // 3: Graze spark chime
        { archetype: 5, x: 90, y: 180 },  // 4: Core hit shatter
        { archetype: 4, x: 165, y: 130 }, // 5: Bonus comet
        { archetype: 6, x: 150, y: 150 }, // 6: Shield pulse
        { archetype: 7, x: 195, y: 128 }, // 7: Wave surge
      ],
    },
    logic: {
      presetGameId: id,
      ruleChips: [
        { id: 'c1', trigger: 'Collide Hazard', paramA: 0, action: 'Bounce + Trauma', paramB: 35, sfxSlot: 4 },
      ],
      customJs: '',
    },
  });
}

export const createCartridgeROM = createROM;

function wrapAngle(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

let activeOrbitMount = 0;

export function mountGame(k, cart, helpers = {}) {
  const myMountId = ++activeOrbitMount;
  const getLiveCart = () => (typeof helpers.getCart === 'function' ? helpers.getCart() : null) || cart;
  const playSfx = (slot, param = 0) => {
    if (typeof helpers.playSfx === 'function') helpers.playSfx(slot, param);
  };

  k.scene('bezel-orbit', () => {
    const initBezel = helpers.touchVerbs ? helpers.touchVerbs.getState().bezelWheel : null;
    let lastBezelAngle = initBezel ? initBezel.angle : 0;
    let glassOffset = 0;
    let shieldAngle = lastBezelAngle;
    let prevShieldAngle = shieldAngle;

    let scoreTotal = 0;
    let grazeMult = 1;
    let grazeCharge = 0;
    let arpStep = 0;
    let coreFlash = 0;
    let spawnClock = 0.25;
    let waveLevel = 1;
    let rngState = 0x9e3779b9;
    const tileScratch = new Uint8Array(64);
    const comets = [];

    function nextRand() {
      rngState = (rngState + 0x6d2b79f5) >>> 0;
      let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // Starfield dust coordinates
    const stars = Array.from({ length: 24 }, () => ({
      x: Math.floor(nextRand() * 124) + 2,
      y: Math.floor(nextRand() * 124) + 2,
      phase: nextRand() * Math.PI * 2,
    }));

    // Direct glass ring drag fallback on canvas
    let glassPointerActive = false;
    let cleanups = [];
    const canvas = typeof document !== 'undefined' ? document.getElementById('bf-screen') : null;
    if (canvas && typeof canvas.addEventListener === 'function') {
      const toLogical = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const w = rect.width || 128;
        const h = rect.height || 128;
        return {
          lx: ((ev.clientX - rect.left) / w) * 128,
          ly: ((ev.clientY - rect.top) / h) * 128,
        };
      };
      const onDown = (ev) => {
        if (myMountId !== activeOrbitMount) return;
        const { lx, ly } = toLogical(ev);
        if (Math.hypot(lx - CX, ly - CY) >= 8) {
          glassPointerActive = true;
          const targetAngle = Math.atan2(ly - CY, lx - CX);
          const diff = wrapAngle(targetAngle - shieldAngle);
          shieldAngle += diff;
          glassOffset = shieldAngle - lastBezelAngle;
          if (helpers.touchVerbs && typeof helpers.touchVerbs.setBezelInput === 'function') {
            helpers.touchVerbs.setBezelInput(shieldAngle, diff, diff * 20);
            lastBezelAngle = helpers.touchVerbs.getState().bezelWheel.angle;
            glassOffset = shieldAngle - lastBezelAngle;
          }
        }
      };
      const onMove = (ev) => {
        if (!glassPointerActive || myMountId !== activeOrbitMount) return;
        const { lx, ly } = toLogical(ev);
        const targetAngle = Math.atan2(ly - CY, lx - CX);
        const diff = wrapAngle(targetAngle - shieldAngle);
        shieldAngle += diff;
        if (helpers.touchVerbs && typeof helpers.touchVerbs.setBezelInput === 'function') {
          helpers.touchVerbs.setBezelInput(shieldAngle, diff, diff * 30);
          lastBezelAngle = helpers.touchVerbs.getState().bezelWheel.angle;
          glassOffset = shieldAngle - lastBezelAngle;
        } else {
          glassOffset = shieldAngle - lastBezelAngle;
        }
      };
      const onUp = () => { glassPointerActive = false; };

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      cleanups.push(() => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
      });
    }

    if (helpers.bus && typeof helpers.bus.on === 'function') {
      let ignoreInitialBoot = true;
      Promise.resolve().then(() => { ignoreInitialBoot = false; });
      const expectedId = cart?.meta?.id || id;
      const cleanupAll = () => {
        for (const fn of cleanups) fn();
        cleanups.length = 0;
      };
      const unsubBoot = helpers.bus.on('cart:boot', (payload) => {
        if (myMountId !== activeOrbitMount) {
          cleanupAll();
          return;
        }
        if (ignoreInitialBoot && (!payload || payload.id === expectedId)) {
          ignoreInitialBoot = false;
          return;
        }
        cleanupAll();
      });
      if (typeof unsubBoot === 'function') cleanups.push(unsubBoot);
    }

    function spawnComet() {
      const ang = nextRand() * Math.PI * 2;
      const dist = 76;
      const sx = CX + Math.cos(ang) * dist;
      const sy = CY + Math.sin(ang) * dist;
      const aimOffset = (nextRand() - 0.5) * 0.24;
      const speed = 26 + Math.min(28, waveLevel * 2.5) + nextRand() * 12;
      const isBonus = nextRand() < 0.22;
      comets.push({
        x: sx,
        y: sy,
        vx: -Math.cos(ang + aimOffset) * speed,
        vy: -Math.sin(ang + aimOffset) * speed,
        isBonus,
        deflected: false,
        grazed: false,
        trail: [],
      });
    }

    // Seed two initial incoming comets so action starts immediately
    spawnComet();

    function playArpeggioBurst(bonus) {
      const row = 3 + ((arpStep * 2) % 12);
      const freq = quantizeRowToFreq('dorian', row, 4);
      if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
        helpers.dsp.playNote(bonus ? 3 : 0, freq, 0.16, 0.7, { dutyOrTimbre: 80 });
      }
      playSfx(bonus ? 5 : 0, { pitchScale: freq / 520, velocity: 0.78 });
      arpStep++;
    }

    k.onUpdate((dt) => {
      if (coreFlash > 0) coreFlash = Math.max(0, coreFlash - dt);

      const bezel = helpers.touchVerbs ? helpers.touchVerbs.getState().bezelWheel : null;
      if (bezel && bezel.angle !== lastBezelAngle) {
        lastBezelAngle = bezel.angle;
        shieldAngle = bezel.angle + glassOffset;
      }
      prevShieldAngle = prevShieldAngle * 0.65 + shieldAngle * 0.35;

      spawnClock -= dt;
      if (spawnClock <= 0 && comets.length < 10) {
        spawnComet();
        spawnClock = Math.max(0.42, 1.05 - waveLevel * 0.05);
      }

      for (let i = comets.length - 1; i >= 0; i--) {
        const c = comets[i];
        c.trail.push({ x: c.x, y: c.y });
        if (c.trail.length > 6) c.trail.shift();

        c.x += c.vx * dt;
        c.y += c.vy * dt;

        const dx = c.x - CX;
        const dy = c.y - CY;
        const dist = Math.hypot(dx, dy);
        const cAng = Math.atan2(dy, dx);
        const angDiff = Math.abs(wrapAngle(cAng - shieldAngle));

        if (!c.deflected) {
          // Shield arc deflection
          if (Math.abs(dist - SHIELD_RADIUS) <= 4.5 && angDiff <= SHIELD_HALF_ARC + 0.12) {
            c.deflected = true;
            const nLen = Math.max(0.001, dist);
            const nx = dx / nLen;
            const ny = dy / nLen;
            const spd = Math.hypot(c.vx, c.vy) * 1.65;
            c.vx = nx * spd;
            c.vy = ny * spd;

            const pts = (c.isBonus ? 25 : 10) * grazeMult;
            scoreTotal += pts;
            if (typeof helpers.addScore === 'function') helpers.addScore(pts);
            if (scoreTotal >= waveLevel * 120) waveLevel++;

            k.hitStop(c.isBonus ? 2 : 1);
            k.shake(0.18);
            k.emitParticles({
              x: c.x,
              y: c.y,
              count: c.isBonus ? 18 : 12,
              color: c.isBonus ? [7, 4, 10] : [10, 4, 7, 13],
              speed: [35, 85],
              gravity: 0,
              life: 0.28,
            });
            playArpeggioBurst(c.isBonus);
            continue;
          }

          // Graze tip multiplier charge
          if (!c.grazed && dist <= SHIELD_RADIUS + 8 && dist >= SHIELD_RADIUS - 7 &&
              angDiff > SHIELD_HALF_ARC + 0.12 && angDiff <= SHIELD_HALF_ARC + 0.58) {
            c.grazed = true;
            grazeCharge++;
            if (grazeCharge >= 2) {
              grazeCharge = 0;
              grazeMult = Math.min(8, grazeMult + 1);
            }
            const gPts = 5 * grazeMult;
            scoreTotal += gPts;
            if (typeof helpers.addScore === 'function') helpers.addScore(gPts);
            k.emitParticles({ x: c.x, y: c.y, count: 6, color: [7, 4], speed: 40, gravity: 0, life: 0.18 });
            playSfx(3, grazeMult);
          }

          // Core collision
          if (dist <= 7.5) {
            comets.splice(i, 1);
            grazeMult = 1;
            grazeCharge = 0;
            coreFlash = 0.35;
            k.hitStop(2);
            k.shake(0.62);
            k.emitParticles({ x: CX, y: CY, count: 20, color: [5, 6, 4], speed: [40, 95], gravity: 0, life: 0.35 });
            playSfx(4, 1);
            continue;
          }
        } else {
          // Deflected comet can shatter another incoming comet mid-flight
          for (let j = i - 1; j >= 0; j--) {
            const other = comets[j];
            if (other.deflected) continue;
            if (Math.hypot(c.x - other.x, c.y - other.y) <= 7) {
              comets.splice(j, 1);
              if (j < i) i--;
              scoreTotal += 15 * grazeMult;
              if (typeof helpers.addScore === 'function') helpers.addScore(15 * grazeMult);
              k.emitParticles({ x: other.x, y: other.y, count: 14, color: [7, 4, 13], speed: 70, gravity: 0, life: 0.3 });
              playArpeggioBurst(true);
            }
          }
        }

        if (c.x < -12 || c.x > 140 || c.y < -12 || c.y > 140) {
          comets.splice(i, 1);
        }
      }
    });

    k.onDraw(() => {
      const live = getLiveCart();
      const cam = k.getCameraOffset();
      const tick = k.frame();

      // Twinkling orbital starfield
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const blink = Math.sin(k.time() * 2.2 + s.phase);
        if (blink > -0.2) {
          k.drawPixel(s.x + cam.x, s.y + cam.y, blink > 0.6 ? 3 : 2, 0);
        }
      }

      // Orbit guide ring (dotted 1px)
      for (let step = 0; step < 36; step++) {
        const a = (step / 36) * Math.PI * 2;
        k.drawPixel(
          Math.round(CX + Math.cos(a) * SHIELD_RADIUS + cam.x),
          Math.round(CY + Math.sin(a) * SHIELD_RADIUS + cam.y),
          2,
          1
        );
      }

      // Live autotiled corner beacons from world
      const world = live?.world;
      if (world && world.mainLayer) {
        const w = world.width === 32 ? 32 : 16;
        const h = world.height === 32 ? 32 : 16;
        for (let ty = 0; ty < h; ty++) {
          for (let tx = 0; tx < w; tx++) {
            const tid = world.mainLayer[ty * w + tx];
            if (!tid) continue;
            const pxBase = tx * 8 + cam.x;
            const pyBase = ty * 8 + cam.y;
            if (tid >= 8 && live.sprites?.[tid - 8]) {
              k.drawSpriteSlot(tid - 8, pxBase, pyBase, { sprites: live.sprites, layer: 2 });
            } else {
              const mask = computeAutotileMask(world.mainLayer, w, h, tx, ty);
              renderAutotile8x8(tid, resolveAutotileIndex(mask), tick, tileScratch);
              for (let py = 0; py < 8; py++) {
                for (let px = 0; px < 8; px++) {
                  const col = tileScratch[py * 8 + px];
                  if (col > 0) k.drawPixel(pxBase + px, pyBase + py, col, 2);
                }
              }
            }
          }
        }
      }

      // Pulsing Reactor Core
      const pulseFrame = ((tick >> 4) & 1);
      const slotIdx = live?.meta?.coverSpriteIdx ?? 0;
      k.drawSpriteSlot(slotIdx, CX - 4 + cam.x, CY - 4 + cam.y, {
        sprites: live?.sprites,
        frame: pulseFrame,
        layer: 2,
      });
      if (coreFlash > 0) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          k.drawPixel(CX + Math.cos(a) * 8 + cam.x, CY + Math.sin(a) * 8 + cam.y, 5, 2);
        }
      }

      // Curved plasma shield + rotary motion afterimage
      const angVel = wrapAngle(shieldAngle - prevShieldAngle);
      for (let a = -SHIELD_HALF_ARC; a <= SHIELD_HALF_ARC; a += 0.045) {
        const ang = shieldAngle + a;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const isTip = Math.abs(a) > SHIELD_HALF_ARC - 0.14;
        for (let dr = -1; dr <= 1; dr++) {
          const px = Math.round(CX + cosA * (SHIELD_RADIUS + dr) + cam.x);
          const py = Math.round(CY + sinA * (SHIELD_RADIUS + dr) + cam.y);
          const col = dr === 0 ? (isTip ? 7 : 4) : 10;
          k.drawPixel(px, py, col, 2);
        }
        if (Math.abs(angVel) > 0.04) {
          const ghostAng = ang - Math.sign(angVel) * 0.18;
          k.drawPixel(
            Math.round(CX + Math.cos(ghostAng) * SHIELD_RADIUS + cam.x),
            Math.round(CY + Math.sin(ghostAng) * SHIELD_RADIUS + cam.y),
            11,
            1
          );
        }
      }

      // Incoming & deflected comets
      for (let i = 0; i < comets.length; i++) {
        const c = comets[i];
        for (let t = 0; t < c.trail.length; t++) {
          const pt = c.trail[t];
          const tCol = c.deflected ? 10 : (c.isBonus ? 7 : (t > 3 ? 6 : 5));
          k.drawPixel(Math.round(pt.x + cam.x), Math.round(pt.y + cam.y), tCol, 2);
        }
        const spIdx = c.isBonus ? 2 : 1;
        const sp = live?.sprites?.[spIdx];
        if (sp && sp.frames?.[0]?.some((v) => v > 0)) {
          k.drawSpriteSlot(spIdx, Math.round(c.x - 4 + cam.x), Math.round(c.y - 4 + cam.y), {
            sprites: live.sprites,
            frame: ((tick >> 3) & 1),
            layer: 2,
          });
        } else {
          k.drawPixel(Math.round(c.x + cam.x), Math.round(c.y + cam.y), c.isBonus ? 7 : 5, 2);
        }
      }

      k.drawText5x7(`SCR ${scoreTotal}`, 4, 3, 4, { shadow: 1 });
      k.drawText5x7(`x${grazeMult}`, 124, 3, grazeMult > 1 ? 7 : 15, { align: 'right', shadow: 1 });
    });
  });

  k.go('bezel-orbit');
}
