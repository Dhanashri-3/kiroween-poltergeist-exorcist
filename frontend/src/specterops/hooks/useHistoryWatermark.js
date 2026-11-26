import { useRef } from 'react';

/**
 * The highest Event seq that counts as history. It is fixed the first time `ready` is true (pass
 * `connection.status === 'connected'`, the same rule useLiveRefresh uses) and never moves after that.
 * Events with seq above it are live and may trigger effects; everything else renders in steady state.
 * Returns null while not ready, which means "nothing is live".
 */
export function useHistoryWatermark({ events, ready } = {}) {
  const mark = useRef(null);
  if (mark.current === null && ready) {
    const list = Array.isArray(events) ? events : [];
    const last = list.length > 0 ? list[list.length - 1] : null;
    mark.current = last && Number.isInteger(last.seq) ? last.seq : -1; // seq may be 0, so empty history is -1
  }
  return mark.current;
}

export default useHistoryWatermark;
