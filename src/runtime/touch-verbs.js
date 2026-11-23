/**
 * BitForge-80 Direct-Touch Glass & Bezel Physics Verbs
 * Five tactile input verbs: slingshot, springDrag, tapRipple, ribbonSlice, bezelWheel.
 */

export const TOUCH_VERBS = Object.freeze({
  SLINGSHOT: 'slingshot',
  SPRING_DRAG: 'springDrag',
  TAP_RIPPLE: 'tapRipple',
  RIBBON_SLICE: 'ribbonSlice',
  BEZEL_WHEEL: 'bezelWheel',
});

const LOGICAL_SIZE = 128;
const SLING_MAX_PULL = 48;
const SLING_POWER = 4.5;
const SLING_GRAVITY = 180;
const SLING_PREVIEW_STEPS = 12;
const SLING_RATCHET_PX = 4;

const SPRING_K = 240;
const SPRING_DAMPING = 22;

const PARRY_WINDOW_SEC = 0.12; // 120ms parry window
const RIBBON_CAPACITY = 24;
const BEZEL_DETENTS = 48;
const TWO_PI = Math.PI * 2;

const BAYER_4X4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Liang-Barsky line segment vs AABB intersection test.
 * Accepts rect `{ x, y, width, height }` (or `{ x, y, w, h }`) or 8 numeric arguments.
 */
export function segmentIntersectsAABB(x0, y0, x1, y1, rect, ryArg, rwArg, rhArg) {
  let rx;
  let ry;
  let rw;
  let rh;

  if (typeof rect === 'object' && rect !== null) {
    rx = Number(rect.x ?? rect.left ?? 0);
    ry = Number(rect.y ?? rect.top ?? 0);
    rw = Number(rect.width ?? rect.w ?? (rect.right !== undefined ? rect.right - rx : 0));
    rh = Number(rect.height ?? rect.h ?? (rect.bottom !== undefined ? rect.bottom - ry : 0));
  } else {
    rx = Number(rect) || 0;
    ry = Number(ryArg) || 0;
    rw = Number(rwArg) || 0;
    rh = Number(rhArg) || 0;
  }

  if (rw < 0 || rh < 0) return false;

  const dx = x1 - x0;
  const dy = y1 - y0;

  // Degenerate zero-length segment reduces to point-in-AABB check
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return x0 >= rx && x0 <= rx + rw && y0 >= ry && y0 <= ry + rh;
  }

  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x0 < rx || x0 > rx + rw) return false;
  } else {
    const invDx = 1 / dx;
    let t1 = (rx - x0) * invDx;
    let t2 = (rx + rw - x0) * invDx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  if (Math.abs(dy) < 1e-9) {
    if (y0 < ry || y0 > ry + rh) return false;
  } else {
    const invDy = 1 / dy;
    let t1 = (ry - y0) * invDy;
    let t2 = (ry + rh - y0) * invDy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return tMin <= tMax;
}

function drawRingPixels(k, cx, cy, radius, colorIdx) {
  const icx = Math.round(cx);
  const icy = Math.round(cy);
  const r = Math.max(1, Math.round(radius));
  let x = r;
  let y = 0;
  let err = 1 - x;
  while (x >= y) {
    k.drawPixel(icx + x, icy + y, colorIdx);
    k.drawPixel(icx + y, icy + x, colorIdx);
    k.drawPixel(icx - y, icy + x, colorIdx);
    k.drawPixel(icx - x, icy + y, colorIdx);
    k.drawPixel(icx - x, icy - y, colorIdx);
    k.drawPixel(icx - y, icy - x, colorIdx);
    k.drawPixel(icx + y, icy - x, colorIdx);
    k.drawPixel(icx + x, icy - y, colorIdx);
    y++;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

/**
 * Create the direct-touch verb physics controller.
 * @param {{ canvas?: any, bus?: any, getPrimaryVerb?: () => string }} [opts]
 */
export function createTouchVerbController({ canvas = null, bus = null, getPrimaryVerb = null } = {}) {
  let activePointerId = null;
  const events = [];
  const pendingParticleBursts = [];

  // 1. Slingshot state
  const slingshot = {
    active: false,
    anchorX: 64,
    anchorY: 64,
    currentX: 64,
    currentY: 64,
    pullX: 0,
    pullY: 0,
    distance: 0,
    ratchetStep: 0,
    ratchetCount: 0,
    previewDots: [],
    lastRelease: null,
  };

  // 2. Critically-damped spring follower state (k = 240, damping = 22)
  const springDrag = {
    active: false,
    k: SPRING_K,
    damping: SPRING_DAMPING,
    pos: { x: 64, y: 64 },
    vel: { x: 0, y: 0 },
    target: { x: 64, y: 64 },
  };

  // 3. Tap Ripple state (120ms parry window, tile flip, shockwave ring)
  const tapRipple = {
    parryActive: false,
    parryRemaining: 0,
    parryWindowMs: 120,
    rings: [],
    lastTap: null,
  };

  // 4. Ribbon Slice state (24-sample ring buffer)
  const ribbonX = new Float32Array(RIBBON_CAPACITY);
  const ribbonY = new Float32Array(RIBBON_CAPACITY);
  const ribbonAge = new Float32Array(RIBBON_CAPACITY);
  const ribbonSlice = {
    active: false,
    capacity: RIBBON_CAPACITY,
    head: 0,
    count: 0,
    lastX: 0,
    lastY: 0,
    recentSegments: [],
    lastSegment: null,
  };

  // 5. Bezel Wheel state (48 detents)
  const bezelWheel = {
    angle: 0,
    delta: 0,
    velocity: 0,
    detent: 0,
    detents: BEZEL_DETENTS,
    totalDetentIndex: 0,
    activityTimer: 0,
  };

  function resolveVerb() {
    if (typeof getPrimaryVerb === 'function') {
      return getPrimaryVerb() || TOUCH_VERBS.SLINGSHOT;
    }
    return TOUCH_VERBS.SLINGSHOT;
  }

  function pushEvent(evt) {
    events.push(evt);
    if (bus && typeof bus.emit === 'function') {
      bus.emit('verb:event', evt);
    }
  }

  function updateSlingshotPull(lx, ly) {
    const rawDx = slingshot.anchorX - lx;
    const rawDy = slingshot.anchorY - ly;
    const rawDist = Math.hypot(rawDx, rawDy);
    const clampedDist = Math.min(SLING_MAX_PULL, rawDist);
    const scale = rawDist > 1e-6 ? clampedDist / rawDist : 0;

    slingshot.currentX = lx;
    slingshot.currentY = ly;
    slingshot.pullX = rawDx * scale;
    slingshot.pullY = rawDy * scale;
    slingshot.distance = clampedDist;

    const newStep = Math.floor(clampedDist / SLING_RATCHET_PX);
    if (newStep !== slingshot.ratchetStep) {
      const dir = newStep > slingshot.ratchetStep ? 1 : -1;
      for (let s = slingshot.ratchetStep + dir; dir > 0 ? s <= newStep : s >= newStep; s += dir) {
        slingshot.ratchetCount++;
        pushEvent({
          type: 'slingshot:ratchet',
          step: s,
          delta: dir,
          distance: s * SLING_RATCHET_PX,
          x: lx,
          y: ly,
        });
      }
      slingshot.ratchetStep = newStep;
    }

    const vx = slingshot.pullX * SLING_POWER;
    const vy = slingshot.pullY * SLING_POWER;
    slingshot.previewDots.length = 0;
    for (let i = 1; i <= SLING_PREVIEW_STEPS; i++) {
      const t = i * 0.045;
      const px = slingshot.anchorX + vx * t;
      const py = slingshot.anchorY + vy * t + 0.5 * SLING_GRAVITY * t * t;
      slingshot.previewDots.push({ x: px, y: py });
    }
  }

  function pushRibbonSample(lx, ly) {
    const idx = ribbonSlice.head;
    ribbonX[idx] = lx;
    ribbonY[idx] = ly;
    ribbonAge[idx] = 0;
    ribbonSlice.head = (idx + 1) % RIBBON_CAPACITY;
    if (ribbonSlice.count < RIBBON_CAPACITY) {
      ribbonSlice.count++;
    }
  }

  function handlePointerDown(lx, ly, id) {
    activePointerId = id;
    const verb = resolveVerb();

    if (verb === TOUCH_VERBS.SLINGSHOT) {
      slingshot.active = true;
      slingshot.anchorX = lx;
      slingshot.anchorY = ly;
      slingshot.currentX = lx;
      slingshot.currentY = ly;
      slingshot.pullX = 0;
      slingshot.pullY = 0;
      slingshot.distance = 0;
      slingshot.ratchetStep = 0;
      slingshot.previewDots.length = 0;
      pushEvent({ type: 'slingshot:grab', x: lx, y: ly });
    } else if (verb === TOUCH_VERBS.SPRING_DRAG) {
      springDrag.active = true;
      springDrag.target.x = lx;
      springDrag.target.y = ly;
      pushEvent({ type: 'springDrag:grab', x: lx, y: ly });
    } else if (verb === TOUCH_VERBS.TAP_RIPPLE) {
      const tileX = Math.max(0, Math.floor(lx / 8));
      const tileY = Math.max(0, Math.floor(ly / 8));
      tapRipple.parryRemaining = PARRY_WINDOW_SEC;
      tapRipple.parryActive = true;
      tapRipple.lastTap = { x: lx, y: ly, tileX, tileY };
      tapRipple.rings.push({
        x: lx,
        y: ly,
        radius: 1,
        maxRadius: 24,
        life: 0.25,
        maxLife: 0.25,
      });
      if (tapRipple.rings.length > 8) tapRipple.rings.shift();

      pendingParticleBursts.push({
        x: lx,
        y: ly,
        count: 12,
        spread: TWO_PI,
        speed: 52,
        gravity: 0,
        life: 0.22,
        color: [4, 7, 10],
      });

      pushEvent({
        type: 'tapRipple:burst',
        x: lx,
        y: ly,
        tileX,
        tileY,
        parryWindowMs: 120,
      });
      pushEvent({
        type: 'tapRipple:tileFlip',
        x: lx,
        y: ly,
        tileX,
        tileY,
      });
    } else if (verb === TOUCH_VERBS.RIBBON_SLICE) {
      ribbonSlice.active = true;
      ribbonSlice.head = 0;
      ribbonSlice.count = 0;
      ribbonSlice.lastX = lx;
      ribbonSlice.lastY = ly;
      ribbonSlice.recentSegments.length = 0;
      pushRibbonSample(lx, ly);
      pushEvent({ type: 'ribbonSlice:start', x: lx, y: ly });
    }
  }

  function handlePointerMove(lx, ly) {
    const verb = resolveVerb();

    if (verb === TOUCH_VERBS.SLINGSHOT && slingshot.active) {
      updateSlingshotPull(lx, ly);
    } else if (verb === TOUCH_VERBS.SPRING_DRAG && springDrag.active) {
      springDrag.target.x = lx;
      springDrag.target.y = ly;
      pushEvent({ type: 'springDrag:target', x: lx, y: ly });
    } else if (verb === TOUCH_VERBS.RIBBON_SLICE && ribbonSlice.active) {
      const prevX = ribbonSlice.lastX;
      const prevY = ribbonSlice.lastY;
      const dx = lx - prevX;
      const dy = ly - prevY;
      const len = Math.hypot(dx, dy);
      if (len >= 0.5) {
        pushRibbonSample(lx, ly);
        const seg = { x0: prevX, y0: prevY, x1: lx, y1: ly, dx, dy, length: len };
        ribbonSlice.lastSegment = seg;
        ribbonSlice.recentSegments.push(seg);
        if (ribbonSlice.recentSegments.length > RIBBON_CAPACITY) {
          ribbonSlice.recentSegments.shift();
        }
        ribbonSlice.lastX = lx;
        ribbonSlice.lastY = ly;

        const angle = Math.atan2(dy, dx);
        pendingParticleBursts.push({
          x: lx,
          y: ly,
          count: 4,
          angle,
          spread: 0.7,
          speed: Math.min(80, 24 + len * 3),
          gravity: 30,
          life: 0.16,
          color: [4, 10, 7],
        });

        pushEvent({
          type: 'ribbonSlice:segment',
          x0: prevX,
          y0: prevY,
          x1: lx,
          y1: ly,
          dx,
          dy,
          length: len,
        });
      }
    }
  }

  function handlePointerUp(lx, ly) {
    const verb = resolveVerb();
    if (verb === TOUCH_VERBS.SLINGSHOT && slingshot.active) {
      updateSlingshotPull(lx, ly);
      const vx = slingshot.pullX * SLING_POWER;
      const vy = slingshot.pullY * SLING_POWER;
      const power = slingshot.distance / SLING_MAX_PULL;
      const release = {
        type: 'slingshot:release',
        anchorX: slingshot.anchorX,
        anchorY: slingshot.anchorY,
        pullX: slingshot.pullX,
        pullY: slingshot.pullY,
        vx,
        vy,
        distance: slingshot.distance,
        power,
        x: lx,
        y: ly,
      };
      slingshot.lastRelease = release;
      slingshot.active = false;
      slingshot.previewDots.length = 0;
      pushEvent(release);
    } else if (verb === TOUCH_VERBS.SPRING_DRAG && springDrag.active) {
      springDrag.target.x = lx;
      springDrag.target.y = ly;
      springDrag.active = false;
      pushEvent({ type: 'springDrag:release', x: lx, y: ly });
    } else if (verb === TOUCH_VERBS.RIBBON_SLICE && ribbonSlice.active) {
      handlePointerMove(lx, ly);
      ribbonSlice.active = false;
      pushEvent({ type: 'ribbonSlice:end', x: lx, y: ly });
    }
    activePointerId = null;
  }

  function simulatePointer(type, lx, ly, id = 0) {
    const normType = String(type || '').toLowerCase();
    const cx = clamp(Number(lx) || 0, 0, LOGICAL_SIZE);
    const cy = clamp(Number(ly) || 0, 0, LOGICAL_SIZE);

    if (normType === 'down' || normType === 'pointerdown') {
      handlePointerDown(cx, cy, id);
    } else if (normType === 'move' || normType === 'pointermove') {
      if (activePointerId === null || activePointerId === id) {
        handlePointerMove(cx, cy);
      }
    } else if (normType === 'up' || normType === 'pointerup' || normType === 'cancel' || normType === 'pointercancel') {
      if (activePointerId === null || activePointerId === id) {
        handlePointerUp(cx, cy);
      }
    }
  }

  function setBezelInput(angle, delta = 0, velocity = 0) {
    const a = Number.isFinite(angle) ? angle : bezelWheel.angle;
    const d = Number.isFinite(delta) ? delta : 0;
    const v = Number.isFinite(velocity) ? velocity : 0;
    const wrapped = ((a % TWO_PI) + TWO_PI) % TWO_PI;
    const totalIdx = Math.floor(a / (TWO_PI / BEZEL_DETENTS));
    const detent = ((totalIdx % BEZEL_DETENTS) + BEZEL_DETENTS) % BEZEL_DETENTS;

    bezelWheel.angle = a;
    bezelWheel.delta = d;
    bezelWheel.velocity = v;
    bezelWheel.detent = detent;
    bezelWheel.activityTimer = 0.5;

    if (totalIdx !== bezelWheel.totalDetentIndex) {
      const detentDelta = totalIdx - bezelWheel.totalDetentIndex;
      bezelWheel.totalDetentIndex = totalIdx;
      pushEvent({
        type: 'bezelWheel:detent',
        detent,
        deltaDetents: detentDelta,
        angle: a,
        delta: d,
        velocity: v,
      });
    }

    if (d !== 0 || v !== 0) {
      pushEvent({
        type: 'bezelWheel:scrub',
        angle: a,
        delta: d,
        velocity: v,
        detent,
      });
    }
  }

  function step(dt = 1 / 60) {
    const totalDt = Math.max(0, Math.min(Number(dt) || 0, 0.25));
    if (totalDt <= 0) return;

    // Sub-step critically-damped spring integration for numerical accuracy
    const steps = Math.max(1, Math.ceil(totalDt / (1 / 60)));
    const subDt = totalDt / steps;
    for (let s = 0; s < steps; s++) {
      const ax = SPRING_K * (springDrag.target.x - springDrag.pos.x) - SPRING_DAMPING * springDrag.vel.x;
      const ay = SPRING_K * (springDrag.target.y - springDrag.pos.y) - SPRING_DAMPING * springDrag.vel.y;
      springDrag.vel.x += ax * subDt;
      springDrag.vel.y += ay * subDt;
      springDrag.pos.x += springDrag.vel.x * subDt;
      springDrag.pos.y += springDrag.vel.y * subDt;
    }

    // Tap ripple parry window + expanding rings
    if (tapRipple.parryRemaining > 0) {
      tapRipple.parryRemaining = Math.max(0, tapRipple.parryRemaining - totalDt);
      tapRipple.parryActive = tapRipple.parryRemaining > 0;
    }
    for (let i = tapRipple.rings.length - 1; i >= 0; i--) {
      const r = tapRipple.rings[i];
      r.life -= totalDt;
      const progress = 1 - Math.max(0, r.life / r.maxLife);
      r.radius = 1 + progress * (r.maxRadius - 1);
      if (r.life <= 0) {
        tapRipple.rings.splice(i, 1);
      }
    }

    // Age ribbon trail samples
    for (let i = 0; i < ribbonSlice.count; i++) {
      const idx = (ribbonSlice.head - 1 - i + RIBBON_CAPACITY) % RIBBON_CAPACITY;
      ribbonAge[idx] += totalDt;
    }
    if (!ribbonSlice.active && ribbonSlice.count > 0) {
      const newestIdx = (ribbonSlice.head - 1 + RIBBON_CAPACITY) % RIBBON_CAPACITY;
      if (ribbonAge[newestIdx] > 0.22) {
        ribbonSlice.count = 0;
        ribbonSlice.recentSegments.length = 0;
      }
    }

    if (bezelWheel.activityTimer > 0) {
      bezelWheel.activityTimer = Math.max(0, bezelWheel.activityTimer - totalDt);
    }
  }

  function cleaveBoxes(boxes) {
    const hits = [];
    if (!Array.isArray(boxes) || ribbonSlice.recentSegments.length === 0) return hits;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (!box) continue;
      for (let s = 0; s < ribbonSlice.recentSegments.length; s++) {
        const seg = ribbonSlice.recentSegments[s];
        if (segmentIntersectsAABB(seg.x0, seg.y0, seg.x1, seg.y1, box)) {
          hits.push({ box, segment: seg });
          break;
        }
      }
    }
    return hits;
  }

  function consumeEvents() {
    if (events.length === 0) return [];
    const copy = events.slice();
    events.length = 0;
    return copy;
  }

  function getState() {
    const trail = [];
    for (let i = 0; i < ribbonSlice.count; i++) {
      const idx = (ribbonSlice.head - ribbonSlice.count + i + RIBBON_CAPACITY) % RIBBON_CAPACITY;
      trail.push({ x: ribbonX[idx], y: ribbonY[idx], age: ribbonAge[idx] });
    }
    return {
      primaryVerb: resolveVerb(),
      slingshot: {
        active: slingshot.active,
        anchor: { x: slingshot.anchorX, y: slingshot.anchorY },
        current: { x: slingshot.currentX, y: slingshot.currentY },
        pull: { x: slingshot.pullX, y: slingshot.pullY },
        distance: slingshot.distance,
        ratchetStep: slingshot.ratchetStep,
        ratchetCount: slingshot.ratchetCount,
        previewDots: slingshot.previewDots.map((d) => ({ x: d.x, y: d.y })),
        lastRelease: slingshot.lastRelease,
      },
      springDrag: {
        active: springDrag.active,
        k: springDrag.k,
        damping: springDrag.damping,
        pos: { x: springDrag.pos.x, y: springDrag.pos.y },
        vel: { x: springDrag.vel.x, y: springDrag.vel.y },
        target: { x: springDrag.target.x, y: springDrag.target.y },
      },
      tapRipple: {
        parryActive: tapRipple.parryActive,
        parryRemainingMs: Math.round(tapRipple.parryRemaining * 1000),
        rings: tapRipple.rings.map((r) => ({ ...r })),
        lastTap: tapRipple.lastTap ? { ...tapRipple.lastTap } : null,
      },
      ribbonSlice: {
        active: ribbonSlice.active,
        capacity: RIBBON_CAPACITY,
        count: ribbonSlice.count,
        trail,
        lastSegment: ribbonSlice.lastSegment ? { ...ribbonSlice.lastSegment } : null,
      },
      bezelWheel: {
        angle: bezelWheel.angle,
        delta: bezelWheel.delta,
        velocity: bezelWheel.velocity,
        detent: bezelWheel.detent,
        detents: BEZEL_DETENTS,
      },
    };
  }

  function flushParticles(k) {
    if (!k || pendingParticleBursts.length === 0 || typeof k.emitParticles !== 'function') return;
    for (let i = 0; i < pendingParticleBursts.length; i++) {
      k.emitParticles(pendingParticleBursts[i]);
    }
    pendingParticleBursts.length = 0;
  }

  function drawOverlay(k) {
    if (!k) return;

    // Flush queued radial / directional sparks to kernel particle pool
    flushParticles(k);

    // 1. Slingshot elastic band + parabolic trajectory preview dots
    if (slingshot.active) {
      k.drawLine(slingshot.anchorX, slingshot.anchorY, slingshot.currentX, slingshot.currentY, 6);
      k.drawPixel(slingshot.anchorX, slingshot.anchorY, 7);
      for (let i = 0; i < slingshot.previewDots.length; i++) {
        const dot = slingshot.previewDots[i];
        const col = (i & 1) === 0 ? 7 : 4;
        k.drawPixel(dot.x, dot.y, col);
      }
    }

    // 2. Spring-Drag tether
    if (springDrag.active) {
      k.drawLine(springDrag.pos.x, springDrag.pos.y, springDrag.target.x, springDrag.target.y, 10);
      k.drawPixel(springDrag.pos.x, springDrag.pos.y, 4);
      k.drawPixel(springDrag.target.x, springDrag.target.y, 7);
    }

    // 3. Tap Ripple expanding pixel shockwave rings
    for (let i = 0; i < tapRipple.rings.length; i++) {
      const r = tapRipple.rings[i];
      const col = r.life > r.maxLife * 0.5 ? 4 : 10;
      drawRingPixels(k, r.x, r.y, r.radius, col);
    }

    // 4. Ribbon Slice tapered 4x4 Bayer-dithered blade
    if (ribbonSlice.count >= 2) {
      const count = ribbonSlice.count;
      for (let i = 1; i < count; i++) {
        const idxA = (ribbonSlice.head - count + i - 1 + RIBBON_CAPACITY) % RIBBON_CAPACITY;
        const idxB = (ribbonSlice.head - count + i + RIBBON_CAPACITY) % RIBBON_CAPACITY;
        const t = i / (count - 1);
        const col = t > 0.7 ? 4 : (t > 0.35 ? 10 : 11);
        const x0 = ribbonX[idxA];
        const y0 = ribbonY[idxA];
        const x1 = ribbonX[idxB];
        const y1 = ribbonY[idxB];
        k.drawLine(x0, y0, x1, y1, col);
        // Tapered dithered outer edge near blade tip
        if (t > 0.45) {
          const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
          for (let s = 0; s <= steps; s++) {
            const u = s / steps;
            const px = Math.round(x0 + (x1 - x0) * u);
            const py = Math.round(y0 + (y1 - y0) * u) + 1;
            const threshold = (BAYER_4X4[((py & 3) << 2) | (px & 3)] + 0.5) / 16;
            if (t > threshold) {
              k.drawPixel(px, py, t > 0.75 ? 10 : 3);
            }
          }
        }
      }
    }

    // 5. Minimal Bezel Wheel horizon pip when scrubbing
    if (bezelWheel.activityTimer > 0 && resolveVerb() === TOUCH_VERBS.BEZEL_WHEEL) {
      const pipX = Math.round((bezelWheel.detent / BEZEL_DETENTS) * (LOGICAL_SIZE - 4)) + 2;
      k.drawPixel(pipX, LOGICAL_SIZE - 2, 7);
      k.drawPixel(pipX + 1, LOGICAL_SIZE - 2, 7);
    }
  }

  // DOM canvas pointer bindings
  function mapClientToLogical(ev) {
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      return { lx: 64, ly: 64 };
    }
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || LOGICAL_SIZE;
    const h = rect.height || LOGICAL_SIZE;
    return {
      lx: clamp(((ev.clientX - rect.left) / w) * LOGICAL_SIZE, 0, LOGICAL_SIZE),
      ly: clamp(((ev.clientY - rect.top) / h) * LOGICAL_SIZE, 0, LOGICAL_SIZE),
    };
  }

  const onDown = (ev) => {
    const { lx, ly } = mapClientToLogical(ev);
    simulatePointer('down', lx, ly, ev.pointerId ?? 0);
  };
  const onMove = (ev) => {
    const { lx, ly } = mapClientToLogical(ev);
    simulatePointer('move', lx, ly, ev.pointerId ?? 0);
  };
  const onUp = (ev) => {
    const { lx, ly } = mapClientToLogical(ev);
    simulatePointer('up', lx, ly, ev.pointerId ?? 0);
  };

  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  let unsubBezel = null;
  if (bus && typeof bus.on === 'function') {
    const bezelHandler = (payload = {}) => {
      const d = Number(payload.delta ?? payload.deltaAngle ?? 0);
      const a = payload.angle !== undefined
        ? Number(payload.angle)
        : (payload.rad !== undefined ? Number(payload.rad) : bezelWheel.angle + d);
      const v = Number(payload.velocity ?? payload.angularVelocity ?? 0);
      setBezelInput(a, d, v);
    };
    const maybeUnsub = bus.on('bezel:scrub', bezelHandler);
    if (typeof maybeUnsub === 'function') {
      unsubBezel = maybeUnsub;
    } else if (typeof bus.off === 'function') {
      unsubBezel = () => bus.off('bezel:scrub', bezelHandler);
    }
  }

  function destroy() {
    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    }
    if (typeof unsubBezel === 'function') {
      unsubBezel();
    }
  }

  return {
    simulatePointer,
    setBezelInput,
    consumeEvents,
    getState,
    flushParticles,
    drawOverlay,
    step,
    update: step,
    cleaveBoxes,
    destroy,
  };
}
