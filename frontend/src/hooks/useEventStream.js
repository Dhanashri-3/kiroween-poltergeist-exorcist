import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '../config.js';
import { createApiClient, loadSnapshot } from '../api/client.js';
import { createEventStream } from '../api/eventStream.js';
import { isValidEvent } from '../state/dashboardReducer.js';

/**
 * Event history lifecycle (Phase 4B.3C.3).
 *
 * The stream replays every Event after `afterSeq`. If the `/events` snapshot failed, afterSeq is 0 and the whole
 * history arrives over the stream after `open`, indistinguishable from live Events. Consumers therefore must not
 * treat anything as live until `history.ready`, and must use `history.boundarySeq` as the live boundary.
 *
 *   history.status   'loading'     first snapshot attempt in flight
 *                    'retrying'    an attempt failed; the next one is scheduled or in flight
 *                    'ready'       a validated `{ events }` response was dispatched; boundarySeq is fixed for good
 *                    'unavailable' the retry budget of one cycle is spent; live effects must stay paused
 *   history.attempts attempts made in the current cycle (1..HISTORY_MAX_ATTEMPTS)
 *   history.error    message of the last failure, or null
 *   history.ready    status === 'ready'; never regresses
 *   history.boundarySeq  highest seq that is history (null until ready). Events with a higher seq are live.
 *
 * Cycle: attempts at 0, 1, 3 and 7 s (delays 1 s, 2 s, 4 s after each failure), each limited to 10 s; a timeout, an
 * abort, a network/HTTP error or a malformed body is a failed attempt, never an empty history. One cycle runs at
 * start. While 'unavailable', each stream reconnection (status back to 'connected') allows one more cycle. Nothing
 * runs while idle, and nothing runs once ready.
 *
 * Boundary (no stale React state): boundarySeq = max(highest seq among the reducer-valid Events of the successful
 * response, highest seq already received from the stream). Every Event created before the successful read is in
 * that response, so it is <= the boundary (history). Stream Events received before success are counted too, so an
 * Event that arrives during the retries is classified as history (conservative: never a false live effect). Only
 * Events with a seq above the boundary, which did not exist at read time, are live. The events response is
 * dispatched before `ready` is set, so the reducer already holds the history when consumers see `ready`.
 */
export const HISTORY_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
export const HISTORY_ATTEMPT_TIMEOUT_MS = 10_000;
export const HISTORY_MAX_ATTEMPTS = HISTORY_RETRY_DELAYS_MS.length + 1;

const INITIAL_HISTORY = Object.freeze({ status: 'loading', attempts: 0, error: null, ready: false, boundarySeq: null });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEventsResponse = (r) => isObject(r) && Array.isArray(r.events);

/** Highest seq among the reducer-valid Events of a validated `{ events }` response; -1 when there are none. */
export function maxValidSeq(events) {
  let max = -1;
  for (const e of Array.isArray(events) ? events : []) if (isValidEvent(e) && e.seq > max) max = e.seq;
  return max;
}

/** loadSnapshot's resume rule: highest non-negative integer seq on any object in the list, else 0. */
function maxResumeSeq(events) {
  let max = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (isObject(e) && Number.isInteger(e.seq) && e.seq >= 0 && e.seq > max) max = e.seq;
  }
  return max;
}

const describe = (e) => {
  const message = typeof e?.message === 'string' && e.message !== '' ? e.message : 'request failed';
  return typeof e?.code === 'string' && e.code !== '' ? `${message} (${e.code})` : message;
};
const timeoutError = (ms) => Object.assign(new Error(`History request timed out after ${ms} ms.`), { code: 'timeout' });
const malformedError = () => Object.assign(new Error('History response has an unexpected shape.'), { code: 'invalid_response' });

/**
 * Loads the snapshot, then streams Events into `dispatch` as {kind:'event', event}.
 * startChaos / reset only dispatch the local request action and call the API (Req 15.8).
 * Optional test hooks: historyRetryDelaysMs, historyTimeoutMs (production defaults above).
 */
export function useEventStream({
  dispatch, client, baseUrl = API_BASE_URL, EventSourceImpl,
  historyRetryDelaysMs = HISTORY_RETRY_DELAYS_MS, historyTimeoutMs = HISTORY_ATTEMPT_TIMEOUT_MS,
} = {}) {
  const apiClient = useMemo(() => client ?? createApiClient({ baseUrl }), [client, baseUrl]);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const timingRef = useRef(null);
  timingRef.current = { delays: historyRetryDelaysMs, timeoutMs: historyTimeoutMs };
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [lastSeq, setLastSeq] = useState(0);
  const [history, setHistory] = useState(INITIAL_HISTORY);

  useEffect(() => {
    let active = true;
    const controller = new AbortController(); // aborts everything on unmount
    let stream = null;
    const timers = new Set();
    let historyReady = false;
    let historyStatus = 'loading';
    let cycleRunning = false;
    let streamMaxSeq = -1; // highest seq received from the stream; part of the boundary

    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    };
    const cancel = (id) => { clearTimeout(id); timers.delete(id); };
    const wait = (ms) => new Promise((resolve) => { later(resolve, ms); }); // never resolves after cleanup
    const update = (next) => {
      if (!active) return;
      historyStatus = next.status;
      setHistory(next);
    };

    /** Records history as ready exactly once. Call right after dispatching the events response. */
    const markReady = (snapshotMax, attempts) => {
      if (!active || historyReady) return;
      historyReady = true;
      update({ status: 'ready', attempts, error: null, ready: true, boundarySeq: Math.max(snapshotMax, streamMaxSeq) });
    };

    /**
     * One `/events` attempt with its own timeout. Resolves {ok, response|error}. The first settlement wins, so a
     * response that arrives after the timeout or after unmount is ignored. Aborts never count as success.
     */
    const attemptEvents = () => new Promise((resolve) => {
      const attempt = new AbortController();
      const onUnmount = () => attempt.abort();
      controller.signal.addEventListener('abort', onUnmount);
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel(timer);
        controller.signal.removeEventListener('abort', onUnmount);
        resolve(result);
      };
      const ms = timingRef.current.timeoutMs;
      timer = later(() => { attempt.abort(); finish({ ok: false, error: timeoutError(ms) }); }, ms);
      Promise.resolve()
        .then(() => apiClient.getEvents({}, { signal: attempt.signal }))
        .then((response) => finish({ ok: true, response }), (e) => finish({ ok: false, error: e }));
    });

    /** One bounded retry cycle. `done` attempts of this cycle already happened (the initial snapshot counts as 1). */
    const runCycle = async (done, lastError) => {
      if (cycleRunning || historyReady || !active) return;
      cycleRunning = true;
      let attempts = done;
      let failure = lastError;
      const delays = timingRef.current.delays;
      while (active && !historyReady && attempts < delays.length + 1) {
        if (attempts > 0) {
          update({ status: 'retrying', attempts, error: describe(failure), ready: false, boundarySeq: null });
          await wait(delays[attempts - 1]);
          if (!active || historyReady) break;
        }
        attempts += 1;
        update({ status: 'retrying', attempts, error: failure ? describe(failure) : null, ready: false, boundarySeq: null });
        const result = await attemptEvents();
        if (!active || historyReady) break;
        if (result.ok && isEventsResponse(result.response)) {
          dispatchRef.current({ kind: 'api', endpoint: 'events', response: result.response });
          markReady(maxValidSeq(result.response.events), attempts);
          break;
        }
        failure = result.ok ? malformedError() : result.error;
      }
      cycleRunning = false;
      if (active && !historyReady) {
        update({ status: 'unavailable', attempts, error: describe(failure), ready: false, boundarySeq: null });
      }
    };

    (async () => {
      let maxSeq = 0;
      // Initial snapshot = attempt 1 of the first cycle. It has its own timeout; on timeout its signal is aborted,
      // so loadSnapshot dispatches nothing late. History success is decided by seeing the events response
      // dispatched, never by the absence of errors (an aborted loadSnapshot reports no errors).
      const snapshot = new AbortController();
      const onUnmount = () => snapshot.abort();
      controller.signal.addEventListener('abort', onUnmount);
      let eventsResponse = null;
      let timedOut = false;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = later(() => { timedOut = true; snapshot.abort(); resolve(null); }, timingRef.current.timeoutMs);
      });
      let snapshotError = null;
      try {
        const result = await Promise.race([
          loadSnapshot({
            client: apiClient,
            dispatch: (action) => {
              if (!active || snapshot.signal.aborted) return;
              if (action.kind === 'api' && action.endpoint === 'events') eventsResponse = action.response;
              dispatchRef.current(action);
            },
            signal: snapshot.signal,
          }),
          timeout,
        ]);
        if (result) {
          maxSeq = result.maxSeq;
          const eventsFailure = result.errors.find((e) => e.endpoint === 'events');
          if (eventsFailure) snapshotError = eventsFailure.error;
          if (active && result.errors.length > 0) {
            const first = result.errors[0];
            setError(`${first.endpoint}: ${first.error?.message ?? 'request failed'}`);
          }
        }
      } catch (e) {
        snapshotError = e;
        if (active) setError(e?.message ?? 'Snapshot failed.');
      } finally {
        if (timer !== null) cancel(timer);
        controller.signal.removeEventListener('abort', onUnmount);
      }
      if (!active) return;
      if (timedOut) {
        snapshotError = timeoutError(timingRef.current.timeoutMs);
        setError(`snapshot: ${snapshotError.message}`);
        // Resume after what was actually dispatched (same rule as loadSnapshot's maxSeq), or from 0.
        maxSeq = eventsResponse === null ? 0 : maxResumeSeq(eventsResponse.events);
      }

      const initialOk = eventsResponse !== null && isEventsResponse(eventsResponse);
      if (initialOk) markReady(maxValidSeq(eventsResponse.events), 1);

      setLastSeq(maxSeq);
      stream = createEventStream({
        baseUrl,
        EventSourceImpl,
        initialAfterSeq: maxSeq,
        onEvent: (event) => {
          if (!active) return;
          if (event.seq > streamMaxSeq) streamMaxSeq = event.seq; // before dispatch: counted even if ready is near
          dispatchRef.current({ kind: 'event', event });
          setLastSeq(stream.getLastSeq());
        },
        onStatus: (s) => {
          if (!active) return;
          setStatus(s);
          // One more bounded cycle per (re)connection while history is unavailable. Never once ready.
          if (s === 'connected' && historyStatus === 'unavailable') runCycle(0, null);
        },
        onError: (e) => { if (active) setError(e.message); },
      });
      stream.start();
      if (!initialOk) runCycle(1, snapshotError ?? malformedError());
    })();

    return () => {
      active = false;
      controller.abort();
      for (const id of timers) clearTimeout(id);
      timers.clear();
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

  return { connected: status === 'connected', status, error, lastSeq, startChaos, reset, history };
}
