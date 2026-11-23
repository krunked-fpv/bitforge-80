# BitForge-80: System Architecture (`IDEA-07065`)

## 1. Overview & Deployment Target
BitForge-80 is a zero-backend, offline-first, installable PWA tactile pixel console and single-URL cartridge arcade deployed to static GitHub Pages (`https://krunked-fpv.github.io/bitforge-80/`). Every path across HTML, CSS, ES modules, manifest, and Service Worker uses relative `./` addressing so subpath hosting works identically to root hosting and standalone offline HTML exports.

## 2. Core Design Laws
1. **100% Zero-Backend & Self-Contained**: Zero external CDNs, zero runtime remote APIs, zero server dependencies. All engine code (Kaboom-compatible 128x128 kernel, URI-safe LZ codec, ISO/IEC 18004 QR Reed-Solomon encoder, 5x7 bitmap pixel font, Web Audio DSP, and foley synth) resides in `./src/`.
2. **Direct-Touch Glass & Bezel Controls ONLY**: Every game and studio mode operates exclusively through direct-touch glass physics (Flick/Slingshot, Spring-Drag/Carve, Tap/Ripple Burst, Ribbon Slice) and the bottom 48-detent mechanical Bezel Thumb-Wheel. Virtual thumb-overlays, simulated directional pads, or floating A/B buttons are strictly forbidden.
3. **Bidirectional Storage Auto-Healing (`krunked-cookie-vault-v1`)**: Synchronous `<head>` script `src/vault/cookie-vault-head.js` executes before UI mount to reconcile `localStorage['bitforge80.active']`, chunked SameSite=Lax cookies (`krunked-cookie-vault-v1_*`), and `location.hash` (`#cart=`).
4. **Integer-Locked 128x128 Pixel Optics**: The logical framebuffer is fixed at `128x128`. Viewport scaling computes `S = Math.max(1, Math.floor(Math.min(availW / 128, availH / 128)))` with `image-rendering: pixelated; crisp-edges`.
5. **Sub-2.5 KB Single-URL Cartridges**: Complete games (32 sprites, 3-layer autotile world, 4-channel 16-step audio + wavetable + 8 SFX patches, rule chips / micro-JS) serialize bit-packed into `BF80` binary + LZ-String `#cart=<payload>` under `2,560` bytes.

## 3. Module Dependency Graph

```text
index.html
 ├── <head> synchronous: ./src/vault/cookie-vault-head.js  (classic IIFE -> window.__BITFORGE_VAULT__)
 ├── ./styles/chassis.css & ./styles/pixel-optics.css
 ├── ./manifest.json + ./assets/icons/*.png + ./sw.js
 └── <script type="module"> ./src/main.js
       ├── src/ui/chassis-shell.js         (window.__BITFORGE_BUS__, integer scaling, tabs, modals)
       ├── src/ui/bezel-wheel.js           (48-detent rotary scrub controller)
       ├── src/ui/dock-ceremony.js         (850ms hardware cartridge insertion animation)
       ├── src/vault/storage-coordinator.js (+ daily-seed.js, local-sync-baker.js)
       ├── src/cart/bitpack-rom.js         (+ lz-codec.js, qr-matrix.js, holo-card-export.js)
       ├── src/studio/palettes.js          (+ sprite-editor.js, dither-symmetry.js, autotile-world.js)
       ├── src/audio/dsp-engine.js         (+ tenori-sequencer.js, sfx-xy-pad.js, asmr-foley.js)
       ├── src/runtime/arcade-core.js      (+ kaboom-core.js, touch-verbs.js, rule-chips.js, js-drawer.js)
       └── src/cartridges/pack-in-index.js (+ 5 signature pack-in cartridge modules)
```

## 4. Exclusive File Ownership Matrix
| Role Slug | Domain | Owned Files |
| :--- | :--- | :--- |
| `kenji-sato` | Specs & Swarm | `ARCHITECTURE.md`, `SPEC.md`, `HANDOFF.md`, `.agents/agents/*.md` |
| `nadia-koury` | PWA & Pages CI | `.gitignore`, `manifest.json`, `sw.js`, `assets/icons/*.png`, `.github/workflows/deploy-pages.yml`, `tests/pwa-binary.test.mjs` |
| `marta-lindqvist` | Vault & Baker | `src/vault/cookie-vault-head.js`, `src/vault/storage-coordinator.js`, `src/vault/daily-seed.js`, `src/vault/local-sync-baker.js`, `tests/vault.test.mjs` |
| `priya-nair` | ROM & QR Card | `src/cart/lz-codec.js`, `src/cart/bitpack-rom.js`, `src/cart/qr-matrix.js`, `src/cart/holo-card-export.js`, `tests/bitpack.test.mjs` |
| `devon-okafor` | 60 FPS Runtime | `src/vendor/kaboom-core.js`, `src/runtime/arcade-core.js`, `src/runtime/touch-verbs.js`, `src/runtime/rule-chips.js`, `src/runtime/js-drawer.js`, `tests/runtime.test.mjs` |
| `elena-vasquez` | Pixel & Autotile | `src/studio/palettes.js`, `src/studio/sprite-editor.js`, `src/studio/dither-symmetry.js`, `src/studio/autotile-world.js`, `tests/autotile.test.mjs` |
| `lucas-bergstrom` | Audio & Foley | `src/audio/dsp-engine.js`, `src/audio/tenori-sequencer.js`, `src/audio/sfx-xy-pad.js`, `src/audio/asmr-foley.js`, `tests/audio.test.mjs` |
| `mateo-chen` | Pack-In Games | `src/cartridges/pack-in-index.js`, `src/cartridges/sling-slime.js`, `src/cartridges/zen-rake.js`, `src/cartridges/bezel-orbit.js`, `src/cartridges/alchemist-glass.js`, `src/cartridges/chroma-chisel.js` |
| `sora-takahashi` | Chassis & App Shell | `index.html`, `styles/chassis.css`, `styles/pixel-optics.css`, `src/main.js`, `src/ui/chassis-shell.js`, `src/ui/bezel-wheel.js`, `src/ui/dock-ceremony.js` |
| `viktor-novak` | Red-Team & QA | `tests/redteam-fuzz.test.mjs`, `tests/e2e-browser-suite.mjs` |

## 5. Persistence & Standalone Self-Baking Flow
- **Primary Store**: `localStorage['bitforge80.active']` holds `{ v: 1, ts, crc, cartHash, summary }`, mirrored into IndexedDB `bitforge80_db` (`cartridges` + 32-slot `snapshots` ring buffer).
- **Shadow Store**: Chunked cookies `krunked-cookie-vault-v1_meta` + `krunked-cookie-vault-v1_0..3` (`Max-Age=31536000; Path=/; SameSite=Lax`, <= 3500 bytes/chunk).
- **Standalone Offline HTML Baker**: `local-sync-baker.js` bundles `styles/*.css`, `cookie-vault-head.js`, and every ES module in topological `MODULE_MANIFEST` order inside an inline module loader (`__BF_DEFINE__` / `__BF_REQUIRE__`) alongside `window.__BITFORGE_BAKED_CART__` and `window.__BITFORGE_STANDALONE__ = true`, yielding an air-gapped single `.html` file.
