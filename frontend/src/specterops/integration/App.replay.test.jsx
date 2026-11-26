/**
 * Phase 4B.3C.3: history replay through the real App (reducer, useEventStream, useLiveRefresh, shell).
 * Fake fetch and fake EventSource; every Event is synthetic test input, not a real recovery.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import App from '../../App.jsx';
import { ev, stateEv } from '../../components/testHelpers.js';

class FakeES {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeES.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  close() { this.readyState = 2; }
  emit(type, evt) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(evt); }
}
const openStreams = () => FakeES.instances.filter((es) => es.readyState !== 2);
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

const HEALTH = {
  status: 'ok',
  testApp: { reachable: true, httpStatus: 200, components: { button: { status: 'ok' }, card: { status: 'ok' }, dataPanel: { status: 'ok' }, layout: { status: 'ok' } } },
  storage: { ok: true },
};
const INCIDENT = {
  incidentId: 'inc-1', state: 'recovered', component: 'button', detectedAt: '2024-01-01T00:00:00.000Z',
  attemptCount: 1, evidenceRefs: [], terminalReason: null,
};
const inject = (seq, target) => ev(seq, 'chaos.injection', { scenarioId: 's', targetComponent: target }, { incidentId: null, component: 'scenario-engine' });
/** History: an injection and a fully verified recovery (passing verification + recovered state). */
const HISTORY = [
  inject(1, 'button'),
  ev(2, 'detection', { failingComponent: 'button' }, { incidentId: null, component: 'button' }),
  ev(3, 'verification', { incidentId: 'inc-1', verificationId: 'v-1', overall: 'pass', checks: [{ outcome: 'pass' }] }),
  stateEv(4, 'recovered'),
];

function installFetch({ eventsReply }) {
  const fetchMock = vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') return reply(202, { runId: 'run-1' });
    if (path.startsWith('/health')) return reply(200, HEALTH);
    if (path.startsWith('/scenarios')) return reply(200, { scenarios: [] });
    if (path.startsWith('/incidents/')) return reply(200, INCIDENT);
    if (path.startsWith('/incidents')) return reply(200, { incidents: [INCIDENT] });
    if (path.startsWith('/events')) return eventsReply();
    return reply(404, { error: { code: 'not_found', message: 'nope' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const count = (fetchMock, pattern) => fetchMock.mock.calls.filter(([u, i]) => i.method === 'GET' && pattern.test(u.replace('/api/v1', ''))).length;
const send = (es, event) => act(() => es.emit(event.type, { data: JSON.stringify(event) }));
const badge = (key) => within(screen.getAllByTestId('so-card').find((el) => el.getAttribute('data-key') === key)).getByTestId('so-card-badge').textContent;
const liveLines = () => document.querySelectorAll('.so-log__line--live').length;
const logText = () => screen.getByRole('log', { name: 'Agent activity' }).textContent;
const FAIL = () => reply(500, { error: { code: 'internal_error', message: 'events boom' } });

beforeEach(() => {
  FakeES.instances = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App: history replay after a failed snapshot', () => {
  it('replayed history triggers no live effects or refreshes; Events after the boundary do', async () => {
    let n = 0;
    const fetchMock = installFetch({ eventsReply: () => (n++ === 0 ? FAIL() : reply(200, { events: HISTORY })) });
    render(<App />);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    const es = FakeES.instances[0];
    expect(es.url).toContain('afterSeq=0');
    act(() => es.emit('open', {}));
    for (const e of HISTORY) send(es, e); // the backend replays history right after `open`

    // Before readiness: no animation, no live log line, no refresh request.
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    expect(screen.queryByTestId('so-heal')).toBeNull();
    expect(liveLines()).toBe(0);

    await waitFor(() => expect(count(fetchMock, /^\/events/)).toBe(2), { timeout: 3000 }); // retry at about 1 s
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); }); // longer than the refresh debounce
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    expect(screen.queryByTestId('so-heal')).toBeNull();
    expect(liveLines()).toBe(0);
    expect(count(fetchMock, /^\/health/)).toBe(1); // snapshot only
    expect(count(fetchMock, /^\/incidents\//)).toBe(0); // no per-incident refresh for history
    // The historical recovery is shown as state (verified evidence exists), but without a live pulse.
    expect(badge('button')).toBe('PATCHED // VERIFIED');

    // A genuine Event after the boundary (seq 5 > 4) is live.
    send(es, inject(5, 'layout'));
    expect(screen.getByTestId('so-reaper')).toBeTruthy();
    expect(liveLines()).toBe(1);
    await waitFor(() => expect(count(fetchMock, /^\/health/)).toBe(2)); // live refresh runs again
    expect(openStreams()).toHaveLength(1);
  });

  it('permanent failure pauses live effects with one note; a reconnect cycle loads history and resumes them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let healthy = false;
    const fetchMock = installFetch({ eventsReply: () => (healthy ? reply(200, { events: [inject(1, 'button')] }) : FAIL()) });
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(FakeES.instances).toHaveLength(1);
    const es = FakeES.instances[0];
    act(() => es.emit('open', {})); // connected during the first cycle: no extra cycle
    send(es, inject(1, 'button'));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(count(fetchMock, /^\/events/)).toBe(4);
    expect(logText()).toContain('Client-side: Event history could not be loaded after 4 attempts (events boom (internal_error)). Live effects are paused until it loads.');

    send(es, inject(2, 'card')); // genuine but the boundary is unknown: paused, not animated
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(count(fetchMock, /^\/health/)).toBe(1);

    healthy = true;
    act(() => { es.readyState = 0; es.emit('error', {}); });
    act(() => es.emit('open', {})); // reconnection: one bounded cycle
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(count(fetchMock, /^\/events/)).toBe(5);
    expect(logText()).toContain('Client-side: Event history loaded. Live effects resumed.');
    expect(screen.queryByTestId('so-reaper')).toBeNull(); // seq 1 and 2 are history (boundary 2)

    send(es, inject(3, 'layout'));
    expect(screen.getByTestId('so-reaper')).toBeTruthy();

    // Another reconnect once ready: no history retry, no new note.
    act(() => { es.readyState = 0; es.emit('error', {}); });
    act(() => es.emit('open', {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(count(fetchMock, /^\/events/)).toBe(5);
    const notes = screen.getAllByTestId('so-log-line').map((l) => l.textContent).filter((t) => t.includes('Event history'));
    expect(notes.length).toBeLessThanOrEqual(1); // collapsed view shows the newest line only
    act(() => screen.getByRole('button', { name: 'Show agent activity history' }).click());
    const all = screen.getAllByTestId('so-log-line').map((l) => l.textContent);
    expect(all.filter((t) => t.includes('could not be loaded'))).toHaveLength(1);
    expect(all.filter((t) => t.includes('Live effects resumed'))).toHaveLength(1);
    expect(openStreams()).toHaveLength(1);
  });

  it('StrictMode: one open EventSource and readiness from the live mount only', async () => {
    let n = 0;
    installFetch({ eventsReply: () => (n++ === 0 ? FAIL() : reply(200, { events: HISTORY })) });
    render(<React.StrictMode><App /></React.StrictMode>);
    await waitFor(() => expect(openStreams()).toHaveLength(1));
    const es = openStreams()[0];
    act(() => es.emit('open', {}));
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    expect(openStreams()).toHaveLength(1);
    send(es, inject(5, 'card'));
    expect(screen.getByTestId('so-reaper')).toBeTruthy(); // ready, boundary 4
    expect(logText()).not.toContain('could not be loaded');
  });

  it('a live recovered state still needs a passing verification after a late history load', async () => {
    let n = 0;
    installFetch({ eventsReply: () => (n++ === 0 ? FAIL() : reply(200, { events: [inject(1, 'button')] })) });
    render(<App />);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    const es = FakeES.instances[0];
    act(() => es.emit('open', {}));
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); }); // retry succeeds, boundary 1
    send(es, stateEv(10, 'recovered'));
    expect(badge('button')).not.toBe('PATCHED // VERIFIED');
    expect(screen.queryByTestId('so-heal')).toBeNull();
    send(es, ev(11, 'verification', { incidentId: 'inc-1', verificationId: 'v-2', overall: 'pass', checks: [{ outcome: 'pass' }] }));
    send(es, stateEv(12, 'recovered'));
    expect(badge('button')).toBe('PATCHED // VERIFIED');
    expect(screen.getByTestId('so-heal')).toBeTruthy();
  });
});
