/**
 * BitForge-80 Dithering Rollers, Symmetry Mirrors, Bresenham Line,
 * 1-Tap Outline, and 120Hz Domino Flood-Fill Engine.
 */

const BAYER_4X4_THRESHOLDS = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function buildBayerMask(thresholdLimit) {
  const mat = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    mat[i] = BAYER_4X4_THRESHOLDS[i] < thresholdLimit ? 1 : 0;
  }
  return mat;
}

const DIAGONAL_WAVE_MASK = new Uint8Array([
  1, 0, 0, 1,
  1, 1, 0, 0,
  0, 1, 1, 0,
  0, 0, 1, 1,
]);

export const BAYER_ROLLERS = Object.freeze([
  Object.freeze({ id: '12.5%', name: '12.5%', density: 0.125, matrix: buildBayerMask(2) }),
  Object.freeze({ id: '25%', name: '25%', density: 0.25, matrix: buildBayerMask(4) }),
  Object.freeze({ id: '37.5%', name: '37.5%', density: 0.375, matrix: buildBayerMask(6) }),
  Object.freeze({ id: '50%', name: '50%', density: 0.5, matrix: buildBayerMask(8) }),
  Object.freeze({ id: '62.5%', name: '62.5%', density: 0.625, matrix: buildBayerMask(10) }),
  Object.freeze({ id: '75%', name: '75%', density: 0.75, matrix: buildBayerMask(12) }),
  Object.freeze({ id: '87.5%', name: '87.5%', density: 0.875, matrix: buildBayerMask(14) }),
  Object.freeze({ id: 'diagonal-wave', name: 'diagonal-wave', density: 0.5, matrix: DIAGONAL_WAVE_MASK }),
]);

function resolveRollerIndex(rollerIdx) {
  if (typeof rollerIdx === 'string') {
    const found = BAYER_ROLLERS.findIndex((r) => r.id === rollerIdx || r.name === rollerIdx);
    if (found >= 0) return found;
  }
  const n = Number(rollerIdx);
  if (!Number.isFinite(n)) return 0;
  const idx = Math.trunc(n);
  return ((idx % BAYER_ROLLERS.length) + BAYER_ROLLERS.length) % BAYER_ROLLERS.length;
}

/**
 * Sample a 4x4 dither roller pattern at pixel coordinate (x, y).
 * @param {number|string} rollerIdx
 * @param {number} x
 * @param {number} y
 * @param {number} fgColor
 * @param {number} [bgColor=0]
 * @returns {number}
 */
export function sampleDitherRoller(rollerIdx, x, y, fgColor, bgColor = 0) {
  const roller = BAYER_ROLLERS[resolveRollerIndex(rollerIdx)];
  const mx = (Math.floor(x) & 3);
  const my = (Math.floor(y) & 3);
  return roller.matrix[(my << 2) | mx] ? fgColor : bgColor;
}

/**
 * Compute deduplicated symmetry coordinates within [0, size - 1].
 * @param {'none'|'x'|'y'|'quad'|'radial'} mode
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {Array<{ x: number, y: number }>}
 */
export function getSymmetryCoords(mode, x, y, size) {
  const s = Math.max(1, size | 0);
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || px >= s || py < 0 || py >= s) return [];

  const max = s - 1;
  let candidates;
  if (mode === 'x') {
    candidates = [
      { x: px, y: py },
      { x: max - px, y: py },
    ];
  } else if (mode === 'y') {
    candidates = [
      { x: px, y: py },
      { x: px, y: max - py },
    ];
  } else if (mode === 'quad') {
    candidates = [
      { x: px, y: py },
      { x: max - px, y: py },
      { x: px, y: max - py },
      { x: max - px, y: max - py },
    ];
  } else if (mode === 'radial') {
    candidates = [
      { x: px, y: py },
      { x: max - py, y: px },
      { x: max - px, y: max - py },
      { x: py, y: max - px },
    ];
  } else {
    return [{ x: px, y: py }];
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.x < 0 || c.x >= s || c.y < 0 || c.y >= s) continue;
    const key = c.y * s + c.x;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/**
 * Compute integer pixel points along a segment from (x0, y0) to (x1, y1) using Bresenham's algorithm.
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @returns {Array<{ x: number, y: number }>}
 */
export function bresenhamLine(x0, y0, x1, y1) {
  let cx = Math.round(x0);
  let cy = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);

  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;

  const points = [];
  while (true) {
    points.push({ x: cx, y: cy });
    if (cx === tx && cy === ty) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
  return points;
}

/**
 * Return a new sprite frame with a 1px 4-connected outline around non-zero silhouette pixels.
 * @param {Uint8Array|number[]} frame
 * @param {number} size
 * @param {number} [outlineColorIdx=1]
 * @returns {Uint8Array}
 */
export function applyOutline1px(frame, size, outlineColorIdx = 1) {
  const s = Math.max(1, size | 0);
  const len = s * s;
  const out = new Uint8Array(len);
  const col = outlineColorIdx & 15;

  if (!frame || frame.length < len) return out;
  for (let i = 0; i < len; i++) {
    out[i] = frame[i] & 15;
  }
  if (col === 0) return out;

  for (let y = 0; y < s; y++) {
    const row = y * s;
    for (let x = 0; x < s; x++) {
      const idx = row + x;
      if ((frame[idx] & 15) !== 0) continue;
      const hasNeighbor =
        (x > 0 && (frame[idx - 1] & 15) !== 0) ||
        (x + 1 < s && (frame[idx + 1] & 15) !== 0) ||
        (y > 0 && (frame[idx - s] & 15) !== 0) ||
        (y + 1 < s && (frame[idx + s] & 15) !== 0);
      if (hasNeighbor) {
        out[idx] = col;
      }
    }
  }
  return out;
}

/**
 * Pre-compute concentric BFS flood-fill rings for 120Hz Domino Flood-Fill propagation.
 * @param {Uint8Array} frame
 * @param {number} size
 * @param {number} startX
 * @param {number} startY
 * @param {number} fillColorIdx
 */
export function createDominoFloodJob(frame, size, startX, startY, fillColorIdx) {
  const s = Math.max(1, size | 0);
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  const fillColor = fillColorIdx & 15;

  const baseEmpty = (targetColor = 0) => ({
    frame,
    size: s,
    startX: sx,
    startY: sy,
    targetColor,
    fillColor,
    rings: [],
    totalRings: 0,
    totalPixels: 0,
    currentRing: 0,
    filledCount: 0,
    wetPixels: [],
    done: true,
    wetDone: true,
  });

  if (!frame || frame.length < s * s || sx < 0 || sx >= s || sy < 0 || sy >= s) {
    return baseEmpty(0);
  }

  const startIdx = sy * s + sx;
  const targetColor = frame[startIdx] & 15;
  if (targetColor === fillColor) {
    return baseEmpty(targetColor);
  }

  const visited = new Uint8Array(s * s);
  const rings = [];
  let frontier = [{ x: sx, y: sy, idx: startIdx }];
  visited[startIdx] = 1;
  let totalPixels = 0;

  while (frontier.length > 0) {
    rings.push(frontier);
    totalPixels += frontier.length;
    const nextFrontier = [];

    for (let i = 0; i < frontier.length; i++) {
      const { x, y } = frontier[i];
      if (x > 0) {
        const nIdx = y * s + (x - 1);
        if (!visited[nIdx] && (frame[nIdx] & 15) === targetColor) {
          visited[nIdx] = 1;
          nextFrontier.push({ x: x - 1, y, idx: nIdx });
        }
      }
      if (x + 1 < s) {
        const nIdx = y * s + (x + 1);
        if (!visited[nIdx] && (frame[nIdx] & 15) === targetColor) {
          visited[nIdx] = 1;
          nextFrontier.push({ x: x + 1, y, idx: nIdx });
        }
      }
      if (y > 0) {
        const nIdx = (y - 1) * s + x;
        if (!visited[nIdx] && (frame[nIdx] & 15) === targetColor) {
          visited[nIdx] = 1;
          nextFrontier.push({ x, y: y - 1, idx: nIdx });
        }
      }
      if (y + 1 < s) {
        const nIdx = (y + 1) * s + x;
        if (!visited[nIdx] && (frame[nIdx] & 15) === targetColor) {
          visited[nIdx] = 1;
          nextFrontier.push({ x, y: y + 1, idx: nIdx });
        }
      }
    }

    frontier = nextFrontier;
  }

  return {
    frame,
    size: s,
    startX: sx,
    startY: sy,
    targetColor,
    fillColor,
    rings,
    totalRings: rings.length,
    totalPixels,
    currentRing: 0,
    filledCount: 0,
    wetPixels: [],
    done: rings.length === 0,
    wetDone: rings.length === 0,
  };
}

/**
 * Advance a Domino Flood-Fill job by `ringsPerTick` BFS rings (default 2 rings/tick = 120Hz at 60fps)
 * and update 2-frame wet-ink scale animation metadata (1.25x -> 1.0x).
 * @param {object} job
 * @param {number} [ringsPerTick=2]
 */
export function stepDominoFloodJob(job, ringsPerTick = 2) {
  if (!job) {
    return {
      done: true,
      wetDone: true,
      ringStart: 0,
      ringEnd: 0,
      filledInStep: 0,
      totalFilled: 0,
      totalPixels: 0,
      wetPixels: [],
    };
  }

  // Advance existing wet-ink pixels across 2 frames: frame 0 = 1.25x -> frame 1 = 1.0x -> settled
  const nextWet = [];
  for (let i = 0; i < job.wetPixels.length; i++) {
    const wp = job.wetPixels[i];
    if (wp.frame === 0) {
      nextWet.push({
        idx: wp.idx,
        x: wp.x,
        y: wp.y,
        ring: wp.ring,
        frame: 1,
        scale: 1.0,
      });
    }
  }

  const count = Math.max(1, ringsPerTick | 0);
  const ringStart = job.currentRing;
  const ringEnd = Math.min(job.totalRings, ringStart + count);
  let filledInStep = 0;

  for (let r = ringStart; r < ringEnd; r++) {
    const ring = job.rings[r];
    for (let j = 0; j < ring.length; j++) {
      const cell = ring[j];
      job.frame[cell.idx] = job.fillColor;
      filledInStep++;
      nextWet.push({
        idx: cell.idx,
        x: cell.x,
        y: cell.y,
        ring: r,
        frame: 0,
        scale: 1.25,
      });
    }
  }

  job.currentRing = ringEnd;
  job.filledCount += filledInStep;
  job.wetPixels = nextWet;
  job.done = job.currentRing >= job.totalRings;
  job.wetDone = job.done && nextWet.length === 0;

  return {
    done: job.done,
    wetDone: job.wetDone,
    ringStart,
    ringEnd,
    filledInStep,
    totalFilled: job.filledCount,
    totalPixels: job.totalPixels,
    wetPixels: nextWet,
  };
}
