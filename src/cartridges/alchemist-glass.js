import { createEmptyCartridgeROM } from '../cart/bitpack-rom.js';
import {
  TERRAIN_TYPES,
  COLLISION_FLAGS,
  computeAutotileMask,
  resolveAutotileIndex,
  renderAutotile8x8,
} from '../studio/autotile-world.js';
import { quantizeRowToFreq } from '../audio/dsp-engine.js';

export const id = 'alchemist-glass';
export const title = 'ALCHEMIST GLASS';

const FIXED_TIMESTAMP = 1735689600000;
const WORLD_SIZE = 16;
const SIZE = 128;
const TOP_BAR_H = 10;

// Cellular automata cell types
const CA_EMPTY = 0;
const CA_SAND = 1;
const CA_WATER = 2;
const CA_SEED = 3;
const CA_OIL = 4;
const CA_EMBER = 5;
const CA_STONE = 6;
const CA_STEAM = 7;
const CA_VINE = 8;
const CA_FIRE = 9;
const CA_BLOSSOM = 10;

const ELEMENTS = Object.freeze([
  { id: CA_SAND, label: 'SAND', short: 'SD', colorIdx: 7, hex: '#f7c566', glyph: [0x6, 0x8, 0x4, 0x2, 0xC] },
  { id: CA_WATER, label: 'WATER', short: 'WT', colorIdx: 10, hex: '#6dc2e8', glyph: [0xA, 0xA, 0xE, 0xE, 0x4] },
  { id: CA_SEED, label: 'SEED', short: 'PL', colorIdx: 8, hex: '#8ec96e', glyph: [0x4, 0xE, 0x4, 0x4, 0x4] },
  { id: CA_OIL, label: 'OIL', short: 'OL', colorIdx: 12, hex: '#a46cd4', glyph: [0x4, 0xA, 0xA, 0xA, 0x4] },
  { id: CA_EMBER, label: 'EMBER', short: 'EM', colorIdx: 6, hex: '#ff7b6b', glyph: [0xE, 0x8, 0xE, 0x8, 0xE] },
  { id: CA_STONE, label: 'STONE', short: 'ST', colorIdx: 3, hex: '#8c5f7e', glyph: [0xE, 0xE, 0xE, 0xE, 0xE] },
]);

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

function buildTerrariumWorld() {
  const total = WORLD_SIZE * WORLD_SIZE;
  const bgLayer = new Uint8Array(total);
  const mainLayer = new Uint8Array(total);
  const fgLayer = new Uint8Array(total);
  const collision = new Uint8Array(total);

  for (let y = 2; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const idx = y * WORLD_SIZE + x;
      if (x === 0 || x === WORLD_SIZE - 1 || y === WORLD_SIZE - 1) {
        mainLayer[idx] = TERRAIN_TYPES.STONE;
        collision[idx] = COLLISION_FLAGS.SOLID;
      }
    }
  }

  // Terrarium basin shelves
  const shelves = [
    [2, 7], [3, 7], [4, 7],
    [11, 8], [12, 8], [13, 8],
    [6, 11], [7, 11], [8, 11], [9, 11],
  ];
  for (const [sx, sy] of shelves) {
    const idx = sy * WORLD_SIZE + sx;
    mainLayer[idx] = TERRAIN_TYPES.STONE;
    collision[idx] = COLLISION_FLAGS.SOLID;
  }

  bgLayer[14 * WORLD_SIZE + 3] = TERRAIN_TYPES.MOSS;
  bgLayer[14 * WORLD_SIZE + 12] = TERRAIN_TYPES.MOSS;

  return { width: WORLD_SIZE, height: WORLD_SIZE, bgLayer, mainLayer, fgLayer, collision };
}

export function createROM() {
  const sprites = Array.from({ length: 32 }, () => ({
    size: 8,
    frames: [new Uint8Array(64)],
  }));

  // Slot 0: Bubbling alchemy glass flask (2 frames)
  sprites[0] = {
    size: 8,
    frames: [
      parseSprite8([
        '00144100',
        '00011000',
        '001a4100',
        '01a4aa10',
        '18889881',
        '18d88d81',
        '01999910',
        '00111100',
      ]),
      parseSprite8([
        '00144100',
        '00014000',
        '0014a100',
        '01aa4a10',
        '188d8881',
        '1988d891',
        '01999910',
        '00111100',
      ]),
    ],
  };

  // Slot 1: Sakura blossom bud
  sprites[1] = {
    size: 8,
    frames: [
      parseSprite8([
        '000dd000',
        '00d4dd00',
        '0dd74dd0',
        '00dddd00',
        '00089000',
        '00889000',
        '00090000',
        '00000000',
      ]),
    ],
  };

  const wavetable32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const p = (i / 32) * Math.PI * 2;
    wavetable32[i] = Math.max(0, Math.min(15, Math.round(7.5 + 5.0 * Math.sin(p) + 2.0 * Math.sin(p * 3))));
  }

  return createEmptyCartridgeROM({
    meta: {
      id,
      title,
      author: 'BITFORGE-80',
      paletteId: 'sakura',
      customPalette: null,
      coverSpriteIdx: 0,
      primaryVerb: 'springDrag',
      dropShadow1px: true,
      crtOptics: true,
      updatedAt: FIXED_TIMESTAMP,
    },
    sprites,
    world: buildTerrariumWorld(),
    audio: {
      bpm: 96,
      scaleId: 'lofiMaj9',
      channels: [
        { steps: buildSteps([4, -1, 6, -1, 9, -1, -1, 7, 4, -1, -1, 6, 8, -1, -1, -1]), dutyOrTimbre: 72, volume: 46 },
        { steps: buildSteps([0, -1, -1, -1, -1, -1, 2, -1, 0, -1, -1, -1, 4, -1, -1, -1]), dutyOrTimbre: 56, volume: 60 },
        { steps: buildSteps([-1, -1, 13, -1, -1, -1, 12, -1, -1, -1, 13, -1, -1, 14, -1, -1]), dutyOrTimbre: 165, volume: 22 },
        { steps: buildSteps([2, -1, -1, -1, 4, -1, -1, -1, 7, -1, -1, -1, 6, -1, -1, -1]), dutyOrTimbre: 112, volume: 42 },
      ],
      wavetable32,
      sfxPatches: [
        { archetype: 4, x: 140, y: 90 },  // 0: Water droplet bubble
        { archetype: 5, x: 160, y: 120 }, // 1: Ember crackle
        { archetype: 2, x: 110, y: 75 },  // 2: Pill click thock
        { archetype: 6, x: 155, y: 140 }, // 3: Vine bloom
        { archetype: 4, x: 195, y: 155 }, // 4: Steam fizz
        { archetype: 1, x: 130, y: 85 },  // 5: Sand pour pop
        { archetype: 5, x: 210, y: 160 }, // 6: Oil ignition
        { archetype: 7, x: 170, y: 130 }, // 7: Crystal chime
      ],
    },
    logic: {
      presetGameId: id,
      ruleChips: [
        { id: 'c1', trigger: 'Tap Entity', paramA: 12, action: 'Spawn Sparks', paramB: 6, sfxSlot: 2 },
      ],
      customJs: '',
    },
  });
}

export const createCartridgeROM = createROM;

let activeAlchemistMount = 0;

export function mountGame(k, cart, helpers = {}) {
  const myMountId = ++activeAlchemistMount;
  const getLiveCart = () => (typeof helpers.getCart === 'function' ? helpers.getCart() : null) || cart;
  const playSfx = (slot, param = 0) => {
    if (typeof helpers.playSfx === 'function') helpers.playSfx(slot, param);
  };

  const caGrid = new Uint8Array(SIZE * SIZE);
  const caLife = new Uint8Array(SIZE * SIZE);
  const worldSolidMask = new Uint8Array(SIZE * SIZE);
  const stepStamp = new Uint8Array(SIZE * SIZE);
  let selectedElemIdx = 0;
  let hudEl = helpers.hudStrip || (typeof document !== 'undefined' ? document.getElementById('bf-hud-strip') : null);
  let pillBarEl = null;
  let pillButtons = [];
  let isPlayVisible = true;
  let cleanedUp = false;

  function syncHudSelection() {
    for (let i = 0; i < pillButtons.length; i++) {
      const btn = pillButtons[i];
      const active = i === selectedElemIdx;
      btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
      if (btn.dataset) btn.dataset.selected = active ? 'true' : 'false';
      if (btn.style) {
        btn.style.outline = active ? '1.5px solid #f7eef2' : '1px solid rgba(255,255,255,0.18)';
        btn.style.transform = active ? 'translateY(-1px)' : 'none';
        btn.style.opacity = active ? '1' : '0.78';
      }
    }
  }

  function selectElement(idx) {
    const next = Math.max(0, Math.min(ELEMENTS.length - 1, idx | 0));
    if (next !== selectedElemIdx) {
      selectedElemIdx = next;
      syncHudSelection();
      playSfx(2, next);
      if (helpers.bus && typeof helpers.bus.emit === 'function') {
        helpers.bus.emit('foley:switch', { index: next });
      }
    }
  }

  function mountDomPills() {
    if (!hudEl) return;
    const doc = hudEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return;

    // Remove stale pills from prior boots inside hudEl
    if (typeof hudEl.querySelectorAll === 'function') {
      const stale = hudEl.querySelectorAll('.bf-alchemist-pills');
      for (let i = 0; i < stale.length; i++) {
        stale[i].parentNode?.removeChild?.(stale[i]);
      }
    }

    pillBarEl = doc.createElement('div');
    pillBarEl.className = 'bf-alchemist-pills';
    if (pillBarEl.dataset) pillBarEl.dataset.cart = id;
    if (pillBarEl.style) {
      pillBarEl.style.display = 'inline-flex';
      pillBarEl.style.alignItems = 'center';
      pillBarEl.style.gap = '4px';
      pillBarEl.style.marginLeft = '6px';
      pillBarEl.style.flexWrap = 'wrap';
    }

    pillButtons = [];
    for (let i = 0; i < ELEMENTS.length; i++) {
      const elDef = ELEMENTS[i];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'bf-alch-pill';
      btn.textContent = elDef.label;
      if (btn.dataset) btn.dataset.element = elDef.label;
      if (btn.style) {
        btn.style.fontSize = '10px';
        btn.style.fontFamily = 'monospace';
        btn.style.padding = '2px 6px';
        btn.style.border = 'none';
        btn.style.borderRadius = '3px';
        btn.style.background = '#25192a';
        btn.style.color = elDef.hex;
        btn.style.cursor = 'pointer';
      }
      btn.addEventListener('click', () => {
        if (cleanedUp || myMountId !== activeAlchemistMount) return;
        selectElement(i);
      });
      pillBarEl.appendChild(btn);
      pillButtons.push(btn);
    }

    hudEl.appendChild(pillBarEl);
    syncHudSelection();
  }

  function unmountDomPills() {
    if (pillBarEl && pillBarEl.parentNode && typeof pillBarEl.parentNode.removeChild === 'function') {
      pillBarEl.parentNode.removeChild(pillBarEl);
    } else if (pillBarEl && typeof pillBarEl.remove === 'function') {
      pillBarEl.remove();
    }
  }

  const busCleanups = [];
  function cleanupAll() {
    if (cleanedUp) return;
    cleanedUp = true;
    isPlayVisible = false;
    unmountDomPills();
    for (const off of busCleanups) off();
    busCleanups.length = 0;
  }

  mountDomPills();

  if (helpers.bus && typeof helpers.bus.on === 'function') {
    let ignoreInitialBoot = true;
    Promise.resolve().then(() => { ignoreInitialBoot = false; });
    const expectedId = cart?.meta?.id || id;

    const unsubBoot = helpers.bus.on('cart:boot', (payload) => {
      if (myMountId !== activeAlchemistMount) {
        cleanupAll();
        return;
      }
      if (ignoreInitialBoot && (!payload || payload.id === expectedId)) {
        ignoreInitialBoot = false;
        return;
      }
      cleanupAll();
    });
    if (typeof unsubBoot === 'function') busCleanups.push(unsubBoot);

    const unsubMode = helpers.bus.on('mode:change', (payload) => {
      if (myMountId !== activeAlchemistMount || cleanedUp) {
        cleanupAll();
        return;
      }
      const mode = payload && payload.mode ? String(payload.mode).toUpperCase() : '';
      if (mode === 'PLAY') {
        isPlayVisible = true;
        if (hudEl && pillBarEl && pillBarEl.parentNode !== hudEl) {
          hudEl.appendChild(pillBarEl);
        }
      } else {
        isPlayVisible = false;
        unmountDomPills();
        if (!mode) cleanupAll();
      }
    });
    if (typeof unsubMode === 'function') busCleanups.push(unsubMode);

    const unsubVerb = helpers.bus.on('verb:event', (evt) => {
      if (myMountId !== activeAlchemistMount || cleanedUp || !evt) return;
      if (evt.type === 'springDrag:grab' && evt.y >= 0 && evt.y <= TOP_BAR_H) {
        const idx = Math.max(0, Math.min(ELEMENTS.length - 1, Math.floor(evt.x / (SIZE / ELEMENTS.length))));
        selectElement(idx);
      }
    });
    if (typeof unsubVerb === 'function') busCleanups.push(unsubVerb);
  }

  // Sync static world barrier cells from live cart world
  function syncWorldSolidMask(world) {
    worldSolidMask.fill(0);
    if (!world) return;
    const w = world.width === 32 ? 32 : 16;
    const h = world.height === 32 ? 32 : 16;
    for (let ty = 0; ty < Math.min(16, h); ty++) {
      for (let tx = 0; tx < Math.min(16, w); tx++) {
        const idx = ty * w + tx;
        const solid = (world.collision && world.collision[idx] > 0) ||
          (world.mainLayer && world.mainLayer[idx] > 0);
        if (!solid) continue;
        for (let py = 0; py < 8; py++) {
          const gy = ty * 8 + py;
          if (gy < TOP_BAR_H) continue;
          for (let px = 0; px < 8; px++) {
            worldSolidMask[gy * SIZE + tx * 8 + px] = 1;
          }
        }
      }
    }
  }

  function seedStarterTerrarium() {
    // Pool of water in center bowl
    for (let y = 78; y <= 87; y++) {
      for (let x = 50; x <= 78; x++) {
        const idx = y * SIZE + x;
        if (!worldSolidMask[idx]) caGrid[idx] = CA_WATER;
      }
    }
    // Golden sand mound on left shelf
    for (let y = 46; y <= 55; y++) {
      const span = y - 45;
      for (let x = 28 - span; x <= 28 + span; x++) {
        const idx = y * SIZE + x;
        if (!worldSolidMask[idx]) caGrid[idx] = CA_SAND;
      }
    }
    // Oil droplets on right shelf
    for (let y = 58; y <= 63; y++) {
      for (let x = 92; x <= 107; x++) {
        const idx = y * SIZE + x;
        if (!worldSolidMask[idx]) caGrid[idx] = CA_OIL;
      }
    }
    // Growing pixelvine sprout near water
    for (let y = 72; y <= 85; y++) {
      caGrid[y * SIZE + 54] = CA_VINE;
      caLife[y * SIZE + 54] = 8;
    }
    caGrid[71 * SIZE + 54] = CA_BLOSSOM;
    caGrid[72 * SIZE + 53] = CA_BLOSSOM;
    caGrid[72 * SIZE + 55] = CA_BLOSSOM;
    // Starter seed
    caGrid[66 * SIZE + 64] = CA_SEED;
  }

  k.scene('alchemist-glass', () => {
    const liveInit = getLiveCart();
    syncWorldSolidMask(liveInit?.world);
    seedStarterTerrarium();

    let rng = 0x13579bdf;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return (rng >>> 16) & 0xffff;
    };

    let simTick = 0;
    let stamp = 1;
    let prevSpringActive = false;
    let draggingTopBar = false;
    let audioCooldown = 0;
    let pourAudioCooldown = 0;
    let scoreTotal = 0;
    const tileScratch = new Uint8Array(64);

    function isOpenForGas(x, y) {
      if (x < 1 || x >= SIZE - 1 || y < TOP_BAR_H || y >= SIZE - 1) return false;
      const idx = y * SIZE + x;
      return !worldSolidMask[idx] && caGrid[idx] === CA_EMPTY;
    }

    function cellTypeAt(x, y) {
      if (x < 0 || x >= SIZE || y < TOP_BAR_H || y >= SIZE) return CA_STONE;
      const idx = y * SIZE + x;
      if (worldSolidMask[idx]) return CA_STONE;
      return caGrid[idx];
    }

    function swapCells(i1, i2) {
      const t = caGrid[i1];
      const l = caLife[i1];
      caGrid[i1] = caGrid[i2];
      caLife[i1] = caLife[i2];
      caGrid[i2] = t;
      caLife[i2] = l;
      stepStamp[i1] = stamp;
      stepStamp[i2] = stamp;
    }

    function paintElementAt(cx, cy, elemId) {
      const radius = elemId === CA_SEED || elemId === CA_EMBER ? 1 : 2;
      let placed = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius + 1) continue;
          const px = Math.round(cx + dx);
          const py = Math.round(cy + dy);
          if (px < 1 || px >= SIZE - 1 || py < TOP_BAR_H || py >= SIZE - 1) continue;
          const idx = py * SIZE + px;
          if (worldSolidMask[idx]) continue;
          if (elemId === CA_STONE || caGrid[idx] === CA_EMPTY || elemId === CA_EMBER) {
            caGrid[idx] = elemId;
            caLife[idx] = elemId === CA_EMBER ? 90 + (rand() & 31) : (elemId === CA_SEED ? 16 : 0);
            placed++;
          }
        }
      }
      if (placed > 0 && pourAudioCooldown <= 0) {
        pourAudioCooldown = 5;
        if (elemId === CA_WATER) playSfx(0, { pitchScale: 0.9 + (rand() % 6) * 0.08, velocity: 0.35 });
        else if (elemId === CA_EMBER) playSfx(1, { pitchScale: 1.0, velocity: 0.45 });
        else if (elemId === CA_SEED) playSfx(3, { pitchScale: 1.1, velocity: 0.35 });
        else playSfx(5, { pitchScale: 0.85 + (rand() % 5) * 0.06, velocity: 0.3 });
      }
    }

    // Canvas direct tap listener so tapping y = 0..10 immediately switches dispenser without waiting
    const canvasEl = typeof document !== 'undefined' ? document.getElementById('bf-screen') : null;
    if (canvasEl && typeof canvasEl.addEventListener === 'function') {
      const onCanvasDown = (ev) => {
        if (myMountId !== activeAlchemistMount || cleanedUp) return;
        const rect = canvasEl.getBoundingClientRect();
        const lx = ((ev.clientX - rect.left) / (rect.width || 128)) * 128;
        const ly = ((ev.clientY - rect.top) / (rect.height || 128)) * 128;
        if (ly >= 0 && ly <= TOP_BAR_H) {
          const idx = Math.max(0, Math.min(ELEMENTS.length - 1, Math.floor(lx / (SIZE / ELEMENTS.length))));
          selectElement(idx);
          draggingTopBar = true;
        }
      };
      canvasEl.addEventListener('pointerdown', onCanvasDown);
      busCleanups.push(() => canvasEl.removeEventListener('pointerdown', onCanvasDown));
    }

    function stepCellularAutomata() {
      stamp = (stamp % 250) + 1;
      let steamCount = 0;
      let fireCount = 0;
      let bloomCount = 0;

      // Pass 1: Bottom-up for falling elements & reactions
      for (let y = SIZE - 2; y >= TOP_BAR_H; y--) {
        const leftToRight = ((y + simTick) & 1) === 0;
        for (let stepX = 1; stepX < SIZE - 1; stepX++) {
          const x = leftToRight ? stepX : (SIZE - 1 - stepX);
          const idx = y * SIZE + x;
          if (worldSolidMask[idx] || stepStamp[idx] === stamp) continue;
          const cell = caGrid[idx];
          if (cell === CA_EMPTY || cell === CA_STONE || cell === CA_STEAM || cell === CA_FIRE) continue;

          if (cell === CA_SAND) {
            const belowIdx = (y + 1) * SIZE + x;
            const belowType = cellTypeAt(x, y + 1);
            if (belowType === CA_EMPTY || belowType === CA_WATER || belowType === CA_OIL) {
              swapCells(idx, belowIdx);
            } else {
              const dir = (rand() & 1) ? 1 : -1;
              const d1 = cellTypeAt(x + dir, y + 1);
              const d2 = cellTypeAt(x - dir, y + 1);
              if (d1 === CA_EMPTY || d1 === CA_WATER || d1 === CA_OIL) {
                swapCells(idx, (y + 1) * SIZE + (x + dir));
              } else if (d2 === CA_EMPTY || d2 === CA_WATER || d2 === CA_OIL) {
                swapCells(idx, (y + 1) * SIZE + (x - dir));
              }
            }
          } else if (cell === CA_WATER || cell === CA_OIL) {
            const belowType = cellTypeAt(x, y + 1);
            if (belowType === CA_EMPTY || (cell === CA_WATER && belowType === CA_OIL)) {
              swapCells(idx, (y + 1) * SIZE + x);
            } else {
              const dir = (rand() & 1) ? 1 : -1;
              const diagA = cellTypeAt(x + dir, y + 1);
              const diagB = cellTypeAt(x - dir, y + 1);
              if (diagA === CA_EMPTY || (cell === CA_WATER && diagA === CA_OIL)) {
                swapCells(idx, (y + 1) * SIZE + (x + dir));
              } else if (diagB === CA_EMPTY || (cell === CA_WATER && diagB === CA_OIL)) {
                swapCells(idx, (y + 1) * SIZE + (x - dir));
              } else {
                const sideA = cellTypeAt(x + dir, y);
                const sideB = cellTypeAt(x - dir, y);
                if (sideA === CA_EMPTY) swapCells(idx, y * SIZE + (x + dir));
                else if (sideB === CA_EMPTY) swapCells(idx, y * SIZE + (x - dir));
              }
            }
          } else if (cell === CA_SEED) {
            // Check adjacent water -> sprout into growing pixelvine
            let nourished = false;
            const dirs = [-1, 1, -SIZE, SIZE];
            for (let d = 0; d < 4; d++) {
              const nIdx = idx + dirs[d];
              if (nIdx >= TOP_BAR_H * SIZE && nIdx < SIZE * SIZE && caGrid[nIdx] === CA_WATER) {
                caGrid[nIdx] = CA_EMPTY;
                nourished = true;
                break;
              }
            }
            if (nourished) {
              caGrid[idx] = CA_VINE;
              caLife[idx] = 18;
              bloomCount++;
            } else if (cellTypeAt(x, y + 1) === CA_EMPTY) {
              swapCells(idx, (y + 1) * SIZE + x);
            } else if (cellTypeAt(x, y + 1) === CA_SAND || cellTypeAt(x, y + 1) === CA_VINE) {
              if ((rand() & 31) === 0) {
                caGrid[idx] = CA_VINE;
                caLife[idx] = 10;
              }
            }
          } else if (cell === CA_VINE) {
            if (caLife[idx] > 0 && (simTick & 3) === 0 && y > TOP_BAR_H + 4) {
              // Drink nearby water to extend growth
              for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx > 0 && nx < SIZE - 1 && ny >= TOP_BAR_H && ny < SIZE - 1) {
                    const nIdx = ny * SIZE + nx;
                    if (caGrid[nIdx] === CA_WATER) {
                      caGrid[nIdx] = CA_EMPTY;
                      caLife[idx] = Math.min(25, caLife[idx] + 5);
                      break;
                    }
                  }
                }
              }
              const growDx = (rand() % 3) - 1;
              const gx = x + growDx;
              const gy = y - 1;
              if (isOpenForGas(gx, gy) && (rand() & 3) === 0) {
                const gIdx = gy * SIZE + gx;
                caGrid[gIdx] = caLife[idx] <= 2 ? CA_BLOSSOM : CA_VINE;
                caLife[gIdx] = caLife[idx] - 1;
                caLife[idx] = 0;
                stepStamp[gIdx] = stamp;
                bloomCount++;
              }
            }
          } else if (cell === CA_EMBER) {
            if (caLife[idx] > 0) caLife[idx]--;
            // React with neighbors: boil water -> steam, ignite oil/vine/seed -> fire
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx <= 0 || nx >= SIZE - 1 || ny < TOP_BAR_H || ny >= SIZE - 1) continue;
                const nIdx = ny * SIZE + nx;
                const nt = caGrid[nIdx];
                if (nt === CA_WATER) {
                  caGrid[nIdx] = CA_STEAM;
                  caLife[nIdx] = 55;
                  caGrid[idx] = CA_STONE;
                  steamCount++;
                } else if (nt === CA_OIL || nt === CA_VINE || nt === CA_SEED || nt === CA_BLOSSOM) {
                  caGrid[nIdx] = CA_FIRE;
                  caLife[nIdx] = 28 + (rand() & 15);
                  fireCount++;
                }
              }
            }
            if (caGrid[idx] === CA_EMBER) {
              if (y > TOP_BAR_H + 1 && isOpenForGas(x, y - 1) && (rand() & 3) === 0) {
                caGrid[(y - 1) * SIZE + x] = CA_FIRE;
                caLife[(y - 1) * SIZE + x] = 14 + (rand() & 7);
              }
              if (cellTypeAt(x, y + 1) === CA_EMPTY) {
                swapCells(idx, (y + 1) * SIZE + x);
              } else if (caLife[idx] === 0) {
                caGrid[idx] = CA_EMPTY;
              }
            }
          }
        }
      }

      // Pass 2: Top-down for rising STEAM & FIRE
      for (let y = TOP_BAR_H + 1; y < SIZE - 1; y++) {
        for (let x = 1; x < SIZE - 1; x++) {
          const idx = y * SIZE + x;
          if (worldSolidMask[idx] || stepStamp[idx] === stamp) continue;
          const cell = caGrid[idx];
          if (cell !== CA_STEAM && cell !== CA_FIRE) continue;

          if (caLife[idx] <= 1) {
            caGrid[idx] = (cell === CA_STEAM && (rand() & 7) === 0 && y < TOP_BAR_H + 12) ? CA_WATER : CA_EMPTY;
            caLife[idx] = 0;
            continue;
          }
          caLife[idx]--;

          if (cell === CA_FIRE) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx <= 0 || nx >= SIZE - 1 || ny < TOP_BAR_H || ny >= SIZE - 1) continue;
                const nIdx = ny * SIZE + nx;
                if (caGrid[nIdx] === CA_OIL || caGrid[nIdx] === CA_VINE || caGrid[nIdx] === CA_BLOSSOM) {
                  caGrid[nIdx] = CA_FIRE;
                  caLife[nIdx] = 24 + (rand() & 15);
                  fireCount++;
                } else if (caGrid[nIdx] === CA_WATER) {
                  caGrid[nIdx] = CA_STEAM;
                  caLife[nIdx] = 48;
                  caGrid[idx] = CA_EMPTY;
                  steamCount++;
                }
              }
            }
          }

          if (caGrid[idx] === cell) {
            const drift = (rand() % 3) - 1;
            if (y > TOP_BAR_H + 1 && isOpenForGas(x + drift, y - 1)) {
              swapCells(idx, (y - 1) * SIZE + (x + drift));
            } else if (isOpenForGas(x + drift, y)) {
              swapCells(idx, y * SIZE + (x + drift));
            }
          }
        }
      }

      if (audioCooldown <= 0) {
        if (fireCount > 0) {
          audioCooldown = 6;
          scoreTotal += fireCount;
          if (typeof helpers.addScore === 'function') helpers.addScore(fireCount);
          playSfx(6, { pitchScale: 0.8 + (rand() % 5) * 0.08, velocity: 0.55 });
        } else if (steamCount > 0) {
          audioCooldown = 7;
          scoreTotal += steamCount;
          if (typeof helpers.addScore === 'function') helpers.addScore(steamCount);
          playSfx(4, { pitchScale: 1.0 + (rand() % 4) * 0.1, velocity: 0.42 });
        } else if (bloomCount > 0) {
          audioCooldown = 10;
          scoreTotal += bloomCount * 3;
          if (typeof helpers.addScore === 'function') helpers.addScore(bloomCount * 3);
          const f = quantizeRowToFreq('lofiMaj9', 4 + (rand() % 8), 4);
          if (helpers.dsp && typeof helpers.dsp.playNote === 'function') {
            helpers.dsp.playNote(1, f, 0.2, 0.4, { dutyOrTimbre: 70 });
          }
          playSfx(3, { pitchScale: f / 440, velocity: 0.4 });
        }
      }
    }

    k.onUpdate(() => {
      simTick++;
      if (audioCooldown > 0) audioCooldown--;
      if (pourAudioCooldown > 0) pourAudioCooldown--;

      // Keep DOM pills mounted if arcade-core updated hudStrip textContent
      if (isPlayVisible && !cleanedUp && hudEl && pillBarEl && pillBarEl.parentNode !== hudEl) {
        hudEl.appendChild(pillBarEl);
      }

      const live = getLiveCart();
      if (simTick % 15 === 0) {
        syncWorldSolidMask(live?.world);
      }

      const spring = helpers.touchVerbs ? helpers.touchVerbs.getState().springDrag : null;
      if (spring && spring.active) {
        if (!prevSpringActive) {
          if (spring.target.y <= TOP_BAR_H) {
            const idx = Math.max(0, Math.min(ELEMENTS.length - 1, Math.floor(spring.target.x / (SIZE / ELEMENTS.length))));
            selectElement(idx);
            draggingTopBar = true;
          } else {
            draggingTopBar = false;
          }
        }
        if (!draggingTopBar && spring.pos.y >= TOP_BAR_H) {
          paintElementAt(spring.pos.x, spring.pos.y, ELEMENTS[selectedElemIdx].id);
        }
        prevSpringActive = true;
      } else {
        prevSpringActive = false;
        draggingTopBar = false;
      }

      stepCellularAutomata();
    });

    k.onDraw(() => {
      const live = getLiveCart();
      const cam = k.getCameraOffset();

      // 1. Top 10px interactive canvas element dispenser bar (y = 0..9)
      for (let y = 0; y < TOP_BAR_H; y++) {
        for (let x = 0; x < SIZE; x++) {
          k.drawPixel(x, y, 1, 2);
        }
      }
      for (let i = 0; i < ELEMENTS.length; i++) {
        const elDef = ELEMENTS[i];
        const x0 = 1 + i * 21;
        const w = 19;
        const selected = i === selectedElemIdx;
        for (let py = 1; py <= 8; py++) {
          for (let px = 0; px < w; px++) {
            const onEdge = py === 1 || py === 8 || px === 0 || px === w - 1;
            const col = onEdge ? (selected ? 4 : 2) : elDef.colorIdx;
            k.drawPixel(x0 + px, py, col, 2);
          }
        }
        // Crisp 4x5 mini glyph centered inside pill
        for (let gy = 0; gy < 5; gy++) {
          const bits = elDef.glyph[gy];
          for (let gx = 0; gx < 4; gx++) {
            if ((bits & (8 >> gx)) !== 0) {
              k.drawPixel(x0 + 7 + gx, 2 + gy, selected ? 4 : 1, 2);
            }
          }
        }
      }

      // 2. Render 128x128 CA terrarium grid (y = 10..127)
      for (let y = TOP_BAR_H; y < SIZE; y++) {
        const rowOff = y * SIZE;
        for (let x = 0; x < SIZE; x++) {
          const cell = caGrid[rowOff + x];
          if (cell === CA_EMPTY) continue;
          let col = 0;
          const shimmer = ((x + y + (simTick >> 2)) & 3) === 0;
          if (cell === CA_SAND) col = ((x ^ y) & 1) ? 7 : 15;
          else if (cell === CA_WATER) col = shimmer ? 4 : (((x + (simTick >> 3)) & 3) === 0 ? 10 : 11);
          else if (cell === CA_SEED) col = 14;
          else if (cell === CA_OIL) col = ((x + y) & 1) ? 12 : 2;
          else if (cell === CA_EMBER) col = ((simTick + x * 3 + y) & 3) === 0 ? 7 : 5;
          else if (cell === CA_STONE) col = ((x ^ y) & 1) ? 3 : 2;
          else if (cell === CA_STEAM) col = ((simTick + x + y) & 1) ? 4 : 15;
          else if (cell === CA_VINE) col = ((x + y) & 1) ? 8 : 9;
          else if (cell === CA_FIRE) col = ((simTick + y) & 1) ? 6 : 7;
          else if (cell === CA_BLOSSOM) col = 13;
          k.drawPixel(x + cam.x, y + cam.y, col, cell === CA_STONE ? 2 : 1);
        }
      }

      // 3. Render live autotiled world stones/vessels from live cart
      const world = live?.world;
      if (world) {
        const w = world.width === 32 ? 32 : 16;
        const h = world.height === 32 ? 32 : 16;
        const drawLayer = (grid, layerId) => {
          if (!grid || grid.length < w * h) return;
          for (let ty = 0; ty < h; ty++) {
            const pyBase = ty * 8 + cam.y;
            if (pyBase < TOP_BAR_H) continue;
            for (let tx = 0; tx < w; tx++) {
              const tid = grid[ty * w + tx];
              if (!tid) continue;
              const pxBase = tx * 8 + cam.x;
              if (tid >= 8 && live.sprites?.[tid - 8]) {
                k.drawSpriteSlot(tid - 8, pxBase, pyBase, { sprites: live.sprites, layer: layerId });
              } else {
                const mask = computeAutotileMask(grid, w, h, tx, ty);
                renderAutotile8x8(tid, resolveAutotileIndex(mask), simTick, tileScratch);
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

      // 4. Dispenser reticle & live cover sprite preview on spring-drag position
      const spring = helpers.touchVerbs ? helpers.touchVerbs.getState().springDrag : null;
      if (spring && spring.pos.y >= TOP_BAR_H) {
        const rx = Math.round(spring.pos.x + cam.x);
        const ry = Math.round(spring.pos.y + cam.y);
        const col = ELEMENTS[selectedElemIdx].colorIdx;
        k.drawPixel(rx - 2, ry, col, 2);
        k.drawPixel(rx + 2, ry, col, 2);
        k.drawPixel(rx, ry - 2, col, 2);
        k.drawPixel(rx, ry + 2, col, 2);
      }

      // Cover flask icon in corner
      const slotIdx = live?.meta?.coverSpriteIdx ?? 0;
      k.drawSpriteSlot(slotIdx, 114 + cam.x, 12 + cam.y, {
        sprites: live?.sprites,
        frame: ((simTick >> 4) & 1),
        layer: 2,
      });
      k.drawText5x7(`${scoreTotal}`, 10, 13, 4, { shadow: 1 });
    });
  });

  k.go('alchemist-glass');
}
