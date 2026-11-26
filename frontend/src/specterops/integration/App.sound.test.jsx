/**
 * Phase 4B.4B: sound through the real App (reducer, useEventStream, watermark, shell) with a fake fetch, a fake
 * EventSource and a fake AudioContext. Every Event is synthetic test input; nothing plays real audio.
 * A cue is identified by the oscillator frequencies it schedules (see CUE_DEFINITIONS).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import App, { SOUND_NOTES } from '../../App.jsx';
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

class Param {
  constructor(v = 0) { this.value = v; this.first = null; }
  setValueAtTime(v) { if (this.first === null) this.first = v; this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class FakeNode {
  connect(n) { return n; }
  disconnect() {}
}

/** Fake AudioContext. Sources end on the next microtask, like very short sounds. */
function fakeAudio({ resume = 'run' } = {}) {
  return class FakeAudioContext {
    static instances = [];
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = new FakeNode();
      this.oscillators = [];
      this.calls = { resume: 0, suspend: 0, close: 0 };
      this.constructor.instances.push(this);
    }
    createGain() { const n = new FakeNode(); n.gain = new Param(1); return n; }
    createBiquadFilter() { const n = new FakeNode(); n.frequency = new Param(); return n; }
    createOscillator() {
      const n = new FakeNode();
      n.frequency = new Param(440);
      n.detune = new Param(0);
      n.start = () => { queueMicrotask(() => n.onended?.()); };
      n.stop = () => {};
      this.oscillators.push(n);
      return n;
    }
    createBufferSource() {
      const n = new FakeNode();
      n.start = () => { queueMicrotask(() => n.onended?.()); };
      n.stop = () => {};
      return n;
    }
    createBuffer(c, length) { const d = new Float32Array(length); return { getChannelData: () => d }; }
    resume() {
      this.calls.resume += 1;
      if (resume === 'reject') return Promise.reject(new Error('not allowed'));
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.calls.suspend += 1; this.state = 'suspended'; return Promise.resolve(); }
    close() { this.calls.close += 1; this.state = 'closed'; return Promise.resolve(); }
  };
}
const freqs = (ctx) => ctx.oscillators.map((o) => o.frequency.first);

const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const HEALTH_OK = {
  status: 'ok',
  testApp: { reachable: true, httpStatus: 200, components: { button: { status: 'ok' }, card: { status: 'ok' }, dataPanel: { status: 'ok' }, layout: { status: 'ok' } } },
  storage: { ok: true },
};
const INCIDENT = {
  incidentId: 'inc-1', state: 'detected', component: 'button', detectedAt: '2024-01-01T00:00:00.000Z',
  attemptCount: 0, evidenceRefs: [], terminalReason: null,
};
function installFetch({ events = [] } = {}) {
  const fetchMock = vi.fn(async (url, init) => {
    const path = url.replace('/api/v1', '');
    if (init.method === 'POST') return reply(202, { runId: 'run-1' });
    if (path.startsWith('/health')) return reply(200, HEALTH_OK);
    if (path.startsWith('/scenarios')) return reply(200, { scenarios: [] });
    if (path.startsWith('/incidents/')) return reply(200, INCIDENT);
    if (path.startsWith('/incidents')) return reply(200, { incidents: [INCIDENT] });
    if (path.startsWith('/events')) return reply(200, { events });
    return reply(404, { error: { code: 'not_found', message: 'nope' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const inject = (seq) => ev(seq, 'chaos.injection', { scenarioId: 'button-failure', targetComponent: 'button' }, { incidentId: null, component: 'scenario-engine' });
const pass = (seq) => ev(seq, 'verification', { incidentId: 'inc-1', verificationId: `v-${seq}`, overall: 'pass', checks: [{ outcome: 'pass' }] });
const fail = (seq) => ev(seq, 'verification', { incidentId: 'inc-1', verificationId: `v-${seq}`, overall: 'fail', checks: [{ outcome: 'fail' }] });
const send = (es, event) => act(() => es.emit(event.type, { data: JSON.stringify(event) }));
const soundButton = () => screen.getByRole('button', { name: 'Sound' });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function renderConnected(options, wrap = (el) => el) {
  const fetchMock = installFetch(options);
  const view = render(wrap(<App />));
  await waitFor(() => expect(openStreams()).toHaveLength(1));
  const es = openStreams()[0];
  act(() => es.emit('open', {}));
  await waitFor(() => expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('connected'));
  await flush(); // snapshot dispatched, history ready
  return { fetchMock, es, view };
}

async function turnSoundOn() {
  fireEvent.click(soundButton());
  await waitFor(() => expect(soundButton().getAttribute('aria-pressed')).toBe('true'));
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

describe('App sound: default and unlock', () => {
  it('is muted by default and creates no AudioContext without a click, even for live Events', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected({ events: [inject(1)] });
    expect(soundButton().getAttribute('aria-pressed')).toBe('false');
    send(es, inject(2));
    await flush();
    expect(Fake.instances).toHaveLength(0);
    expect(openStreams()).toHaveLength(1);
  });

  it('a click unlocks and resumes one context; history stays silent and a live Event plays', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected({ events: [inject(1), pass(2)] });
    await turnSoundOn();
    expect(Fake.instances).toHaveLength(1);
    const ctx = Fake.instances[0];
    expect(ctx.calls.resume).toBe(1);
    expect(ctx.oscillators).toHaveLength(0); // seq 1 and 2 are history
    send(es, inject(3));
    await flush();
    expect(freqs(ctx)).toEqual([330, 330]); // the poltergeist ghost wail (two tonal voices)
    expect(openStreams()).toHaveLength(1); // audio opened no stream
  });

  it('muting suspends at once; Events while muted are never replayed after unmuting', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected();
    await turnSoundOn();
    const ctx = Fake.instances[0];
    fireEvent.click(soundButton());
    expect(soundButton().getAttribute('aria-pressed')).toBe('false');
    expect(ctx.calls.suspend).toBe(1);
    send(es, inject(1));
    await flush();
    await turnSoundOn();
    expect(ctx.calls.resume).toBe(2);
    expect(ctx.oscillators).toHaveLength(0);
    send(es, ev(2, 'diagnosis', { status: 'accepted', source: 'rule_based' }));
    await flush();
    expect(freqs(ctx)).toEqual([660, 880]);
  });
});

describe('App sound: verified recovery only', () => {
  it('a recovered state before its passing verification gives exactly one success cue', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected();
    await turnSoundOn();
    const ctx = Fake.instances[0];
    send(es, stateEv(10, 'recovered'));
    await flush();
    expect(freqs(ctx)).not.toContain(659.25);
    send(es, pass(11));
    await flush();
    expect(freqs(ctx).filter((f) => f === 784)).toHaveLength(1); // neutral confirmation
    expect(freqs(ctx).filter((f) => f === 659.25)).toHaveLength(1); // one success arpeggio
    send(es, pass(11)); // duplicate seq
    send(es, ev(12, 'recovery', { verificationId: 'v-11', healthyChecks: 3 }));
    await flush();
    expect(freqs(ctx).filter((f) => f === 659.25)).toHaveLength(1);
  });

  it('a passing verification alone gives only the neutral confirmation', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected();
    await turnSoundOn();
    send(es, pass(10));
    await flush();
    expect(freqs(Fake.instances[0])).toEqual([784]);
  });

  it('an unverified recovery claim never gives the success cue', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es } = await renderConnected();
    await turnSoundOn();
    send(es, stateEv(10, 'recovered'));
    send(es, fail(11));
    await flush();
    const f = freqs(Fake.instances[0]);
    expect(f).toContain(196); // the failed-verification warning
    expect(f).not.toContain(659.25);
  });
});

describe('App sound: unavailable, blocked and lifecycle', () => {
  it('without Web Audio the toggle stays off and explains why', async () => {
    await renderConnected();
    fireEvent.click(soundButton());
    await waitFor(() => expect(screen.getByText(SOUND_NOTES.unavailable)).toBeTruthy());
    expect(soundButton().getAttribute('aria-pressed')).toBe('false');
    expect(soundButton().getAttribute('aria-describedby')).toBe('so-sound-note');
  });

  it('a blocked resume stays off and explains why', async () => {
    const Fake = fakeAudio({ resume: 'reject' });
    vi.stubGlobal('AudioContext', Fake);
    await renderConnected();
    fireEvent.click(soundButton());
    await waitFor(() => expect(screen.getByText(SOUND_NOTES.blocked)).toBeTruthy());
    expect(soundButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('StrictMode: no context before the click, one after it, one EventSource, and unmount closes it', async () => {
    const Fake = fakeAudio();
    vi.stubGlobal('AudioContext', Fake);
    const { es, view } = await renderConnected({}, (el) => <React.StrictMode>{el}</React.StrictMode>);
    expect(Fake.instances).toHaveLength(0);
    await turnSoundOn();
    expect(Fake.instances).toHaveLength(1);
    expect(Fake.instances[0].state).toBe('running');
    send(es, inject(1));
    await flush();
    expect(freqs(Fake.instances[0])).toEqual([330, 330]); // played once, not twice
    expect(openStreams()).toHaveLength(1);
    view.unmount();
    expect(Fake.instances[0].calls.close).toBe(1);
    expect(Fake.instances[0].state).toBe('closed');
  });
});
