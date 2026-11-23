import { createEmptyCartridgeROM } from '../cart/bitpack-rom.js';
import {
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  renderAutotile8x8,
} from '../studio/autotile-world.js';
import { quantizeRowToFreq } from '../audio/dsp-engine.js';

export const id = 'zen-rake';
export const title = 'ZEN RAKE // KARESANSUI';

const FIXED_TIMESTAMP = 1735689600000;
const WORLD_SIZE = 16;
const SIZE = 128;

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

function buildGardenWorld() {
  const total = WORLD_SIZE * WORLD_SIZE;
  const bgLayer = new Uint8Array(total);
  const mainLayer = new Uint8Array(total);
  const fgLayer = new Uint8Array(total);
  const collision = new Uint8Array(total);

  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const idx = y * WORLD_SIZE + x;
      if (x === 0 || y === 0 || x === WORLD_SIZE - 1 || y === WORLD_SIZE - 1) {
        mainLayer[idx] = TERRAIN_TYPES.CLIFF;
        collision[idx] = COLLISION_FLAGS.SOLID;
      }
    }
  }

  // Mossy autotiled rock islands
  const mossRocks = [
    [4, 4], [5, 4], [4, 5],
    [11, 6], [11, 7],
    [6, 11], [7, 11],
  ];
  for (const [rx, ry] of mossRocks) {
    const idx = ry * WORLD_SIZE + rx;
    mainLayer[idx] = TERRAIN_TYPES.MOSS;
    collision[idx] = COLLISION_FLAGS.SOLID;
  }

  // Reeds accents at garden corners
  fgLayer[1 * WORLD_SIZE + 1] = TERRAIN_TYPES.REEDS;
  fgLayer[1 * WORLD_SIZE + 14] = TERRAIN_TYPES.REEDS;
  fgLayer[14 * WORLD_SIZE + 1] = TERRAIN_TYPES.REEDS;

  return { width: WORLD_SIZE, height: WORLD_SIZE, bgLayer, mainLayer, fgLayer, collision };
}

export function createROM() {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));

  // Slot 0: Cedar bamboo rake (cover)
  sprites[0] = {
    size: 8,
    frames: [
      parseSprite8([
        '0001e000',
        '0001e000',
        '0001e000',
        '01eeeeee',
        '01e1e1e1',
        '04040404',
        '00000000',
        '00000000',
      ]),
    ],
  };

  // Slot 1: Drifting sakura & matcha leaf (2 frames)
  sprites[1] = {
    size: 8,
    frames: [
      parseSprite8([
        '000dd000',
        '00d4dd00',
        '0dd4ddd0',
        '00dd4d00',
        '000dd000',
        '00000000',
        '00000000',
        '00000000',
      ]),
      parseSprite8([
        '00000000',
        '00088000',
        '00848800',
        '00889800',
        '00090000',
        '00000000',
        '00000000',
        '00000000',
      ]),
    ],
  };

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const p = (i / 32) * Math.PI * 2;
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(7.5 + 6.0 * Math.sin(p) + 1.2 * Math.sin(p * 2))));
  }

  return createEmptyCartridgeROM({
    meta: {
      id,
      title,
      author: 'BITFORGE-80',
      paletteId: 'matcha',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'springDrag',
      dropShadow1px: true,
      crtOptics: true,
      updatedAt: FIXED_TIMESTAMP,
    },
    sprites,
    world: buildGardenWorld(),
    audio: {
      bpm: 80,
      scaleId: 'hirajoshi',
      channels: [
        { steps: buildSteps([7, -1, -1, 8, -1, -1, 10, -1, -1, 8, -1, -1, 5, -1, -1, -1]), dutyOrTimbre: 64, volume: 48 },
        { steps: buildSteps([0, -1, -1, -1, -1, -1, 3, -1, 0, -1, -1, -1, 2, -1, -1, -1]), dutyOrTimbre: 48, volume: 65 },
        { steps: buildSteps([-1, -1, -1, -1, -1, -1, -1, 13, -1, -1, -1, -1, -1, -1, -1, 13]), dutyOrTimbre: 180, volume: 18 },
        { steps: buildSteps([2, -1, -1, -1, -1, -1, -1, -1, 4, -1, -1, -1, -1, -1, -1, -1]), dutyOrTimbre: 96, volume: 42 },
      ],
      wavetable32,
      sfxPatches: [
        { archetype: 7, x: 180, y: 120 }, // 0: Hirajoshi bell
        { archetype: 6, x: 140, y: 160 }, // 1: Sand bloom
        { archetype: 2, x: 75, y: 90 },   // 2: Bamboo thock
        { archetype: 4, x: 128, y: 110 }, // 3: Dew bubble
        { archetype: 1, x: 96, y: 80 },   // 4: Soft tap
        { archetype: 5, x: 110, y: 80 },  // 5: Gravel sweep
        { archetype: 6, x: 165, y: 170 }, // 6: Petal breeze
        { archetype: 7, x: 205, y: 135 }, // 7: Wind-chime
      ],
    },
    logic: {
      presetGameId: id,
      ruleChips: [
        { id: 'c1', trigger: 'Tap Entity', paramA: 14, action: 'Spawn Sparks', paramB: 6, sfxSlot: 7 },
      ],
      customJs: '',
    },
  });
}

export const createCartridgeROM = createROM;

function buildObstacleMask(world) {
  const mask = new Uint8Array(SIZE * SIZE);
  if (!world) return mask;
  const w = world.width === 32 ? 32 : 16;
  const h = world.height === 32 ? 32 : 16;
  for (let ty = 0; ty < Math.min(16, h); ty++) {
    for (let tx = 0; tx < Math.min(16, w); tx++) {
      const idx = ty * w + tx;
      const isBlocked = (world.collision && world.collision[idx] > 0) ||
        (world.mainLayer && world.mainLayer[idx] > 0);
      if (!isBlocked) continue;
      for (let py = 0; py < 8; py++) {
        const gy = ty * 8 + py;
        for (let px = 0; px < 8; px++) {
          mask[gy * SIZE + (tx * 8 + px)] = 1;
        }
      }
    }
  }
  return mask;
}

function seedKaresansuiPatterns(sand, obstacles) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = y * SIZE + x;
      if (obstacles[idx]) {
        sand[idx] = 0;
        continue;
      }
      // Subtle calm horizontal grooves with ripple halos near mossy stones
      let ringDist = 99;
      for (let oy = -10; oy <= 10; oy += 2) {
        for (let ox = -10; ox <= 10; ox += 2) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx >= 8 && sx < 120 && sy >= 8 && sy < 120 && obstacles[sy * SIZE + sx]) {
            const d = Math.hypot(ox, oy);
            if (d < ringDist) ringDist = d;
          }
        }
      }
      if (ringDist < 11) {
        sand[idx] = Math.sin(ringDist * 1.65) * 0.78;
      } else {
        sand[idx] = Math.sin(y * 1.45) * 0.42;
      }
    }
  }
}

export function mountGame(k, cart, helpers = {}) {
  const getLiveCart = () => (typeof helpers.getCart === 'function' ? helpers.getCart() : null) || cart;

  k.scene('zen-rake', () => {
    const sandHeight = new Float32Array(SIZE * SIZE);
    const liveInit = getLiveCart();
    let obstacleMask = buildObstacleMask(liveInit?.world);
    seedKaresansuiPatterns(sandHeight, obstacleMask);

    let prevPos = { x: 64, y: 64 };
    let wasDragging = false;
    let rakeDistAccum = 0;
    let chimeStep = 0;
    let scoreTotal = 0;
    let frameCounter = 0;
    const tileScratch = new Uint8Array(64);

    // Floating sakura & matcha petals
    const petals = Array.from({ length: 14 }, (_, i) => ({
      x: (i * 19 + 11) % 112 + 8,
      y: (i * 23 + 17) % 112 + 8,
      vx: 6 + (i % 3) * 3,
      vy: 4 + (i % 4) * 2,
      phase: i * 0.85,
      color: i % 3 === 0 ? 13 : (i % 3 === 1 ? 8 : 6),
    }));

    function triggerWindChime() {
      const row = 3 + ((chimeStep * 2 + (chimeStep % 3)) % 11);
      const freq = quantizeRowToFreq('hirajoshi', row, 4);
      if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
        helpers.dsp.playNote(1, freq, 0.34, 0.42, { dutyOrTimbre: 56 });
      }
      if (typeof helpers.playSfx === 'function') {
        helpers.playSfx(7, { pitchScale: freq / 660, velocity: 0.45 });
      }
      chimeStep++;
    }

    function carveRakeSegment(x0, y0, x1, y1) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.25) return;

      const nx = -dy / dist;
      const ny = dx / dist;
      const steps = Math.max(1, Math.ceil(dist * 1.5));

      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const cx = x0 + dx * u;
        const cy = y0 + dy * u;

        for (let t = -7; t <= 7; t++) {
          const px = Math.round(cx + nx * t);
          const py = Math.round(cy + ny * t);
          if (px < 1 || px >= SIZE - 1 || py < 1 || py >= SIZE - 1) continue;
          const idx = py * SIZE + px;
          if (obstacleMask[idx]) continue;

          // Parallel rake tine waves: grooves at -6,-3,0,3,6 and crests between
          const wave = -Math.cos((t / 3) * Math.PI * 2) * 0.92;
          const fade = Math.max(0, 1 - Math.abs(t) / 8);
          sandHeight[idx] = sandHeight[idx] * (1 - fade * 0.82) + wave * fade;
        }
      }

      rakeDistAccum += dist;
      if (rakeDistAccum >= 14) {
        rakeDistAccum = 0;
        scoreTotal += 2;
        if (typeof helpers.addScore === 'function') helpers.addScore(2);
        triggerWindChime();
        k.emitParticles({
          x: x1,
          y: y1,
          count: 4,
          color: [4, 15],
          speed: [10, 24],
          gravity: 12,
          life: 0.3,
        });
      }
    }

    k.onUpdate((dt) => {
      frameCounter++;
      const live = getLiveCart();
      if (frameCounter % 15 === 0) {
        obstacleMask = buildObstacleMask(live?.world);
      }

      const spring = helpers.touchVerbs ? helpers.touchVerbs.getState().springDrag : null;
      if (spring && spring.active) {
        const px = Math.max(8, Math.min(120, spring.pos.x));
        const py = Math.max(8, Math.min(120, spring.pos.y));
        if (wasDragging) {
          carveRakeSegment(prevPos.x, prevPos.y, px, py);
        }
        prevPos.x = px;
        prevPos.y = py;
        wasDragging = true;
      } else {
        wasDragging = false;
      }

      // Update drifting sakura & autumn leaf petals
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        p.phase += dt * 2.2;
        p.x += (p.vx + Math.sin(p.phase) * 5) * dt;
        p.y += (p.vy + Math.cos(p.phase * 0.7) * 2.5) * dt;
        if (p.x > 122) p.x = 6;
        if (p.y > 122) p.y = 6;
      }
    });

    k.onDraw(() => {
      const live = getLiveCart();
      const cam = k.getCameraOffset();

      // 1. Render 128x128 shadowed sand heightfield on layer 1
      for (let y = 1; y < SIZE - 1; y++) {
        const rowOff = y * SIZE;
        for (let x = 1; x < SIZE - 1; x++) {
          const idx = rowOff + x;
          if (obstacleMask[idx]) continue;
          const h = sandHeight[idx];
          const slope = h - sandHeight[idx - SIZE - 1];
          const lit = h * 0.65 + slope * 0.55;
          const grain = ((x * 7 + y * 13) & 3) === 0 ? 0.08 : 0;
          const val = lit + grain;

          let col = 15; // warm sand midtone
          if (val > 0.34) col = 4;        // bright crest
          else if (val < -0.36) col = 2;  // deep groove shadow
          else if (val < -0.11) col = 3;  // mid groove shadow
          k.drawPixel(x + cam.x, y + cam.y, col, 1);
        }
      }

      // 2. Render live autotiled world stones/moss/cedar frame on layer 2
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
                renderAutotile8x8(tid, resolveAutotileIndex(mask), k.frame(), tileScratch);
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

      // 3. Draw drifting sakura & leaf petals
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        const px = Math.round(p.x + cam.x);
        const py = Math.round(p.y + cam.y);
        k.drawPixel(px, py, p.color, 2);
        if ((i & 1) === 0) k.drawPixel(px + 1, py, p.color === 13 ? 4 : p.color, 2);
      }

      // 4. Draw bamboo rake cursor sprite
      const spring = helpers.touchVerbs ? helpers.touchVerbs.getState().springDrag : null;
      const rx = spring ? spring.pos.x : prevPos.x;
      const ry = spring ? spring.pos.y : prevPos.y;
      const slotIdx = live?.meta?.coverSpriteIdx ?? 0;
      k.drawSpriteSlot(slotIdx, rx - 4 + cam.x, ry - 4 + cam.y, {
        sprites: live?.sprites,
        layer: 2,
      });

      k.drawText5x7(`ZEN ${scoreTotal}`, 10, 10, 4, { shadow: 1 });
    });
  });

  k.go('zen-rake');
}
