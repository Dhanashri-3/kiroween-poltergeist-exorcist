import { useEffect, useMemo, useRef } from 'react';
import { API_BASE_URL } from '../../config.js';
import { ApiError, createApiClient } from '../../api/client.js';
import { selectIncidentIds } from '../../state/dashboardReducer.js';
import { omittedPayloadBytes } from '../../state/dashboardViews.js';

/**
 * Live refresh of backend state (Phase 4B.2).
 *
 * The existing SSE hook loads health, scenarios and incidents once, then only streams Events. Incident
 * records (component, attemptCount, terminalReason, ...) and health therefore go stale. This hook reads the
 * Events already in reducer state and, for genuine live Events, re-reads the affected resource through the
 * existing API client and dispatches the EXISTING reducer action shape:
 *
 *   { kind: 'api', endpoint: 'health' | 'incident' | 'verification', response }
 *
 * It opens no EventSource, does not poll while idle, invents no data and never turns an error into a success
 * state. The reducer stays authoritative: recovery still needs a passing verification Event.
 *
 * Arguments (one object):
 *   state          reducer state (uses state.events and state.apiIncidents)
 *   dispatch       the reducer dispatch (App owns it)
 *   client         optional API client (tests); default createApiClient({ baseUrl })
 *   baseUrl        default API_BASE_URL
 *   ready          default true. Events present when this first becomes true are history and are NOT refreshed.
 *                  Pass `connection.status === 'connected'` so snapshot history never triggers requests.
 *   onError        optional callback for refresh failures: { tag:'SYSTEM', text, key, code, status, attempts, message }.
 *                  It is separate from the connection error and control error UI.
 *   debounceMs     default 300. Triggers for the same resource inside this window share one request.
 *   settleMs       default 2000. One extra refresh after a terminal incident state.
 *   cooldownMs     default 5000. Pause after 404 incident_not_found and between unknown-incident lookups.
 *   retryDelaysMs  default [1000, 2000, 4000]. Delays before retries after an ApiError (3 retries at most).
 *                  The budget belongs to one resource and one refresh episode: Events that arrive during a backoff
 *                  are absorbed by the pending retry and never reset the budget. A success, a handled 404 or the
 *                  final failure report ends the episode; only a trigger after that starts a fresh budget.
 */

export const HEALTH_EVENT_TYPES = Object.freeze([
  'chaos.injection', 'detection', 'cleared', 'repair', 'rollback', 'verification', 'recovery', 'reset',
]);
export const INCIDENT_EVENT_TYPES = Object.freeze([
  'incident.state', 'diagnosis', 'plan', 'gate', 'repair', 'verification', 'rollback', 'escalation', 'recovery',
]);
/** `rolled_back` is transient in the backend state machine and is intentionally not listed. */
export const TERMINAL_STATES = Object.freeze(['recovered', 'escalated']);
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

const HEALTH_TYPES = new Set(HEALTH_EVENT_TYPES);
const INCIDENT_TYPES = new Set(INCIDENT_EVENT_TYPES);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isAbort = (e) => e !== null && typeof e === 'object' && e.name === 'AbortError';
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const HEALTH = Object.freeze({ type: 'health' });
const incidentSpec = (id) => ({ type: 'incident', id });
const verificationSpec = (id) => ({ type: 'verification', id });
const keyOf = (spec) => (spec.type === 'health' ? 'health' : `${spec.type}:${spec.id}`);

/** True when the Event payload already holds the full Verification_Result the reducer can use. */
export function isFullVerificationPayload(payload) {
  return isObject(payload) && omittedPayloadBytes(payload) === null &&
    isNonEmptyString(payload.verificationId) && isNonEmptyString(payload.incidentId) &&
    (payload.overall === 'pass' || payload.overall === 'fail');
}

function isOlder(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta < tb;
}

function requestFor(client, spec, signal) {
  switch (spec.type) {
    case 'health': return client.getHealth({ signal });
    case 'incident': return client.getIncident(spec.id, { signal });
    default: return client.getVerification(spec.id, { signal });
  }
}

/**
 * Request engine, independent of React. All state lives in this closure; options are read through
 * `getOptions()` at call time, so a re-render never leaves a stale client, dispatch or callback behind.
 */
export function createRefreshEngine(getOptions) {
  const entries = new Map();
  const settleTimers = new Set();
  const lastUpdatedAt = new Map();
  const lastUnknownAt = new Map();
  let disposed = true; // start() enables it, dispose() disables it (StrictMode mounts twice)

  /**
   * One entry per resource key ('health', 'incident:<id>', 'verification:<id>'), so budgets never mix.
   *
   * Retry episode: `failures` counts failed attempts since the last success. It is stored on the entry, not passed
   * along the call chain, so no trigger can reset it. It returns to 0 only when the episode ends: a success, a
   * handled 404, or the final failure report after the retry budget is spent. Aborted or superseded requests
   * never count as failures.
   */
  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { debounceTimer: null, retryTimer: null, controller: null, counter: 0, cooldownUntil: 0, failures: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  function clearTimers(entry) {
    if (entry.debounceTimer !== null) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    if (entry.retryTimer !== null) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
  }

  function report(spec, key, error, attempts) {
    const { onError } = getOptions();
    if (typeof onError !== 'function') return;
    const what = spec.type === 'health' ? 'health' : `${spec.type} ${spec.id}`;
    const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'request failed';
    const code = typeof error?.code === 'string' ? error.code : null;
    try {
      onError({
        tag: 'SYSTEM',
        text: `[SYSTEM] Live refresh of ${what} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${message}${code ? ` (${code})` : ''}`,
        key,
        code,
        status: Number.isInteger(error?.status) ? error.status : null,
        attempts,
        message,
      });
    } catch { /* a callback must never break the hook */ }
  }

  function deliver(spec, response) {
    if (spec.type === 'incident' && isObject(response)) {
      const at = response.updatedAt;
      const previous = lastUpdatedAt.get(spec.id);
      if (typeof at === 'string' && typeof previous === 'string' && isOlder(at, previous)) return; // older than what is shown
      if (typeof at === 'string') lastUpdatedAt.set(spec.id, at);
    }
    getOptions().dispatch?.({ kind: 'api', endpoint: spec.type, response });
  }

  function handleFailure(spec, key, entry, error) {
    const status = error?.status;
    const code = error?.code;
    if (spec.type === 'incident' && status === 404 && code === 'incident_not_found') {
      entry.failures = 0; // episode ends
      entry.cooldownUntil = Date.now() + getOptions().cooldownMs; // expected for an unknown id: pause, stay silent
      return;
    }
    if (spec.type === 'verification' && status === 404 && (code === 'verification_not_found' || code === 'incident_not_found')) {
      entry.failures = 0; // no Verification_Result yet is a normal state; episode ends
      return;
    }
    entry.failures += 1;
    const delays = getOptions().retryDelaysMs;
    if ((error instanceof ApiError || error?.name === 'ApiError') && entry.failures <= delays.length) {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        run(spec, key, entry);
      }, delays[entry.failures - 1]);
      return;
    }
    const attempts = entry.failures;
    entry.failures = 0; // budget spent: this episode is over, a later trigger may start a new one
    report(spec, key, error, attempts);
  }

  async function run(spec, key, entry) {
    if (disposed) return;
    if (entry.retryTimer !== null) { clearTimeout(entry.retryTimer); entry.retryTimer = null; } // this request serves the pending retry
    entry.counter += 1;
    const ticket = entry.counter;
    if (entry.controller) entry.controller.abort(); // a newer request supersedes the one in flight
    const controller = new AbortController();
    entry.controller = controller;
    const current = () => !disposed && entry.counter === ticket && !controller.signal.aborted;
    try {
      const response = await requestFor(getOptions().apiClient, spec, controller.signal);
      if (!current()) return; // superseded or disposed: never overwrite newer data
      entry.controller = null;
      entry.failures = 0; // success ends the retry episode
      deliver(spec, response);
    } catch (error) {
      if (isAbort(error) || !current()) return; // aborted or superseded: not a failure, consumes no retry
      entry.controller = null;
      handleFailure(spec, key, entry, error);
    }
  }

  /**
   * Request one resource. Triggers inside the debounce window are coalesced into one request.
   * During a retry backoff a trigger is absorbed by the pending retry, which fetches fresh data anyway; the
   * retry budget is never reset by a trigger. immediate: skip the debounce (keeps the current budget).
   * force: ignore the cooldown.
   */
  function fire(spec, { immediate = false, force = false } = {}) {
    if (disposed) return;
    const key = keyOf(spec);
    const entry = entryFor(key);
    if (!force && Date.now() < entry.cooldownUntil) return;
    if (immediate) {
      clearTimers(entry);
      run(spec, key, entry);
      return;
    }
    if (entry.debounceTimer !== null) return; // already queued; that request will see this change too
    if (entry.retryTimer !== null) return; // in backoff: coalesce into the pending retry of this episode
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      run(spec, key, entry);
    }, getOptions().debounceMs);
  }

  /** Incident with Events but no API record. At most one lookup per cooldown window. */
  function fireUnknown(id) {
    const now = Date.now();
    const last = lastUnknownAt.get(id);
    if (last !== undefined && now - last < getOptions().cooldownMs) return;
    lastUnknownAt.set(id, now);
    fire(incidentSpec(id));
  }

  /** Terminal incident state: refresh now, then once more after settleMs. */
  function terminal(id) {
    const specs = id ? [HEALTH, incidentSpec(id)] : [HEALTH];
    for (const spec of specs) fire(spec, { immediate: true, force: true });
    const timer = setTimeout(() => {
      settleTimers.delete(timer);
      for (const spec of specs) fire(spec, { immediate: true, force: true });
    }, getOptions().settleMs);
    settleTimers.add(timer);
  }

  function handleEvent(event) {
    const id = isNonEmptyString(event.incidentId) ? event.incidentId : null; // detection has incidentId null: never invent one
    if (event.type === 'incident.state' && TERMINAL_STATES.includes(event.payload?.to)) {
      terminal(id);
      return;
    }
    if (HEALTH_TYPES.has(event.type)) fire(HEALTH);
    if (id && INCIDENT_TYPES.has(event.type)) fire(incidentSpec(id));
    if (event.type === 'verification' && id && !isFullVerificationPayload(event.payload)) fire(verificationSpec(id));
  }

  function start() { disposed = false; }

  function dispose() {
    disposed = true;
    for (const entry of entries.values()) {
      clearTimers(entry);
      if (entry.controller) entry.controller.abort();
      entry.controller = null;
    }
    entries.clear();
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers.clear();
    // The lookups scheduled before dispose were cancelled above, so their throttle must go too. Otherwise a
    // StrictMode remount (start after dispose) would skip the unknown-incident lookup for a whole cooldown.
    lastUnknownAt.clear();
  }

  return { start, dispose, handleEvent, fireUnknown };
}

export function useLiveRefresh({
  state,
  dispatch,
  client,
  baseUrl = API_BASE_URL,
  ready = true,
  onError,
  debounceMs = 300,
  settleMs = 2000,
  cooldownMs = 5000,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
} = {}) {
  const apiClient = useMemo(() => client ?? createApiClient({ baseUrl }), [client, baseUrl]);

  const optionsRef = useRef(null);
  optionsRef.current = { apiClient, dispatch, onError, debounceMs, settleMs, cooldownMs, retryDelaysMs };

  const engineRef = useRef(null);
  if (engineRef.current === null) engineRef.current = createRefreshEngine(() => optionsRef.current);

  const processedSeq = useRef(null); // highest seq already handled (or treated as history)

  // Lifecycle first, so effects below run against a started engine. Cleanup clears timers and aborts requests.
  useEffect(() => {
    const engine = engineRef.current;
    engine.start();
    return () => engine.dispose();
  }, []);

  const events = state?.events;
  const apiIncidents = state?.apiIncidents;

  useEffect(() => {
    if (!ready || !state) return;
    const engine = engineRef.current;
    const list = Array.isArray(events) ? events : [];
    const lastSeq = list.length > 0 ? list[list.length - 1].seq : 0;

    if (processedSeq.current === null) {
      processedSeq.current = lastSeq; // everything present now is history
    } else if (lastSeq > processedSeq.current) {
      const fresh = [];
      for (let i = list.length - 1; i >= 0 && list[i].seq > processedSeq.current; i -= 1) fresh.unshift(list[i]);
      processedSeq.current = lastSeq;
      for (const event of fresh) engine.handleEvent(event);
    }

    const known = isObject(apiIncidents) ? apiIncidents : {};
    for (const id of selectIncidentIds(state)) {
      if (!has(known, id)) engine.fireUnknown(id);
    }
    // `state` is intentionally represented by its two inputs: events and apiIncidents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, apiIncidents, ready]);
}

export default useLiveRefresh;
