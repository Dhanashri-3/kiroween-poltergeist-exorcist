/**
 * Phase 4B.3C integration tests: the real App (reducer, useEventStream, useLiveRefresh, shared guard and the
 * SPECTEROPS shell) with a fake fetch and a fake EventSource. All Events here are synthetic test input; they
 * show how the UI reacts to the documented contract, not that any real recovery happened.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, act, fireEvent, within } from '@testing-library/react';
import App, { SUMMON_IDLE_NOTICE } from '../../App.jsx';
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
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const HEALTH_OK = {
  status: 'ok',
  testApp: { reachable: true, httpStatus: 200, components: { button: { status: 'ok' }, card: { status: 'ok' }, dataPanel: { status: 'ok' }, layout: { status: 'ok' } } },
  storage: { ok: true },
};
const INCIDENT = {
  incidentId: 'inc-1', state: 'detected', component: 'button', detectedAt: '2024-01-01T00:00:00.000Z',
  attemptCount: 0, evidenceRefs: [], terminalReason: null,
};

/**
 * Fake API. `health` may be a function (call number -> reply) so a later refresh can fail.
 * POST handlers may return a promise so tests can hold a request in flight.
 */
function installFetch({ events = [], incidents = [], health = () => reply(200, HEALTH_OK), chaos, resetReply } = {}) {
  let healthCalls = 0;
  const fetchMock = vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') {
      if (path.startsWith('/chaos-runs')) return chaos ? chaos(init) : reply(202, { runId: 'run-1' });
      return resetReply ? resetReply(init) : reply(200, { reset: true });
    }
    if (path.startsWith('/health')) { healthCalls += 1; return health(healthCalls); }
    if (path.startsWith('/scenarios')) return reply(200, { scenarios: [{ id: 's1', label: 'Break button', severity: 'low' }] });
    if (path.startsWith('/incidents/')) {
      const id = decodeURIComponent(path.slice('/incidents/'.length).split('/')[0]);
      const found = incidents.find((i) => i.incidentId === id);
      return found ? reply(200, found) : reply(404, { error: { code: 'incident_not_found', message: 'no such incident' } });
    }
    if (path.startsWith('/incidents')) return reply(200, { incidents });
    if (path.startsWith('/events')) return reply(200, { events });
    return reply(404, { error: { code: 'not_found', message: 'nope' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock, suffix) => fetchMock.mock.calls.filter(([u, i]) => u.endsWith(suffix) && i.method === 'POST');
const cardFor = (key) => screen.getAllByTestId('so-card').find((el) => el.getAttribute('data-key') === key);
const badge = (key) => within(cardFor(key)).getByTestId('so-card-badge').textContent;
const send = (es, event) => act(() => es.emit(event.type, { data: JSON.stringify(event) }));

/** Renders App, waits for the snapshot and the single stream, and opens it (history is then fixed). */
async function renderConnected(options) {
  const fetchMock = installFetch(options);
  render(<App />);
  await waitFor(() => expect(FakeES.instances).toHaveLength(1));
  const es = FakeES.instances[0];
  act(() => es.emit('open', {}));
  expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('connected');
  return { fetchMock, es };
}

beforeEach(() => {
  FakeES.instances = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App with the SPECTEROPS shell: structure and compatibility', () => {
  it('opens exactly one EventSource, also under StrictMode', async () => {
    installFetch();
    render(<React.StrictMode><App /></React.StrictMode>);
    await waitFor(() => expect(openStreams()).toHaveLength(1));
    expect(openStreams()[0].url).toContain('/events/stream?afterSeq=0');
  });

  it('keeps exactly one main and one h1, owned by the Dashboard inside #so-dashboard', async () => {
    installFetch();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId('scenario-item')).toHaveLength(1));
    expect(document.querySelectorAll('main')).toHaveLength(1);
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('Poltergeist vs. Exorcist');
    expect(document.getElementById('so-dashboard').contains(document.querySelector('main'))).toBe(true);
    expect(screen.getByRole('link', { name: 'Skip to dashboard' }).getAttribute('href')).toBe('#so-dashboard');
  });

  it('keeps one Start chaos and one Reset control and the Dashboard test ids', async () => {
    installFetch();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId('scenario-item')).toHaveLength(1));
    // Substring and case-insensitive, like Playwright's default name matching.
    expect(screen.getAllByRole('button', { name: /start chaos/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /reset/i })).toHaveLength(1);
    for (const id of ['connection-status', 'scenario-controls', 'health-panel', 'timeline-panel', 'incident-list-panel', 'idle']) {
      expect(screen.getAllByTestId(id), id).toHaveLength(1);
    }
    expect(screen.getAllByTestId('health-component')).toHaveLength(4);
    expect(document.querySelectorAll('[data-testid="event-row"]')).toHaveLength(0);
  });
});

describe('guarded controls', () => {
  it('Summon requests a random scenario through the shared guard and claims only acceptance', async () => {
    const hold = deferred();
    const { fetchMock } = await renderConnected({ chaos: () => hold.promise });
    expect(screen.getByText(SUMMON_IDLE_NOTICE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Summon Poltergeist' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Summoning…' }).disabled).toBe(true));
    expect(JSON.parse(posts(fetchMock, '/chaos-runs')[0][1].body)).toEqual({}); // no scenarioId: backend picks one

    // The Dashboard's Start chaos is rejected by the shared guard while Summon is in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Start chaos' }));
    expect((await screen.findByTestId('control-error')).textContent).toContain('request_in_progress');
    expect(posts(fetchMock, '/chaos-runs')).toHaveLength(1);

    await act(async () => { hold.resolve(reply(202, { runId: 'run-9' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Summon Poltergeist' }).disabled).toBe(false));
    expect(screen.getByText('Chaos run request accepted (runId run-9). Random scenario; waiting for backend Events.')).toBeTruthy();
    // Acceptance changes nothing that only Events may change.
    expect(screen.getByTestId('idle')).toBeTruthy();
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    expect(document.body.textContent).not.toContain('PATCHED // VERIFIED');
  });

  it('a Dashboard Reset in flight blocks Summon with request_in_progress', async () => {
    const hold = deferred();
    const { fetchMock } = await renderConnected({ resetReply: () => hold.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByTestId('control-pending')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Summoning…' }).disabled).toBe(true); // shared busy state
    await act(async () => { hold.resolve(reply(200, { reset: true })); });
    await waitFor(() => expect(screen.getByTestId('control-notice').textContent).toContain('Reset request accepted'));
    expect(posts(fetchMock, '/reset')).toHaveLength(1);
    expect(posts(fetchMock, '/chaos-runs')).toHaveLength(0);
  });

  it('shows a Summon rejection from the backend as an error, not a success', async () => {
    await renderConnected({ chaos: () => reply(409, { error: { code: 'incident_active', message: 'An Incident is active.' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Summon Poltergeist' }));
    await waitFor(() => expect(document.querySelector('.so-summon__error')?.getAttribute('role')).toBe('alert'));
    expect(document.querySelector('.so-summon__error').textContent).toContain('(incident_active)');
    expect(screen.queryByText(/request accepted/)).toBeNull();
  });
});

describe('real data in the shell', () => {
  it('normalizes the real and legacy health shapes and never shows unknown values as nominal', async () => {
    installFetch({
      health: () => reply(200, {
        status: 'degraded',
        testApp: {
          reachable: true, httpStatus: 200,
          components: { button: { status: 'fail', error: 'onClick missing' }, card: { status: 'ok' }, dataPanel: 'ok', layout: 'failing' },
        },
        storage: { ok: true },
      }),
    });
    render(<App />);
    await waitFor(() => expect(badge('button')).toBe('BREACHED // FAULT'));
    expect(within(cardFor('button')).getByTestId('so-card-error').textContent).toBe('onClick missing');
    expect(badge('card')).toBe('NOMINAL');
    expect(badge('dataPanel')).toBe('NOMINAL');
    expect(badge('layout')).toBe('STATUS REPORTED'); // an unrecognised value is shown raw, not as nominal
    expect(within(cardFor('layout')).getByTestId('so-card-health').textContent).toBe('failing');
  });

  it('shows the cards as unavailable when health cannot be loaded', async () => {
    installFetch({ health: () => reply(500, { error: { code: 'internal_error', message: 'down' } }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('connection-error')).toBeTruthy());
    for (const key of ['dataPanel', 'button', 'card', 'layout']) expect(badge(key)).toBe('UNAVAILABLE');
  });

  it('maps incidents by their real component and keeps unmapped ones separate', async () => {
    const appIncident = { ...INCIDENT, incidentId: 'inc-app', component: 'app' };
    installFetch({ incidents: [INCIDENT, appIncident] });
    render(<App />);
    await waitFor(() => expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-1'));
    expect(screen.getAllByTestId('so-applevel-item').map((el) => el.textContent)).toEqual([expect.stringContaining('inc-app')]);
    for (const key of ['dataPanel', 'card', 'layout']) {
      expect(within(cardFor(key)).getByTestId('so-card-incident').textContent).toBe('None');
    }
  });
});

describe('verified recovery only', () => {
  it('does not treat a passing verification alone as recovery', async () => {
    const { es } = await renderConnected({ incidents: [INCIDENT] });
    await waitFor(() => expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-1'));
    send(es, ev(10, 'verification', { incidentId: 'inc-1', verificationId: 'v-1', overall: 'pass', checks: [{ outcome: 'pass' }] }));
    expect(badge('button')).not.toBe('PATCHED // VERIFIED');
    expect(screen.queryByTestId('so-heal')).toBeNull();
  });

  it('does not treat a recovered state without a passing verification as recovery', async () => {
    const { es } = await renderConnected({ incidents: [INCIDENT] });
    await waitFor(() => expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-1'));
    send(es, stateEv(11, 'recovered'));
    expect(badge('button')).not.toBe('PATCHED // VERIFIED'); // state claim without a passing verification
    expect(screen.queryByTestId('so-heal')).toBeNull();
    expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('Recovery claimed, not verified');
    expect(screen.getByRole('log', { name: 'Agent activity' }).textContent).toContain('state: recovered. Not verified.');
  });

  it('shows PATCHED // VERIFIED and one heal pulse once state is recovered and a passing verification exists', async () => {
    const { es } = await renderConnected({ incidents: [INCIDENT] });
    await waitFor(() => expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-1'));
    send(es, ev(10, 'verification', { incidentId: 'inc-1', verificationId: 'v-1', overall: 'pass', checks: [{ outcome: 'pass' }] }));
    send(es, stateEv(11, 'recovered'));
    expect(badge('button')).toBe('PATCHED // VERIFIED');
    expect(within(cardFor('button')).getByTestId('so-heal')).toBeTruthy();
  });

  it('does not show recovery for rolled_back or escalated', async () => {
    const { es } = await renderConnected({ incidents: [INCIDENT] });
    await waitFor(() => expect(within(cardFor('button')).getByTestId('so-card-incident').textContent).toContain('inc-1'));
    send(es, stateEv(10, 'rolled_back'));
    expect(badge('button')).toBe('INCIDENT OPEN');
    send(es, stateEv(11, 'escalated'));
    expect(badge('button')).toBe('ESCALATED');
    expect(screen.queryByTestId('so-heal')).toBeNull();
  });
});

describe('history versus live Events', () => {
  const history = [
    ev(1, 'chaos.injection', { scenarioId: 's1', targetComponent: 'button' }, { incidentId: null, component: 'scenario-engine' }),
    ev(2, 'detection', { failingComponent: 'button' }, { incidentId: null, component: 'button' }),
  ];

  it('renders historical Events in steady state: no reaper, no live log lines', async () => {
    await renderConnected({ events: history });
    await waitFor(() => expect(screen.getAllByTestId('event-row')).toHaveLength(2));
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show agent activity history' }));
    const lines = screen.getAllByTestId('so-log-line');
    expect(lines.map((l) => l.getAttribute('data-actor'))).toEqual(['POLTERGEIST', 'SYSTEM']);
    expect(lines.some((l) => l.className.includes('so-log__line--live'))).toBe(false);
  });

  it('strikes the card named by a live payload.targetComponent', async () => {
    const { es } = await renderConnected({ events: history });
    await waitFor(() => expect(screen.getAllByTestId('event-row')).toHaveLength(2));
    send(es, ev(3, 'chaos.injection', { scenarioId: 's2', targetComponent: 'layout' }, { incidentId: null, component: 'scenario-engine' }));
    expect(screen.getByTestId('so-reaper')).toBeTruthy();
    await waitFor(() => expect(within(cardFor('layout')).getByTestId('so-slash')).toBeTruthy(), { timeout: 3000 });
    for (const key of ['dataPanel', 'button', 'card']) expect(within(cardFor(key)).queryByTestId('so-slash')).toBeNull();
    const live = screen.getAllByTestId('so-log-line').at(-1);
    expect(live.className).toContain('so-log__line--live');
    expect(live.textContent).toBe('[POLTERGEIST] Injected scenario s2 into component layout.');
  });

  it('does not invent a target from the fake-fixture `target` field', async () => {
    const { es } = await renderConnected();
    send(es, ev(1, 'chaos.injection', { scenarioId: 's1', target: 'testapp/src/Button.jsx' }, { incidentId: null, component: 'poltergeist' }));
    expect(screen.queryByTestId('so-reaper')).toBeNull();
    expect(screen.getAllByTestId('so-log-line').at(-1).textContent).toBe('[POLTERGEIST] Injected scenario s1.');
  });
});

describe('client-side refresh failures', () => {
  it('appear as client-side SYSTEM notes, not as backend Events', async () => {
    const { es } = await renderConnected({
      health: (n) => (n === 1 ? reply(200, HEALTH_OK) : reply(500, { error: { code: 'internal_error', message: 'health down' } })),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    send(es, ev(5, 'detection', { failingComponent: 'button' }, { incidentId: null, component: 'button' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); // debounce plus three retries
    const last = screen.getAllByTestId('so-log-line').at(-1);
    expect(last.getAttribute('data-actor')).toBe('SYSTEM');
    expect(last.textContent).toBe('[SYSTEM] Client-side: Live refresh of health failed after 4 attempts: health down (internal_error)');
    expect(last.hasAttribute('data-seq')).toBe(false); // not a backend Event
    expect(screen.getAllByTestId('event-row')).toHaveLength(1); // the timeline holds only the real Event
  });
});
