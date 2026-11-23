import * as slingSlime from './sling-slime.js';
import * as zenRake from './zen-rake.js';
import * as bezelOrbit from './bezel-orbit.js';
import * as alchemistGlass from './alchemist-glass.js';
import * as chromaChisel from './chroma-chisel.js';

export const PACK_IN_ORDER = Object.freeze([
  'sling-slime',
  'zen-rake',
  'bezel-orbit',
  'alchemist-glass',
  'chroma-chisel',
]);

export const PACK_IN_GAMES = Object.freeze({
  'sling-slime': Object.freeze({
    id: slingSlime.id,
    title: slingSlime.title,
    createROM: slingSlime.createROM,
    createCartridgeROM: slingSlime.createCartridgeROM,
    mountGame: slingSlime.mountGame,
  }),
  'zen-rake': Object.freeze({
    id: zenRake.id,
    title: zenRake.title,
    createROM: zenRake.createROM,
    createCartridgeROM: zenRake.createCartridgeROM,
    mountGame: zenRake.mountGame,
  }),
  'bezel-orbit': Object.freeze({
    id: bezelOrbit.id,
    title: bezelOrbit.title,
    createROM: bezelOrbit.createROM,
    createCartridgeROM: bezelOrbit.createCartridgeROM,
    mountGame: bezelOrbit.mountGame,
  }),
  'alchemist-glass': Object.freeze({
    id: alchemistGlass.id,
    title: alchemistGlass.title,
    createROM: alchemistGlass.createROM,
    createCartridgeROM: alchemistGlass.createCartridgeROM,
    mountGame: alchemistGlass.mountGame,
  }),
  'chroma-chisel': Object.freeze({
    id: chromaChisel.id,
    title: chromaChisel.title,
    createROM: chromaChisel.createROM,
    createCartridgeROM: chromaChisel.createCartridgeROM,
    mountGame: chromaChisel.mountGame,
  }),
});

const PACK_IN_TAGLINES = Object.freeze({
  'sling-slime': 'Elastic dungeon ricochet & gem shatter combos',
  'zen-rake': '128x128 karesansui sand garden & wind chimes',
  'bezel-orbit': 'Rotary plasma shield & comet arpeggio parry',
  'alchemist-glass': '128x128 cellular-automata pixel terrarium',
  'chroma-chisel': 'Geode strata slicer & cascading crystal beads',
});

/**
 * Create a fresh default CartridgeROM for the specified pack-in ID.
 * Falls back to 'sling-slime' if no valid ID is provided.
 * @param {string} [id='sling-slime']
 * @returns {object}
 */
export function getDefaultPackInROM(id = 'sling-slime') {
  const mod = (typeof id === 'string' && PACK_IN_GAMES[id]) || PACK_IN_GAMES['sling-slime'];
  return mod.createROM();
}

/**
 * Return lightweight metadata for all 5 pack-in cartridges in canonical order.
 * @returns {Array<{ id: string, title: string, paletteId: string, primaryVerb: string, scaleId: string, coverSpriteIdx: number, tagline: string }>}
 */
export function listPackInMetadata() {
  return PACK_IN_ORDER.map((id) => {
    const mod = PACK_IN_GAMES[id];
    const rom = mod.createROM();
    return {
      id: mod.id,
      title: mod.title,
      paletteId: rom.meta.paletteId,
      primaryVerb: rom.meta.primaryVerb,
      scaleId: rom.audio.scaleId,
      coverSpriteIdx: rom.meta.coverSpriteIdx,
      tagline: PACK_IN_TAGLINES[id] || '',
    };
  });
}
