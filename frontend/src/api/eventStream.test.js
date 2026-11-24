import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEventStream } from './eventStream.js';
import { EVENT_TYPES, reduce, initialState } from '../state/dashboardReducer.js';

export class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  close() { this.closed = true; this.readyState = 2; }
  count() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
  emit(type, evt) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(evt); }
  open() { this.readyState = 1; this.emit('open', {}); }
  message(type, data) { this.emit(type, { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  dropToConnecting() { this.readyState = 0; this.emit('error', {}); }
  failClosed() { this.readyState = 2; this.emit('error', {}); }
}

const makeEvent = (seq, type = 'detection') => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq,
  ts: '2024-01-01T00:00:00.000Z',
  type,
  component: 'monitor',
  incidentId: null,
  runId: null,
  payload: {},
});

function make(opts = {}) {
  const calls = { events: [], statuses: [], errors: [] };
  const stream = createEventStream({
    baseUrl: 'http://test/api/v1',
    EventSourceImpl: FakeEventSource,
    onEvent: (e) => calls.events.push(e),
    onStatus: (s) => calls.statuses.push(s),
    onError: (e) => calls.errors.push(e),
    ...opts,
  });
  return { stream, calls };
}
const latest = () => FakeEventSource.instances.at(-1);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('createEventStream', () => {
  it('opens with afterSeq and registers a listener for every event type', () => {
    const { stream, calls } = make({ initialAfterSeq: 7 });
    stream.start();
    const es = latest();
    expect(es.url).toBe('http://test/api/v1/events/stream?afterSeq=7');
    for (const type of EVENT_TYPES) expect(es.listeners.get(type)?.size).toBe(1);
    expect(es.listeners.has('message')).toBe(false);
    expect(calls.statuses).toEqual(['connecting']);
    es.open();
    expect(calls.statuses).toEqual(['connecting', 'connected']);
  });

  it('delivers valid events and tracks the last seq', () => {
    const { stream, calls } = make();
    stream.start();
    latest().message('detection', makeEvent(3));
    latest().message('repair', makeEvent(5, 'repair'));
    expect(calls.events.map((e) => e.seq)).toEqual([3, 5]);
    expect(stream.getLastSeq()).toBe(5);
  });

  it('skips malformed JSON, name mismatches and unknown shapes without throwing', () => {
    const { stream, calls } = make();
    stream.start();
    const es = latest();
    expect(() => {
      es.message('detection', '{not json');
      es.message('detection', makeEvent(2, 'repair')); // type != event name
      es.message('detection', { type: 'detection' }); // no seq
      es.message('detection', { ...makeEvent(1), seq: -1 });
      es.message('detection', { ...makeEvent(1), seq: 1.5 });
      es.message('detection', '[1]');
      es.message('detection', 'null');
      es.emit('detection', {}); // no data
    }).not.toThrow();
    expect(calls.events).toEqual([]);
    expect(calls.errors).toHaveLength(8);
    expect(stream.getLastSeq()).toBe(0);
  });

  it('tells a server-sent "error" Event from a native connection error', () => {
    const { stream, calls } = make();
    stream.start();
    latest().open();
    latest().message('error', makeEvent(4, 'error'));
    expect(calls.events.map((e) => e.seq)).toEqual([4]);
    expect(calls.statuses.at(-1)).toBe('connected');
    latest().dropToConnecting();
    expect(calls.statuses.at(-1)).toBe('disconnected');
    expect(calls.events).toHaveLength(1);
  });

  it('does not alter events it delivers', () => {
    const { stream, calls } = make();
    stream.start();
    const e = makeEvent(1);
    latest().message('detection', e);
    expect(calls.events[0]).toEqual(e);
  });

  it('reports a throwing onEvent through onError and keeps going', () => {
    const errors = [];
    const stream = createEventStream({
      baseUrl: '/a', EventSourceImpl: FakeEventSource,
      onEvent: () => { throw new Error('boom'); }, onError: (e) => errors.push(e),
    });
    stream.start();
    expect(() => latest().message('detection', makeEvent(1))).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('lets the browser reconnect on CONNECTING without opening a second stream', () => {
    const { stream, calls } = make();
    stream.start();
    latest().open();
    latest().dropToConnecting();
    vi.advanceTimersByTime(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().closed).toBe(false);
    expect(calls.statuses.at(-1)).toBe('disconnected');
    latest().open();
    expect(calls.statuses.at(-1)).toBe('connected');
  });

  it('opens a new EventSource with the last seq after CLOSED, with doubling backoff capped and reset on open', () => {
    const { stream } = make({ retryBaseMs: 2000, retryMaxMs: 10000 });
    stream.start();
    latest().message('detection', makeEvent(9));
    const first = latest();
    first.failClosed();
    expect(first.closed).toBe(true);
    expect(first.count()).toBe(0);
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toMatch(/afterSeq=9$/);

    latest().failClosed(); // attempt 2: 4000
    vi.advanceTimersByTime(3999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().failClosed(); // 8000
    vi.advanceTimersByTime(8000);
    expect(FakeEventSource.instances).toHaveLength(4);
    latest().failClosed(); // capped at 10000
    vi.advanceTimersByTime(9999);
    expect(FakeEventSource.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(5);

    latest().open(); // resets backoff
    latest().failClosed();
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(6);
  });

  it('close() stops everything and ignores late callbacks', () => {
    const { stream, calls } = make();
    stream.start();
    const es = latest();
    es.failClosed();
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(calls.statuses.at(-1)).toBe('closed');

    const live = make();
    live.stream.start();
    const es2 = latest();
    live.stream.close();
    expect(es2.closed).toBe(true);
    expect(es2.count()).toBe(0);
    es2.message('detection', makeEvent(1)); // late callback
    expect(live.calls.events).toEqual([]);
    live.stream.start(); // cannot restart
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('start() is idempotent', () => {
    const { stream } = make();
    stream.start();
    stream.start();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('reports a missing EventSource instead of throwing', () => {
    const errors = [];
    const stream = createEventStream({ baseUrl: '/a', EventSourceImpl: undefined, onError: (e) => errors.push(e) });
    const original = globalThis.EventSource;
    delete globalThis.EventSource;
    expect(() => stream.start()).not.toThrow();
    if (original) globalThis.EventSource = original;
    expect(errors).toHaveLength(1);
  });

  it('replay after reconnect is deduplicated by the real reducer', () => {
    let state = initialState;
    const stream = createEventStream({
      baseUrl: '/a', EventSourceImpl: FakeEventSource,
      onEvent: (event) => { state = reduce(state, { kind: 'event', event }); },
    });
    stream.start();
    latest().message('detection', makeEvent(1));
    latest().message('repair', makeEvent(2, 'repair'));
    latest().failClosed();
    vi.advanceTimersByTime(2000);
    latest().message('repair', makeEvent(2, 'repair')); // replayed
    latest().message('verification', makeEvent(3, 'verification'));
    latest().message('detection', '{bad');
    expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
