import { createEmptyCartridgeROM } from '../cart/bitpack-rom.js';
import {
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  renderAutotile8x8,
} from '../studio/autotile-world.js';
import { quantizeRowToFreq } from '../audio/dsp-engine.js';

export const id = 'sling-slime';
export const title = 'SLING-SLIME 80';

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

function buildWorldData() {
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
        mainLayer[idx] = TERRAIN_TYPES.STONE;
        collision[idx] = COLLISION_FLAGS.SOLID;
      } else if ((x + y) % 4 === 0) {
        bgLayer[idx] = TERRAIN_TYPES.MOSS;
      }
    }
  }

  // Symmetric autotiled stone bumper islands
  const stoneBlocks = [
    [3, 3], [4, 3], [3, 4],
    [11, 3], [12, 3], [12, 4],
    [7, 5], [8, 5],
    [2, 9], [13, 9],
  ];
  for (const [bx, by] of stoneBlocks) {
    const idx = by * WORLD_SIZE + bx;
    mainLayer[idx] = TERRAIN_TYPES.STONE;
    collision[idx] = COLLISION_FLAGS.SOLID;
  }

  // Crystal bounce bumpers
  const crystalBumpers = [
    [5, 7], [10, 7],
  ];
  for (const [cx, cy] of crystalBumpers) {
    const idx = cy * WORLD_SIZE + cx;
    mainLayer[idx] = TERRAIN_TYPES.CRYSTAL;
    collision[idx] = COLLISION_FLAGS.BOUNCE;
  }

  // Small ember hazard corners on lower floor
  const hazards = [[2, 13], [13, 13]];
  for (const [hx, hy] of hazards) {
    const idx = hy * WORLD_SIZE + hx;
    mainLayer[idx] = TERRAIN_TYPES.EMBER;
    collision[idx] = COLLISION_FLAGS.HAZARD;
  }

  return { width: WORLD_SIZE, height: WORLD_SIZE, bgLayer, mainLayer, fgLayer, collision };
}

export function createROM() {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));

  // Slot 0: Bouncy pixel slime (2 frames)
  sprites[0] = {
    size: 8,
    frames: [
      parseSprite8([
        '00111100',
        '01888910',
        '18489991',
        '18919191',
        '19919191',
        '19999991',
        '01999910',
        '00111100',
      ]),
      parseSprite8([
        '00000000',
        '00111100',
        '01888910',
        '18499991',
        '19199191',
        '19999991',
        '19999991',
        '01111110',
      ]),
    ],
  };

  // Slot 1: 16-color sparkling gem cluster (2 frames)
  sprites[1] = {
    size: 8,
    frames: [
      parseSprite8([
        '00011000',
        '0014a100',
        '01a47c10',
        '15a7cd51',
        '155ccdd1',
        '0159cd10',
        '0019d100',
        '00011000',
      ]),
      parseSprite8([
        '00044000',
        '001aa100',
        '0147ac10',
        '1a7ccd41',
        '15ccdd51',
        '019cd510',
        '001d9100',
        '00011000',
      ]),
    ],
  };

  // Slot 2: Stone bounce orb
  sprites[2] = {
    size: 8,
    frames: [
      parseSprite8([
        '00111100',
        '014aa310',
        '14aaabb1',
        '1aabbbb1',
        '1abbb221',
        '12222221',
        '01222210',
        '00111100',
      ]),
    ],
  };

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const p = (i / 32) * Math.PI * 2;
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(7.5 + 5.2 * Math.sin(p) + 2.2 * Math.sin(p * 3))));
  }

  return createEmptyCartridgeROM({
    meta: {
      id,
      title,
      author: 'BITFORGE-80',
      paletteId: 'classic16',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'slingshot',
      dropShadow1px: true,
      crtOptics: true,
      updatedAt: FIXED_TIMESTAMP,
    },
    sprites,
    world: buildWorldData(),
    audio: {
      bpm: 118,
      scaleId: 'pentatonic',
      channels: [
        { steps: buildSteps([5, -1, 7, -1, 9, -1, 7, 5, 4, -1, 5, -1, 7, -1, 9, -1]), dutyOrTimbre: 96, volume: 65 },
        { steps: buildSteps([0, -1, -1, -1, 2, -1, -1, -1, 0, -1, -1, -1, 4, -1, -1, -1]), dutyOrTimbre: 72, volume: 75 },
        { steps: buildSteps([-1, -1, 12, -1, -1, -1, 12, -1, -1, -1, 12, -1, -1, 12, -1, -1]), dutyOrTimbre: 140, volume: 30 },
        { steps: buildSteps([4, -1, -1, -1, -1, -1, -1, -1, 7, -1, -1, -1, -1, -1, -1, -1]), dutyOrTimbre: 128, volume: 45 },
      ],
      wavetable32,
      sfxPatches: [
        { archetype: 0, x: 168, y: 120 }, // 0: Coin
        { archetype: 1, x: 110, y: 96 },  // 1: Pop
        { archetype: 2, x: 96, y: 110 },  // 2: Thock
        { archetype: 4, x: 144, y: 96 },  // 3: Bubble
        { archetype: 5, x: 120, y: 150 }, // 4: Shatter hazard
        { archetype: 5, x: 200, y: 140 }, // 5: Gem burst
        { archetype: 6, x: 140, y: 160 }, // 6: Wave bloom
        { archetype: 7, x: 185, y: 128 }, // 7: Combo chime
      ],
    },
    logic: {
      presetGameId: id,
      ruleChips: [
        { id: 'c1', trigger: 'Slingshot Release', paramA: 100, action: 'Spawn Sparks', paramB: 10, sfxSlot: 1 },
      ],
      customJs: '',
    },
  });
}

export const createCartridgeROM = createROM;

function drawAutotiledWorld(k, world, sprites, tick) {
  if (!world) return;
  const w = world.width === 32 ? 32 : 16;
  const h = world.height === 32 ? 32 : 16;
  const scratch = new Uint8Array(64);
  const cam = k.getCameraOffset();

  const renderGridLayer = (grid, fbLayer) => {
    if (!grid || grid.length < w * h) return;
    for (let ty = 0; ty < h; ty++) {
      const pyBase = Math.round(ty * 8 + cam.y);
      if (pyBase >= 128 || pyBase + 8 <= 0) continue;
      for (let tx = 0; tx < w; tx++) {
        const tid = grid[ty * w + tx];
        if (!tid) continue;
        const pxBase = Math.round(tx * 8 + cam.x);
        if (pxBase >= 128 || pxBase + 8 <= 0) continue;
        if (tid >= 8 && sprites && sprites[tid - 8]) {
          k.drawSpriteSlot(tid - 8, pxBase, pyBase, { sprites, layer: fbLayer });
        } else {
          const mask = computeAutotileMask(grid, w, h, tx, ty);
          const vIdx = resolveAutotileIndex(mask);
          renderAutotile8x8(tid, vIdx, tick, scratch);
          for (let py = 0; py < 8; py++) {
            for (let px = 0; px < 8; px++) {
              const col = scratch[py * 8 + px];
              if (col > 0) k.drawPixel(pxBase + px, pyBase + py, col, fbLayer);
            }
          }
        }
      }
    }
  };

  renderGridLayer(world.bgLayer, 1);
  renderGridLayer(world.mainLayer, 2);
  renderGridLayer(world.fgLayer, 2);
}

function findOpenGemCells(world) {
  const w = world?.width === 32 ? 32 : 16;
  const h = world?.height === 32 ? 32 : 16;
  const colGrid = world?.collision;
  const candidates = [];
  for (let y = 1; y < Math.min(13, h - 1); y++) {
    for (let x = 1; x < Math.min(15, w - 1); x++) {
      const idx = y * w + x;
      if (!colGrid || colGrid[idx] === 0) {
        if (Math.hypot(x * 8 + 4 - 64, y * 8 + 4 - 96) > 18) {
          candidates.push({ x: x * 8, y: y * 8 });
        }
      }
    }
  }
  return candidates;
}

export function mountGame(k, cart, helpers = {}) {
  const getLiveCart = () => (typeof helpers.getCart === 'function' ? helpers.getCart() : null) || cart;
  const playSfx = (slot, param = 0) => {
    if (typeof helpers.playSfx === 'function') helpers.playSfx(slot, param);
  };
  const playPentatonicChime = (comboStep) => {
    const row = Math.min(14, 3 + comboStep * 2);
    const freq = quantizeRowToFreq('pentatonic', row, 4);
    if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
      helpers.dsp.playNote(1, freq, 0.22, 0.72, { dutyOrTimbre: 120 });
    }
    playSfx(7, { pitchScale: freq / 660, velocity: 0.78 });
  };

  k.scene('sling-slime', () => {
    let combo = 0;
    let wave = 1;
    let totalScore = 0;
    let lastHandledRelease = helpers.touchVerbs ? helpers.touchVerbs.getState().slingshot.lastRelease : null;
    let prevRatchetCount = helpers.touchVerbs ? helpers.touchVerbs.getState().slingshot.ratchetCount : 0;
    let squashX = 1;
    let squashY = 1;
    let slimeFrame = 0;
    let hazardCooldown = 0;
    let bannerTimer = 0;
    let bannerText = '';

    const slime = k.add([
      k.pos(60, 92),
      k.vel(0, 0),
      k.area({ width: 8, height: 8 }),
      k.body({ gravity: 118, drag: 0.42, bounce: 0.84, collideWorld: true, maxVel: 310 }),
      'actor',
      'player',
      'slime',
    ]);

    function spawnGemWave(waveNum) {
      const live = getLiveCart();
      const openCells = findOpenGemCells(live?.world);
      const gemCount = Math.min(8, 5 + (waveNum % 3));
      const stride = Math.max(1, Math.floor(openCells.length / gemCount));
      const paletteChoices = [5, 7, 10, 12, 13, 8];
      for (let i = 0; i < gemCount && i * stride < openCells.length; i++) {
        const cell = openCells[(i * stride + waveNum * 3) % openCells.length];
        const gemColor = paletteChoices[(i + waveNum) % paletteChoices.length];
        const gem = k.add([
          k.pos(cell.x, cell.y),
          k.area({ width: 8, height: 8 }),
          k.z(1),
          'gem',
        ]);
        gem._baseY = cell.y;
        gem._phase = i * 0.9;
        gem._tint = gemColor;
        gem.onDraw(() => {
          const cur = getLiveCart();
          const cam = k.getCameraOffset();
          const bob = Math.round(Math.sin(k.time() * 3.4 + gem._phase) * 1.2);
          const sp = cur?.sprites?.[1];
          const hasPixels = sp && sp.frames?.[0]?.some((v) => v > 0);
          if (hasPixels) {
            k.drawSpriteSlot(1, gem.pos.x + cam.x, gem.pos.y + cam.y + bob, {
              sprites: cur.sprites,
              frame: (Math.floor(k.time() * 4 + gem._phase)) % sp.frames.length,
            });
          } else {
            k.drawPixel(gem.pos.x + 3 + cam.x, gem.pos.y + 3 + cam.y + bob, gem._tint);
            k.drawPixel(gem.pos.x + 4 + cam.x, gem.pos.y + 3 + cam.y + bob, 4);
          }
          if (((k.frame() + i * 7) & 31) === 0) {
            k.drawPixel(gem.pos.x + 1 + cam.x, gem.pos.y + 1 + cam.y + bob, 4);
          }
        });
      }
    }

    spawnGemWave(wave);

    k.onDraw(() => {
      const live = getLiveCart();
      drawAutotiledWorld(k, live?.world, live?.sprites, k.frame());
      k.drawText5x7(`SCR ${totalScore}`, 4, 3, 4, { shadow: 1 });
      if (combo > 1) {
        k.drawText5x7(`x${combo}`, 124, 3, 7, { align: 'right', shadow: 1 });
      }
      if (bannerTimer > 0 && bannerText) {
        k.drawText5x7(bannerText, 64, 15, 7, { align: 'center', shadow: 1 });
      }
    });

    slime.onDraw(() => {
      const live = getLiveCart();
      const cam = k.getCameraOffset();
      const slotIdx = live?.meta?.coverSpriteIdx ?? 0;
      const dx = Math.round(slime.pos.x + 4 * (1 - squashX) + cam.x);
      const dy = Math.round(slime.pos.y + 8 * (1 - squashY) + cam.y);
      k.drawSpriteSlot(slotIdx, dx, dy, {
        sprites: live?.sprites,
        frame: slimeFrame,
        scaleX: squashX,
        scaleY: squashY,
        flipX: slime.vel.x < -12,
      });
    });

    function resolveWorldCollisions(liveWorld) {
      const w = liveWorld?.width === 32 ? 32 : 16;
      const h = liveWorld?.height === 32 ? 32 : 16;
      const colGrid = liveWorld?.collision;
      if (!colGrid || colGrid.length < w * h) return;

      const minTx = Math.max(0, Math.floor(slime.pos.x / 8));
      const maxTx = Math.min(w - 1, Math.floor((slime.pos.x + 7.9) / 8));
      const minTy = Math.max(0, Math.floor(slime.pos.y / 8));
      const maxTy = Math.min(h - 1, Math.floor((slime.pos.y + 7.9) / 8));

      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const flag = colGrid[ty * w + tx];
          if (flag === 0) continue;

          const rx = tx * 8;
          const ry = ty * 8;
          const cx = slime.pos.x + 4;
          const cy = slime.pos.y + 4;
          const overlapX = 8 - Math.abs(cx - (rx + 4));
          const overlapY = 8 - Math.abs(cy - (ry + 4));
          if (overlapX <= 0 || overlapY <= 0) continue;

          if (flag === COLLISION_FLAGS.HAZARD) {
            if (hazardCooldown <= 0) {
              hazardCooldown = 0.45;
              combo = 0;
              slime.vel.y = -135;
              slime.vel.x = (cx < rx + 4 ? -90 : 90);
              squashX = 1.38;
              squashY = 0.68;
              k.hitStop(2);
              k.shake(0.5);
              k.emitParticles({ x: cx, y: cy, count: 14, color: [5, 6, 4], speed: [30, 80], gravity: 90, life: 0.32 });
              playSfx(4, 1);
            }
            continue;
          }

          const bounceMul = flag === COLLISION_FLAGS.BOUNCE ? 1.12 : 0.84;
          const speed = Math.hypot(slime.vel.x, slime.vel.y);
          if (overlapX < overlapY) {
            slime.pos.x += cx < rx + 4 ? -overlapX : overlapX;
            slime.vel.x = -slime.vel.x * bounceMul;
            if (flag === COLLISION_FLAGS.BOUNCE && Math.abs(slime.vel.x) < 110) {
              slime.vel.x = (cx < rx + 4 ? -125 : 125);
            }
            squashX = 0.68;
            squashY = 1.38;
          } else {
            slime.pos.y += cy < ry + 4 ? -overlapY : overlapY;
            slime.vel.y = -slime.vel.y * bounceMul;
            if (flag === COLLISION_FLAGS.BOUNCE && Math.abs(slime.vel.y) < 120) {
              slime.vel.y = (cy < ry + 4 ? -145 : 145);
            }
            squashX = 1.38;
            squashY = 0.68;
          }

          if (flag === COLLISION_FLAGS.BOUNCE) {
            k.shake(0.24);
            k.emitParticles({ x: cx, y: cy, count: 10, color: [10, 4, 12], speed: 55, gravity: 40, life: 0.25 });
            playSfx(3, 1);
          } else if (speed > 65) {
            k.shake(0.12);
            k.emitParticles({ x: cx, y: cy, count: 5, color: [8, 9, 4], speed: 36, gravity: 70, life: 0.2 });
            playSfx(2, 1);
          }
        }
      }
    }

    k.onUpdate((dt) => {
      const live = getLiveCart();
      if (hazardCooldown > 0) hazardCooldown = Math.max(0, hazardCooldown - dt);
      if (bannerTimer > 0) bannerTimer = Math.max(0, bannerTimer - dt);

      const state = helpers.touchVerbs ? helpers.touchVerbs.getState() : null;
      if (state && state.slingshot) {
        const sling = state.slingshot;
        if (sling.ratchetCount !== prevRatchetCount) {
          prevRatchetCount = sling.ratchetCount;
          playSfx(2, { pitchScale: 0.8 + (sling.ratchetStep % 8) * 0.08, velocity: 0.38 });
        }
        if (sling.active) {
          const power = Math.min(1, sling.distance / 48);
          squashX = Math.max(0.65, 1 - power * 0.25);
          squashY = Math.min(1.45, 1 + power * 0.35);
          slimeFrame = 1;
        }
        if (sling.lastRelease && sling.lastRelease !== lastHandledRelease) {
          lastHandledRelease = sling.lastRelease;
          const speedBoost = 1.18;
          slime.vel.x += sling.lastRelease.vx * speedBoost;
          slime.vel.y += sling.lastRelease.vy * speedBoost;
          const spd = Math.hypot(slime.vel.x, slime.vel.y);
          if (spd < 45 && sling.lastRelease.distance > 4) {
            const kScale = 65 / Math.max(1, spd);
            slime.vel.x *= kScale;
            slime.vel.y *= kScale;
          }
          squashX = 0.7;
          squashY = 1.42;
          slimeFrame = 0;
          k.emitParticles({
            x: slime.pos.x + 4,
            y: slime.pos.y + 4,
            count: 9,
            color: [8, 9, 4],
            speed: 48,
            gravity: 60,
            life: 0.24,
          });
          playSfx(1, 1);
        }
      }

      // Recover squash-and-stretch smoothly toward (1, 1)
      squashX += (1 - squashX) * Math.min(1, dt * 12);
      squashY += (1 - squashY) * Math.min(1, dt * 12);
      if (!state?.slingshot?.active) {
        slimeFrame = Math.hypot(slime.vel.x, slime.vel.y) > 95 ? 1 : 0;
      }

      // Keep slime cleanly inside inner playfield & resolve tilemap collisions
      resolveWorldCollisions(live?.world);
      if (slime.pos.x < 8) { slime.pos.x = 8; slime.vel.x = Math.abs(slime.vel.x) * 0.84; }
      if (slime.pos.x > 112) { slime.pos.x = 112; slime.vel.x = -Math.abs(slime.vel.x) * 0.84; }
      if (slime.pos.y < 8) { slime.pos.y = 8; slime.vel.y = Math.abs(slime.vel.y) * 0.84; }
      if (slime.pos.y > 112) {
        slime.pos.y = 112;
        if (Math.abs(slime.vel.y) > 45) {
          squashX = 1.32;
          squashY = 0.72;
          playSfx(2, 0.7);
        }
        slime.vel.y = -Math.abs(slime.vel.y) * 0.8;
        if (Math.abs(slime.vel.y) < 12) {
          slime.vel.y = 0;
          combo = 0;
        }
      }

      // Gem cluster collection & shattering
      const gems = k.get('gem');
      const sx = slime.pos.x + 4;
      const sy = slime.pos.y + 4;
      for (let i = 0; i < gems.length; i++) {
        const g = gems[i];
        if (!g.exists()) continue;
        const gx = g.pos.x + 4;
        const gy = g.pos.y + 4;
        if (Math.hypot(sx - gx, sy - gy) <= 8.5) {
          k.destroy(g);
          combo++;
          const pts = 10 * combo;
          totalScore += pts;
          if (typeof helpers.addScore === 'function') helpers.addScore(pts);
          k.hitStop(2);
          k.shake(Math.min(0.95, 0.24 + combo * 0.08));
          k.emitParticles({
            x: gx,
            y: gy,
            count: 20,
            color: [4, 5, 7, 8, 10, 12, 13],
            speed: [35, 95],
            gravity: 75,
            life: 0.42,
            size: 1,
          });
          playPentatonicChime(combo);
          bannerText = combo > 1 ? `COMBO x${combo}!` : '+10 GEM';
          bannerTimer = 0.75;
        }
      }

      if (k.get('gem').length === 0) {
        wave++;
        bannerText = `FLOOR ${wave}`;
        bannerTimer = 1.1;
        playSfx(6, 1);
        spawnGemWave(wave);
      }
    });
  });

  k.go('sling-slime');
}
