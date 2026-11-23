import { createEmptyCartridgeROM } from '../cart/bitpack-rom.js';
import {
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  renderAutotile8x8,
} from '../studio/autotile-world.js';
import { segmentIntersectsAABB } from '../runtime/touch-verbs.js';
import { quantizeRowToFreq } from '../audio/dsp-engine.js';

export const id = 'chroma-chisel';
export const title = 'CHROMA CHISEL';

const FIXED_TIMESTAMP = 1735689600000;
const WORLD_SIZE = 16;

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

function buildGeodeWorld() {
  const total = WORLD_SIZE * WORLD_SIZE;
  const bgLayer = new Uint8Array(total);
  const mainLayer = new Uint8Array(total);
  const fgLayer = new Uint8Array(total);
  const collision = new Uint8Array(total);

  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const idx = y * WORLD_SIZE + x;
      const border = x === 0 || y === 0 || x === WORLD_SIZE - 1 || y === WORLD_SIZE - 1;
      if (border) {
        mainLayer[idx] = TERRAIN_TYPES.CLIFF;
        collision[idx] = COLLISION_FLAGS.SOLID;
      } else if (x === 1 || x === 14 || y === 1 || y === 14) {
        bgLayer[idx] = TERRAIN_TYPES.STONE;
      }
    }
  }

  // Crystal cavern pockets on floor
  const floorCrystals = [[3, 14], [4, 14], [11, 14], [12, 14]];
  for (const [cx, cy] of floorCrystals) {
    const idx = cy * WORLD_SIZE + cx;
    mainLayer[idx] = TERRAIN_TYPES.CRYSTAL;
    collision[idx] = COLLISION_FLAGS.BOUNCE;
  }

  return { width: WORLD_SIZE, height: WORLD_SIZE, bgLayer, mainLayer, fgLayer, collision };
}

export function createROM() {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));

  // Slot 0: Faceted rainbow crystal prism (2 frames)
  sprites[0] = {
    size: 8,
    frames: [
      parseSprite8([
        '00014000',
        '0014a100',
        '014aac10',
        '14aacc51',
        '1accc5d1',
        '01cc5d10',
        '0015d100',
        '00011000',
      ]),
      parseSprite8([
        '00044000',
        '001a4100',
        '01aa4c10',
        '1aa4c551',
        '1ac5dd51',
        '01c5d510',
        '001d5100',
        '00011000',
      ]),
    ],
  };

  // Slot 1: Crystal shard bead
  sprites[1] = {
    size: 8,
    frames: [
      parseSprite8([
        '00000000',
        '00074000',
        '0074a700',
        '074aa670',
        '007a6700',
        '00077000',
        '00000000',
        '00000000',
      ]),
    ],
  };

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const p = (i / 32) * Math.PI * 2;
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(7.5 + 5.6 * Math.sin(p) + 1.8 * Math.sin(p * 5))));
  }

  return createEmptyCartridgeROM({
    meta: {
      id,
      title,
      author: 'BITFORGE-80',
      paletteId: 'frost80',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'ribbonSlice',
      dropShadow1px: true,
      crtOptics: true,
      updatedAt: FIXED_TIMESTAMP,
    },
    sprites,
    world: buildGeodeWorld(),
    audio: {
      bpm: 112,
      scaleId: 'lydian',
      channels: [
        { steps: buildSteps([7, -1, 9, -1, 11, -1, 14, -1, 11, -1, 9, -1, 7, -1, 6, -1]), dutyOrTimbre: 112, volume: 58 },
        { steps: buildSteps([0, -1, -1, -1, 4, -1, -1, -1, 2, -1, -1, -1, 4, -1, -1, -1]), dutyOrTimbre: 68, volume: 68 },
        { steps: buildSteps([-1, -1, 14, -1, -1, -1, 14, -1, -1, -1, 14, -1, -1, 14, -1, -1]), dutyOrTimbre: 185, volume: 26 },
        { steps: buildSteps([4, -1, -1, -1, -1, -1, -1, -1, 8, -1, -1, -1, -1, -1, -1, -1]), dutyOrTimbre: 150, volume: 46 },
      ],
      wavetable32,
      sfxPatches: [
        { archetype: 7, x: 195, y: 120 }, // 0: Lydian crystal ping
        { archetype: 5, x: 180, y: 155 }, // 1: Geode shatter
        { archetype: 2, x: 115, y: 80 },  // 2: Chisel tap
        { archetype: 0, x: 210, y: 135 }, // 3: Bead avalanche sparkle
        { archetype: 5, x: 230, y: 180 }, // 4: Fault line rupture
        { archetype: 5, x: 170, y: 140 }, // 5: Strata cleave
        { archetype: 6, x: 165, y: 175 }, // 6: Deep geode bloom
        { archetype: 7, x: 225, y: 150 }, // 7: Cascading chime
      ],
    },
    logic: {
      presetGameId: id,
      ruleChips: [
        { id: 'c1', trigger: 'Slice Hit', paramA: 1, action: 'Spawn Sparks', paramB: 8, sfxSlot: 5 },
      ],
      customJs: '',
    },
  });
}

export const createCartridgeROM = createROM;

function pointToSegmentDist(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-6) return Math.hypot(px - x0, py - y0);
  const t = Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / lenSq));
  return Math.hypot(px - (x0 + vx * t), py - (y0 + vy * t));
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const ccw = (p1x, p1y, p2x, p2y, p3x, p3y) =>
    (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
  return ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);
}

export function mountGame(k, cart, helpers = {}) {
  const getLiveCart = () => (typeof helpers.getCart === 'function' ? helpers.getCart() : null) || cart;
  const playSfx = (slot, param = 0) => {
    if (typeof helpers.playSfx === 'function') helpers.playSfx(slot, param);
  };

  k.scene('chroma-chisel', () => {
    let strataDepth = 1;
    let scoreTotal = 0;
    let chimeStep = 0;
    let beadSoundCooldown = 0;
    let prevSliceActive = false;
    let prevLastSegment = null;
    let prevTapObj = helpers.touchVerbs ? helpers.touchVerbs.getState().tapRipple.lastTap : null;
    let sliceStartPos = null;
    let sliceMaxTravel = 0;
    let prevTrailAge = Infinity;
    let tapHandledForTrail = false;
    let rngState = 0x517cc1b7;

    const crystals = [];
    const faults = [];
    const beads = [];
    const shockRings = [];
    const tileScratch = new Uint8Array(64);

    function nextRand() {
      rngState = (rngState + 0x6d2b79f5) >>> 0;
      let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function playLydianNote(stepOffset, velocity = 0.65) {
      const row = 3 + ((chimeStep + stepOffset) % 12);
      const freq = quantizeRowToFreq('lydian', row, 4);
      if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
        helpers.dsp.playNote(1, freq, 0.24, velocity, { dutyOrTimbre: 90 });
      }
      playSfx(7, { pitchScale: freq / 660, velocity });
      chimeStep = (chimeStep + 1) % 14;
    }

    function spawnGeodeStrata(depth) {
      crystals.length = 0;
      faults.length = 0;
      k.destroyAll('crystal');

      const strataColors = [
        [5, 6, 4],
        [7, 15, 4],
        [8, 9, 4],
        [10, 11, 15],
        [12, 13, 4],
      ];

      // Build arched crystal clusters in geode chamber
      const cols = 6;
      const rows = 5;
      for (let r = 0; r < rows; r++) {
        const pal = strataColors[(r + depth) % strataColors.length];
        for (let c = 0; c < cols; c++) {
          const distCenter = Math.abs(c - 2.5) + Math.abs(r - 2);
          if (distCenter > 3.6 && ((r + c + depth) & 1) === 0) continue;

          const x = 22 + c * 14 + ((r & 1) ? 3 : 0);
          const y = 20 + r * 14;
          const w = 11;
          const h = 11;
          const faultGroup = (r + Math.floor(c / 2)) % 3;

          const ent = k.add([
            k.pos(x, y),
            k.area({ width: w, height: h }),
            'crystal',
          ]);

          crystals.push({
            ent,
            x,
            y,
            w,
            h,
            baseCol: pal[0],
            hiCol: pal[1],
            glintCol: pal[2],
            faultGroup,
            stratum: r,
            shattered: false,
          });
        }
      }

      // 3 glowing fault lines running across strata
      faults.push(
        { x0: 20, y0: 36, x1: 106, y1: 28, faultGroup: 0, triggered: false },
        { x0: 24, y0: 54, x1: 104, y1: 68, faultGroup: 1, triggered: false },
        { x0: 30, y0: 84, x1: 98, y1: 42, faultGroup: 2, triggered: false }
      );
    }

    spawnGeodeStrata(strataDepth);

    function spawnBeadAvalanche(cx, cy, colorA, colorB, count) {
      for (let i = 0; i < count && beads.length < 180; i++) {
        const ang = nextRand() * Math.PI * 2;
        const spd = 20 + nextRand() * 65;
        beads.push({
          x: cx + (nextRand() - 0.5) * 6,
          y: cy + (nextRand() - 0.5) * 6,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 25,
          col: (i & 1) ? colorA : colorB,
          size: (i % 3) === 0 ? 2 : 1,
          bounces: 0,
          life: 2.2 + nextRand() * 1.1,
        });
      }
    }

    function shatterCrystal(c, hitForce = 1) {
      if (c.shattered) return;
      c.shattered = true;
      if (c.ent && c.ent.exists()) k.destroy(c.ent);

      const cx = c.x + c.w * 0.5;
      const cy = c.y + c.h * 0.5;
      const pts = 15 * hitForce;
      scoreTotal += pts;
      if (typeof helpers.addScore === 'function') helpers.addScore(pts);

      k.hitStop(2);
      k.shake(Math.min(0.85, 0.24 + hitForce * 0.08));
      k.emitParticles({
        x: cx,
        y: cy,
        count: 14,
        color: [c.baseCol, c.hiCol, c.glintCol, 4],
        speed: [35, 90],
        gravity: 110,
        life: 0.38,
      });
      spawnBeadAvalanche(cx, cy, c.baseCol, c.hiCol, 7);
      playLydianNote(c.stratum + c.faultGroup, 0.65);
    }

    function triggerFaultLine(fault) {
      if (fault.triggered) return;
      fault.triggered = true;
      let chain = 0;
      for (let i = 0; i < crystals.length; i++) {
        const c = crystals[i];
        if (!c.shattered && c.faultGroup === fault.faultGroup) {
          chain++;
          shatterCrystal(c, chain);
        }
      }
      playSfx(4, 1);
      k.shake(0.58);
    }

    function applyTapShockwave(tx, ty) {
      shockRings.push({ x: tx, y: ty, radius: 1, maxRadius: 20, life: 0.26, maxLife: 0.26 });
      let hitAny = false;
      for (let i = 0; i < faults.length; i++) {
        const f = faults[i];
        if (f.triggered) continue;
        if (pointToSegmentDist(tx, ty, f.x0, f.y0, f.x1, f.y1) <= 12) {
          triggerFaultLine(f);
          hitAny = true;
        }
      }
      for (let i = 0; i < crystals.length; i++) {
        const c = crystals[i];
        if (c.shattered) continue;
        if (Math.hypot(c.x + c.w * 0.5 - tx, c.y + c.h * 0.5 - ty) <= 14) {
          shatterCrystal(c, 1);
          hitAny = true;
        }
      }
      if (!hitAny) playSfx(2, 0.6);
    }

    k.onUpdate((dt) => {
      if (beadSoundCooldown > 0) beadSoundCooldown = Math.max(0, beadSoundCooldown - dt);

      const state = helpers.touchVerbs ? helpers.touchVerbs.getState() : null;
      if (state) {
        // 1. TapRipple support if active or emitted
        if (state.tapRipple?.lastTap && state.tapRipple.lastTap !== prevTapObj) {
          prevTapObj = state.tapRipple.lastTap;
          applyTapShockwave(state.tapRipple.lastTap.x, state.tapRipple.lastTap.y);
        }

        // 2. RibbonSlice segments & quick-tap chisel detection (including single-frame down+up taps)
        const rib = state.ribbonSlice;
        if (rib) {
          const trail = rib.trail || [];
          const newest = trail.length > 0 ? trail[trail.length - 1] : null;
          if (!newest) {
            tapHandledForTrail = false;
            prevTrailAge = Infinity;
          } else if (newest.age < prevTrailAge - 0.001) {
            tapHandledForTrail = false;
          }

          if (rib.active) {
            if (!prevSliceActive) {
              sliceStartPos = trail.length > 0 ? { x: trail[0].x, y: trail[0].y } : null;
              sliceMaxTravel = 0;
              tapHandledForTrail = false;
            }
            if (sliceStartPos && newest) {
              for (let t = 0; t < trail.length; t++) {
                sliceMaxTravel = Math.max(sliceMaxTravel, Math.hypot(trail[t].x - sliceStartPos.x, trail[t].y - sliceStartPos.y));
              }
            }
          } else if (prevSliceActive) {
            if (sliceStartPos && sliceMaxTravel < 4 && !tapHandledForTrail) {
              applyTapShockwave(sliceStartPos.x, sliceStartPos.y);
              tapHandledForTrail = true;
            }
            sliceStartPos = null;
          } else if (!tapHandledForTrail && trail.length > 0 && newest && newest.age < 0.05) {
            let maxDist = 0;
            const origin = trail[0];
            for (let t = 1; t < trail.length; t++) {
              maxDist = Math.max(maxDist, Math.hypot(trail[t].x - origin.x, trail[t].y - origin.y));
            }
            if (maxDist < 4) {
              applyTapShockwave(origin.x, origin.y);
              tapHandledForTrail = true;
            }
          }

          prevTrailAge = newest ? newest.age : Infinity;
          prevSliceActive = rib.active;

          if (rib.lastSegment && rib.lastSegment !== prevLastSegment) {
            prevLastSegment = rib.lastSegment;
            const segs = [];
            for (let t = 1; t < rib.trail.length; t++) {
              if (rib.trail[t].age <= 0.04) {
                segs.push({
                  x0: rib.trail[t - 1].x,
                  y0: rib.trail[t - 1].y,
                  x1: rib.trail[t].x,
                  y1: rib.trail[t].y,
                });
              }
            }
            if (segs.length === 0) segs.push(rib.lastSegment);

            let slicedCount = 0;
            if (helpers.touchVerbs && typeof helpers.touchVerbs.cleaveBoxes === 'function') {
              const activeBoxes = crystals.filter((c) => !c.shattered);
              const hits = helpers.touchVerbs.cleaveBoxes(activeBoxes);
              for (let h = 0; h < hits.length; h++) {
                const c = hits[h].box;
                if (!c.shattered) {
                  slicedCount++;
                  shatterCrystal(c, slicedCount);
                }
              }
            }

            for (let s = 0; s < segs.length; s++) {
              const seg = segs[s];
              for (let i = 0; i < crystals.length; i++) {
                const c = crystals[i];
                if (c.shattered) continue;
                if (segmentIntersectsAABB(seg.x0, seg.y0, seg.x1, seg.y1, { x: c.x, y: c.y, width: c.w, height: c.h })) {
                  slicedCount++;
                  shatterCrystal(c, slicedCount);
                }
              }
              for (let i = 0; i < faults.length; i++) {
                const f = faults[i];
                if (!f.triggered && segmentsIntersect(seg.x0, seg.y0, seg.x1, seg.y1, f.x0, f.y0, f.x1, f.y1)) {
                  triggerFaultLine(f);
                }
              }
            }
            if (slicedCount > 0) playSfx(1, slicedCount);
          }
        }
      }

      // Update expanding chisel shockwave rings
      for (let i = shockRings.length - 1; i >= 0; i--) {
        const sr = shockRings[i];
        sr.life -= dt;
        sr.radius = 1 + (1 - Math.max(0, sr.life / sr.maxLife)) * (sr.maxRadius - 1);
        if (sr.life <= 0) shockRings.splice(i, 1);
      }

      // Update cascading crystal beads
      for (let i = beads.length - 1; i >= 0; i--) {
        const b = beads[i];
        b.life -= dt;
        if (b.life <= 0) {
          beads.splice(i, 1);
          continue;
        }
        b.vy += 225 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.x < 9) { b.x = 9; b.vx = Math.abs(b.vx) * 0.72; }
        if (b.x > 118) { b.x = 118; b.vx = -Math.abs(b.vx) * 0.72; }
        if (b.y > 117) {
          b.y = 117;
          if (Math.abs(b.vy) > 30) {
            b.vy = -Math.abs(b.vy) * 0.56;
            b.vx *= 0.85;
            b.bounces++;
            if (b.bounces <= 2 && beadSoundCooldown <= 0) {
              beadSoundCooldown = 0.055;
              const row = 5 + ((Math.floor(b.x / 12) + b.bounces) % 10);
              const freq = quantizeRowToFreq('lydian', row, 4);
              if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
                helpers.dsp.playNote(1, freq, 0.11, 0.34, { dutyOrTimbre: 100 });
              }
              playSfx(3, { pitchScale: freq / 660, velocity: 0.32 });
            }
          } else {
            b.vy = 0;
            b.vx *= 0.82;
          }
        }
      }

      // Regenerate deeper crystal geode when excavated
      let remaining = 0;
      for (let i = 0; i < crystals.length; i++) {
        if (!crystals[i].shattered) remaining++;
      }
      if (remaining === 0) {
        strataDepth++;
        playSfx(6, 1);
        spawnGeodeStrata(strataDepth);
      }
    });

    k.onDraw(() => {
      const live = getLiveCart();
      const cam = k.getCameraOffset();
      const tick = k.frame();

      // 1. Autotiled cavern shell from live cart world
      const world = live?.world;
      if (world) {
        const w = world.width === 32 ? 32 : 16;
        const h = world.height === 32 ? 32 : 16;
        const drawLayer = (grid, layerId) => {
          if (!grid || grid.length < w * h) return;
          for (let ty = 0; ty < h; ty++) {
            for (let tx = 0; tx < w; tx++) {
              const tid = grid[ty * w + tx];
              if (!tid) continue;
              const pxBase = tx * 8 + cam.x;
              const pyBase = ty * 8 + cam.y;
              if (tid >= 8 && live.sprites?.[tid - 8]) {
                k.drawSpriteSlot(tid - 8, pxBase, pyBase, { sprites: live.sprites, layer: layerId });
              } else {
                const mask = computeAutotileMask(grid, w, h, tx, ty);
                renderAutotile8x8(tid, resolveAutotileIndex(mask), tick, tileScratch);
                for (let py = 0; py < 8; py++) {
                  for (let px = 0; px < 8; px++) {
                    const c = tileScratch[py * 8 + px];
                    if (c > 0) k.drawPixel(pxBase + px, pyBase + py, c, layerId);
                  }
                }
              }
            }
          }
        };
        drawLayer(world.bgLayer, 1);
        drawLayer(world.mainLayer, 2);
        drawLayer(world.fgLayer, 2);
      }

      // 2. Intact crystal formation prisms + live cover sprite on center prism
      const coverSlot = live?.meta?.coverSpriteIdx ?? 0;
      for (let i = 0; i < crystals.length; i++) {
        const c = crystals[i];
        if (c.shattered) continue;
        const x0 = Math.round(c.x + cam.x);
        const y0 = Math.round(c.y + cam.y);
        for (let py = 0; py < c.h; py++) {
          for (let px = 0; px < c.w; px++) {
            const onBorder = px === 0 || py === 0 || px === c.w - 1 || py === c.h - 1;
            let col = c.baseCol;
            if (onBorder) col = 1;
            else if (px + py <= 4) col = c.glintCol;
            else if (px < c.w - 3 && py < c.h - 3) col = c.hiCol;
            k.drawPixel(x0 + px, y0 + py, col, 2);
          }
        }
        if ((i % 5) === 0) {
          k.drawSpriteSlot(coverSlot, x0 + 1, y0 + 1, {
            sprites: live?.sprites,
            frame: ((tick >> 4) & 1),
            layer: 2,
          });
        }
      }

      // 3. Glowing pulsing fault lines across strata
      const pulseCol = ((tick >> 3) & 1) ? 4 : 7;
      for (let i = 0; i < faults.length; i++) {
        const f = faults[i];
        if (f.triggered) continue;
        k.drawLine(f.x0 + cam.x, f.y0 + cam.y, f.x1 + cam.x, f.y1 + cam.y, pulseCol, 2);
        const mx = (f.x0 + f.x1) * 0.5 + cam.x;
        const my = (f.y0 + f.y1) * 0.5 + cam.y;
        k.drawPixel(mx - 1, my, 10, 2);
        k.drawPixel(mx + 1, my, 10, 2);
        k.drawPixel(mx, my - 1, 10, 2);
        k.drawPixel(mx, my + 1, 10, 2);
      }

      // 4. Expanding chisel tap shockwaves
      for (let i = 0; i < shockRings.length; i++) {
        const sr = shockRings[i];
        for (let a = 0; a < 24; a++) {
          const ang = (a / 24) * Math.PI * 2;
          k.drawPixel(
            Math.round(sr.x + Math.cos(ang) * sr.radius + cam.x),
            Math.round(sr.y + Math.sin(ang) * sr.radius + cam.y),
            sr.life > sr.maxLife * 0.5 ? 4 : 10,
            2
          );
        }
      }

      // 5. Cascading musical crystal beads
      for (let i = 0; i < beads.length; i++) {
        const b = beads[i];
        const bx = Math.round(b.x + cam.x);
        const by = Math.round(b.y + cam.y);
        k.drawPixel(bx, by, b.col, 2);
        if (b.size === 2) {
          k.drawPixel(bx + 1, by, 4, 2);
          k.drawPixel(bx, by + 1, b.col, 2);
        }
      }

      k.drawText5x7(`GEO ${strataDepth}`, 4, 3, 10, { shadow: 1 });
      k.drawText5x7(`${scoreTotal}`, 124, 3, 4, { align: 'right', shadow: 1 });
    });
  });

  k.go('chroma-chisel');
}
