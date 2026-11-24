import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import App from './App.jsx';
import { ev, healthOk } from './components/testHelpers.js';

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

const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

function installFetch({ events = [] } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') {
      if (path.startsWith('/chaos-runs')) return reply(409, { error: { code: 'incident_active', message: 'An Incident is active.' } });
      return reply(200, { reset: true });
    }
    if (path.startsWith('/health')) return reply(200, healthOk);
    if (path.startsWith('/scenarios')) return reply(200, { scenarios: [{ id: 's1', label: 'Break cart', severity: 'low' }] });
    if (path.startsWith('/incidents')) return reply(200, { incidents: [] });
    if (path.startsWith('/events')) return reply(200, { events });
    return reply(404, { error: { code: 'not_found', message: 'nope' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  FakeES.instances = [];
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App (fake fetch + EventSource, real reducer and hook)', () => {
  it('renders the heading and loads the snapshot', async () => {
    installFetch({ events: [ev(1, 'detection', { note: 'seeded' }, { incidentId: null, component: 'monitor' })] });
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Poltergeist vs. Exorcist', level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('event-row')).toHaveLength(1));
    expect(screen.getAllByTestId('health-component')).toHaveLength(2);
    expect(screen.getAllByTestId('scenario-item')).toHaveLength(1);
    expect(screen.getByTestId('idle')).toBeTruthy();
  });

  it('renders a streamed Event and the connection status', async () => {
    installFetch();
    render(<App />);
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    const es = FakeES.instances[0];
    expect(es.url).toContain('/events/stream?afterSeq=0');
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('connecting');
    act(() => es.emit('open', {}));
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('connected');
    const event = ev(5, 'detection', { note: 'live' }, { incidentId: 'inc-live', component: 'monitor' });
    act(() => es.emit('detection', { data: JSON.stringify(event) }));
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('event-seq')[0].textContent).toBe('#5');
    expect(screen.getByTestId('incident-panel').textContent).toContain('inc-live');
    act(() => es.emit('error', {}));
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('disconnected');
  });

  it('start chaos hits the API and shows its 409 error without changing incident display', async () => {
    const fetchMock = installFetch();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId('scenario-item')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Start chaos' }));
    const alert = await screen.findByTestId('control-error');
    expect(alert.textContent).toContain('incident_active');
    expect(fetchMock.mock.calls.some(([u, i]) => u.endsWith('/chaos-runs') && i.method === 'POST')).toBe(true);
    expect(screen.getByTestId('idle')).toBeTruthy();
  });
});
