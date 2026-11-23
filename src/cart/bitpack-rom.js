import { compressBytesToUri, decompressBytesFromUri } from './lz-codec.js';

const MAGIC_BYTES = [0x42, 0x46, 0x38, 0x30]; // "BF80"
const FORMAT_VERSION = 1;

const PALETTE_IDS = ['classic16', 'sakura', 'matcha', 'amber', 'frost80'];
const PRIMARY_VERBS = ['slingshot', 'springDrag', 'tapRipple', 'ribbonSlice', 'bezelWheel'];
const SCALE_IDS = ['pentatonic', 'dorian', 'lydian', 'hirajoshi', 'lofiMaj9'];
const PRESET_GAME_IDS = [null, 'sling-slime', 'zen-rake', 'bezel-orbit', 'alchemist-glass', 'chroma-chisel'];

const KNOWN_TRIGGERS = [
  'Slingshot Release',
  'Tap Entity',
  'Slice Hit',
  'Bezel Scrub',
  'Collide Hazard',
];

const KNOWN_ACTIONS = [
  'Launch Impulse',
  'Shatter Pixels',
  'Bounce + Trauma',
  'Spawn Sparks',
  'Score +1',
  'Play SFX',
];

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Compute CRC16-CCITT (poly 0x1021, init 0xFFFF, no reflection, xorOut 0x0000).
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc16Ccitt(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc & 0xFFFF;
}

/**
 * Create a canonical valid CartridgeROM object with optional nested overrides.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createEmptyCartridgeROM(overrides = {}) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  const srcMeta = src.meta && typeof src.meta === 'object' ? src.meta : {};
  const srcWorld = src.world && typeof src.world === 'object' ? src.world : {};
  const srcAudio = src.audio && typeof src.audio === 'object' ? src.audio : {};
  const srcLogic = src.logic && typeof src.logic === 'object' ? src.logic : {};

  const width = srcWorld.width === 32 ? 32 : 16;
  const height = srcWorld.height === 32 ? 32 : (width === 32 ? 32 : 16);
  const cellCount = width * height;

  const sprites = new Array(32);
  for (let i = 0; i < 32; i++) {
    const rawSprite = Array.isArray(src.sprites) ? src.sprites[i] : null;
    const size = rawSprite && rawSprite.size === 16 ? 16 : 8;
    const pixelCount = size * size;
    let frames;
    if (rawSprite && Array.isArray(rawSprite.frames) && rawSprite.frames.length >= 1) {
      frames = rawSprite.frames.slice(0, 4).map((f) => coerceU8(f, pixelCount));
    } else {
      frames = [new Uint8Array(pixelCount)];
    }
    sprites[i] = { size, frames };
  }

  const channels = new Array(4);
  for (let c = 0; c < 4; c++) {
    const rawCh = Array.isArray(srcAudio.channels) ? srcAudio.channels[c] : null;
    channels[c] = {
      steps: rawCh && rawCh.steps ? coerceU16(rawCh.steps, 16) : new Uint16Array(16),
      dutyOrTimbre: rawCh && Number.isInteger(rawCh.dutyOrTimbre) ? rawCh.dutyOrTimbre : 128,
      volume: rawCh && Number.isInteger(rawCh.volume) ? rawCh.volume : 75,
    };
  }

  const sfxPatches = new Array(8);
  for (let p = 0; p < 8; p++) {
    const rawPatch = Array.isArray(srcAudio.sfxPatches) ? srcAudio.sfxPatches[p] : null;
    sfxPatches[p] = {
      archetype: rawPatch && Number.isInteger(rawPatch.archetype) ? rawPatch.archetype : p,
      x: rawPatch && Number.isInteger(rawPatch.x) ? rawPatch.x : 128,
      y: rawPatch && Number.isInteger(rawPatch.y) ? rawPatch.y : 128,
    };
  }

  const ruleChips = Array.isArray(srcLogic.ruleChips)
    ? srcLogic.ruleChips.map((chip) => ({
        id: String(chip?.id ?? 'chip'),
        trigger: String(chip?.trigger ?? 'Slingshot Release'),
        paramA: Number.isInteger(chip?.paramA) ? chip.paramA : 0,
        action: String(chip?.action ?? 'Launch Impulse'),
        paramB: Number.isInteger(chip?.paramB) ? chip.paramB : 0,
        sfxSlot: Number.isInteger(chip?.sfxSlot) ? chip.sfxSlot : 0,
      }))
    : [];

  return {
    magic: 'BF80',
    version: 1,
    meta: {
      id: typeof srcMeta.id === 'string' ? srcMeta.id : 'cart-empty',
      title: typeof srcMeta.title === 'string' ? srcMeta.title : 'UNTITLED CART',
      author: typeof srcMeta.author === 'string' ? srcMeta.author : 'BITFORGE',
      paletteId: typeof srcMeta.paletteId === 'string' ? srcMeta.paletteId : 'classic16',
      customPalette: srcMeta.customPalette instanceof Uint8Array
        ? new Uint8Array(srcMeta.customPalette)
        : null,
      coverSpriteIdx: Number.isInteger(srcMeta.coverSpriteIdx) ? srcMeta.coverSpriteIdx : 0,
      primaryVerb: typeof srcMeta.primaryVerb === 'string' ? srcMeta.primaryVerb : 'slingshot',
      dropShadow1px: typeof srcMeta.dropShadow1px === 'boolean' ? srcMeta.dropShadow1px : true,
      crtOptics: typeof srcMeta.crtOptics === 'boolean' ? srcMeta.crtOptics : true,
      updatedAt: Number.isSafeInteger(srcMeta.updatedAt) ? srcMeta.updatedAt : Date.now(),
    },
    sprites,
    world: {
      width,
      height,
      bgLayer: coerceU8(srcWorld.bgLayer, cellCount),
      mainLayer: coerceU8(srcWorld.mainLayer, cellCount),
      fgLayer: coerceU8(srcWorld.fgLayer, cellCount),
      collision: coerceU8(srcWorld.collision, cellCount),
    },
    audio: {
      bpm: Number.isInteger(srcAudio.bpm) ? srcAudio.bpm : 120,
      scaleId: typeof srcAudio.scaleId === 'string' ? srcAudio.scaleId : 'pentatonic',
      channels,
      wavetable32: coerceU8(srcAudio.wavetable32, 32),
      sfxPatches,
    },
    logic: {
      presetGameId: srcLogic.presetGameId !== undefined ? srcLogic.presetGameId : null,
      ruleChips,
      customJs: typeof srcLogic.customJs === 'string' ? srcLogic.customJs : '',
    },
  };
}

/**
 * Deeply clone a CartridgeROM including all nested arrays and TypedArrays.
 * @param {object} rom
 * @returns {object}
 */
export function cloneCartridgeROM(rom) {
  if (!rom || typeof rom !== 'object') {
    throw new TypeError('cloneCartridgeROM expected a CartridgeROM object');
  }

  return {
    magic: rom.magic,
    version: rom.version,
    meta: {
      id: rom.meta.id,
      title: rom.meta.title,
      author: rom.meta.author,
      paletteId: rom.meta.paletteId,
      customPalette: rom.meta.customPalette ? new Uint8Array(rom.meta.customPalette) : null,
      coverSpriteIdx: rom.meta.coverSpriteIdx,
      primaryVerb: rom.meta.primaryVerb,
      dropShadow1px: rom.meta.dropShadow1px,
      crtOptics: rom.meta.crtOptics,
      updatedAt: rom.meta.updatedAt,
    },
    sprites: rom.sprites.map((sp) => ({
      size: sp.size,
      frames: sp.frames.map((frame) => new Uint8Array(frame)),
    })),
    world: {
      width: rom.world.width,
      height: rom.world.height,
      bgLayer: new Uint8Array(rom.world.bgLayer),
      mainLayer: new Uint8Array(rom.world.mainLayer),
      fgLayer: new Uint8Array(rom.world.fgLayer),
      collision: new Uint8Array(rom.world.collision),
    },
    audio: {
      bpm: rom.audio.bpm,
      scaleId: rom.audio.scaleId,
      channels: rom.audio.channels.map((ch) => ({
        steps: new Uint16Array(ch.steps),
        dutyOrTimbre: ch.dutyOrTimbre,
        volume: ch.volume,
      })),
      wavetable32: new Uint8Array(rom.audio.wavetable32),
      sfxPatches: rom.audio.sfxPatches.map((patch) => ({
        archetype: patch.archetype,
        x: patch.x,
        y: patch.y,
      })),
    },
    logic: {
      presetGameId: rom.logic.presetGameId,
      ruleChips: rom.logic.ruleChips.map((chip) => ({
        id: chip.id,
        trigger: chip.trigger,
        paramA: chip.paramA,
        action: chip.action,
        paramB: chip.paramB,
        sfxSlot: chip.sfxSlot,
      })),
      customJs: rom.logic.customJs,
    },
  };
}

/**
 * Validate a CartridgeROM object against the canonical SPEC.md Section 2 schema.
 * @param {any} rom
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCartridgeROM(rom) {
  const errors = [];
  if (!rom || typeof rom !== 'object') {
    return { ok: false, errors: ['ROM must be an object'] };
  }

  if (rom.magic !== 'BF80') errors.push('magic must equal "BF80"');
  if (rom.version !== 1) errors.push('version must equal 1');

  validateMeta(rom.meta, errors);
  validateSprites(rom.sprites, errors);
  validateWorld(rom.world, errors);
  validateAudio(rom.audio, errors);
  validateLogic(rom.logic, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Serialize a valid CartridgeROM into binary BF80 v1 bytes with trailing CRC16-CCITT.
 * @param {object} rom
 * @returns {Uint8Array}
 */
export function encodeCartridgeToBytes(rom) {
  const validation = validateCartridgeROM(rom);
  if (!validation.ok) {
    throw new Error(`Invalid CartridgeROM: ${validation.errors.join('; ')}`);
  }

  const writer = new ByteWriter(512);
  const hasCustomPalette = rom.meta.customPalette !== null;
  const worldIs32 = rom.world.width === 32;
  const presetIdx = PRESET_GAME_IDS.indexOf(rom.logic.presetGameId);
  const hasCustomJs = rom.logic.customJs.length > 0;

  let flags = 0;
  if (hasCustomPalette) flags |= 0x01;
  if (rom.meta.dropShadow1px) flags |= 0x02;
  if (rom.meta.crtOptics) flags |= 0x04;
  if (worldIs32) flags |= 0x08;
  flags |= (presetIdx & 0x07) << 4;
  if (hasCustomJs) flags |= 0x80;

  // 1. Magic + version
  for (let i = 0; i < 4; i++) writer.writeU8(MAGIC_BYTES[i]);
  writer.writeU8(FORMAT_VERSION);

  // 2. Flags
  writer.writeU8(flags);

  // 3. Meta
  writer.writeU8(rom.meta.coverSpriteIdx);
  writer.writeU8(PRIMARY_VERBS.indexOf(rom.meta.primaryVerb));
  writer.writeU8(PALETTE_IDS.indexOf(rom.meta.paletteId));
  writer.writeF64LE(rom.meta.updatedAt);
  writer.writeUtf8U8(rom.meta.id);
  writer.writeUtf8U8(rom.meta.title);
  writer.writeUtf8U8(rom.meta.author);

  // 4. Optional 48-byte customPalette
  if (hasCustomPalette) {
    writer.writeBytes(rom.meta.customPalette);
  }

  // 5. Sprites (32 slots)
  let sizeMask = 0;
  const frameCountBytes = new Uint8Array(8);
  for (let i = 0; i < 32; i++) {
    const sp = rom.sprites[i];
    if (sp.size === 16) sizeMask |= (1 << i);
    const fcMinus1 = (sp.frames.length - 1) & 0x03;
    frameCountBytes[i >> 2] |= fcMinus1 << ((i & 3) * 2);
  }
  writer.writeU32LE(sizeMask >>> 0);
  writer.writeBytes(frameCountBytes);

  for (let i = 0; i < 32; i++) {
    const sp = rom.sprites[i];
    for (let f = 0; f < sp.frames.length; f++) {
      encodeSpriteFrame(writer, sp.frames[f]);
    }
  }

  // 6. World layers + 2-bit packed collision
  encodeAdaptiveByteLayer(writer, rom.world.bgLayer);
  encodeAdaptiveByteLayer(writer, rom.world.mainLayer);
  encodeAdaptiveByteLayer(writer, rom.world.fgLayer);
  encodeAdaptiveByteLayer(writer, pack2BitCollision(rom.world.collision));

  // 7. Audio
  writer.writeU8(rom.audio.bpm);
  writer.writeU8(SCALE_IDS.indexOf(rom.audio.scaleId));
  for (let c = 0; c < 4; c++) {
    const ch = rom.audio.channels[c];
    writer.writeU8(ch.dutyOrTimbre);
    writer.writeU8(ch.volume);
    let rowMask = 0;
    for (let s = 0; s < 16; s++) {
      if (ch.steps[s] !== 0) rowMask |= 1 << s;
    }
    writer.writeU16LE(rowMask);
    for (let s = 0; s < 16; s++) {
      if ((rowMask & (1 << s)) !== 0) {
        writer.writeU16LE(ch.steps[s]);
      }
    }
  }

  for (let i = 0; i < 16; i++) {
    const lo = rom.audio.wavetable32[i * 2] & 0x0F;
    const hi = rom.audio.wavetable32[i * 2 + 1] & 0x0F;
    writer.writeU8(lo | (hi << 4));
  }

  for (let p = 0; p < 8; p++) {
    const patch = rom.audio.sfxPatches[p];
    writer.writeU8(patch.archetype);
    writer.writeU8(patch.x);
    writer.writeU8(patch.y);
  }

  // 8. Logic
  writer.writeU8(rom.logic.ruleChips.length);
  for (let i = 0; i < rom.logic.ruleChips.length; i++) {
    const chip = rom.logic.ruleChips[i];
    writer.writeUtf8U8(chip.id);
    writeTokenOrUtf8(writer, chip.trigger, KNOWN_TRIGGERS);
    writer.writeI16LE(chip.paramA);
    writeTokenOrUtf8(writer, chip.action, KNOWN_ACTIONS);
    writer.writeI16LE(chip.paramB);
    writer.writeU8(chip.sfxSlot);
  }
  if (hasCustomJs) {
    writer.writeUtf8U16(rom.logic.customJs);
  }

  // 9. Trailing CRC16-CCITT (u16 LE)
  return writer.finishWithCrc16();
}

/**
 * Decode binary BF80 v1 bytes back into a validated CartridgeROM, throwing on corruption.
 * @param {Uint8Array} bytes
 * @returns {object}
 */
export function decodeCartridgeFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Input must be a Uint8Array');
  }
  if (bytes.length < 25) {
    throw new Error('Truncated BF80 cartridge payload');
  }

  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new Error('Invalid BF80 magic header');
    }
  }
  if (bytes[4] !== FORMAT_VERSION) {
    throw new Error(`Unsupported BF80 version: ${bytes[4]}`);
  }

  const body = bytes.subarray(0, bytes.length - 2);
  const expectedCrc = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
  const actualCrc = crc16Ccitt(body);
  if (actualCrc !== expectedCrc) {
    throw new Error(`CRC16 mismatch (expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`);
  }

  const reader = new ByteReader(body, 5);

  const flags = reader.readU8();
  const hasCustomPalette = (flags & 0x01) !== 0;
  const dropShadow1px = (flags & 0x02) !== 0;
  const crtOptics = (flags & 0x04) !== 0;
  const worldIs32 = (flags & 0x08) !== 0;
  const presetIdx = (flags >> 4) & 0x07;
  const hasCustomJs = (flags & 0x80) !== 0;

  if (presetIdx >= PRESET_GAME_IDS.length) {
    throw new Error(`Invalid presetGameIdx: ${presetIdx}`);
  }

  const coverSpriteIdx = reader.readU8();
  if (coverSpriteIdx > 31) throw new Error(`Invalid coverSpriteIdx: ${coverSpriteIdx}`);

  const primaryVerbIdx = reader.readU8();
  if (primaryVerbIdx >= PRIMARY_VERBS.length) {
    throw new Error(`Invalid primaryVerbIdx: ${primaryVerbIdx}`);
  }

  const paletteIdx = reader.readU8();
  if (paletteIdx >= PALETTE_IDS.length) {
    throw new Error(`Invalid paletteIdx: ${paletteIdx}`);
  }

  const updatedAt = reader.readF64LE();
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('Invalid updatedAt timestamp');
  }

  const id = reader.readUtf8U8();
  const title = reader.readUtf8U8();
  const author = reader.readUtf8U8();

  const customPalette = hasCustomPalette ? reader.readBytes(48) : null;

  // Sprites
  const sizeMask = reader.readU32LE();
  const frameCountBytes = reader.readBytes(8);
  const sprites = new Array(32);

  for (let i = 0; i < 32; i++) {
    const size = ((sizeMask >>> i) & 1) === 1 ? 16 : 8;
    const frameCount = ((frameCountBytes[i >> 2] >> ((i & 3) * 2)) & 0x03) + 1;
    const frames = new Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      frames[f] = decodeSpriteFrame(reader, size * size);
    }
    sprites[i] = { size, frames };
  }

  // World
  const dim = worldIs32 ? 32 : 16;
  const cellCount = dim * dim;
  const bgLayer = decodeAdaptiveByteLayer(reader, cellCount);
  const mainLayer = decodeAdaptiveByteLayer(reader, cellCount);
  const fgLayer = decodeAdaptiveByteLayer(reader, cellCount);
  const packedCollision = decodeAdaptiveByteLayer(reader, cellCount / 4);
  const collision = unpack2BitCollision(packedCollision, cellCount);

  // Audio
  const bpm = reader.readU8();
  if (bpm < 70 || bpm > 180) throw new Error(`Invalid BPM: ${bpm}`);

  const scaleIdx = reader.readU8();
  if (scaleIdx >= SCALE_IDS.length) throw new Error(`Invalid scaleIdx: ${scaleIdx}`);

  const channels = new Array(4);
  for (let c = 0; c < 4; c++) {
    const dutyOrTimbre = reader.readU8();
    const volume = reader.readU8();
    if (volume > 100) throw new Error(`Invalid channel volume: ${volume}`);
    const rowMask = reader.readU16LE();
    const steps = new Uint16Array(16);
    for (let s = 0; s < 16; s++) {
      if ((rowMask & (1 << s)) !== 0) {
        steps[s] = reader.readU16LE();
      }
    }
    channels[c] = { steps, dutyOrTimbre, volume };
  }

  const wavetable32 = new Uint8Array(32);
  const packedWave = reader.readBytes(16);
  for (let i = 0; i < 16; i++) {
    wavetable32[i * 2] = packedWave[i] & 0x0F;
    wavetable32[i * 2 + 1] = (packedWave[i] >> 4) & 0x0F;
  }

  const sfxPatches = new Array(8);
  for (let p = 0; p < 8; p++) {
    const archetype = reader.readU8();
    if (archetype > 7) throw new Error(`Invalid SFX archetype: ${archetype}`);
    const x = reader.readU8();
    const y = reader.readU8();
    sfxPatches[p] = { archetype, x, y };
  }

  // Logic
  const chipCount = reader.readU8();
  const ruleChips = new Array(chipCount);
  for (let i = 0; i < chipCount; i++) {
    const chipId = reader.readUtf8U8();
    const trigger = readTokenOrUtf8(reader, KNOWN_TRIGGERS);
    const paramA = reader.readI16LE();
    const action = readTokenOrUtf8(reader, KNOWN_ACTIONS);
    const paramB = reader.readI16LE();
    const sfxSlot = reader.readU8();
    if (sfxSlot > 7) throw new Error(`Invalid chip sfxSlot: ${sfxSlot}`);
    ruleChips[i] = { id: chipId, trigger, paramA, action, paramB, sfxSlot };
  }

  const customJs = hasCustomJs ? reader.readUtf8U16() : '';

  if (reader.remaining() !== 0) {
    throw new Error(`Unexpected trailing bytes: ${reader.remaining()}`);
  }

  const rom = {
    magic: 'BF80',
    version: 1,
    meta: {
      id,
      title,
      author,
      paletteId: PALETTE_IDS[paletteIdx],
      customPalette,
      coverSpriteIdx,
      primaryVerb: PRIMARY_VERBS[primaryVerbIdx],
      dropShadow1px,
      crtOptics,
      updatedAt,
    },
    sprites,
    world: {
      width: dim,
      height: dim,
      bgLayer,
      mainLayer,
      fgLayer,
      collision,
    },
    audio: {
      bpm,
      scaleId: SCALE_IDS[scaleIdx],
      channels,
      wavetable32,
      sfxPatches,
    },
    logic: {
      presetGameId: PRESET_GAME_IDS[presetIdx],
      ruleChips,
      customJs,
    },
  };

  const check = validateCartridgeROM(rom);
  if (!check.ok) {
    throw new Error(`Decoded ROM failed validation: ${check.errors.join('; ')}`);
  }

  return rom;
}

/**
 * Encode a CartridgeROM to a '#cart=<payload>' URI hash string.
 * @param {object} rom
 * @returns {string}
 */
export function encodeCartToHash(rom) {
  const bytes = encodeCartridgeToBytes(rom);
  return `#cart=${compressBytesToUri(bytes)}`;
}

/**
 * Safely decode a '#cart=...' hash, full URL, or raw LZ payload without throwing.
 * @param {string} hashOrPayload
 * @returns {{ ok: true, rom: object, byteLength: number, hash: string } | { ok: false, error: string }}
 */
export function decodeCartFromHash(hashOrPayload) {
  try {
    if (typeof hashOrPayload !== 'string') {
      return { ok: false, error: 'Cartridge hash must be a string' };
    }
    const trimmed = hashOrPayload.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'Empty cartridge hash' };
    }

    let payload;
    const hashIdx = trimmed.indexOf('#cart=');
    if (hashIdx !== -1) {
      payload = trimmed.slice(hashIdx + 6);
    } else if (trimmed.startsWith('#')) {
      return { ok: false, error: 'Hash must begin with #cart=' };
    } else if (trimmed.includes('://')) {
      return { ok: false, error: 'URL missing #cart= payload' };
    } else if (trimmed.startsWith('cart=')) {
      payload = trimmed.slice(5);
    } else {
      payload = trimmed;
    }

    if (!payload) {
      return { ok: false, error: 'Empty #cart= payload' };
    }

    const bytes = decompressBytesFromUri(payload);
    if (!bytes) {
      return { ok: false, error: 'Failed to decompress LZ cartridge payload' };
    }

    const rom = decodeCartridgeFromBytes(bytes);
    return {
      ok: true,
      rom,
      byteLength: bytes.byteLength,
      hash: `#cart=${payload}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to decode cartridge',
    };
  }
}

/* ── Internal Helpers ────────────────────────────────────────────────────── */

function coerceU8(src, length) {
  const out = new Uint8Array(length);
  if (src && typeof src.length === 'number') {
    const limit = Math.min(length, src.length);
    for (let i = 0; i < limit; i++) out[i] = src[i] & 0xFF;
  }
  return out;
}

function coerceU16(src, length) {
  const out = new Uint16Array(length);
  if (src && typeof src.length === 'number') {
    const limit = Math.min(length, src.length);
    for (let i = 0; i < limit; i++) out[i] = src[i] & 0xFFFF;
  }
  return out;
}

function utf8ByteLength(str) {
  return TEXT_ENCODER.encode(str).length;
}

function validateMeta(meta, errors) {
  if (!meta || typeof meta !== 'object') {
    errors.push('meta must be an object');
    return;
  }
  if (typeof meta.id !== 'string' || utf8ByteLength(meta.id) > 255) {
    errors.push('meta.id must be a string <= 255 UTF-8 bytes');
  }
  if (typeof meta.title !== 'string' || [...meta.title].length > 24 || utf8ByteLength(meta.title) > 255) {
    errors.push('meta.title must be a string <= 24 chars');
  }
  if (typeof meta.author !== 'string' || [...meta.author].length > 16 || utf8ByteLength(meta.author) > 255) {
    errors.push('meta.author must be a string <= 16 chars');
  }
  if (!PALETTE_IDS.includes(meta.paletteId)) {
    errors.push('meta.paletteId invalid');
  }
  if (
    meta.customPalette !== null &&
    (!(meta.customPalette instanceof Uint8Array) || meta.customPalette.length !== 48)
  ) {
    errors.push('meta.customPalette must be null or Uint8Array(48)');
  }
  if (!Number.isInteger(meta.coverSpriteIdx) || meta.coverSpriteIdx < 0 || meta.coverSpriteIdx > 31) {
    errors.push('meta.coverSpriteIdx must be 0..31');
  }
  if (!PRIMARY_VERBS.includes(meta.primaryVerb)) {
    errors.push('meta.primaryVerb invalid');
  }
  if (typeof meta.dropShadow1px !== 'boolean') {
    errors.push('meta.dropShadow1px must be boolean');
  }
  if (typeof meta.crtOptics !== 'boolean') {
    errors.push('meta.crtOptics must be boolean');
  }
  if (!Number.isSafeInteger(meta.updatedAt) || meta.updatedAt < 0) {
    errors.push('meta.updatedAt must be a non-negative safe integer');
  }
}

function validateSprites(sprites, errors) {
  if (!Array.isArray(sprites) || sprites.length !== 32) {
    errors.push('sprites must be an array of length 32');
    return;
  }
  for (let i = 0; i < 32; i++) {
    const sp = sprites[i];
    if (!sp || (sp.size !== 8 && sp.size !== 16)) {
      errors.push(`sprites[${i}].size must be 8 or 16`);
      continue;
    }
    if (!Array.isArray(sp.frames) || sp.frames.length < 1 || sp.frames.length > 4) {
      errors.push(`sprites[${i}].frames must have length 1..4`);
      continue;
    }
    const expectedLen = sp.size * sp.size;
    for (let f = 0; f < sp.frames.length; f++) {
      const frame = sp.frames[f];
      if (!(frame instanceof Uint8Array) || frame.length !== expectedLen) {
        errors.push(`sprites[${i}].frames[${f}] must be Uint8Array(${expectedLen})`);
        continue;
      }
      for (let p = 0; p < frame.length; p++) {
        if (frame[p] > 15) {
          errors.push(`sprites[${i}].frames[${f}] pixel out of 0..15 range`);
          break;
        }
      }
    }
  }
}

function validateWorld(world, errors) {
  if (!world || typeof world !== 'object') {
    errors.push('world must be an object');
    return;
  }
  if ((world.width !== 16 && world.width !== 32) || world.height !== world.width) {
    errors.push('world dimensions must be 16x16 or 32x32');
    return;
  }
  const len = world.width * world.height;
  for (const key of ['bgLayer', 'mainLayer', 'fgLayer']) {
    if (!(world[key] instanceof Uint8Array) || world[key].length !== len) {
      errors.push(`world.${key} must be Uint8Array(${len})`);
    }
  }
  if (!(world.collision instanceof Uint8Array) || world.collision.length !== len) {
    errors.push(`world.collision must be Uint8Array(${len})`);
  } else {
    for (let i = 0; i < len; i++) {
      if (world.collision[i] > 3) {
        errors.push('world.collision values must be 0..3');
        break;
      }
    }
  }
}

function validateAudio(audio, errors) {
  if (!audio || typeof audio !== 'object') {
    errors.push('audio must be an object');
    return;
  }
  if (!Number.isInteger(audio.bpm) || audio.bpm < 70 || audio.bpm > 180) {
    errors.push('audio.bpm must be integer 70..180');
  }
  if (!SCALE_IDS.includes(audio.scaleId)) {
    errors.push('audio.scaleId invalid');
  }
  if (!Array.isArray(audio.channels) || audio.channels.length !== 4) {
    errors.push('audio.channels must have length 4');
  } else {
    for (let c = 0; c < 4; c++) {
      const ch = audio.channels[c];
      if (!ch || !(ch.steps instanceof Uint16Array) || ch.steps.length !== 16) {
        errors.push(`audio.channels[${c}].steps must be Uint16Array(16)`);
      }
      if (!ch || !Number.isInteger(ch.dutyOrTimbre) || ch.dutyOrTimbre < 0 || ch.dutyOrTimbre > 255) {
        errors.push(`audio.channels[${c}].dutyOrTimbre must be integer 0..255`);
      }
      if (!ch || !Number.isInteger(ch.volume) || ch.volume < 0 || ch.volume > 100) {
        errors.push(`audio.channels[${c}].volume must be integer 0..100`);
      }
    }
  }
  if (!(audio.wavetable32 instanceof Uint8Array) || audio.wavetable32.length !== 32) {
    errors.push('audio.wavetable32 must be Uint8Array(32)');
  } else {
    for (let i = 0; i < 32; i++) {
      if (audio.wavetable32[i] > 15) {
        errors.push('audio.wavetable32 values must be 0..15');
        break;
      }
    }
  }
  if (!Array.isArray(audio.sfxPatches) || audio.sfxPatches.length !== 8) {
    errors.push('audio.sfxPatches must have length 8');
  } else {
    for (let p = 0; p < 8; p++) {
      const patch = audio.sfxPatches[p];
      if (
        !patch ||
        !Number.isInteger(patch.archetype) || patch.archetype < 0 || patch.archetype > 7 ||
        !Number.isInteger(patch.x) || patch.x < 0 || patch.x > 255 ||
        !Number.isInteger(patch.y) || patch.y < 0 || patch.y > 255
      ) {
        errors.push(`audio.sfxPatches[${p}] invalid`);
      }
    }
  }
}

function validateLogic(logic, errors) {
  if (!logic || typeof logic !== 'object') {
    errors.push('logic must be an object');
    return;
  }
  if (!PRESET_GAME_IDS.includes(logic.presetGameId)) {
    errors.push('logic.presetGameId invalid');
  }
  if (!Array.isArray(logic.ruleChips) || logic.ruleChips.length > 255) {
    errors.push('logic.ruleChips must be an array of length <= 255');
  } else {
    for (let i = 0; i < logic.ruleChips.length; i++) {
      const chip = logic.ruleChips[i];
      if (!chip || typeof chip !== 'object') {
        errors.push(`logic.ruleChips[${i}] invalid`);
        continue;
      }
      if (typeof chip.id !== 'string' || utf8ByteLength(chip.id) > 255) {
        errors.push(`logic.ruleChips[${i}].id invalid`);
      }
      if (typeof chip.trigger !== 'string' || utf8ByteLength(chip.trigger) > 255) {
        errors.push(`logic.ruleChips[${i}].trigger invalid`);
      }
      if (!Number.isInteger(chip.paramA) || chip.paramA < -32768 || chip.paramA > 32767) {
        errors.push(`logic.ruleChips[${i}].paramA must be i16`);
      }
      if (typeof chip.action !== 'string' || utf8ByteLength(chip.action) > 255) {
        errors.push(`logic.ruleChips[${i}].action invalid`);
      }
      if (!Number.isInteger(chip.paramB) || chip.paramB < -32768 || chip.paramB > 32767) {
        errors.push(`logic.ruleChips[${i}].paramB must be i16`);
      }
      if (!Number.isInteger(chip.sfxSlot) || chip.sfxSlot < 0 || chip.sfxSlot > 7) {
        errors.push(`logic.ruleChips[${i}].sfxSlot must be 0..7`);
      }
    }
  }
  if (typeof logic.customJs !== 'string' || utf8ByteLength(logic.customJs) > 65535) {
    errors.push('logic.customJs must be string <= 65535 UTF-8 bytes');
  }
}

function encodeSpriteFrame(writer, frame) {
  let allZero = true;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    writer.writeU8(0);
    return;
  }

  // Build mode 1: nibble-RLE ([count-1 (4b) | color (4b)])
  const rle = [];
  let idx = 0;
  while (idx < frame.length) {
    const color = frame[idx] & 0x0F;
    let run = 1;
    while (idx + run < frame.length && run < 16 && (frame[idx + run] & 0x0F) === color) {
      run += 1;
    }
    rle.push(((run - 1) << 4) | color);
    idx += run;
  }

  const rawByteLen = frame.length >> 1;
  if (rle.length <= rawByteLen) {
    writer.writeU8(1);
    for (let i = 0; i < rle.length; i++) writer.writeU8(rle[i]);
  } else {
    writer.writeU8(2);
    for (let i = 0; i < frame.length; i += 2) {
      writer.writeU8((frame[i] & 0x0F) | ((frame[i + 1] & 0x0F) << 4));
    }
  }
}

function decodeSpriteFrame(reader, pixelCount) {
  const mode = reader.readU8();
  if (mode === 0) {
    return new Uint8Array(pixelCount);
  }
  if (mode === 1) {
    const out = new Uint8Array(pixelCount);
    let pos = 0;
    while (pos < pixelCount) {
      const token = reader.readU8();
      const run = (token >> 4) + 1;
      const color = token & 0x0F;
      if (pos + run > pixelCount) {
        throw new Error('Sprite nibble-RLE overrun');
      }
      out.fill(color, pos, pos + run);
      pos += run;
    }
    return out;
  }
  if (mode === 2) {
    const packed = reader.readBytes(pixelCount >> 1);
    const out = new Uint8Array(pixelCount);
    for (let i = 0; i < packed.length; i++) {
      out[i * 2] = packed[i] & 0x0F;
      out[i * 2 + 1] = (packed[i] >> 4) & 0x0F;
    }
    return out;
  }
  throw new Error(`Invalid sprite frame encoding mode: ${mode}`);
}

function encodeAdaptiveByteLayer(writer, bytes) {
  let allZero = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    writer.writeU8(0);
    return;
  }

  const rle = [];
  let idx = 0;
  while (idx < bytes.length) {
    const val = bytes[idx];
    let run = 1;
    while (idx + run < bytes.length && run < 256 && bytes[idx + run] === val) {
      run += 1;
    }
    rle.push(run - 1, val);
    idx += run;
  }

  if (rle.length < bytes.length) {
    writer.writeU8(1);
    for (let i = 0; i < rle.length; i++) writer.writeU8(rle[i]);
  } else {
    writer.writeU8(2);
    writer.writeBytes(bytes);
  }
}

function decodeAdaptiveByteLayer(reader, expectedLen) {
  const mode = reader.readU8();
  if (mode === 0) {
    return new Uint8Array(expectedLen);
  }
  if (mode === 1) {
    const out = new Uint8Array(expectedLen);
    let pos = 0;
    while (pos < expectedLen) {
      const run = reader.readU8() + 1;
      const val = reader.readU8();
      if (pos + run > expectedLen) {
        throw new Error('World layer RLE overrun');
      }
      out.fill(val, pos, pos + run);
      pos += run;
    }
    return out;
  }
  if (mode === 2) {
    return reader.readBytes(expectedLen);
  }
  throw new Error(`Invalid world layer encoding mode: ${mode}`);
}

function pack2BitCollision(collision) {
  const packed = new Uint8Array(collision.length >> 2);
  for (let i = 0; i < packed.length; i++) {
    const base = i * 4;
    packed[i] =
      (collision[base] & 0x03) |
      ((collision[base + 1] & 0x03) << 2) |
      ((collision[base + 2] & 0x03) << 4) |
      ((collision[base + 3] & 0x03) << 6);
  }
  return packed;
}

function unpack2BitCollision(packed, cellCount) {
  const out = new Uint8Array(cellCount);
  for (let i = 0; i < packed.length; i++) {
    const b = packed[i];
    const base = i * 4;
    out[base] = b & 0x03;
    out[base + 1] = (b >> 2) & 0x03;
    out[base + 2] = (b >> 4) & 0x03;
    out[base + 3] = (b >> 6) & 0x03;
  }
  return out;
}

function writeTokenOrUtf8(writer, value, knownList) {
  const idx = knownList.indexOf(value);
  if (idx !== -1 && idx < 0xFF) {
    writer.writeU8(idx);
  } else {
    writer.writeU8(0xFF);
    writer.writeUtf8U8(value);
  }
}

function readTokenOrUtf8(reader, knownList) {
  const code = reader.readU8();
  if (code === 0xFF) {
    return reader.readUtf8U8();
  }
  if (code >= knownList.length) {
    throw new Error(`Invalid rule token index: ${code}`);
  }
  return knownList[code];
}

class ByteWriter {
  constructor(initialSize = 512) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }

  ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let nextCap = this.buf.length;
    while (nextCap < this.len + extra) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeU8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xFF;
  }

  writeU16LE(v) {
    this.ensure(2);
    this.view.setUint16(this.len, v & 0xFFFF, true);
    this.len += 2;
  }

  writeI16LE(v) {
    this.ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
  }

  writeU32LE(v) {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  writeF64LE(v) {
    this.ensure(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
  }

  writeBytes(bytes) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  writeUtf8U8(str) {
    const encoded = TEXT_ENCODER.encode(str);
    this.writeU8(encoded.length);
    this.writeBytes(encoded);
  }

  writeUtf8U16(str) {
    const encoded = TEXT_ENCODER.encode(str);
    this.writeU16LE(encoded.length);
    this.writeBytes(encoded);
  }

  finishWithCrc16() {
    const body = this.buf.subarray(0, this.len);
    const crc = crc16Ccitt(body);
    this.writeU16LE(crc);
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  constructor(bytes, startOffset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = startOffset;
  }

  remaining() {
    return this.bytes.length - this.pos;
  }

  require(n) {
    if (this.pos + n > this.bytes.length) {
      throw new Error('Unexpected end of BF80 byte stream');
    }
  }

  readU8() {
    this.require(1);
    return this.bytes[this.pos++];
  }

  readU16LE() {
    this.require(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readI16LE() {
    this.require(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32LE() {
    this.require(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readF64LE() {
    this.require(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(len) {
    this.require(len);
    const slice = this.bytes.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readUtf8U8() {
    const len = this.readU8();
    return TEXT_DECODER.decode(this.readBytes(len));
  }

  readUtf8U16() {
    const len = this.readU16LE();
    return TEXT_DECODER.decode(this.readBytes(len));
  }
}
