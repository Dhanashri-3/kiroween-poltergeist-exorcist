/**
 * SSE controller (task 14.5; Requirements 15.4, 15.7, 15.9). Framework-free. Contract: docs/api.md.
 *
 * Events are named (`event: <type>`), so one listener is registered per type in EVENT_TYPES.
 * Native EventSource reconnects by itself (with Last-Event-ID) while readyState is CONNECTING.
 * When readyState is CLOSED it never retries, so this controller opens a new EventSource after a
 * backoff delay with afterSeq=<last seen seq>.
 */
import { API_BASE_URL } from '../config.js';
import { EVENT_TYPES } from '../state/dashboardReducer.js';

const CLOSED_STATE = 2;

export function createEventStream({
  baseUrl = API_BASE_URL,
  EventSourceImpl,
  onEvent,
  onStatus,
  onError,
  initialAfterSeq = 0,
  retryBaseMs = 2000,
  retryMaxMs = 30000,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const setTimer = setTimeoutImpl ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = clearTimeoutImpl ?? ((id) => globalThis.clearTimeout(id));

  let lastSeq = Number.isInteger(initialAfterSeq) && initialAfterSeq >= 0 ? initialAfterSeq : 0;
  let source = null;
  let removeListeners = () => {};
  let timer = null;
  let attempt = 0;
  let started = false;
  let closed = false;
  let status = null;

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    safe(() => onStatus?.(next));
  };
  const report = (message, extra) => safe(() => onError?.({ message, ...extra }));
  function safe(fn) {
    try { fn(); } catch { /* a callback must never break the stream */ }
  }

  function detach() {
    removeListeners();
    removeListeners = () => {};
    if (source) {
      const s = source;
      source = null;
      safe(() => s.close());
    }
  }

  function handleMessage(type, message) {
    if (closed) return;
    let parsed;
    try {
      parsed = JSON.parse(message?.data);
    } catch {
      report(`Ignored an unparseable "${type}" event.`, { type });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Number.isInteger(parsed.seq) || parsed.seq < 0 || parsed.type !== type) {
      report(`Ignored a malformed "${type}" event.`, { type });
      return;
    }
    if (parsed.seq > lastSeq) lastSeq = parsed.seq;
    try {
      onEvent?.(parsed);
    } catch (error) {
      report(`Event handler failed for "${type}": ${error?.message ?? error}`, { type });
    }
  }

  function open() {
    if (closed) return;
    const Impl = EventSourceImpl ?? globalThis.EventSource;
    if (typeof Impl !== 'function') {
      setStatus('disconnected');
      report('EventSource is not available in this environment.');
      return;
    }
    setStatus('connecting');
    let es;
    try {
      es = new Impl(`${base}/events/stream?afterSeq=${lastSeq}`);
    } catch (error) {
      report(`Could not open the event stream: ${error?.message ?? error}`);
      setStatus('disconnected');
      scheduleReopen();
      return;
    }
    source = es;

    // `error` is both an Event type and EventSource's native connection-error event. A server-sent
    // `event: error` is a MessageEvent with string data; a connection error has no data.
    const listeners = EVENT_TYPES.filter((type) => type !== 'error').map((type) => {
      const fn = (message) => { if (source === es) handleMessage(type, message); };
      es.addEventListener(type, fn);
      return [type, fn];
    });
    const onOpen = () => {
      if (closed || source !== es) return;
      attempt = 0;
      setStatus('connected');
    };
    const onErr = (message) => {
      if (closed || source !== es) return;
      if (typeof message?.data === 'string') {
        handleMessage('error', message);
        return;
      }
      setStatus('disconnected');
      if (es.readyState === CLOSED_STATE) {
        report('The event stream closed; reconnecting.');
        detach();
        scheduleReopen();
      } else {
        report('The event stream was interrupted; the browser is reconnecting.');
      }
    };
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onErr);
    removeListeners = () => {
      for (const [type, fn] of listeners) safe(() => es.removeEventListener(type, fn));
      safe(() => es.removeEventListener('open', onOpen));
      safe(() => es.removeEventListener('error', onErr));
    };
  }

  function scheduleReopen() {
    if (closed || timer !== null) return;
    const delay = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs);
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      open();
    }, delay);
  }

  return {
    start() {
      if (started || closed) return;
      started = true;
      open();
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      detach();
      setStatus('closed');
    },
    getLastSeq: () => lastSeq,
  };
}
