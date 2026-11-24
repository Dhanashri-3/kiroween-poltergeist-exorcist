import React, { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEventStream } from './useEventStream.js';
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
  count() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
  emit(type, evt) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(evt); }
  message(type, data) { this.emit(type, { data: JSON.stringify(data) }); }
}

const makeEvent = (seq, type = 'detection', extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq,
  ts: '2024-01-01T00:00:00.000Z',
  type,
  component: 'monitor',
  incidentId: null,
  runId: null,
  payload: {},
  ...extra,
});

const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

function makeFetch({ events = [makeEvent(1), makeEvent(2)], failScenarios = false } = {}) {
  return vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') return reply(202, { runId: 'run-1', scenarioId: 's' });
    if (path.startsWith('/health')) return reply(200, { status: 'ok', testApp: { up: true } });
    if (path.startsWith('/scenarios')) {
      return failScenarios ? reply(500, { error: { code: 'internal_error', message: 'scenario boom' } })
        : reply(200, { scenarios: [{ id: 's', label: 'S', severity: 'low' }] });
    }
    if (path.startsWith('/incidents')) return reply(200, { incidents: [] });
    if (path.startsWith('/events')) return reply(200, { events });
    return reply(404, { error: { code: 'not_found', message: 'x' } });
  });
}

beforeEach(() => { FakeES.instances = []; });

const render = (fetchImpl, dispatch, opts = {}) => {
  const client = createApiClient({ baseUrl: '/api/v1', fetchImpl }); // stable across renders
  return renderHook(
    () => useEventStream({ dispatch, client, baseUrl: '/api/v1', EventSourceImpl: FakeES }),
    opts,
  );
};

describe('useEventStream', () => {
  it('loads the snapshot, seeds lastSeq, connects and dispatches events', async () => {
    const dispatch = vi.fn();
    const { result } = render(makeFetch(), dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    expect(FakeES.instances[0].url).toBe('/api/v1/events/stream?afterSeq=2');
    expect(result.current.lastSeq).toBe(2);
    expect(result.current.connected).toBe(false);

    act(() => FakeES.instances[0].emit('open', {}));
    expect(result.current.connected).toBe(true);
    expect(result.current.status).toBe('connected');

    act(() => FakeES.instances[0].message('repair', makeEvent(3, 'repair')));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'event', event: makeEvent(3, 'repair') });
    expect(result.current.lastSeq).toBe(3);

    act(() => { FakeES.instances[0].readyState = 0; FakeES.instances[0].emit('error', {}); });
    expect(result.current.connected).toBe(false);
    expect(result.current.status).toBe('disconnected');
    expect(result.current.error).toBeTruthy();
  });

  it('surfaces snapshot failures but still connects', async () => {
    const dispatch = vi.fn();
    const { result } = render(makeFetch({ failScenarios: true }), dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    expect(result.current.error).toContain('scenario boom');
    expect(dispatch.mock.calls.some((c) => c[0].endpoint === 'health')).toBe(true);
  });

  it('startChaos and reset dispatch only local actions and return the API result', async () => {
    const dispatch = vi.fn();
    const fetchImpl = makeFetch();
    const { result } = render(fetchImpl, dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    dispatch.mockClear();

    let started;
    await act(async () => { started = await result.current.startChaos('s'); });
    expect(started).toEqual({ runId: 'run-1', scenarioId: 's' });
    await act(async () => { await result.current.reset(); });
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'chaos-start-requested' },
      { kind: 'reset-requested' },
    ]);
    const posts = fetchImpl.mock.calls.filter((c) => c[1].method === 'POST');
    expect(posts.map((c) => c[0])).toEqual(['/api/v1/chaos-runs', '/api/v1/reset']);
  });

  it('startChaos rejects with the ApiError and dispatches no outcome', async () => {
    const dispatch = vi.fn();
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === 'POST') return reply(409, { error: { code: 'incident_active', message: 'busy' } });
      return reply(200, { events: [], scenarios: [], incidents: [], status: 'ok', testApp: {} });
    });
    const { result } = render(fetchImpl, dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    dispatch.mockClear();
    await act(async () => {
      await expect(result.current.startChaos()).rejects.toMatchObject({ code: 'incident_active', status: 409 });
    });
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([{ kind: 'chaos-start-requested' }]);
  });

  it('cleans up on unmount: closes the stream, removes listeners, ignores late events', async () => {
    const dispatch = vi.fn();
    const { unmount } = render(makeFetch(), dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    const es = FakeES.instances[0];
    dispatch.mockClear();
    unmount();
    expect(es.closed).toBe(true);
    expect(es.count()).toBe(0);
    es.message('detection', makeEvent(10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not connect or dispatch when unmounted during the snapshot', async () => {
    const dispatch = vi.fn();
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = makeFetch();
    const fetchImpl = vi.fn(async (...args) => { await gate; return inner(...args); });
    const { unmount } = render(fetchImpl, dispatch);
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.instances).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tolerates StrictMode double mount without leaking a stream', async () => {
    const dispatch = vi.fn();
    render(makeFetch(), dispatch, { wrapper: StrictMode });
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    const open = FakeES.instances.filter((es) => !es.closed);
    expect(open).toHaveLength(1);
  });

  it('integration: snapshot plus replayed stream events produce a deduplicated timeline in the real reducer', async () => {
    let state = initialState;
    const dispatch = (a) => { state = reduce(state, a); };
    render(makeFetch(), dispatch);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    expect(state.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(state.health.status).toBe('ok');
    act(() => {
      FakeES.instances[0].message('detection', makeEvent(2)); // replay
      FakeES.instances[0].message('repair', makeEvent(3, 'repair'));
    });
    expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
