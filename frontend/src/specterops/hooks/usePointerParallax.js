import { useEffect, useRef } from 'react';
import { useReducedMotion } from './useReducedMotion.js';

const DEFAULT_PROPERTY_X = '--specterops-pointer-x';
const DEFAULT_PROPERTY_Y = '--specterops-pointer-y';
const SETTLE_EPSILON = 0.001;

/** True only with a real viewport and a pointer that can hover. jsdom (clientWidth 0) and touch-only devices fail. */
function canTrackPointer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (!root || !(root.clientWidth > 0) || !(root.clientHeight > 0)) return false;
  if (typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(hover: none)').matches) return false;
    } catch { /* treat as hover-capable */ }
  }
  return true;
}

/** Schedules fn on the next frame (rAF, or a 16 ms timer when rAF is missing). Returns a cancel function. */
function requestFrame(fn) {
  if (typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(fn);
    return () => {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
    };
  }
  const id = window.setTimeout(fn, 16);
  return () => window.clearTimeout(id);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Writes smoothed pointer position, each axis in [-0.5, 0.5] (0 = viewport centre), to two CSS custom
 * properties on `targetRef.current`. Mirrors the cursor parallax in web-ui without re-rendering React.
 *
 * options:
 *   targetRef   required ref to the element that receives the properties (the shell wrapper)
 *   enabled     default true
 *   propertyX / propertyY   default '--specterops-pointer-x' / '--specterops-pointer-y'
 *   smoothing   0.01..1, fraction of the remaining distance covered per frame (default 0.12)
 *
 * returns { pointerRef, reducedMotion }. pointerRef.current is { x, y }.
 *
 * Safeguards:
 *  - Nothing is registered when disabled, when targetRef is empty, in jsdom (no viewport), or on touch-only devices.
 *  - With reduced motion the values are fixed at 0 and no listeners are registered.
 *  - The animation loop runs only while the value is still moving; it stops once settled, so an idle page does no work.
 *  - Pointer events are ignored while the target is off screen (IntersectionObserver, used only if present).
 *  - The pointer listener is passive. Listeners, observers and pending frames are cleaned up.
 */
export function usePointerParallax({
  targetRef,
  enabled = true,
  propertyX = DEFAULT_PROPERTY_X,
  propertyY = DEFAULT_PROPERTY_Y,
  smoothing = 0.12,
} = {}) {
  const reducedMotion = useReducedMotion();
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const target = targetRef?.current;
    if (!enabled || !target) return undefined;

    const write = (x, y) => {
      pointerRef.current = { x, y };
      target.style.setProperty(propertyX, x.toFixed(4));
      target.style.setProperty(propertyY, y.toFixed(4));
    };

    if (reducedMotion) {
      write(0, 0);
      return undefined;
    }
    if (!canTrackPointer()) return undefined;

    const factor = clamp(Number.isFinite(smoothing) ? smoothing : 0.12, 0.01, 1);
    let goal = { x: 0, y: 0 };
    let current = { x: 0, y: 0 };
    let cancelFrame = null;
    let visible = true;

    const step = () => {
      cancelFrame = null;
      const dx = goal.x - current.x;
      const dy = goal.y - current.y;
      if (Math.abs(dx) < SETTLE_EPSILON && Math.abs(dy) < SETTLE_EPSILON) {
        current = { ...goal };
        write(current.x, current.y);
        return; // settled: no further frames until the pointer moves again
      }
      current = { x: current.x + dx * factor, y: current.y + dy * factor };
      write(current.x, current.y);
      cancelFrame = requestFrame(step);
    };

    const onMove = (event) => {
      if (!visible) return;
      const root = document.documentElement;
      const width = window.innerWidth || root.clientWidth;
      const height = window.innerHeight || root.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      const x = event.clientX / width - 0.5;
      const y = event.clientY / height - 0.5;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      goal = { x: clamp(x, -0.5, 0.5), y: clamp(y, -0.5, 0.5) };
      if (cancelFrame === null) cancelFrame = requestFrame(step);
    };

    window.addEventListener('pointermove', onMove, { passive: true });

    let intersection = null;
    if (typeof window.IntersectionObserver === 'function') {
      try {
        intersection = new window.IntersectionObserver((entries) => {
          const last = entries[entries.length - 1];
          visible = last ? last.isIntersecting : true;
          if (!visible && cancelFrame !== null) {
            cancelFrame();
            cancelFrame = null;
          }
        });
        intersection.observe(target);
      } catch {
        intersection = null;
      }
    }

    return () => {
      window.removeEventListener('pointermove', onMove);
      if (intersection) intersection.disconnect();
      if (cancelFrame !== null) cancelFrame();
    };
  }, [targetRef, enabled, propertyX, propertyY, smoothing, reducedMotion]);

  return { pointerRef, reducedMotion };
}

export default usePointerParallax;
