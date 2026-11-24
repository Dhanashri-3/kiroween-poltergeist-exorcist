import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '../config.js';
import { createApiClient, loadSnapshot } from '../api/client.js';
import { createEventStream } from '../api/eventStream.js';

/**
 * Loads the snapshot, then streams Events into `dispatch` as {kind:'event', event}.
 * startChaos / reset only dispatch the local request action and call the API (Req 15.8).
 */
export function useEventStream({ dispatch, client, baseUrl = API_BASE_URL, EventSourceImpl } = {}) {
  const apiClient = useMemo(() => client ?? createApiClient({ baseUrl }), [client, baseUrl]);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [lastSeq, setLastSeq] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let stream = null;

    (async () => {
      let maxSeq = 0;
      try {
        const result = await loadSnapshot({
          client: apiClient,
          dispatch: (action) => { if (active) dispatchRef.current(action); },
          signal: controller.signal,
        });
        maxSeq = result.maxSeq;
        if (active && result.errors.length > 0) {
          const first = result.errors[0];
          setError(`${first.endpoint}: ${first.error?.message ?? 'request failed'}`);
        }
      } catch (e) {
        if (active) setError(e?.message ?? 'Snapshot failed.');
      }
      if (!active) return;
      setLastSeq(maxSeq);
      stream = createEventStream({
        baseUrl,
        EventSourceImpl,
        initialAfterSeq: maxSeq,
        onEvent: (event) => {
          if (!active) return;
          dispatchRef.current({ kind: 'event', event });
          setLastSeq(stream.getLastSeq());
        },
        onStatus: (s) => { if (active) setStatus(s); },
        onError: (e) => { if (active) setError(e.message); },
      });
      stream.start();
    })();

    return () => {
      active = false;
      controller.abort();
      if (stream) stream.close();
    };
  }, [apiClient, baseUrl, EventSourceImpl]);

  const startChaos = useCallback((scenarioId) => {
    dispatchRef.current({ kind: 'chaos-start-requested' });
    return apiClient.startChaosRun(scenarioId);
  }, [apiClient]);

  const reset = useCallback(() => {
    dispatchRef.current({ kind: 'reset-requested' });
    return apiClient.reset();
  }, [apiClient]);

  return { connected: status === 'connected', status, error, lastSeq, startChaos, reset };
}
