import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** The MediaQueryList, or null when matchMedia is missing (jsdom, old browsers, SSR) or throws. */
function getQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia(QUERY);
  } catch {
    return null;
  }
}

/**
 * True when the user asked for reduced motion.
 *
 * Without matchMedia (jsdom, SSR) it returns false and registers nothing, so there is no effect work.
 * When the preference changes at runtime the value updates. Listeners are removed on unmount.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    const query = getQuery();
    return query ? Boolean(query.matches) : false;
  });

  useEffect(() => {
    const query = getQuery();
    if (!query) return undefined;
    const update = () => setReduced(Boolean(query.matches));
    update();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    if (typeof query.addListener === 'function') { // Safari < 14
      query.addListener(update);
      return () => query.removeListener(update);
    }
    return undefined;
  }, []);

  return reduced;
}

export default useReducedMotion;
