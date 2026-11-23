import { encodeCartToHash, encodeCartridgeToBytes } from './bitpack-rom.js';
import { encodeQrMatrix } from './qr-matrix.js';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1520;

const DEFAULT_PALETTE_HEX16 = [
  '#12131a', '#1e2230', '#383d52', '#646c87',
  '#9ba3bd', '#e8ecf4', '#f6c453', '#eb6b6f',
  '#f09248', '#5ec27a', '#3aa89d', '#4f8fba',
  '#7c68c9', '#d16bb3', '#96563b', '#f8f9fc',
];

// Compact 5x7 uppercase/ASCII bitmap glyphs (5 bits wide per 7 rows)
const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 0, 0, 0, 0, 0],
  '#': [10, 31, 10, 10, 31, 10, 0],
  '$': [4, 15, 20, 14, 5, 30, 4],
  '%': [25, 26, 4, 4, 11, 19, 0],
  '&': [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 0, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '*': [0, 10, 4, 31, 4, 10, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ',': [0, 0, 0, 0, 4, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 4, 4],
  '/': [1, 2, 2, 4, 8, 8, 16],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 6, 8, 16, 31],
  '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 4, 4, 0, 4, 4, 0],
  ';': [0, 4, 4, 0, 4, 4, 8],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '@': [14, 17, 23, 21, 23, 16, 14],
  'A': [14, 17, 17, 31, 17, 17, 17],
  'B': [30, 17, 17, 30, 17, 17, 30],
  'C': [14, 17, 16, 16, 16, 17, 14],
  'D': [28, 18, 17, 17, 17, 18, 28],
  'E': [31, 16, 16, 30, 16, 16, 31],
  'F': [31, 16, 16, 30, 16, 16, 16],
  'G': [14, 17, 16, 23, 17, 17, 15],
  'H': [17, 17, 17, 31, 17, 17, 17],
  'I': [14, 4, 4, 4, 4, 4, 14],
  'J': [7, 2, 2, 2, 18, 18, 12],
  'K': [17, 18, 20, 24, 20, 18, 17],
  'L': [16, 16, 16, 16, 16, 16, 31],
  'M': [17, 27, 21, 21, 17, 17, 17],
  'N': [17, 25, 21, 19, 17, 17, 17],
  'O': [14, 17, 17, 17, 17, 17, 14],
  'P': [30, 17, 17, 30, 16, 16, 16],
  'Q': [14, 17, 17, 17, 21, 18, 13],
  'R': [30, 17, 17, 30, 20, 18, 17],
  'S': [15, 16, 16, 14, 1, 1, 30],
  'T': [31, 4, 4, 4, 4, 4, 4],
  'U': [17, 17, 17, 17, 17, 17, 14],
  'V': [17, 17, 17, 17, 17, 10, 4],
  'W': [17, 17, 17, 21, 21, 27, 17],
  'X': [17, 17, 10, 4, 10, 17, 17],
  'Y': [17, 17, 10, 4, 4, 4, 4],
  'Z': [31, 1, 2, 4, 8, 16, 31],
  '_': [0, 0, 0, 0, 0, 0, 31],
  '[': [14, 8, 8, 8, 8, 8, 14],
  ']': [14, 2, 2, 2, 2, 2, 14],
};

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[n] = c >>> 0;
}

/**
 * Render a standalone crisp collector trading card SVG depicting the BitForge-80 cartridge,
 * cover sprite, 16-color palette DNA strip, metadata, byte badge, and scannable quiet-zoned QR.
 * @param {object} rom
 * @param {string} cartUrl
 * @param {string[]} [paletteHex16]
 * @returns {string}
 */
export function renderHoloCardSvg(rom, cartUrl, paletteHex16) {
  const ctx = prepareCardContext(rom, cartUrl, paletteHex16);
  const { title, author, byteBadge, qrBadge, palette, sprite, qr } = ctx;

  // Build cover sprite rects
  const spriteBoxSize = 288;
  const spriteCellPx = Math.floor(spriteBoxSize / sprite.size);
  const spriteOriginX = Math.floor((CARD_WIDTH - sprite.size * spriteCellPx) / 2);
  const spriteOriginY = 304;
  const spriteRects = [];

  if (rom?.meta?.dropShadow1px) {
    for (let y = 0; y < sprite.size; y++) {
      for (let x = 0; x < sprite.size; x++) {
        if (sprite.pixels[y * sprite.size + x] !== 0) {
          spriteRects.push(
            `<rect x="${spriteOriginX + x * spriteCellPx + 4}" y="${spriteOriginY + y * spriteCellPx + 4}" width="${spriteCellPx}" height="${spriteCellPx}" fill="#07080d" opacity="0.72"/>`
          );
        }
      }
    }
  }
  for (let y = 0; y < sprite.size; y++) {
    for (let x = 0; x < sprite.size; x++) {
      const colorIdx = sprite.pixels[y * sprite.size + x] & 0x0F;
      if (colorIdx === 0) continue;
      spriteRects.push(
        `<rect x="${spriteOriginX + x * spriteCellPx}" y="${spriteOriginY + y * spriteCellPx}" width="${spriteCellPx}" height="${spriteCellPx}" fill="${palette[colorIdx]}"/>`
      );
    }
  }

  // Build 16-color palette DNA strip
  const dnaSwatches = [];
  const dnaX = 156;
  const dnaY = 628;
  const swatchW = 48;
  const swatchH = 40;
  for (let i = 0; i < 16; i++) {
    dnaSwatches.push(
      `<rect x="${dnaX + i * swatchW}" y="${dnaY}" width="${swatchW}" height="${swatchH}" fill="${palette[i]}"/>`
    );
  }

  // Build scannable quiet-zoned QR matrix inside 600x600 panel
  const qrPanelSize = 600;
  const qrPanelX = Math.floor((CARD_WIDTH - qrPanelSize) / 2);
  const qrPanelY = 688;
  const modPx = Math.max(2, Math.floor(qrPanelSize / qr.totalSize));
  const qrDrawnSize = qr.totalSize * modPx;
  const qrOffsetX = qrPanelX + Math.floor((qrPanelSize - qrDrawnSize) / 2);
  const qrOffsetY = qrPanelY + Math.floor((qrPanelSize - qrDrawnSize) / 2);

  // Batch horizontal dark runs per row for compact, crisp SVG output
  const qrPaths = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.isSet(x, y)) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.isSet(x + run, y)) {
        run += 1;
      }
      const rx = qrOffsetX + (qr.quietZone + x) * modPx;
      const ry = qrOffsetY + (qr.quietZone + y) * modPx;
      qrPaths.push(`M${rx} ${ry}h${run * modPx}v${modPx}h-${run * modPx}z`);
      x += run;
    }
  }

  // Bottom 16 gold edge connector pins
  const pins = [];
  for (let i = 0; i < 16; i++) {
    const px = 178 + i * 46;
    pins.push(
      `<rect x="${px}" y="1358" width="32" height="84" rx="4" fill="#f6c453"/>` +
      `<rect x="${px + 4}" y="1364" width="24" height="68" rx="2" fill="#ffe18a" opacity="0.45"/>`
    );
  }

  // Top cartridge grip ribs
  const gripRibs = [];
  for (let i = 0; i < 6; i++) {
    gripRibs.push(`<rect x="148" y="${76 + i * 10}" width="180" height="5" rx="2" fill="#272b3d"/>`);
    gripRibs.push(`<rect x="752" y="${76 + i * 10}" width="180" height="5" rx="2" fill="#272b3d"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" role="img" aria-label="${escapeXml(title)} BitForge-80 Cartridge Card">`,
    `<defs>`,
    `<linearGradient id="bf-holo-foil" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="#f6c453"/>`,
    `<stop offset="28%" stop-color="#eb6b6f"/>`,
    `<stop offset="56%" stop-color="#5ec27a"/>`,
    `<stop offset="80%" stop-color="#4f8fba"/>`,
    `<stop offset="100%" stop-color="#d16bb3"/>`,
    `</linearGradient>`,
    `<linearGradient id="bf-shell-grad" x1="0%" y1="0%" x2="0%" y2="100%">`,
    `<stop offset="0%" stop-color="#191c28"/>`,
    `<stop offset="100%" stop-color="#101219"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0c0d13"/>`,
    `<rect x="70" y="54" width="940" height="1412" rx="34" fill="url(#bf-shell-grad)" stroke="#2e3449" stroke-width="4"/>`,
    ...gripRibs,
    `<rect x="366" y="78" width="348" height="44" rx="10" fill="#12141e" stroke="#2d3347" stroke-width="2"/>`,
    `<text x="540" y="108" fill="#9ba3bd" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="22" font-weight="700" letter-spacing="4" text-anchor="middle">BITFORGE-80</text>`,
    `<rect x="116" y="138" width="848" height="1196" rx="22" fill="#1a1d27" stroke="url(#bf-holo-foil)" stroke-width="4"/>`,
    `<text x="156" y="198" fill="#f8f9fc" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="38" font-weight="800">${escapeXml(title)}</text>`,
    `<text x="156" y="242" fill="#9ba3bd" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="24" font-weight="600">BY ${escapeXml(author)}</text>`,
    `<rect x="760" y="164" width="164" height="42" rx="8" fill="#12131a" stroke="#f6c453" stroke-width="2"/>`,
    `<text x="842" y="192" fill="#f6c453" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="21" font-weight="700" text-anchor="middle">${escapeXml(byteBadge)}</text>`,
    `<rect x="760" y="216" width="164" height="32" rx="6" fill="#12131a" stroke="#3aa89d" stroke-width="1.5"/>`,
    `<text x="842" y="238" fill="#5ec27a" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="16" font-weight="700" text-anchor="middle">${escapeXml(qrBadge)}</text>`,
    `<rect x="368" y="276" width="344" height="332" rx="16" fill="#11131b" stroke="#2e3449" stroke-width="3"/>`,
    `<g shape-rendering="crispEdges">`,
    ...spriteRects,
    `</g>`,
    `<rect x="152" y="624" width="776" height="48" rx="6" fill="#0d0e14" stroke="#383d52" stroke-width="2"/>`,
    `<g shape-rendering="crispEdges">`,
    ...dnaSwatches,
    `</g>`,
    `<rect x="${qrPanelX}" y="${qrPanelY}" width="${qrPanelSize}" height="${qrPanelSize}" rx="12" fill="#ffffff"/>`,
    `<path shape-rendering="crispEdges" fill="#000000" d="${qrPaths.join('')}"/>`,
    `<text x="540" y="1316" fill="#9ba3bd" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="18" font-weight="700" letter-spacing="2" text-anchor="middle">SCAN TO BOOT #CART= CARTRIDGE</text>`,
    `<rect x="156" y="1350" width="768" height="104" rx="10" fill="#0d0e14" stroke="#2a2f42" stroke-width="2"/>`,
    ...pins,
    `</svg>`,
  ].join('\n');
}

/**
 * Render a 1080x1520 nearest-neighbor collector card PNG Blob (works in both browsers and headless Node).
 * @param {object} rom
 * @param {string} cartUrl
 * @param {string[]} [paletteHex16]
 * @returns {Promise<Blob>}
 */
export async function renderHoloCardPngBlob(rom, cartUrl, paletteHex16) {
  const ctx = prepareCardContext(rom, cartUrl, paletteHex16);
  const rgba = rasterizeHoloCardRgba(ctx, rom);
  const pngBytes = await encodeRgbaToPng(CARD_WIDTH, CARD_HEIGHT, rgba);
  return new Blob([pngBytes], { type: 'image/png' });
}

/**
 * Mount an interactive holographic tilted collector card preview modal with .svg, .png, and copy URL actions.
 * @param {{ container: HTMLElement, rom: object, cartUrl: string, paletteHex16?: string[], onClose?: () => void }} opts
 * @returns {{ destroy(): void }}
 */
export function mountHoloCardModal({ container, rom, cartUrl, paletteHex16, onClose }) {
  if (typeof document === 'undefined' || !container) {
    return { destroy() {} };
  }

  injectModalStyles();

  const resolvedUrl = resolveCartUrl(rom, cartUrl);
  const svgMarkup = renderHoloCardSvg(rom, resolvedUrl, paletteHex16);
  const slug = sanitizeFilename(rom?.meta?.title || 'bitforge-cart');

  const overlay = document.createElement('div');
  overlay.className = 'bf-holo-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Holographic Cartridge Card Export');

  const dialog = document.createElement('div');
  dialog.className = 'bf-holo-dialog';

  const stage = document.createElement('div');
  stage.className = 'bf-holo-stage';

  const cardWrap = document.createElement('div');
  cardWrap.className = 'bf-holo-card';
  cardWrap.innerHTML = svgMarkup;

  const foil = document.createElement('div');
  foil.className = 'bf-holo-foil-sweep';
  cardWrap.appendChild(foil);
  stage.appendChild(cardWrap);

  const actions = document.createElement('div');
  actions.className = 'bf-holo-actions';

  const btnSvg = document.createElement('button');
  btnSvg.type = 'button';
  btnSvg.className = 'bf-holo-btn bf-holo-btn-primary';
  btnSvg.textContent = 'SAVE .SVG';

  const btnPng = document.createElement('button');
  btnPng.type = 'button';
  btnPng.className = 'bf-holo-btn bf-holo-btn-primary';
  btnPng.textContent = 'SAVE .PNG';

  const btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.className = 'bf-holo-btn';
  btnCopy.textContent = 'COPY URL';

  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'bf-holo-btn bf-holo-btn-close';
  btnClose.textContent = 'CLOSE';

  actions.append(btnSvg, btnPng, btnCopy, btnClose);
  dialog.append(stage, actions);
  overlay.appendChild(dialog);
  container.appendChild(overlay);

  let destroyed = false;
  const timers = new Set();

  const applyTilt = (nx, ny) => {
    const cx = Math.max(-1, Math.min(1, nx));
    const cy = Math.max(-1, Math.min(1, ny));
    const rx = (-cy * 11).toFixed(2);
    const ry = (cx * 11).toFixed(2);
    cardWrap.style.transform = `perspective(960px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    cardWrap.style.setProperty('--holo-x', `${(50 + cx * 45).toFixed(1)}%`);
    cardWrap.style.setProperty('--holo-y', `${(50 + cy * 45).toFixed(1)}%`);
  };

  const onPointerMove = (e) => {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    applyTilt(nx, ny);
  };

  const onPointerLeave = () => {
    applyTilt(0, 0);
  };

  const onDeviceOrientation = (e) => {
    if (typeof e.gamma !== 'number' || typeof e.beta !== 'number') return;
    const nx = Math.max(-1, Math.min(1, e.gamma / 30));
    const ny = Math.max(-1, Math.min(1, (e.beta - 35) / 30));
    applyTilt(nx, ny);
  };

  const onSvgClick = () => {
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    triggerBlobDownload(blob, `${slug}-card.svg`);
  };

  const onPngClick = async () => {
    btnPng.disabled = true;
    btnPng.textContent = 'RENDERING...';
    try {
      const blob = await renderHoloCardPngBlob(rom, resolvedUrl, paletteHex16);
      if (!destroyed) {
        triggerBlobDownload(blob, `${slug}-card.png`);
      }
    } finally {
      if (!destroyed) {
        btnPng.disabled = false;
        btnPng.textContent = 'SAVE .PNG';
      }
    }
  };

  const onCopyClick = async () => {
    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(resolvedUrl);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = resolvedUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }
    btnCopy.textContent = copied ? 'COPIED!' : 'URL READY';
    const tid = setTimeout(() => {
      timers.delete(tid);
      if (!destroyed) btnCopy.textContent = 'COPY URL';
    }, 1400);
    timers.add(tid);
  };

  const handleClose = () => {
    destroy();
    if (typeof onClose === 'function') onClose();
  };

  const onOverlayClick = (e) => {
    if (e.target === overlay) handleClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') handleClose();
  };

  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);
  btnSvg.addEventListener('click', onSvgClick);
  btnPng.addEventListener('click', onPngClick);
  btnCopy.addEventListener('click', onCopyClick);
  btnClose.addEventListener('click', handleClose);
  overlay.addEventListener('click', onOverlayClick);
  if (typeof window !== 'undefined') {
    window.addEventListener('deviceorientation', onDeviceOrientation);
    window.addEventListener('keydown', onKeyDown);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const tid of timers) clearTimeout(tid);
    timers.clear();
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerleave', onPointerLeave);
    btnSvg.removeEventListener('click', onSvgClick);
    btnPng.removeEventListener('click', onPngClick);
    btnCopy.removeEventListener('click', onCopyClick);
    btnClose.removeEventListener('click', handleClose);
    overlay.removeEventListener('click', onOverlayClick);
    if (typeof window !== 'undefined') {
      window.removeEventListener('deviceorientation', onDeviceOrientation);
      window.removeEventListener('keydown', onKeyDown);
    }
    overlay.remove();
  }

  return { destroy };
}

/* ── Shared Card Preparation & Software Rasterizer ───────────────────────── */

function resolveCartUrl(rom, cartUrl) {
  if (typeof cartUrl === 'string' && cartUrl.length > 0) return cartUrl;
  return encodeCartToHash(rom);
}

function resolvePaletteHex16(rom, paletteHex16) {
  if (Array.isArray(paletteHex16) && paletteHex16.length >= 16) {
    return paletteHex16.slice(0, 16).map((c, idx) => normalizeHex(c, DEFAULT_PALETTE_HEX16[idx]));
  }
  const custom = rom?.meta?.customPalette;
  if (custom instanceof Uint8Array && custom.length === 48) {
    const out = new Array(16);
    for (let i = 0; i < 16; i++) {
      const r = custom[i * 3].toString(16).padStart(2, '0');
      const g = custom[i * 3 + 1].toString(16).padStart(2, '0');
      const b = custom[i * 3 + 2].toString(16).padStart(2, '0');
      out[i] = `#${r}${g}${b}`;
    }
    return out;
  }
  return DEFAULT_PALETTE_HEX16.slice();
}

function normalizeHex(hex, fallback) {
  if (typeof hex !== 'string') return fallback;
  const trimmed = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  return fallback;
}

function parseHexRgba(hex) {
  const clean = normalizeHex(hex, '#000000');
  const v = parseInt(clean.slice(1), 16);
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF, 255];
}

function prepareCardContext(rom, cartUrl, paletteHex16) {
  const url = resolveCartUrl(rom, cartUrl);
  const palette = resolvePaletteHex16(rom, paletteHex16);

  const coverIdx = Number.isInteger(rom?.meta?.coverSpriteIdx) ? rom.meta.coverSpriteIdx : 0;
  const rawSprite = rom?.sprites?.[coverIdx] || { size: 8, frames: [new Uint8Array(64)] };
  const spSize = rawSprite.size === 16 ? 16 : 8;
  const spPixels = rawSprite.frames?.[0] instanceof Uint8Array
    ? rawSprite.frames[0]
    : new Uint8Array(spSize * spSize);

  let romByteLen;
  try {
    romByteLen = encodeCartridgeToBytes(rom).length;
  } catch {
    romByteLen = new TextEncoder().encode(url).length;
  }

  const qr = encodeQrMatrix(url, 'M');
  const title = String(rom?.meta?.title || 'UNTITLED CART').slice(0, 24);
  const author = String(rom?.meta?.author || 'BITFORGE').slice(0, 16);

  return {
    url,
    title,
    author,
    byteBadge: `${romByteLen} B`,
    qrBadge: `QR V${qr.version}-${qr.ecLevel}`,
    palette,
    sprite: { size: spSize, pixels: spPixels },
    qr,
  };
}

function rasterizeHoloCardRgba(ctx, rom) {
  const rgba = new Uint8Array(CARD_WIDTH * CARD_HEIGHT * 4);
  const { title, author, byteBadge, qrBadge, palette, sprite, qr } = ctx;

  // Background fill
  fillRectRgba(rgba, 0, 0, CARD_WIDTH, CARD_HEIGHT, 12, 13, 19, 255);

  // Anodized cartridge outer shell + bezel border
  fillRectRgba(rgba, 70, 54, 940, 1412, 46, 52, 73, 255);
  fillRectRgba(rgba, 74, 58, 932, 1404, 21, 24, 34, 255);

  // Top grip ribs
  for (let i = 0; i < 6; i++) {
    fillRectRgba(rgba, 148, 76 + i * 10, 180, 5, 39, 43, 61, 255);
    fillRectRgba(rgba, 752, 76 + i * 10, 180, 5, 39, 43, 61, 255);
  }

  // Top brand pill
  fillRectRgba(rgba, 366, 78, 348, 44, 45, 51, 71, 255);
  fillRectRgba(rgba, 368, 80, 344, 40, 18, 20, 30, 255);
  drawBitmapTextCentered(rgba, 'BITFORGE-80', 540, 90, 3, [155, 163, 189, 255]);

  // Iridescent holographic foil border around label plate
  drawHoloGradientBorder(rgba, 116, 138, 848, 1196, 4);
  fillRectRgba(rgba, 120, 142, 840, 1188, 26, 29, 39, 255);

  // Title, Author, Byte Badge, QR Badge
  drawBitmapText(rgba, title, 156, 164, 4, [248, 249, 252, 255]);
  drawBitmapText(rgba, `BY ${author}`, 156, 216, 3, [155, 163, 189, 255]);

  fillRectRgba(rgba, 760, 164, 164, 42, 246, 196, 83, 255);
  fillRectRgba(rgba, 762, 166, 160, 38, 18, 19, 26, 255);
  drawBitmapTextCentered(rgba, byteBadge, 842, 175, 3, [246, 196, 83, 255]);

  fillRectRgba(rgba, 760, 216, 164, 32, 58, 168, 157, 255);
  fillRectRgba(rgba, 762, 218, 160, 28, 18, 19, 26, 255);
  drawBitmapTextCentered(rgba, qrBadge, 842, 225, 2, [94, 194, 122, 255]);

  // Cover sprite window
  fillRectRgba(rgba, 368, 276, 344, 332, 46, 52, 73, 255);
  fillRectRgba(rgba, 371, 279, 338, 326, 17, 19, 27, 255);

  const spriteCellPx = Math.floor(288 / sprite.size);
  const spriteOriginX = Math.floor((CARD_WIDTH - sprite.size * spriteCellPx) / 2);
  const spriteOriginY = 304;
  const paletteRgba = palette.map(parseHexRgba);

  if (rom?.meta?.dropShadow1px) {
    for (let y = 0; y < sprite.size; y++) {
      for (let x = 0; x < sprite.size; x++) {
        if (sprite.pixels[y * sprite.size + x] !== 0) {
          fillRectRgba(
            rgba,
            spriteOriginX + x * spriteCellPx + 4,
            spriteOriginY + y * spriteCellPx + 4,
            spriteCellPx,
            spriteCellPx,
            7, 8, 13, 255
          );
        }
      }
    }
  }

  for (let y = 0; y < sprite.size; y++) {
    for (let x = 0; x < sprite.size; x++) {
      const colorIdx = sprite.pixels[y * sprite.size + x] & 0x0F;
      if (colorIdx === 0) continue;
      const [r, g, b, a] = paletteRgba[colorIdx];
      fillRectRgba(
        rgba,
        spriteOriginX + x * spriteCellPx,
        spriteOriginY + y * spriteCellPx,
        spriteCellPx,
        spriteCellPx,
        r, g, b, a
      );
    }
  }

  // 16-color palette DNA strip
  fillRectRgba(rgba, 152, 624, 776, 48, 56, 61, 82, 255);
  fillRectRgba(rgba, 154, 626, 772, 44, 13, 14, 20, 255);
  for (let i = 0; i < 16; i++) {
    const [r, g, b, a] = paletteRgba[i];
    fillRectRgba(rgba, 156 + i * 48, 628, 48, 40, r, g, b, a);
  }

  // Scannable quiet-zoned QR matrix (nearest-neighbor integer modules)
  const qrPanelSize = 600;
  const qrPanelX = Math.floor((CARD_WIDTH - qrPanelSize) / 2);
  const qrPanelY = 688;
  fillRectRgba(rgba, qrPanelX, qrPanelY, qrPanelSize, qrPanelSize, 255, 255, 255, 255);

  const modPx = Math.max(2, Math.floor(qrPanelSize / qr.totalSize));
  const qrDrawnSize = qr.totalSize * modPx;
  const qrOffsetX = qrPanelX + Math.floor((qrPanelSize - qrDrawnSize) / 2);
  const qrOffsetY = qrPanelY + Math.floor((qrPanelSize - qrDrawnSize) / 2);

  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.isSet(x, y)) {
        fillRectRgba(
          rgba,
          qrOffsetX + (qr.quietZone + x) * modPx,
          qrOffsetY + (qr.quietZone + y) * modPx,
          modPx,
          modPx,
          0, 0, 0, 255
        );
      }
    }
  }

  drawBitmapTextCentered(rgba, 'SCAN TO BOOT #CART= CARTRIDGE', 540, 1302, 2, [155, 163, 189, 255]);

  // Bottom 16 gold edge connector pins
  fillRectRgba(rgba, 156, 1350, 768, 104, 42, 47, 66, 255);
  fillRectRgba(rgba, 158, 1352, 764, 100, 13, 14, 20, 255);
  for (let i = 0; i < 16; i++) {
    const px = 178 + i * 46;
    fillRectRgba(rgba, px, 1358, 32, 84, 246, 196, 83, 255);
    fillRectRgba(rgba, px + 4, 1364, 24, 68, 255, 225, 138, 255);
  }

  return rgba;
}

function fillRectRgba(rgba, x, y, w, h, r, g, b, a) {
  const x0 = Math.max(0, x | 0);
  const y0 = Math.max(0, y | 0);
  const x1 = Math.min(CARD_WIDTH, (x + w) | 0);
  const y1 = Math.min(CARD_HEIGHT, (y + h) | 0);
  for (let py = y0; py < y1; py++) {
    let idx = (py * CARD_WIDTH + x0) * 4;
    for (let px = x0; px < x1; px++) {
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = a;
      idx += 4;
    }
  }
}

function drawHoloGradientBorder(rgba, x, y, w, h, thickness) {
  const stops = [
    [246, 196, 83],
    [235, 107, 111],
    [94, 194, 122],
    [79, 143, 186],
    [209, 107, 179],
  ];
  const sampleColor = (t) => {
    const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i0 = Math.floor(scaled);
    const i1 = Math.min(stops.length - 1, i0 + 1);
    const f = scaled - i0;
    return [
      Math.round(stops[i0][0] + (stops[i1][0] - stops[i0][0]) * f),
      Math.round(stops[i0][1] + (stops[i1][1] - stops[i0][1]) * f),
      Math.round(stops[i0][2] + (stops[i1][2] - stops[i0][2]) * f),
    ];
  };

  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const onEdge = px < x + thickness || px >= x + w - thickness || py < y + thickness || py >= y + h - thickness;
      if (!onEdge) continue;
      const t = ((px - x) / w + (py - y) / h) * 0.5;
      const [r, g, b] = sampleColor(t);
      const idx = (py * CARD_WIDTH + px) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
}

function drawBitmapText(rgba, text, x, y, scale, color) {
  const upper = String(text).toUpperCase();
  const [r, g, b, a] = color;
  let cx = x;
  for (let i = 0; i < upper.length; i++) {
    const ch = upper.charAt(i);
    const rows = FONT_5X7[ch] || FONT_5X7['?'];
    for (let row = 0; row < 7; row++) {
      const bits = rows[row];
      for (let col = 0; col < 5; col++) {
        if ((bits & (1 << (4 - col))) !== 0) {
          fillRectRgba(rgba, cx + col * scale, y + row * scale, scale, scale, r, g, b, a);
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawBitmapTextCentered(rgba, text, centerX, y, scale, color) {
  const width = Math.max(0, text.length * 6 * scale - scale);
  drawBitmapText(rgba, text, Math.round(centerX - width / 2), y, scale, color);
}

/* ── Pure-JS PNG Encoder (CompressionStream with RFC 1950 Stored Fallback) ─ */

async function encodeRgbaToPng(width, height, rgba) {
  const stride = width * 4 + 1;
  const rawScanlines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const dstOff = y * stride;
    rawScanlines[dstOff] = 0; // PNG filter type 0 (None)
    rawScanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dstOff + 1);
  }

  const idatPayload = await compressZlib(rawScanlines);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrChunk = buildPngChunk('IHDR', ihdr);
  const idatChunk = buildPngChunk('IDAT', idatPayload);
  const iendChunk = buildPngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let pos = 0;
  out.set(signature, pos); pos += signature.length;
  out.set(ihdrChunk, pos); pos += ihdrChunk.length;
  out.set(idatChunk, pos); pos += idatChunk.length;
  out.set(iendChunk, pos);
  return out;
}

async function compressZlib(rawBytes) {
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('deflate');
      const writer = cs.writable.getWriter();
      writer.write(rawBytes);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      // Fall through to pure-JS stored-block zlib fallback
    }
  }
  return encodeUncompressedZlib(rawBytes);
}

function encodeUncompressedZlib(rawBytes) {
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(rawBytes.length / maxBlock));
  const outLen = 2 + rawBytes.length + numBlocks * 5 + 4;
  const out = new Uint8Array(outLen);
  out[0] = 0x78;
  out[1] = 0x01;

  let pos = 2;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = Math.min(maxBlock, rawBytes.length - offset);
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    const nlen = (~len) & 0xFFFF;
    out[pos++] = isFinal;
    out[pos++] = len & 0xFF;
    out[pos++] = (len >> 8) & 0xFF;
    out[pos++] = nlen & 0xFF;
    out[pos++] = (nlen >> 8) & 0xFF;
    out.set(rawBytes.subarray(offset, offset + len), pos);
    pos += len;
    offset += len;
  }

  const adler = computeAdler32(rawBytes);
  const view = new DataView(out.buffer);
  view.setUint32(pos, adler, false);
  return out;
}

function computeAdler32(bytes) {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + bytes[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function buildPngChunk(typeStr, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = typeStr.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = computeCrc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function computeCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ── DOM / Modal Helpers ─────────────────────────────────────────────────── */

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeFilename(str) {
  return String(str || 'bitforge-cart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bitforge-cart';
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function injectModalStyles() {
  if (document.getElementById('bf-holo-modal-style')) return;
  const style = document.createElement('style');
  style.id = 'bf-holo-modal-style';
  style.textContent = `
    .bf-holo-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(8, 9, 14, 0.86);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .bf-holo-dialog {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      max-width: min(92vw, 440px);
      width: 100%;
    }
    .bf-holo-stage {
      width: 100%;
      max-width: 360px;
      display: flex;
      justify-content: center;
      touch-action: none;
    }
    .bf-holo-card {
      position: relative;
      width: 100%;
      aspect-ratio: 1080 / 1520;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(246, 196, 83, 0.28);
      transform: perspective(960px) rotateX(0deg) rotateY(0deg);
      transition: transform 90ms ease-out;
      --holo-x: 50%;
      --holo-y: 50%;
    }
    .bf-holo-card svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .bf-holo-foil-sweep {
      position: absolute;
      inset: 0;
      pointer-events: none;
      mix-blend-mode: color-dodge;
      opacity: 0.42;
      background: radial-gradient(
        circle at var(--holo-x) var(--holo-y),
        rgba(246, 196, 83, 0.65) 0%,
        rgba(94, 194, 122, 0.35) 28%,
        rgba(79, 143, 186, 0.3) 52%,
        rgba(209, 107, 179, 0.2) 72%,
        transparent 92%
      );
    }
    .bf-holo-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      width: 100%;
    }
    .bf-holo-btn {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 9px 14px;
      border-radius: 8px;
      border: 1px solid #383d52;
      background: #1a1d27;
      color: #e8ecf4;
      cursor: pointer;
    }
    .bf-holo-btn:hover {
      border-color: #646c87;
    }
    .bf-holo-btn-primary {
      border-color: #f6c453;
      color: #f6c453;
    }
    .bf-holo-btn-close {
      border-color: #eb6b6f;
      color: #eb6b6f;
    }
  `;
  document.head.appendChild(style);
}
