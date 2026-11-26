import { useCallback, useEffect, useRef, useState } from 'react';

export const REQUEST_IN_PROGRESS = 'request_in_progress';
export const REQUEST_IN_PROGRESS_MESSAGE = 'Another request is already in progress.';

const inProgressError = () => Object.assign(new Error(REQUEST_IN_PROGRESS_MESSAGE), { code: REQUEST_IN_PROGRESS });

/**
 * One shared in-flight guard for the chaos-start and reset requests (Phase 4B.2).
 *
 * Wraps the existing `startChaos` and `reset` functions from useEventStream without replacing them. Both
 * wrapped functions use the SAME guard, so the hero Summon action and the Dashboard ScenarioControls can never
 * submit overlapping requests. While a request is in flight, any other call rejects with
 * `{ code: 'request_in_progress', message: 'Another request is already in progress.' }` (an Error carrying that
 * code) and the wrapped function is NOT called. The guard is released when the request settles, whether it
 * succeeds or fails, and before the caller observes the result.
 *
 * It adds no endpoint and fabricates no result. Arguments and return values pass through unchanged, so
 * ScenarioControls' own guard and the backend's 409 `incident_active` keep working as before.
 *
 * returns { startChaos, reset, busy }. The two functions keep a stable identity across renders and always call
 * the latest functions passed in. `busy` is for UI (for example disabling the hero button); the ref is the
 * authority, so the guard also holds between a click and the next render.
 */
export function useSharedChaosGuard({ startChaos, reset } = {}) {
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({ startChaos, reset });
  latest.current = { startChaos, reset };
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback((name, args) => {
    if (inFlight.current) return Promise.reject(inProgressError());
    const fn = latest.current[name];
    if (typeof fn !== 'function') return Promise.reject(new TypeError(`${name} is not available.`));

    inFlight.current = true;
    if (mounted.current) setBusy(true);
    const release = () => {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    };

    let result;
    try {
      result = fn(...args);
    } catch (error) {
      release();
      throw error; // a synchronous throw behaves exactly as it did without the guard
    }
    return Promise.resolve(result).finally(release);
  }, []);

  const guardedStartChaos = useCallback((...args) => run('startChaos', args), [run]);
  const guardedReset = useCallback((...args) => run('reset', args), [run]);

  return { startChaos: guardedStartChaos, reset: guardedReset, busy };
}

export default useSharedChaosGuard;
