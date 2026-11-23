/**
 * BitForge-80 Console Entry & System Coordinator
 * Rehydrates vault storage, mounts DSP + ASMR foley + 60 FPS arcade runtime + studio editors,
 * runs the 850ms dock ceremony, and handles DAILY, SYNC, MINT, CRACK, and DECK actions.
 */

import { EVENT_NAMES, createEventBus, createChassisShell } from './ui/chassis-shell.js';
import { createBezelWheel } from './ui/bezel-wheel.js';
import { runDockCeremony } from './ui/dock-ceremony.js';
import {
  initVaultCoordinator,
  getInitialBootPayload,
  commitActiveCart,
  snapshotToRingBuffer,
  getSnapshots,
  resetDailyRitual,
  exportVaultJson,
  importVaultJson,
  bakeStandaloneHtml,
} from './vault/storage-coordinator.js';
import {
  createEmptyCartridgeROM,
  cloneCartridgeROM,
  validateCartridgeROM,
  encodeCartToHash,
  decodeCartFromHash,
} from './cart/bitpack-rom.js';
import { mountHoloCardModal } from './cart/holo-card-export.js';
import { PALETTE_ORDER, getPalette } from './studio/palettes.js';
import { createSpriteEditor } from './studio/sprite-editor.js';
import { createWorldEditor } from './studio/autotile-world.js';
import { createDspEngine } from './audio/dsp-engine.js';
import { createAudioStudio } from './audio/tenori-sequencer.js';
import { createAsmrFoley } from './audio/asmr-foley.js';
import { createArcadeRuntime } from './runtime/arcade-core.js';
import { createRulesEditor } from './runtime/js-drawer.js';
import {
  PACK_IN_GAMES,
  getDefaultPackInROM,
  listPackInMetadata,
} from './cartridges/pack-in-index.js';

function sanitizeFileSlug(title) {
  const clean = String(title || 'bitforge-cart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'bitforge-cart';
}

function triggerBlobDownload(blob, filename) {
  if (typeof document === 'undefined' || !blob) return;
  const urlApi = typeof URL !== 'undefined' ? URL : globalThis.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function') return;
  const url = urlApi.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    try {
      urlApi.revokeObjectURL(url);
    } catch {
      // Ignore cleanup failures
    }
  }, 1000);
}

function resolveCartPalette(rom) {
  const pid = rom?.meta?.paletteId || 'classic16';
  const custom = rom?.meta?.customPalette instanceof Uint8Array && rom.meta.customPalette.length >= 48
    ? rom.meta.customPalette
    : null;
  return getPalette(pid, custom);
}

function drawMiniSpritePreview(canvas, rom, palette) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = palette.hex[0] || '#12131a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const idx = Math.max(0, Math.min(31, rom?.meta?.coverSpriteIdx ?? 0));
  const slot = rom?.sprites?.[idx];
  const frame = slot?.frames?.[0];
  if (!frame) return;

  const size = slot.size === 16 ? 16 : 8;
  const scale = Math.max(1, Math.floor(canvas.width / size));
  const ox = Math.floor((canvas.width - size * scale) / 2);
  const oy = Math.floor((canvas.height - size * scale) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = frame[y * size + x] & 15;
      if (c === 0) continue;
      ctx.fillStyle = palette.hex[c] || '#e8ecf5';
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
}

function resolveSafeRom(candidate) {
  if (candidate && validateCartridgeROM(candidate).ok) {
    return candidate;
  }
  try {
    const packIn = getDefaultPackInROM('sling-slime');
    if (packIn && validateCartridgeROM(packIn).ok) {
      return cloneCartridgeROM(packIn);
    }
  } catch {
    // Fall through to empty ROM template
  }
  return createEmptyCartridgeROM({ id: 'bitforge-boot', title: 'BITFORGE-80' });
}

function buildMintShareUrl(hashStr) {
  try {
    if (typeof location !== 'undefined' && location.href) {
      return new URL(hashStr, location.href).href;
    }
  } catch {
    // Ignore non-hierarchical URL schemes
  }
  return hashStr;
}

function replaceUrlHashSafely(hashStr) {
  try {
    if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
      history.replaceState(null, '', hashStr);
      return;
    }
  } catch {
    // Fall back to location.hash assignment when replaceState is restricted
  }
  try {
    if (typeof location !== 'undefined') {
      location.hash = hashStr;
    }
  } catch {
    // Ignore read-only location contexts
  }
}

/**
 * Boot the full BitForge-80 tactile console inside `rootEl`.
 * @param {{ rootEl?: HTMLElement|null, ceremonyDurationMs?: number }} [opts]
 */
export async function bootBitForgeConsole({ rootEl = null, ceremonyDurationMs = 850 } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const targetEl = rootEl || (doc ? doc.getElementById('app') : null);
  if (!targetEl) return null;

  const bus = createEventBus();
  const shell = createChassisShell({ rootEl: targetEl, bus });
  let activeCart = resolveSafeRom(null);
  let activeHash = encodeCartToHash(activeCart);
  let dirtyForPlay = false;
  let crackedDraft = false;
  let activeHoloModal = null;
  let currentStudio = null;
  let ledRafId = null;
  let destroyed = false;

  const dsp = createDspEngine({ bus });
  const foley = createAsmrFoley({
    dsp,
    bus,
    getCart: () => activeCart,
  });

  await initVaultCoordinator({
    encodeCart: encodeCartToHash,
    decodeCart: decodeCartFromHash,
    encodeCartToHash,
    decodeCartFromHash,
    getDefaultRom: () => resolveSafeRom(null),
  });

  const vaultApi = globalThis.__BITFORGE_VAULT__;
  const bootPayload = vaultApi && typeof vaultApi.getInitialBootPayload === 'function'
    ? vaultApi.getInitialBootPayload()
    : getInitialBootPayload();

  if (bootPayload && typeof bootPayload.cartHash === 'string' && bootPayload.cartHash.length > 0) {
    const decoded = decodeCartFromHash(bootPayload.cartHash);
    if (decoded && decoded.ok) {
      activeCart = resolveSafeRom(decoded.rom);
      activeHash = decoded.hash || encodeCartToHash(activeCart);
    }
  }

  const hudBridge = {
    get textContent() {
      return shell.hudTextEl.textContent;
    },
    set textContent(v) {
      shell.hudTextEl.textContent = String(v ?? '');
    },
    get ownerDocument() {
      return shell.hudStripEl.ownerDocument;
    },
    get children() {
      return shell.hudStripEl.children;
    },
    get childNodes() {
      return shell.hudStripEl.childNodes;
    },
    querySelectorAll(sel) {
      return typeof shell.hudStripEl.querySelectorAll === 'function'
        ? shell.hudStripEl.querySelectorAll(sel)
        : [];
    },
    appendChild(node) {
      return shell.hudStripEl.appendChild(node);
    },
    removeChild(node) {
      return shell.hudStripEl.removeChild(node);
    },
  };

  const runtime = createArcadeRuntime({
    canvas: shell.screenCanvas,
    hudStrip: hudBridge,
    getCart: () => activeCart,
    packInRegistry: PACK_IN_GAMES,
    dsp,
    bus,
  });

  const bezelWheel = createBezelWheel({
    element: shell.bezelWheelEl,
    bus,
    detents: 48,
    runtime,
  });

  function handleStudioMutate() {
    if (!activeCart) return;
    activeCart.meta.updatedAt = Date.now();
    activeHash = encodeCartToHash(activeCart);
    shell.setCartMeta(activeCart, activeHash.length);
    dsp.syncCart(activeCart);
    dirtyForPlay = true;
    commitActiveCart(activeHash, activeCart).catch(() => {});
  }

  const spriteEditor = createSpriteEditor({
    container: shell.studioStageEl,
    toolStrip: shell.toolStripEl,
    getCart: () => activeCart,
    onMutate: handleStudioMutate,
    bus,
  });

  const worldEditor = createWorldEditor({
    container: shell.studioStageEl,
    toolStrip: shell.toolStripEl,
    getCart: () => activeCart,
    onMutate: handleStudioMutate,
    bus,
  });

  const audioStudio = createAudioStudio({
    container: shell.studioStageEl,
    toolStrip: shell.toolStripEl,
    getCart: () => activeCart,
    onMutate: handleStudioMutate,
    dsp,
    bus,
  });

  const rulesEditor = createRulesEditor({
    container: shell.studioStageEl,
    toolStrip: shell.toolStripEl,
    getCart: () => activeCart,
    onMutate: handleStudioMutate,
    bus,
  });

  const studioEditors = {
    sprite: spriteEditor,
    world: worldEditor,
    audio: audioStudio,
    rules: rulesEditor,
  };

  function unmountActiveStudio() {
    if (currentStudio && typeof currentStudio.unmount === 'function') {
      currentStudio.unmount();
    }
    currentStudio = null;
    shell.studioStageEl.innerHTML = '';
    shell.toolStripEl.innerHTML = '';
  }

  async function bootCartridge(rom, { commit = true, runCeremony = true, notice = '' } = {}) {
    activeCart = resolveSafeRom(rom);
    activeHash = encodeCartToHash(activeCart);
    dirtyForPlay = false;

    const palette = resolveCartPalette(activeCart);
    shell.setCartMeta(activeCart, activeHash.length);
    shell.setCrackedState(crackedDraft);
    dsp.syncCart(activeCart);
    bus.emit(EVENT_NAMES.PALETTE_CHANGE, { paletteId: palette.id, palette });

    if (commit) {
      await commitActiveCart(activeHash, activeCart).catch(() => {});
    }

    if (currentStudio && typeof currentStudio.refresh === 'function') {
      currentStudio.refresh();
    }

    if (shell.getMode() !== 'play') {
      unmountActiveStudio();
      shell.setMode('play', { silent: true });
    }

    runtime.stop();
    runtime.setPalette(palette);

    if (notice) {
      shell.showNotice(notice, 2200);
    }

    if (runCeremony) {
      await runDockCeremony({
        canvas: shell.screenCanvas,
        rom: activeCart,
        palette,
        dsp,
        bus,
        durationMs: ceremonyDurationMs,
      });
    }

    if (destroyed) return;
    runtime.rebootCartridge(activeCart, palette);
    if (shell.getMode() === 'play') {
      runtime.start();
    }
  }

  // Mode Tabs Orchestration
  const unsubMode = bus.on(EVENT_NAMES.MODE_CHANGE, ({ mode } = {}) => {
    unmountActiveStudio();
    if (mode === 'play') {
      shell.hudTextEl.textContent = `VERB: ${String(activeCart?.meta?.primaryVerb || 'slingshot').toUpperCase()}`;
      const palette = resolveCartPalette(activeCart);
      runtime.setPalette(palette);
      if (dirtyForPlay) {
        dirtyForPlay = false;
        runtime.rebootCartridge(activeCart, palette);
      }
      runtime.start();
      return;
    }

    runtime.stop();
    const editor = studioEditors[mode];
    if (editor && typeof editor.mount === 'function') {
      currentStudio = editor;
      editor.mount();
      shell.hudTextEl.textContent = `STUDIO // ${mode.toUpperCase()}`;
    }
  });

  // Top Bezel Action: DAILY Ritual Reset
  shell.onAction('daily', async () => {
    const dailyRom = await resetDailyRitual({
      encodeCart: encodeCartToHash,
      onShutter: () => {
        shell.triggerShutterFlash();
        dsp.playSfxSlot?.(6, 0.7);
      },
    });
    crackedDraft = false;
    if (typeof location !== 'undefined' && location.hash.startsWith('#cart=')) {
      replaceUrlHashSafely(encodeCartToHash(dailyRom));
    }
    await bootCartridge(dailyRom, {
      commit: true,
      runCeremony: true,
      notice: `DAILY SEED // ${dailyRom.meta.id.toUpperCase()}`,
    });
  });

  // Top Bezel Action: SYNC Vault Backup & 1-Tap Standalone HTML Baker
  shell.onAction('sync', async () => {
    const snapshots = await getSnapshots().catch(() => []);
    shell.openModal({
      title: 'LOCAL SYNC // VAULT & BAKER',
      render(bodyEl, { close }) {
        const slug = sanitizeFileSlug(activeCart?.meta?.title);

        // Export .bitforge.json + 1-Tap Standalone .html
        const exportSection = doc.createElement('div');
        exportSection.className = 'bf-modal-section';

        const exportLabel = doc.createElement('div');
        exportLabel.className = 'bf-modal-label';
        exportLabel.textContent = 'EXPORT VAULT OR AIR-GAPPED STANDALONE CARTRIDGE';
        exportSection.appendChild(exportLabel);

        const exportActions = doc.createElement('div');
        exportActions.className = 'bf-modal-actions';

        const jsonExportBtn = doc.createElement('button');
        jsonExportBtn.type = 'button';
        jsonExportBtn.className = 'bf-modal-btn';
        jsonExportBtn.textContent = 'EXPORT .BITFORGE.JSON';
        jsonExportBtn.addEventListener('click', async () => {
          const blob = await exportVaultJson();
          triggerBlobDownload(blob, `${slug}.bitforge.json`);
          statusEl.dataset.error = 'false';
          statusEl.textContent = 'Exported .bitforge.json vault backup.';
        });
        exportActions.appendChild(jsonExportBtn);

        const htmlExportBtn = doc.createElement('button');
        htmlExportBtn.type = 'button';
        htmlExportBtn.className = 'bf-modal-btn bf-modal-btn-primary';
        htmlExportBtn.textContent = '1-TAP STANDALONE .HTML';
        htmlExportBtn.addEventListener('click', async () => {
          htmlExportBtn.disabled = true;
          htmlExportBtn.textContent = 'BAKING...';
          try {
            const blob = await bakeStandaloneHtml(activeHash, activeCart?.meta?.title || 'BitForge-80');
            triggerBlobDownload(blob, `${slug}-standalone.html`);
            statusEl.dataset.error = 'false';
            statusEl.textContent = 'Baked zero-dependency offline .html cartridge!';
          } catch (err) {
            statusEl.dataset.error = 'true';
            statusEl.textContent = err?.message || 'Standalone bake unavailable in this context.';
          } finally {
            htmlExportBtn.disabled = false;
            htmlExportBtn.textContent = '1-TAP STANDALONE .HTML';
          }
        });
        exportActions.appendChild(htmlExportBtn);
        exportSection.appendChild(exportActions);
        bodyEl.appendChild(exportSection);

        // Import .bitforge.json (File Picker + Drag & Drop)
        const importSection = doc.createElement('div');
        importSection.className = 'bf-modal-section';

        const importLabel = doc.createElement('div');
        importLabel.className = 'bf-modal-label';
        importLabel.textContent = 'IMPORT .BITFORGE.JSON BACKUP';
        importSection.appendChild(importLabel);

        const dropzone = doc.createElement('div');
        dropzone.className = 'bf-dropzone';
        dropzone.textContent = 'DROP .BITFORGE.JSON HERE OR TAP TO SELECT FILE';

        const fileInput = doc.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,.bitforge.json,application/json';
        fileInput.hidden = true;

        const handleJsonFile = async (file) => {
          if (!file) return;
          try {
            const text = await file.text();
            const imported = await importVaultJson(text);
            close();
            await bootCartridge(imported.activeCart, {
              commit: true,
              runCeremony: true,
              notice: `VAULT RESTORED (${imported.importedCount} ITEMS)`,
            });
          } catch (err) {
            statusEl.dataset.error = 'true';
            statusEl.textContent = err?.message || 'Invalid .bitforge.json vault file.';
          }
        };

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          dropzone.dataset.dragover = 'true';
        });
        dropzone.addEventListener('dragleave', () => {
          dropzone.dataset.dragover = 'false';
        });
        dropzone.addEventListener('drop', (ev) => {
          ev.preventDefault();
          dropzone.dataset.dragover = 'false';
          const file = ev.dataTransfer?.files?.[0];
          handleJsonFile(file);
        });
        fileInput.addEventListener('change', () => {
          const file = fileInput.files?.[0];
          handleJsonFile(file);
        });

        importSection.appendChild(dropzone);
        importSection.appendChild(fileInput);
        bodyEl.appendChild(importSection);

        // Ring Buffer Snapshots
        if (snapshots.length > 0) {
          const snapSection = doc.createElement('div');
          snapSection.className = 'bf-modal-section';

          const snapLabel = doc.createElement('div');
          snapLabel.className = 'bf-modal-label';
          snapLabel.textContent = `RING BUFFER SNAPSHOTS (${snapshots.length}/32)`;
          snapSection.appendChild(snapLabel);

          const list = doc.createElement('div');
          list.className = 'bf-snap-list';
          for (const snap of snapshots.slice(0, 6)) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'bf-snap-item';
            const dateStr = new Date(snap.ts || Date.now()).toLocaleTimeString();
            btn.innerHTML = '';
            const left = doc.createElement('span');
            left.textContent = `SLOT ${String(snap.slot).padStart(2, '0')} // ${snap.reason}`;
            const right = doc.createElement('span');
            right.className = 'bf-deck-sub';
            right.textContent = `${dateStr} (${snap.cartHash.length}B)`;
            btn.appendChild(left);
            btn.appendChild(right);
            btn.addEventListener('click', async () => {
              const dec = decodeCartFromHash(snap.cartHash);
              if (!dec.ok) {
                statusEl.dataset.error = 'true';
                statusEl.textContent = 'Snapshot payload could not be decoded.';
                return;
              }
              close();
              await bootCartridge(dec.rom, {
                commit: true,
                runCeremony: true,
                notice: `RESTORED SLOT ${snap.slot}`,
              });
            });
            list.appendChild(btn);
          }
          snapSection.appendChild(list);
          bodyEl.appendChild(snapSection);
        }

        const statusEl = doc.createElement('div');
        statusEl.className = 'bf-modal-status';
        statusEl.textContent = `Active cartridge: ${activeHash.length} bytes`;
        bodyEl.appendChild(statusEl);
      },
    });
  });

  // Top Bezel Action: MINT URL + Holographic Collector Card
  shell.onAction('mint', async () => {
    if (activeHoloModal && typeof activeHoloModal.destroy === 'function') {
      activeHoloModal.destroy();
      activeHoloModal = null;
    }
    shell.closeModal();

    activeCart.meta.updatedAt = Date.now();
    activeHash = encodeCartToHash(activeCart);
    shell.setCartMeta(activeCart, activeHash.length);
    await commitActiveCart(activeHash, activeCart).catch(() => {});

    replaceUrlHashSafely(activeHash);
    const cartUrl = buildMintShareUrl(activeHash);
    const palette = resolveCartPalette(activeCart);

    bus.emit(EVENT_NAMES.CART_MINTED, {
      hash: activeHash,
      cartUrl,
      byteLength: activeHash.length,
      rom: activeCart,
    });

    activeHoloModal = mountHoloCardModal({
      container: shell.modalRootEl,
      rom: activeCart,
      cartUrl,
      paletteHex16: Array.from(palette.hex),
      onClose: () => {
        activeHoloModal = null;
      },
    });
  });

  // Top Bezel Action: CRACK Cartridge Into Live Studio Editor
  shell.onAction('crack', () => {
    if (!activeCart.logic) {
      activeCart.logic = { presetGameId: null, ruleChips: [], customJs: '' };
    }
    const presetGameId = activeCart.logic.presetGameId ?? null;
    activeCart.logic.presetGameId = presetGameId;
    crackedDraft = true;
    shell.setCrackedState(true);
    shell.triggerShutterFlash();
    shell.showNotice(
      presetGameId ? `CRACKED ${presetGameId.toUpperCase()} // LIVE EDIT` : 'DRAFT MODE // LIVE EDIT',
      2200
    );
    shell.setMode('sprite');
  });

  // Top Bezel Action: DECK Pack-In Cartridge Launcher Drawer
  shell.onAction('deck', () => {
    const entries = listPackInMetadata();
    shell.openModal({
      title: 'CARTRIDGE DECK // PACK-INS',
      render(bodyEl, { close }) {
        const list = doc.createElement('div');
        list.className = 'bf-deck-list';

        for (const item of entries) {
          const romPreview = resolveSafeRom(getDefaultPackInROM(item.id));
          const pal = resolveCartPalette(romPreview);
          const hashLen = encodeCartToHash(romPreview).length;

          const card = doc.createElement('button');
          card.type = 'button';
          card.className = 'bf-deck-item';

          const thumb = doc.createElement('canvas');
          thumb.className = 'bf-deck-thumb';
          thumb.width = 32;
          thumb.height = 32;
          drawMiniSpritePreview(thumb, romPreview, pal);
          card.appendChild(thumb);

          const meta = doc.createElement('div');
          meta.className = 'bf-deck-meta';

          const nameEl = doc.createElement('span');
          nameEl.className = 'bf-deck-name';
          nameEl.textContent = item.title || romPreview.meta.title;
          meta.appendChild(nameEl);

          const subEl = doc.createElement('span');
          subEl.className = 'bf-deck-sub';
          const verb = item.primaryVerb || romPreview.meta.primaryVerb;
          const palId = item.paletteId || romPreview.meta.paletteId;
          subEl.textContent = item.tagline
            ? `${verb} // ${palId} // ${hashLen}B — ${item.tagline}`
            : `${verb} // ${palId} // ${hashLen}B`;
          meta.appendChild(subEl);

          card.appendChild(meta);
          card.addEventListener('click', async () => {
            close();
            if (activeHash) {
              await snapshotToRingBuffer(activeHash, 'deck-swap').catch(() => {});
            }
            crackedDraft = false;
            const freshRom = cloneCartridgeROM(getDefaultPackInROM(item.id));
            if (typeof location !== 'undefined' && location.hash.startsWith('#cart=')) {
              replaceUrlHashSafely(encodeCartToHash(freshRom));
            }
            await bootCartridge(freshRom, {
              commit: true,
              runCeremony: true,
              notice: `DOCKED // ${freshRom.meta.title}`,
            });
          });
          list.appendChild(card);
        }

        // Blank Scratch Cartridge Option
        const blankBtn = doc.createElement('button');
        blankBtn.type = 'button';
        blankBtn.className = 'bf-modal-btn';
        blankBtn.textContent = '+ NEW BLANK CARTRIDGE';
        blankBtn.addEventListener('click', async () => {
          close();
          if (activeHash) {
            await snapshotToRingBuffer(activeHash, 'new-blank').catch(() => {});
          }
          crackedDraft = true;
          const blank = createEmptyCartridgeROM({
            id: `draft-${Date.now()}`,
            title: 'NEW DRAFT 80',
            author: 'MAKER',
          });
          await bootCartridge(blank, {
            commit: true,
            runCeremony: true,
            notice: 'BLANK CARTRIDGE READY',
          });
        });

        bodyEl.appendChild(list);
        bodyEl.appendChild(blankBtn);
      },
    });
  });

  // CRT Phosphor Optics Toggle
  shell.onAction('toggle-crt', () => {
    activeCart.meta.crtOptics = !activeCart.meta.crtOptics;
    shell.setCrtOptics(activeCart.meta.crtOptics);
    handleStudioMutate();
  });

  // Boutique 16-Color Palette Cycler
  shell.onAction('cycle-palette', () => {
    const idx = PALETTE_ORDER.indexOf(activeCart.meta.paletteId);
    const nextId = PALETTE_ORDER[(idx + 1) % PALETTE_ORDER.length];
    activeCart.meta.paletteId = nextId;
    activeCart.meta.customPalette = null;
    const palette = resolveCartPalette(activeCart);
    runtime.setPalette(palette);
    bus.emit(EVENT_NAMES.PALETTE_CHANGE, { paletteId: nextId, palette });
    handleStudioMutate();
    if (shell.getMode() === 'play') {
      dirtyForPlay = false;
      runtime.rebootCartridge(activeCart, palette);
    }
    shell.showNotice(`PALETTE // ${palette.name.toUpperCase()}`, 1400);
  });

  // External #cart= URL Hash Hot-Swap
  const onHashChange = async () => {
    if (typeof location === 'undefined') return;
    const h = location.hash || '';
    if (!h.startsWith('#cart=') || h.length <= 6 || h === activeHash) return;
    const decoded = decodeCartFromHash(h);
    if (!decoded.ok) {
      shell.showNotice('INVALID #CART= PAYLOAD', 2200);
      return;
    }
    if (activeHash) {
      await snapshotToRingBuffer(activeHash, 'hashchange').catch(() => {});
    }
    crackedDraft = false;
    await bootCartridge(decoded.rom, {
      commit: true,
      runCeremony: true,
      notice: `LOADED // ${decoded.rom.meta.title}`,
    });
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', onHashChange);
  }

  // Live CH1-CH4 Voice LED Pip Animation Loop
  const pumpLeds = () => {
    if (destroyed) return;
    shell.setLedLevels(dsp.getChannelLevels());
    if (typeof globalThis.requestAnimationFrame === 'function') {
      ledRafId = globalThis.requestAnimationFrame(pumpLeds);
    }
  };
  if (typeof globalThis.requestAnimationFrame === 'function') {
    ledRafId = globalThis.requestAnimationFrame(pumpLeds);
  }

  // Initial Dock & Boot (defer foley haptics if browser has no user activation yet)
  const needsActivationGate =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.userActivation) &&
    !navigator.userActivation.hasBeenActive;
  if (needsActivationGate) {
    foley.setEnabled(false);
  }
  await bootCartridge(activeCart, { commit: true, runCeremony: true });
  if (needsActivationGate && !destroyed) {
    foley.setEnabled(true);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (ledRafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(ledRafId);
    }
    if (typeof unsubMode === 'function') unsubMode();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('hashchange', onHashChange);
    }
    if (activeHoloModal && typeof activeHoloModal.destroy === 'function') {
      activeHoloModal.destroy();
    }
    unmountActiveStudio();
    bezelWheel.destroy();
    runtime.destroy();
    foley.destroy();
    dsp.destroy();
    shell.destroy();
  }

  return {
    bus,
    shell,
    dsp,
    foley,
    runtime,
    bezelWheel,
    getCart: () => activeCart,
    bootCartridge,
    destroy,
  };
}

// Auto-boot when running in a browser document containing #app
if (typeof document !== 'undefined') {
  const startApp = () => {
    const appRoot = document.getElementById('app');
    if (!appRoot) return;
    bootBitForgeConsole({ rootEl: appRoot }).then((app) => {
      try {
        globalThis.__BITFORGE_APP__ = app;
      } catch {
        // Ignore read-only global contexts
      }
    }).catch(() => {});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp, { once: true });
  } else {
    startApp();
  }
}
