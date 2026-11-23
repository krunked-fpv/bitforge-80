/**
 * BitForge-80 48-Detent Tactile Bezel Thumb-Wheel
 * Pointer-capture rotary/horizontal notched thumb-wheel ribbon driving bezel:scrub,
 * bezel:detent, visual notch displacement, and runtime TouchVerbController.setBezelInput.
 */

const TWO_PI = Math.PI * 2;
const PX_PER_REV = 240;
const NOTCH_PITCH_PX = 24;

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function wrapDetent(totalIdx, detents) {
  return ((totalIdx % detents) + detents) % detents;
}

/**
 * Create the 48-detent bottom bezel thumb-wheel controller.
 * @param {{
 *   element?: HTMLElement|null,
 *   bus?: { emit?: Function, on?: Function, off?: Function }|null,
 *   detents?: number,
 *   runtime?: object|null,
 *   getRuntime?: (() => object|null)|null,
 * }} [opts]
 */
export function createBezelWheel({
  element = null,
  bus = null,
  detents = 48,
  runtime = null,
  getRuntime = null,
} = {}) {
  const detentCount = Math.max(8, Math.round(Number(detents) || 48));
  const stepAngle = TWO_PI / detentCount;

  let boundRuntime = runtime;
  let angle = 0;
  let velocity = 0;
  let totalDetentIndex = 0;
  let detentIndex = 0;
  let destroyed = false;

  let activePointerId = null;
  let lastClientX = 0;
  let lastMoveMs = 0;

  let notchesEl = null;
  let readoutEl = null;
  const cleanupListeners = [];

  function resolveRuntime() {
    if (typeof getRuntime === 'function') {
      const rt = getRuntime();
      if (rt) return rt;
    }
    return boundRuntime;
  }

  function updateVisuals() {
    if (notchesEl) {
      const pxOffset = ((angle / TWO_PI) * PX_PER_REV) % NOTCH_PITCH_PX;
      const wrappedPx = pxOffset < 0 ? pxOffset + NOTCH_PITCH_PX : pxOffset;
      notchesEl.style.transform = `translate3d(${wrappedPx.toFixed(2)}px, 0, 0)`;
    }
    if (readoutEl) {
      readoutEl.textContent = `${String(detentIndex).padStart(2, '0')} / ${detentCount}`;
    }
    if (element && typeof element.setAttribute === 'function') {
      element.setAttribute('aria-valuenow', String(detentIndex));
    }
  }

  function syncRuntimeTouchVerb(nextAngle, deltaAngle, nextVelocity) {
    const rt = resolveRuntime();
    const touchVerbs = rt && typeof rt.getTouchVerbs === 'function' ? rt.getTouchVerbs() : null;
    if (!touchVerbs || typeof touchVerbs.setBezelInput !== 'function') return;

    const current = typeof touchVerbs.getState === 'function'
      ? touchVerbs.getState()?.bezelWheel
      : null;

    // Avoid duplicate bezelWheel:scrub emission if shared bus listener already synced this exact sample
    if (
      current &&
      Math.abs((current.angle ?? 0) - nextAngle) < 1e-9 &&
      Math.abs((current.velocity ?? 0) - nextVelocity) < 1e-9
    ) {
      return;
    }
    touchVerbs.setBezelInput(nextAngle, deltaAngle, nextVelocity);
  }

  function applyRotation(deltaAngle, nextVelocity = 0) {
    if (destroyed) return;
    const delta = Number.isFinite(deltaAngle) ? deltaAngle : 0;
    const vel = Number.isFinite(nextVelocity) ? nextVelocity : 0;
    angle += delta;
    velocity = vel;

    const nextTotalIdx = Math.floor(angle / stepAngle);
    const prevTotalIdx = totalDetentIndex;
    if (nextTotalIdx !== prevTotalIdx) {
      const direction = nextTotalIdx > prevTotalIdx ? 1 : -1;
      const stepsCrossed = Math.min(detentCount, Math.abs(nextTotalIdx - prevTotalIdx));
      for (let s = 1; s <= stepsCrossed; s++) {
        const crossedIdx = prevTotalIdx + direction * s;
        const wrapped = wrapDetent(crossedIdx, detentCount);
        detentIndex = wrapped;
        if (bus && typeof bus.emit === 'function') {
          bus.emit('bezel:detent', {
            detentIndex: wrapped,
            detent: wrapped,
            direction,
            velocity: vel,
            angle,
          });
        }
      }
      totalDetentIndex = nextTotalIdx;
      detentIndex = wrapDetent(nextTotalIdx, detentCount);
    }

    if (bus && typeof bus.emit === 'function') {
      bus.emit('bezel:scrub', {
        angle,
        delta,
        velocity: vel,
      });
    }

    syncRuntimeTouchVerb(angle, delta, vel);
    updateVisuals();
  }

  function setAngle(nextAngle, nextVelocity = 0) {
    const target = Number.isFinite(nextAngle) ? nextAngle : 0;
    applyRotation(target - angle, nextVelocity);
  }

  function buildDom() {
    if (!element || typeof element !== 'object') return;
    const doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return;

    element.innerHTML = '';
    if (typeof element.setAttribute === 'function') {
      element.setAttribute('role', 'slider');
      element.setAttribute('tabindex', '0');
      element.setAttribute('aria-label', `${detentCount}-Detent Bezel Thumb-Wheel`);
      element.setAttribute('aria-valuemin', '0');
      element.setAttribute('aria-valuemax', String(detentCount - 1));
      element.setAttribute('aria-valuenow', String(detentIndex));
    }

    const metaRow = doc.createElement('div');
    metaRow.className = 'bf-bezel-meta';

    const labelEl = doc.createElement('span');
    labelEl.textContent = `BEZEL // ${detentCount} DETENTS`;
    metaRow.appendChild(labelEl);

    readoutEl = doc.createElement('span');
    readoutEl.className = 'bf-bezel-readout';
    metaRow.appendChild(readoutEl);

    const trackEl = doc.createElement('div');
    trackEl.className = 'bf-bezel-track';

    notchesEl = doc.createElement('div');
    notchesEl.className = 'bf-bezel-notches';
    trackEl.appendChild(notchesEl);

    const centerPip = doc.createElement('div');
    centerPip.className = 'bf-bezel-center-pip';
    trackEl.appendChild(centerPip);

    element.appendChild(metaRow);
    element.appendChild(trackEl);

    const bind = (target, type, fn, opts) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, opts);
      cleanupListeners.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, fn, opts);
        }
      });
    };

    const onPointerDown = (ev) => {
      if (destroyed) return;
      activePointerId = ev.pointerId ?? 0;
      lastClientX = Number(ev.clientX) || 0;
      lastMoveMs = nowMs();
      if (element.dataset) element.dataset.scrubbing = 'true';
      try {
        if (typeof element.setPointerCapture === 'function' && ev.pointerId !== undefined) {
          element.setPointerCapture(ev.pointerId);
        }
      } catch {
        // Ignore mock or non-capturing pointer targets
      }
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
    };

    const onPointerMove = (ev) => {
      if (destroyed || activePointerId === null) return;
      const pid = ev.pointerId ?? 0;
      if (pid !== activePointerId) return;

      const x = Number(ev.clientX) || 0;
      const dx = x - lastClientX;
      if (dx === 0) return;

      const t = nowMs();
      const dt = Math.max(0.004, (t - lastMoveMs) / 1000);
      lastClientX = x;
      lastMoveMs = t;

      const deltaAngle = (dx / PX_PER_REV) * TWO_PI;
      const vel = deltaAngle / dt;
      applyRotation(deltaAngle, vel);
    };

    const onPointerUp = (ev) => {
      const pid = ev.pointerId ?? 0;
      if (activePointerId !== null && pid !== activePointerId) return;
      activePointerId = null;
      velocity = 0;
      if (element.dataset) element.dataset.scrubbing = 'false';
      try {
        if (typeof element.releasePointerCapture === 'function' && ev.pointerId !== undefined) {
          element.releasePointerCapture(ev.pointerId);
        }
      } catch {
        // Ignore pointer capture release errors
      }
    };

    const onWheel = (ev) => {
      if (destroyed) return;
      const raw = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (!Number.isFinite(raw) || raw === 0) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const deltaAngle = (-Math.sign(raw) * Math.min(48, Math.abs(raw)) / PX_PER_REV) * TWO_PI;
      applyRotation(deltaAngle, deltaAngle * 30);
    };

    const onKeyDown = (ev) => {
      if (destroyed) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        applyRotation(stepAngle, stepAngle * 24);
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        applyRotation(-stepAngle, -stepAngle * 24);
      }
    };

    bind(element, 'pointerdown', onPointerDown);
    bind(element, 'pointermove', onPointerMove);
    bind(element, 'pointerup', onPointerUp);
    bind(element, 'pointercancel', onPointerUp);
    bind(element, 'wheel', onWheel, { passive: false });
    bind(element, 'keydown', onKeyDown);

    updateVisuals();
  }

  buildDom();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of cleanupListeners) off();
    cleanupListeners.length = 0;
    activePointerId = null;
    notchesEl = null;
    readoutEl = null;
  }

  return {
    scrubBy: applyRotation,
    setAngle,
    setRuntime(rt) {
      boundRuntime = rt || null;
    },
    getState: () => ({
      angle,
      velocity,
      detentIndex,
      detents: detentCount,
      scrubbing: activePointerId !== null,
    }),
    destroy,
  };
}
