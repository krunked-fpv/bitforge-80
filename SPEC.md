# BitForge-80: Technical Contract Specification (`SPEC.md`)

All modules across Gates 01-04 MUST adhere strictly to the schemas, constants, binary encodings, and exported ES signatures defined below.

---

## 1. Global Constants & PWA Contracts
- **PWA Cache Constant & Name**: `const BITFORGE_PWA_CACHE_V1 = 'bitforge-80-pwa-v1';`
- **Manifest Relative Paths**: `start_url: "./"`, `scope: "./"`, `display: "standalone"`, `background_color: "#12131a"`, `theme_color: "#12131a"`.
- **Icons**:
  - `./assets/icons/icon-192.png` (`192x192`, `"purpose": "any maskable"`)
  - `./assets/icons/icon-512.png` (`512x512`, `"purpose": "any maskable"`)
  - `./assets/icons/apple-touch-icon.png` (`180x180`)
  - Must contain authentic PNG magic bytes `89 50 4E 47 0D 0A 1A 0A`, valid `IHDR`, zlib `IDAT`, and `IEND`.
- **Logical Viewport**: `128 x 128` pixels. Integer scale `S = Math.max(1, Math.floor(Math.min(availW / 128, availH / 128)))`.

---

## 2. `CartridgeROM` Canonical Schema
```ts
interface CartridgeROM {
  magic: "BF80";
  version: 1;
  meta: {
    id: string;
    title: string;                 // max 24 chars
    author: string;                // max 16 chars
    paletteId: "classic16" | "sakura" | "matcha" | "amber" | "frost80";
    customPalette: Uint8Array | null; // null or 48 bytes (16 * RGB)
    coverSpriteIdx: number;        // 0..31
    primaryVerb: "slingshot" | "springDrag" | "tapRipple" | "ribbonSlice" | "bezelWheel";
    dropShadow1px: boolean;
    crtOptics: boolean;
    updatedAt: number;             // epoch ms (safe integer)
  };
  sprites: Array<{                 // length 32
    size: 8 | 16;
    frames: Array<Uint8Array>;     // length 1..4; each Uint8Array(size*size), values 0..15
  }>;
  world: {
    width: 16 | 32;
    height: 16 | 32;
    bgLayer: Uint8Array;           // length width*height (0..255)
    mainLayer: Uint8Array;         // length width*height (0..255)
    fgLayer: Uint8Array;           // length width*height (0..255)
    collision: Uint8Array;         // length width*height (0=none, 1=solid, 2=bounce, 3=hazard)
  };
  audio: {
    bpm: number;                   // 70..180
    scaleId: "pentatonic" | "dorian" | "lydian" | "hirajoshi" | "lofiMaj9";
    channels: Array<{              // length 4: CH1 Pulse, CH2 Triangle, CH3 Noise, CH4 Wavetable
      steps: Uint16Array;          // length 16; bitmask of active rows 0..15 (bit y = row y)
      dutyOrTimbre: number;        // 0..255
      volume: number;              // 0..100
    }>;
    wavetable32: Uint8Array;       // length 32, values 0..15
    sfxPatches: Array<{            // length 8
      archetype: number;           // 0..7
      x: number;                   // 0..255
      y: number;                   // 0..255
    }>;
  };
  logic: {
    presetGameId: null | "sling-slime" | "zen-rake" | "bezel-orbit" | "alchemist-glass" | "chroma-chisel";
    ruleChips: Array<{
      id: string;
      trigger: string;
      paramA: number;
      action: string;
      paramB: number;
      sfxSlot: number;             // 0..7
    }>;
    customJs: string;
  };
}
```

---

## 3. Binary `BF80` Codec & `#cart=` Format (`src/cart/lz-codec.js`, `src/cart/bitpack-rom.js`)
- **`lz-codec.js` exports**:
  - `compressToEncodedURIComponent(input: string): string`
  - `decompressFromEncodedURIComponent(encoded: string): string | null`
  - `compressBytesToUri(bytes: Uint8Array): string` (maps each byte `b` to Latin-1 `String.fromCharCode(b)` before compressing -> zero UTF-16 lone surrogates!)
  - `decompressBytesFromUri(encoded: string): Uint8Array | null`
- **`bitpack-rom.js` exports**:
  - `crc16Ccitt(bytes: Uint8Array): number` (poly `0x1021`, init `0xFFFF`)
  - `createEmptyCartridgeROM(overrides?: object): CartridgeROM`
  - `cloneCartridgeROM(rom: CartridgeROM): CartridgeROM`
  - `validateCartridgeROM(rom: any): { ok: boolean, errors: string[] }`
  - `encodeCartridgeToBytes(rom: CartridgeROM): Uint8Array`
  - `decodeCartridgeFromBytes(bytes: Uint8Array): CartridgeROM`
  - `encodeCartToHash(rom: CartridgeROM): string` (returns `'#cart=' + payload`; all 5 pack-ins MUST be `< 2560` bytes)
  - `decodeCartFromHash(hashOrPayload: string): { ok: true, rom: CartridgeROM, byteLength: number, hash: string } | { ok: false, error: string }` (never throws)
- **Binary Layout**:
  1. Magic `[0x42, 0x46, 0x38, 0x30]` (`"BF80"`), Version `0x01`.
  2. Flags byte (`bit0: hasCustomPalette`, `bit1: dropShadow1px`, `bit2: crtOptics`, `bit3: worldIs32`, `bit4..6: presetGameIdx 0..5`, `bit7: hasCustomJs`).
  3. `coverSpriteIdx` (`u8`), `primaryVerbIdx` (`u8`), `paletteIdx` (`u8`), `updatedAt` (`f64 LE`), `id` (`u8 len + utf8`), `title` (`u8 len + utf8`), `author` (`u8 len + utf8`).
  4. Optional 48-byte `customPalette`.
  5. `sprites` (32 slots): `u32 sizeMask` (`bit i = 1` for `16x16`), `32 x 2-bit` frame counts (`(frames.length - 1)`). Each frame starts with `modeByte`: `0` = all zeros (0 payload bytes), `1` = nibble-RLE (`[count-1 (4b) | color (4b)]` tokens), `2` = raw packed 4-bit nibbles (2 pixels/byte). Encoder picks smallest per frame!
  6. `world`: byte-RLE for `bgLayer`, `mainLayer`, `fgLayer` (`0` flag if all zero else RLE `[runLen-1, val]` with raw fallback if larger); 2-bit packed `collision` (`4` cells/byte) + RLE/zero-flag.
  7. `audio`: `bpm` (`u8`), `scaleIdx` (`u8`), 4 channels (`dutyOrTimbre u8`, `volume u8`, `u16 rowMask` indicating which of 16 steps are non-zero + only non-zero `u16 LE` step masks), 16-byte packed `wavetable32`, 8x 3-byte `sfxPatches` (`archetype`, `x`, `y`).
  8. `logic`: `u8 chipCount` + chips (`id` u8+utf8, `triggerIdx` u8 or u8+utf8, `paramA` i16 LE, `actionIdx` u8 or u8+utf8, `paramB` i16 LE, `sfxSlot` u8) + optional `customJs` (`u16 LE len + utf8`).
  9. Trailing 2-byte `CRC16-CCITT` (`u16 BE` or `LE` consistently validated over `[0 .. len - 3]`).

---

## 4. `krunked-cookie-vault-v1` & Storage Contracts (`src/vault/*`)
- **Cookie Keys**:
  - `krunked-cookie-vault-v1_meta`: URI-encoded JSON `{ v: 1, ts, crc, chunks }`
  - `krunked-cookie-vault-v1_0` .. `krunked-cookie-vault-v1_3`: URI-safe string chunks (max `3500` chars per cookie, `Max-Age=31536000; Path=/; SameSite=Lax`).
- **Primary Storage Key**: `localStorage['bitforge80.active']` -> JSON `{ v: 1, ts, crc, cartHash, summary }`.
- **IndexedDB**: Database `bitforge80_db` (v1), stores `cartridges` (keyPath `id`), `snapshots` (keyPath `slot`, `0..31` circular ring buffer).
- **`src/vault/cookie-vault-head.js`**:
  - MUST be classic non-module IIFE (zero `import` or `export` tokens!) loaded synchronously in `<head>`.
  - Attaches `globalThis.__BITFORGE_VAULT__`:
    - `_crc32(str: string): number`
    - `_rehydrateSync(env?: { storage?, getCookie?, setCookie?, hash?, bakedCart? }): BootPayload`
    - `getInitialBootPayload(): { source: 'url-hash'|'local-storage'|'shadow-cookie'|'pack-in', cartHash: string|null, healedFromCookie: boolean, regeneratedCookie: boolean }`
  - Sets `globalThis.__BITFORGE_PENDING_SNAPSHOT__` when incoming `#cart=` differs from stored local/cookie state so `storage-coordinator.js` snapshots the previous draft into IndexedDB on init.
- **`src/vault/storage-coordinator.js` exports** (and attaches async methods onto `globalThis.__BITFORGE_VAULT__`):
  - `initVaultCoordinator(opts?): Promise<void>`
  - `getInitialBootPayload()`
  - `commitActiveCart(cartHash: string, romSummary?: object): Promise<void>`
  - `snapshotToRingBuffer(cartHash: string, reason?: string): Promise<number>`
  - `getSnapshots(): Promise<Array>`
  - `resetDailyRitual(options?: { utcDate?: string, onShutter?: () => void }): Promise<CartridgeROM>`
  - `exportVaultJson(): Promise<Blob>`
  - `importVaultJson(jsonText: string): Promise<{ importedCount: number, activeCart: CartridgeROM }>`
  - `bakeStandaloneHtml(cartHash: string, title?: string): Promise<Blob>`
- **`src/vault/daily-seed.js` exports**:
  - `mulberry32(seed: number): () => number`
  - `hashDateSeed(utcDateStr: string): number`
  - `getTodayUtcString(date?: Date): string`
  - `generateDailySeedSpec(utcDateStr?: string): { utcDate, seed, paletteRgb, scaleId, sprites8x8 }`
  - `generateDailyCartridgeROM(utcDateStr?: string): CartridgeROM`
- **`src/vault/local-sync-baker.js` exports**:
  - `MODULE_MANIFEST: Array<{ path: string, type: 'css'|'head'|'module'|'icon' }>`
  - `bundleModulesInline(fileMap: Record<string, string>, entryPath?: string): string`
  - `buildStandaloneHtmlString({ cartHash, title, cssText, headVaultJs, bundledMainJs, iconBase64 }): string`
  - `bakeStandaloneHtml(cartHash: string, title?: string, customReader?: (relPath: string) => Promise<string>): Promise<Blob>`

---

## 5. QR Matrix & Holographic Card (`src/cart/qr-matrix.js`, `src/cart/holo-card-export.js`)
- **`qr-matrix.js` exports**:
  - `encodeQrMatrix(text: string, preferredEcLevel?: 'L'|'M'): { version: number, ecLevel: 'L'|'M', size: number, quietZone: number, totalSize: number, modules: Uint8Array, isSet(x: number, y: number): boolean, isQuietSet(x: number, y: number): boolean }`
  - Implements ISO/IEC 18004 Byte-mode Versions 1–40, GF(256) poly `0x11d`, Reed-Solomon multi-block interleaving, alignment patterns, timing strips, dark module `(4*version + 9, 8)`, 15-bit BCH format info, 18-bit BCH version info (`v >= 7`), 8-mask penalty evaluation, and `quietZone = 4`.
- **`holo-card-export.js` exports**:
  - `renderHoloCardSvg(rom: CartridgeROM, cartUrl: string, paletteHex16: string[]): string`
  - `renderHoloCardPngBlob(rom: CartridgeROM, cartUrl: string, paletteHex16: string[]): Promise<Blob>` (`1080x1520` nearest-neighbor PNG)
  - `mountHoloCardModal({ container, rom, cartUrl, paletteHex16, onClose }): { destroy() }`

---

## 6. Palettes, Pixel Studio & 47-Tile Autotiler (`src/studio/*`)
- **`palettes.js` exports**:
  - `PALETTES`: `{ classic16, sakura, matcha, amber, frost80 }` (16 RGB colors each; index `0` is chassis dark / transparent index in sprites).
  - `PALETTE_ORDER`: `['classic16', 'sakura', 'matcha', 'amber', 'frost80']`.
  - `getPalette(paletteId: string, customPaletteBytes?: Uint8Array | null): { id, name, hex: string[], rgb: Uint8Array, rgba32: Uint32Array, shadeMap: Uint8Array, highlightMap: Uint8Array, luminance: Float32Array }`.
- **`dither-symmetry.js` exports**:
  - `BAYER_ROLLERS` (8 named 4x4 matrices), `sampleDitherRoller(rollerIdx, x, y, fg, bg)`
  - `getSymmetryCoords(mode: 'none'|'x'|'y'|'quad'|'radial', x, y, size)`
  - `bresenhamLine(x0, y0, x1, y1)`
  - `applyOutline1px(frame, size, outlineColor)`
  - `createDominoFloodJob(frame, size, startX, startY, fillColor)`, `stepDominoFloodJob(job, ringsPerTick = 2)`
- **`autotile-world.js` exports**:
  - `AUTOTILE_47_MASKS: number[]` (length `47` canonical gated 8-bit neighbor masks `[N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128]` where corners `NE/SE/SW/NW` are cleared unless both adjacent cardinals are present: e.g. `NE` requires `N && E`)
  - `TERRAIN_TYPES`: `{ EMPTY: 0, STONE: 1, MOSS: 2, CLIFF: 3, WATER: 4, EMBER: 5, REEDS: 6, CRYSTAL: 7 }`
  - `COLLISION_FLAGS`: `{ NONE: 0, SOLID: 1, BOUNCE: 2, HAZARD: 3 }`
  - `computeAutotileMask(grid: Uint8Array, width: number, height: number, x: number, y: number): number`
  - `resolveAutotileIndex(mask: number): number` (`0..46`)
  - `resolveLayerAutotiles(grid: Uint8Array, width: number, height: number): Uint8Array`
  - `computeCastShadowMask(mainLayer: Uint8Array, fgLayer: Uint8Array, width: number, height: number): Uint8Array`
  - `renderAutotile8x8(terrainId: number, variantIdx: number, animTick: number, outPixels?: Uint8Array): Uint8Array`
  - `createWorldEditor({ container, toolStrip, getCart, onMutate, bus })`
- **`sprite-editor.js` exports**:
  - `createSpriteEditor({ container, toolStrip, getCart, onMutate, bus })` -> `{ mount(), unmount(), refresh(), selectSlot(i) }`

---

## 7. Web Audio DSP & ASMR Foley (`src/audio/*`)
- **`dsp-engine.js` exports**:
  - `HARMONIC_SCALES`: `{ pentatonic, dorian, lydian, hirajoshi, lofiMaj9 }`
  - `quantizeRowToFreq(scaleId: string, row: number, octaveBase?: number): number`
  - `generateLfsr15Noise(numSamples: number, seed?: number): Float32Array`
  - `buildPulseWavePeriodic(ctx, dutyCycle: number): PeriodicWave`
  - `buildCustomWavetable32Periodic(ctx, nibbles32: Uint8Array): PeriodicWave`
  - `softClipSample(x: number): number` (tanh soft-knee limiter guaranteeing `|y| <= 1.0`)
  - `createDspEngine({ bus }): DspEngine`
- **`sfx-xy-pad.js` exports**:
  - `SFX_ARCHETYPES`: `['Coin', 'Pop', 'Thock', 'Laser', 'Bubble', 'Shatter', 'Bloom', 'Chime']`
  - `computeSfxPatchParameters({ archetype, x, y }): { freqStart, freqEnd, decayMs, filterHz, crunch, waveType }`
  - `packSfxPatch6Bytes(patch): Uint8Array` (6 bytes), `unpackSfxPatch6Bytes(bytes): { archetype, x, y }`
  - `createSfxXyPad({ container, getCart, onMutate, dsp, bus })`
- **`tenori-sequencer.js` exports**:
  - `createAudioStudio({ container, toolStrip, getCart, onMutate, dsp, bus })`
- **`asmr-foley.js` exports**:
  - `computeKalimbaPluckParams(yRow, luminance, scaleId, velocity)`
  - `computeDominoHarpFreq(ringIdx, scaleId)`
  - `createAsmrFoley({ dsp, bus, getCart })`

---

## 8. 60 FPS Touch Physics, Rule Chips & Arcade Runtime (`src/vendor/*`, `src/runtime/*`)
- **`kaboom-core.js` exports**: `kaboom(opts)` with `scene`, `go`, `add`, `destroy`, `destroyAll`, `get`, `pos`, `vel`, `area`, `body`, `sprite`, `rect`, `circle`, `color`, `opacity`, `scale`, `rotate`, `z`, `lifespan`, `onUpdate`, `onDraw`, `onCollide`, `shake`, `hitStop`, `emitParticles`, `drawPixel`, `drawLine`, `drawSpriteSlot`, `drawTilemap`, `drawText5x7`, `stepFrame`, `renderToCanvas`, `getParticlePoolStats`.
- **`touch-verbs.js` exports**: `TOUCH_VERBS`, `segmentIntersectsAABB`, `createTouchVerbController({ canvas, bus, getPrimaryVerb })`.
- **`rule-chips.js` exports**: `RULE_TRIGGERS`, `RULE_ACTIONS`, `compileChipsToJs(ruleChips)`, `parseJsToChips(jsSource)`, `attachRuleChipsToScene(k, ruleChips, hooks)`.
- **`js-drawer.js` exports**: `highlightMicroJs(code)`, `executeSandboxedCartJs(jsSource, k, hooks)`, `createRulesEditor({ container, toolStrip, getCart, onMutate, bus })`.
- **`arcade-core.js` exports**: `createArcadeRuntime({ canvas, hudStrip, getCart, packInRegistry, dsp, bus })`.

---

## 9. Pack-In Cartridges & Chassis UI (`src/cartridges/*`, `src/ui/*`, `src/main.js`)
- **`pack-in-index.js` exports**: `PACK_IN_ORDER`, `PACK_IN_GAMES`, `getDefaultPackInROM(id)`, `listPackInMetadata()`.
  - Pack-in IDs: `'sling-slime'`, `'zen-rake'`, `'bezel-orbit'`, `'alchemist-glass'`, `'chroma-chisel'`.
  - Each pack-in module exports `{ id, title, createROM(), mountGame(k, cart, helpers) }`.
- **`chassis-shell.js` exports**: `EVENT_NAMES`, `createEventBus()`, `computeIntegerScale(availW, availH)`, `createChassisShell(opts)`.
- **`bezel-wheel.js` exports**: `createBezelWheel({ element, bus, detents = 48 })`.
- **`dock-ceremony.js` exports**: `runDockCeremony({ canvas, rom, palette, dsp, bus, durationMs = 850 })`.
- **`window.__BITFORGE_BUS__` Events**:
  - `mode:change`, `cart:boot`, `cart:minted`, `palette:change`, `foley:pixel`, `foley:flood`, `foley:erase`, `foley:autotile`, `foley:switch`, `bezel:scrub`, `bezel:detent`, `telemetry:fps`, `pwa:install-available`.
