import { useEffect, useRef } from 'react';
import { useReducedMotion } from './useReducedMotion.js';

const DEFAULT_PROPERTY = '--specterops-scroll';

/** True only when a real viewport exists. jsdom reports clientHeight 0, so it fails this check. */
function canMeasureLayout() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const root = document.documentElement;
  return Boolean(root) && root.clientHeight > 0;
}

/** Document scroll progress in [0, 1]. Returns 0 when the page cannot scroll or values are not finite. */
function readProgress() {
  const root = document.documentElement;
  const scrollable = root.scrollHeight - root.clientHeight;
  if (!(scrollable > 0)) return 0;
  const top = window.scrollY ?? window.pageYOffset ?? root.scrollTop ?? 0;
  const progress = top / scrollable;
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
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

/**
 * Writes document scroll progress (0..1) to a CSS custom property on `targetRef.current`, so a
 * scroll-driven scene updates without re-rendering React on every scroll event.
 *
 * options:
 *   targetRef   required ref to the element that receives the property (the shell wrapper)
 *   enabled     default true
 *   property    default '--specterops-scroll'
 *   onProgress  optional callback with the latest value
 *
 * returns { progressRef, reducedMotion }. progressRef.current holds the latest value.
 *
 * Safeguards:
 *  - Nothing is registered when disabled, when targetRef is empty, or when layout is unavailable
 *    (jsdom, no viewport). In those cases the CSS variable is not written; CSS keeps its default.
 *  - With reduced motion the value is fixed at 0 and no listeners are registered.
 *  - Updates are throttled to one per animation frame. Scroll and resize listeners are passive.
 *  - ResizeObserver (content height changes) and document.fonts.ready (font swap) are used only if present.
 *  - It never scrolls the page. All listeners, observers and pending frames are cleaned up.
 */
export function useScrollProgress({ targetRef, enabled = true, property = DEFAULT_PROPERTY, onProgress } = {}) {
  const reducedMotion = useReducedMotion();
  const progressRef = useRef(0);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    const target = targetRef?.current;
    if (!enabled || !target) return undefined;

    const publish = (value) => {
      progressRef.current = value;
      target.style.setProperty(property, value.toFixed(4));
      try {
        onProgressRef.current?.(value);
      } catch { /* a callback must never break the hook */ }
    };

    if (reducedMotion) {
      publish(0);
      return undefined;
    }
    if (!canMeasureLayout()) return undefined;

    let cancelFrame = null;
    const update = () => {
      cancelFrame = null;
      publish(readProgress());
    };
    const schedule = () => {
      if (cancelFrame === null) cancelFrame = requestFrame(update);
    };

    update(); // initial measurement; no scrolling happens

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    let resizeObserver = null;
    if (typeof window.ResizeObserver === 'function') {
      try {
        resizeObserver = new window.ResizeObserver(schedule);
        resizeObserver.observe(document.documentElement);
      } catch {
        resizeObserver = null;
      }
    }

    let active = true;
    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      fontsReady.then(() => { if (active) schedule(); }, () => {});
    }

    return () => {
      active = false;
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (resizeObserver) resizeObserver.disconnect();
      if (cancelFrame !== null) cancelFrame();
    };
  }, [targetRef, enabled, property, reducedMotion]);

  return { progressRef, reducedMotion };
}

export default useScrollProgress;
