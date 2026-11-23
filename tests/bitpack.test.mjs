import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
  compressBytesToUri,
  decompressBytesFromUri,
} from '../src/cart/lz-codec.js';

import {
  crc16Ccitt,
  createEmptyCartridgeROM,
  cloneCartridgeROM,
  validateCartridgeROM,
  encodeCartridgeToBytes,
  decodeCartridgeFromBytes,
  encodeCartToHash,
  decodeCartFromHash,
} from '../src/cart/bitpack-rom.js';

import { encodeQrMatrix } from '../src/cart/qr-matrix.js';

import {
  renderHoloCardSvg,
  renderHoloCardPngBlob,
  mountHoloCardModal,
} from '../src/cart/holo-card-export.js';

const URI_ALPHABET = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$'.split(''));

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDFFF) return true;
  }
  return false;
}

function lcgBytes(length, seed = 0x12345678) {
  let state = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xFF;
  }
  return out;
}

function buildRichCartridgeROM() {
  const rom = createEmptyCartridgeROM({
    meta: {
      id: 'cart-neon-slime-80',
      title: 'ネオン★Slime 80!',
      author: 'Priya_N',
      paletteId: 'sakura',
      customPalette: new Uint8Array(48).map((_, idx) => (idx * 17 + 23) & 0xFF),
      coverSpriteIdx: 12,
      primaryVerb: 'ribbonSlice',
      dropShadow1px: true,
      crtOptics: false,
      updatedAt: 1763865600123,
    },
    world: { width: 32, height: 32 },
    audio: {
      bpm: 138,
      scaleId: 'hirajoshi',
    },
    logic: {
      presetGameId: 'alchemist-glass',
      ruleChips: [
        { id: 'c1', trigger: 'Slingshot Release', paramA: 420, action: 'Launch Impulse', paramB: -120, sfxSlot: 2 },
        { id: 'c2', trigger: 'CustomPulse', paramA: -32768, action: 'WarpColor', paramB: 32767, sfxSlot: 7 },
      ],
      customJs: 'onUpdate(() => {\n  shake(0.25);\n});',
    },
  });

  // Sprite 0: 8x8 multi-frame (all-zero + nibble-RLE + checkerboard raw)
  const sp0f1 = new Uint8Array(64).fill(5);
  const sp0f2 = new Uint8Array(64).map((_, i) => (i * 7 + 1) & 0x0F);
  rom.sprites[0] = { size: 8, frames: [new Uint8Array(64), sp0f1, sp0f2] };

  // Sprite 12 (cover): 16x16 multi-frame (4 frames)
  const sp12Frames = [0, 1, 2, 3].map((f) => {
    const arr = new Uint8Array(256);
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        arr[y * 16 + x] = ((x + y + f) % 15) + 1;
      }
    }
    return arr;
  });
  rom.sprites[12] = { size: 16, frames: sp12Frames };

  // Sprite 31 (tests bit 31 of u32 sizeMask): 16x16 noisy frame
  rom.sprites[31] = {
    size: 16,
    frames: [new Uint8Array(256).map((_, i) => (i * 11 + 3) & 0x0F)],
  };

  // Populate 32x32 world layers + collision
  for (let i = 0; i < 1024; i++) {
    rom.world.bgLayer[i] = i < 512 ? 1 : (i % 7);
    rom.world.mainLayer[i] = (i % 32 === 0 || i % 32 === 31) ? 2 : 0;
    rom.world.fgLayer[i] = i % 97 === 0 ? 44 : 0;
    rom.world.collision[i] = (i % 13 === 0) ? 3 : (i % 5 === 0 ? 1 : (i % 11 === 0 ? 2 : 0));
  }

  // Populate 4-channel audio + wavetable + sfxPatches
  rom.audio.channels[0].steps[0] = 0b0000_0001_0001_0001;
  rom.audio.channels[0].steps[15] = 0xFFFF;
  rom.audio.channels[1].dutyOrTimbre = 192;
  rom.audio.channels[1].volume = 88;
  rom.audio.channels[2].steps[4] = 0x00AA;
  rom.audio.channels[3].volume = 0;
  for (let i = 0; i < 32; i++) rom.audio.wavetable32[i] = (i * 3) & 0x0F;
  rom.audio.sfxPatches[5] = { archetype: 6, x: 210, y: 45 };

  return rom;
}

describe('1. LZ-String URI-Safe Byte & String Codec', () => {
  it('round-trips arbitrary binary bytes with zero UTF-16 surrogates', () => {
    const edgeCases = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xFF]),
      new Uint8Array(128).fill(0x00),
      new Uint8Array(128).fill(0xFF),
      Uint8Array.from({ length: 256 }, (_, i) => i),
      // Byte pairs that would collide with UTF-16 surrogates if naively decoded as UTF-16
      new Uint8Array([0xD8, 0x00, 0xDF, 0xFF, 0x00, 0xD8, 0xFF, 0xDF]),
      lcgBytes(512, 0xCAFEBABE),
      lcgBytes(1500, 0xDEADBEEF),
    ];

    for (const original of edgeCases) {
      const encoded = compressBytesToUri(original);
      assert.equal(typeof encoded, 'string');
      assert.ok(encoded.length > 0);
      assert.equal(hasLoneSurrogate(encoded), false);
      for (let i = 0; i < encoded.length; i++) {
        assert.ok(URI_ALPHABET.has(encoded.charAt(i)), `Non-URI char: ${encoded.charAt(i)}`);
      }

      const decoded = decompressBytesFromUri(encoded);
      assert.ok(decoded instanceof Uint8Array);
      assert.deepEqual(decoded, original);
    }
  });

  it('round-trips Unicode strings and prototype-colliding keys cleanly', () => {
    const samples = [
      '',
      'constructor __proto__ toString valueOf',
      'BitForge-80 ★ カタカナ 🎮✨',
      'A'.repeat(2000),
    ];
    for (const s of samples) {
      const encoded = compressToEncodedURIComponent(s);
      const decoded = decompressFromEncodedURIComponent(encoded);
      assert.equal(decoded, s);
    }
  });

  it('returns null gracefully on invalid, truncated, or corrupt LZ inputs', () => {
    const valid = compressBytesToUri(lcgBytes(120, 42));
    assert.equal(decompressFromEncodedURIComponent(''), null);
    assert.equal(decompressFromEncodedURIComponent(null), null);
    assert.equal(decompressFromEncodedURIComponent(undefined), null);
    assert.equal(decompressFromEncodedURIComponent('invalid!@#$%'), null);
    assert.equal(decompressBytesFromUri(''), null);
    assert.equal(decompressBytesFromUri(valid.slice(0, Math.floor(valid.length / 2))), null);
    assert.equal(decompressBytesFromUri(`${valid}AAAA`), null);

    // Non-byte (>255) string payload must return null from decompressBytesFromUri
    const unicodeCompressed = compressToEncodedURIComponent('★🎮');
    assert.equal(decompressBytesFromUri(unicodeCompressed), null);

    // Random URI-alphabet fuzz strings never hang or throw
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
    const rnd = lcgBytes(200 * 24, 0xABCDEF01);
    for (let i = 0; i < 200; i++) {
      let fuzz = '';
      const len = (rnd[i * 24] % 22) + 1;
      for (let j = 0; j < len; j++) {
        fuzz += alphabet.charAt(rnd[i * 24 + j + 1] % alphabet.length);
      }
      const res = decompressBytesFromUri(fuzz);
      assert.ok(res === null || res instanceof Uint8Array);
    }
  });
});

describe('2. BF80 Binary Bitpacking & CartridgeROM Schema', () => {
  it('computes standard CRC16-CCITT (0x1021, init 0xFFFF)', () => {
    const vector = new TextEncoder().encode('123456789');
    assert.equal(crc16Ccitt(vector), 0x29B1);
  });

  it('validates canonical CartridgeROM and isolates cloneCartridgeROM mutations', () => {
    const empty = createEmptyCartridgeROM();
    assert.deepEqual(validateCartridgeROM(empty), { ok: true, errors: [] });

    const cloned = cloneCartridgeROM(empty);
    cloned.meta.title = 'MUTATED';
    cloned.sprites[0].frames[0][0] = 9;
    cloned.world.collision[0] = 2;
    cloned.audio.channels[0].steps[0] = 0x1234;
    cloned.audio.wavetable32[0] = 15;
    assert.equal(empty.meta.title, 'UNTITLED CART');
    assert.equal(empty.sprites[0].frames[0][0], 0);
    assert.equal(empty.world.collision[0], 0);
    assert.equal(empty.audio.channels[0].steps[0], 0);
    assert.equal(empty.audio.wavetable32[0], 0);

    const bad = cloneCartridgeROM(empty);
    bad.meta.title = 'A'.repeat(25);
    bad.audio.bpm = 250;
    const check = validateCartridgeROM(bad);
    assert.equal(check.ok, false);
    assert.ok(check.errors.length >= 2);
  });

  it('bit-exact round-trips rich 8x8/16x16 sprites, 32x32 world, customPalette, audio, chips, customJs & Unicode', () => {
    const rom = buildRichCartridgeROM();
    assert.deepEqual(validateCartridgeROM(rom), { ok: true, errors: [] });

    const bytes = encodeCartridgeToBytes(rom);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'BF80');
    assert.equal(bytes[4], 1);

    const decoded = decodeCartridgeFromBytes(bytes);
    assert.deepEqual(decoded, rom);

    const hash = encodeCartToHash(rom);
    assert.ok(hash.startsWith('#cart='));
    const hashRes = decodeCartFromHash(hash);
    assert.equal(hashRes.ok, true);
    assert.equal(hashRes.byteLength, bytes.byteLength);
    assert.equal(hashRes.hash, hash);
    assert.deepEqual(hashRes.rom, rom);

    // Full URL extraction
    const urlRes = decodeCartFromHash(`https://krunked-fpv.github.io/bitforge-80/${hash}`);
    assert.equal(urlRes.ok, true);
    assert.deepEqual(urlRes.rom, rom);
  });

  it('keeps typical game cartridges well below the 2,560-byte #cart= target', () => {
    const packRom = createEmptyCartridgeROM({
      meta: {
        id: 'sling-slime',
        title: 'SLING SLIME',
        author: 'BITFORGE',
        paletteId: 'classic16',
        coverSpriteIdx: 0,
        primaryVerb: 'slingshot',
      },
      world: { width: 16, height: 16 },
      logic: {
        presetGameId: 'sling-slime',
        ruleChips: [
          { id: 'r1', trigger: 'Slingshot Release', paramA: 300, action: 'Launch Impulse', paramB: 180, sfxSlot: 1 },
          { id: 'r2', trigger: 'Collide Hazard', paramA: 10, action: 'Bounce + Trauma', paramB: 45, sfxSlot: 2 },
        ],
      },
    });
    for (let i = 0; i < 64; i++) packRom.sprites[0].frames[0][i] = (i % 5) + 1;
    for (let i = 0; i < 256; i++) {
      packRom.world.mainLayer[i] = (i < 16 || i >= 240) ? 1 : 0;
      packRom.world.collision[i] = (i < 16 || i >= 240) ? 1 : 0;
    }
    packRom.audio.channels[0].steps[0] = 0b0001_0000_0010_0001;
    packRom.audio.channels[0].steps[8] = 0b0000_0100_0000_1000;

    const hash = encodeCartToHash(packRom);
    assert.ok(hash.length < 2560, `Expected < 2560 chars, got ${hash.length}`);
  });
});

describe('3. Graceful Corrupt Hash, CRC & Truncated Stream Rejection', () => {
  it('decodeCartFromHash never throws and rejects corrupt/truncated inputs cleanly', () => {
    const rom = buildRichCartridgeROM();
    const validHash = encodeCartToHash(rom);
    const validBytes = encodeCartridgeToBytes(rom);

    const malformedInputs = [
      null,
      undefined,
      12345,
      {},
      '',
      '#',
      '#other=abc',
      '#cart=',
      'https://example.com/',
      '#cart=!!!not-valid-lz!!!',
      validHash.slice(0, 20),
      validHash.slice(0, -3),
      `${validHash}Z`,
    ];

    for (const input of malformedInputs) {
      const res = decodeCartFromHash(input);
      assert.equal(res.ok, false);
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    }

    // Corrupt CRC byte in binary and re-encode to URI
    const badCrcBytes = new Uint8Array(validBytes);
    badCrcBytes[badCrcBytes.length - 1] ^= 0x01;
    assert.throws(() => decodeCartridgeFromBytes(badCrcBytes), /CRC16 mismatch/);
    const badCrcHash = `#cart=${compressBytesToUri(badCrcBytes)}`;
    const badCrcRes = decodeCartFromHash(badCrcHash);
    assert.equal(badCrcRes.ok, false);
    assert.match(badCrcRes.error, /CRC16 mismatch/);

    // Corrupt magic header
    const badMagic = new Uint8Array(validBytes);
    badMagic[0] = 0x58;
    assert.throws(() => decodeCartridgeFromBytes(badMagic), /magic/i);

    // Truncated bytes
    assert.throws(() => decodeCartridgeFromBytes(validBytes.subarray(0, 10)), /Truncated/);
    assert.throws(() => decodeCartridgeFromBytes(validBytes.subarray(0, validBytes.length - 1)), /CRC16/);
  });
});

describe('4. ISO/IEC 18004 QR Matrix Encoder', () => {
  function assertFinderAt(qr, fx, fy) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        const expected = dist !== 2;
        assert.equal(qr.isSet(fx + dx, fy + dy), expected, `Finder mismatch at (${fx + dx}, ${fy + dy})`);
      }
    }
  }

  function assertQrInvariants(qr) {
    assert.equal(qr.quietZone, 4);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.totalSize, qr.size + 8);
    assert.equal(qr.modules.length, qr.size * qr.size);

    // 3 finders + separators
    assertFinderAt(qr, 0, 0);
    assertFinderAt(qr, qr.size - 7, 0);
    assertFinderAt(qr, 0, qr.size - 7);
    for (let i = 0; i < 8; i++) {
      assert.equal(qr.isSet(7, i), false);
      assert.equal(qr.isSet(i, 7), false);
      assert.equal(qr.isSet(qr.size - 8, i), false);
      assert.equal(qr.isSet(qr.size - 1 - i, 7), false);
      assert.equal(qr.isSet(i, qr.size - 8), false);
      assert.equal(qr.isSet(7, qr.size - 1 - i), false);
    }

    // Timing patterns (row 6, col 6 between finders)
    for (let i = 8; i <= qr.size - 9; i++) {
      const expected = i % 2 === 0;
      assert.equal(qr.isSet(i, 6), expected, `Timing row 6 at x=${i}`);
      assert.equal(qr.isSet(6, i), expected, `Timing col 6 at y=${i}`);
    }

    // Dark module at row = 4*version + 9, col = 8 -> (x=8, y=4*version+9)
    assert.equal(qr.isSet(8, 4 * qr.version + 9), true, 'Dark module must be set');

    // Strict 4-module quiet zone around all 4 sides
    for (let y = 0; y < qr.totalSize; y++) {
      for (let x = 0; x < qr.totalSize; x++) {
        if (x < 4 || y < 4 || x >= qr.totalSize - 4 || y >= qr.totalSize - 4) {
          assert.equal(qr.isQuietSet(x, y), false, `Quiet zone violated at (${x}, ${y})`);
        } else {
          assert.equal(qr.isQuietSet(x, y), qr.isSet(x - 4, y - 4));
        }
      }
    }
  }

  it('encodes short and ~2000-byte #cart= URLs with valid ISO structural patterns and quiet zone', () => {
    const shortQr = encodeQrMatrix('#cart=NoIgRg', 'M');
    assert.equal(shortQr.version, 1);
    assert.equal(shortQr.ecLevel, 'M');
    assertQrInvariants(shortQr);

    const longUrl = `https://krunked-fpv.github.io/bitforge-80/#cart=${'AbCdEf0123456789'.repeat(125)}`;
    assert.ok(longUrl.length > 1950);
    const longQr = encodeQrMatrix(longUrl, 'M');
    assert.equal(longQr.ecLevel, 'M');
    assert.ok(longQr.version >= 35 && longQr.version <= 40);
    assertQrInvariants(longQr);

    // Format info Copy 1 & Copy 2 must agree
    for (let i = 0; i <= 5; i++) {
      assert.equal(longQr.isSet(8, i), longQr.isSet(longQr.size - 1 - i, 8));
    }
    assert.equal(longQr.isSet(8, 7), longQr.isSet(longQr.size - 7, 8));
    assert.equal(longQr.isSet(8, 8), longQr.isSet(longQr.size - 8, 8));
    assert.equal(longQr.isSet(7, 8), longQr.isSet(8, longQr.size - 7));
  });

  it('auto-steps EC level M -> L above 2331 bytes and rejects > 2953 bytes', () => {
    const stepped = encodeQrMatrix('X'.repeat(2500), 'M');
    assert.equal(stepped.ecLevel, 'L');
    assert.ok(stepped.version >= 37 && stepped.version <= 40);
    assertQrInvariants(stepped);

    const maxL = encodeQrMatrix('Y'.repeat(2953), 'M');
    assert.equal(maxL.version, 40);
    assert.equal(maxL.ecLevel, 'L');
    assertQrInvariants(maxL);

    assert.throws(() => encodeQrMatrix('Z'.repeat(2954), 'M'), RangeError);
  });
});

describe('5. Holographic Collector Card SVG & 1080x1520 PNG Export', () => {
  function parsePngChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    const chunks = [];
    while (pos < bytes.length) {
      const length = view.getUint32(pos, false);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const data = bytes.subarray(pos + 8, pos + 8 + length);
      const crc = view.getUint32(pos + 8 + length, false);
      const computedCrc = zlib.crc32(bytes.subarray(pos + 4, pos + 8 + length)) >>> 0;
      assert.equal(crc, computedCrc, `PNG chunk ${type} CRC32 mismatch`);
      chunks.push({ type, length, data });
      pos += 12 + length;
    }
    assert.equal(pos, bytes.length);
    return chunks;
  }

  it('renders crisp SVG and valid 1080x1520 nearest-neighbor PNG Blob', async () => {
    const rom = buildRichCartridgeROM();
    rom.meta.title = 'SLIME <80> & CO';
    const cartUrl = `https://krunked-fpv.github.io/bitforge-80/${encodeCartToHash(rom)}`;
    const paletteHex = Array.from({ length: 16 }, (_, i) => `#${((i * 16) + 15).toString(16).padStart(2, '0')}4080`);

    const svg = renderHoloCardSvg(rom, cartUrl, paletteHex);
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.endsWith('</svg>'));
    assert.ok(svg.includes('viewBox="0 0 1080 1520"'));
    assert.ok(svg.includes('SLIME &lt;80&gt; &amp; CO'));
    assert.ok(svg.includes('shape-rendering="crispEdges"'));
    assert.ok(svg.includes('fill="#ffffff"'));
    assert.ok(svg.includes('fill="#f6c453"'));

    const pngBlob = await renderHoloCardPngBlob(rom, cartUrl, paletteHex);
    assert.equal(pngBlob.type, 'image/png');
    const bytes = new Uint8Array(await pngBlob.arrayBuffer());

    // Verify PNG magic signature
    assert.deepEqual(
      Array.from(bytes.subarray(0, 8)),
      [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    );

    const chunks = parsePngChunks(bytes);
    assert.equal(chunks[0].type, 'IHDR');
    const ihdrView = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, chunks[0].data.byteLength);
    assert.equal(ihdrView.getUint32(0, false), 1080);
    assert.equal(ihdrView.getUint32(4, false), 1520);
    assert.equal(chunks[0].data[8], 8); // 8-bit
    assert.equal(chunks[0].data[9], 6); // RGBA

    const idatChunks = chunks.filter((c) => c.type === 'IDAT');
    assert.ok(idatChunks.length >= 1);
    const idatTotalLen = idatChunks.reduce((sum, c) => sum + c.data.length, 0);
    const idatBuf = new Uint8Array(idatTotalLen);
    let off = 0;
    for (const c of idatChunks) {
      idatBuf.set(c.data, off);
      off += c.data.length;
    }

    const inflated = zlib.inflateSync(idatBuf);
    assert.equal(inflated.length, 1520 * (1 + 1080 * 4));

    // Verify QR quiet-zone top-left corner pixel at (240, 688) is crisp white (#FFFFFF)
    const stride = 1 + 1080 * 4;
    const qrCornerIdx = 688 * stride + 1 + 240 * 4;
    assert.deepEqual(Array.from(inflated.subarray(qrCornerIdx, qrCornerIdx + 4)), [255, 255, 255, 255]);

    assert.equal(chunks[chunks.length - 1].type, 'IEND');
    assert.equal(chunks[chunks.length - 1].length, 0);

    // Also verify pure-JS uncompressed zlib DEFLATE fallback works when CompressionStream is absent
    const origCompressionStream = globalThis.CompressionStream;
    try {
      globalThis.CompressionStream = undefined;
      const fallbackBlob = await renderHoloCardPngBlob(rom, cartUrl);
      const fallbackBytes = new Uint8Array(await fallbackBlob.arrayBuffer());
      const fbChunks = parsePngChunks(fallbackBytes);
      const fbIdat = fbChunks.find((c) => c.type === 'IDAT');
      const fbInflated = zlib.inflateSync(fbIdat.data);
      assert.deepEqual(fbInflated.length, inflated.length);
    } finally {
      globalThis.CompressionStream = origCompressionStream;
    }

    // Safe no-op in headless Node without DOM
    const modal = mountHoloCardModal({ container: null, rom, cartUrl, paletteHex16: paletteHex });
    assert.equal(typeof modal.destroy, 'function');
    modal.destroy();
  });
});
