/**
 * Phase 4B.3C.3: event history lifecycle of useEventStream (bounded snapshot retry + readiness gate).
 * Fake fetch and fake EventSource only; every Event is synthetic test input.
 */
import React, { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useEventStream, maxValidSeq, HISTORY_RETRY_DELAYS_MS, HISTORY_ATTEMPT_TIMEOUT_MS, HISTORY_MAX_ATTEMPTS,
} from './useEventStream.js';
import { createApiClient } from '../api/client.js';
import { reduce, initialState } from '../state/dashboardReducer.js';

class FakeES {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeES.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type, evt) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(evt); }
  message(type, data) { this.emit(type, { data: JSON.stringify(data) }); }
}
const openStreams = () => FakeES.instances.filter((es) => !es.closed);

const ev = (seq, type = 'detection', extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq, ts: '2024-01-01T00:00:00.000Z', type, component: 'monitor', incidentId: null, runId: null, payload: {}, ...extra,
});
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const FAIL = () => reply(500, { error: { code: 'internal_error', message: 'events boom' } });
const OK = (events) => () => reply(200, { events });
const NEVER = () => new Promise(() => {}); // ignores the abort signal on purpose

/** /events answers come from `script` in order (the last one repeats); other endpoints always succeed. */
function makeFetch(script) {
  const calls = { events: 0, eventTimes: [] };
  const fetchImpl = vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') return reply(202, { runId: 'r' });
    if (path.startsWith('/health')) return reply(200, { status: 'ok', testApp: { reachable: true } });
    if (path.startsWith('/scenarios')) return reply(200, { scenarios: [] });
    if (path.startsWith('/incidents')) return reply(200, { incidents: [] });
    if (path.startsWith('/events')) {
      const step = script[Math.min(calls.events, script.length - 1)];
      calls.events += 1;
      calls.eventTimes.push(Date.now());
      return step();
    }
    return reply(404, { error: { code: 'not_found', message: 'x' } });
  });
  return { fetchImpl, calls };
}

function setup(script, { delays = [5, 10, 20], timeoutMs = 50, wrapper, real = false } = {}) {
  const { fetchImpl, calls } = makeFetch(script);
  const client = createApiClient({ baseUrl: '/api/v1', fetchImpl });
  let state = initialState;
  const actions = [];
  const dispatch = (a) => { actions.push(a); state = reduce(state, a); };
  const opts = real ? {} : { historyRetryDelaysMs: delays, historyTimeoutMs: timeoutMs };
  const hook = renderHook(() => useEventStream({ dispatch, client, baseUrl: '/api/v1', EventSourceImpl: FakeES, ...opts }), { wrapper });
  return { ...hook, calls, actions, getState: () => state, fetchImpl };
}
const eventsDispatches = (actions) => actions.filter((a) => a.kind === 'api' && a.endpoint === 'events');

beforeEach(() => { FakeES.instances = []; });
afterEach(() => { vi.useRealTimers(); });

describe('maxValidSeq', () => {
  it('uses only reducer-valid Events and returns -1 for none', () => {
    expect(maxValidSeq([])).toBe(-1);
    expect(maxValidSeq([ev(1), ev(4), { seq: 99, type: 'bogus' }])).toBe(4);
    expect(maxValidSeq('nope')).toBe(-1);
  });
});

describe('useEventStream history lifecycle', () => {
  it('production defaults: attempts at 0, 1, 3 and 7 s, 10 s per attempt', () => {
    expect(HISTORY_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000]);
    expect(HISTORY_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(HISTORY_MAX_ATTEMPTS).toBe(4);
  });

  it('a successful empty snapshot is ready at once with boundary -1 and no retries', async () => {
    const { result, calls } = setup([OK([])]);
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    expect(result.current.history).toEqual({ status: 'ready', attempts: 1, error: null, ready: true, boundarySeq: -1 });
    expect(calls.events).toBe(1);
    expect(openStreams()).toHaveLength(1);
  });

  it('initial failure then success: one stream at afterSeq=0, ready with the boundary from the validated response', async () => {
    const history = [ev(1), ev(2), { seq: 9, type: 'not-an-event' }];
    const { result, calls, actions } = setup([FAIL, OK(history)], { delays: [300, 300, 300] });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    expect(FakeES.instances[0].url).toBe('/api/v1/events/stream?afterSeq=0'); // opened after attempt 1 settled
    await waitFor(() => expect(result.current.history).toMatchObject({ status: 'retrying', attempts: 1, ready: false }));
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    expect(result.current.history).toMatchObject({ status: 'ready', attempts: 2, boundarySeq: 2 }); // invalid seq 9 ignored
    expect(calls.events).toBe(2);
    expect(eventsDispatches(actions)).toHaveLength(1); // the failed attempt dispatched nothing
    expect(result.current.error).toContain('events: events boom'); // existing connection error behaviour kept
    expect(openStreams()).toHaveLength(1);
  });

  it('never treats a failure as an empty history: four failures leave it unavailable', async () => {
    const { result, calls, actions } = setup([FAIL]);
    await waitFor(() => expect(result.current.history.status).toBe('unavailable'));
    expect(result.current.history).toMatchObject({ attempts: 4, ready: false, boundarySeq: null, error: 'events boom (internal_error)' });
    expect(eventsDispatches(actions)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.events).toBe(4); // bounded: no fifth attempt, no polling
  });

  it('makes exactly four attempts at 0, 1, 3 and 7 s with the production schedule', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const start = Date.now();
    const { result, calls } = setup([FAIL], { real: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.events).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(calls.eventTimes.map((t) => t - start)).toEqual([0, 1000, 3000, 7000]);
    expect(result.current.history.status).toBe('unavailable');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls.events).toBe(4);
  });

  it('a timeout is a failed attempt, the stream still opens, and the late response is ignored', async () => {
    const { result, calls, actions } = setup([NEVER, OK([ev(1)])], { timeoutMs: 30 });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    expect(FakeES.instances[0].url).toBe('/api/v1/events/stream?afterSeq=0');
    expect(result.current.error).toContain('timed out');
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    expect(result.current.history.boundarySeq).toBe(1);
    expect(calls.events).toBe(2);
    expect(eventsDispatches(actions)).toHaveLength(1);
  });

  it('a timed-out retry counts as a failure and reports the timeout', async () => {
    const { result } = setup([FAIL, NEVER], { timeoutMs: 20 });
    await waitFor(() => expect(result.current.history.status).toBe('unavailable'), { timeout: 2000 });
    expect(result.current.history.error).toContain('timed out');
  });

  it('a malformed response is a failed attempt, not an empty history', async () => {
    const malformed = () => reply(200, { events: 'nope' });
    const { result, actions } = setup([malformed, malformed, malformed, malformed]);
    await waitFor(() => expect(result.current.history.status).toBe('unavailable'));
    expect(result.current.history.error).toContain('invalid_response');
    expect(eventsDispatches(actions)).toHaveLength(0);
  });

  it('classifies an Event that arrives during the retries as history (conservative boundary)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { result } = setup([FAIL, async () => { await gate; return reply(200, { events: [ev(1), ev(2), ev(3)] }); }]);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    act(() => FakeES.instances[0].emit('open', {}));
    act(() => FakeES.instances[0].message('detection', ev(5))); // arrives before history is ready
    await waitFor(() => expect(result.current.history.status).toBe('retrying'));
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    expect(result.current.history.boundarySeq).toBe(5); // max(snapshot 3, stream 5)
  });

  it('keeps the boundary fixed after readiness, through later Events and a reconnect', async () => {
    const { result, calls } = setup([OK([ev(1), ev(2)])]);
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    const es = FakeES.instances[0];
    act(() => es.emit('open', {}));
    act(() => es.message('repair', ev(3, 'repair')));
    act(() => { es.readyState = 0; es.emit('error', {}); }); // native reconnect (Last-Event-ID path)
    act(() => es.emit('open', {}));
    act(() => es.message('repair', ev(4, 'repair')));
    expect(result.current.history).toMatchObject({ ready: true, boundarySeq: 2 });
    expect(calls.events).toBe(1); // no history retry once ready
    expect(FakeES.instances).toHaveLength(1);
  });

  it('allows one bounded cycle per reconnection while unavailable, then becomes ready', async () => {
    let healthy = false;
    const { result, calls, actions } = setup([() => (healthy ? reply(200, { events: [ev(1), ev(2)] }) : FAIL())]);
    await waitFor(() => expect(result.current.history.status).toBe('unavailable'));
    const es = FakeES.instances[0];
    act(() => es.emit('open', {}));
    // First 'connected' after the budget: one cycle of four attempts, all failing.
    await waitFor(() => expect(calls.events).toBe(8));
    await waitFor(() => expect(result.current.history.status).toBe('unavailable'));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.events).toBe(8); // nothing while idle
    healthy = true;
    act(() => { es.readyState = 0; es.emit('error', {}); });
    act(() => es.emit('open', {}));
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    expect(calls.events).toBe(9);
    expect(result.current.history).toMatchObject({ attempts: 1, boundarySeq: 2 });
    expect(eventsDispatches(actions)).toHaveLength(1);
    expect(FakeES.instances).toHaveLength(1); // the same EventSource throughout
  });

  it('unmount during a retry wait clears every timer and never dispatches or connects again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result, unmount, calls, actions } = setup([FAIL, OK([ev(1)])], { real: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.history.status).toBe('retrying');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls.events).toBe(1);
    expect(eventsDispatches(actions)).toHaveLength(0);
    expect(openStreams()).toHaveLength(0);
  });

  it('unmount during an in-flight attempt aborts it; its late response cannot dispatch', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { unmount, calls, actions } = setup([FAIL, async () => { await gate; return reply(200, { events: [ev(1)] }); }], { timeoutMs: 5000 });
    await waitFor(() => expect(calls.events).toBe(2)); // retry in flight
    unmount();
    await act(async () => { release(); await gate; await new Promise((r) => setTimeout(r, 20)); });
    expect(eventsDispatches(actions)).toHaveLength(0);
    expect(openStreams()).toHaveLength(0);
  });

  it('StrictMode: exactly one open EventSource and one events dispatch from the live mount', async () => {
    const { result, actions } = setup([FAIL, OK([ev(1)])], { wrapper: StrictMode });
    await waitFor(() => expect(result.current.history.ready).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(openStreams()).toHaveLength(1);
    expect(eventsDispatches(actions)).toHaveLength(1);
  });

  it('keeps afterSeq resume behaviour: a closed stream reopens once with afterSeq=<last seq>', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result } = setup([OK([ev(1), ev(2)])], { real: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(FakeES.instances[0].url).toBe('/api/v1/events/stream?afterSeq=2');
    const es = FakeES.instances[0];
    act(() => es.emit('open', {}));
    act(() => es.message('repair', ev(3, 'repair')));
    act(() => { es.readyState = 2; es.emit('error', {}); }); // CLOSED: controller reopens after backoff
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[1].url).toBe('/api/v1/events/stream?afterSeq=3');
    expect(openStreams()).toHaveLength(1);
    expect(result.current.history).toMatchObject({ ready: true, boundarySeq: 2 });
  });
});
