// Task 12.1: HTTP API (Requirements 13.1-13.6, 14.8). Real Express app over a real loopback socket.
import { afterEach, describe, expect, it } from 'vitest';
import { createApiApp, parseDashboardOrigin, ApiConfigError } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';

const ORIGIN = 'http://127.0.0.1:5173';
const SECRET = 'sk-test-0123456789abcdef0123456789abcdef';

const scenarios = [
  { scenarioId: 'button-failure', label: 'Button failure', severity: 'high', targetFiles: ['public/button.js'], injection: { secret: 1 } },
  { scenarioId: 'api-failure', label: 'API failure', severity: 'critical', targetFiles: ['mock-api.js'], injection: { secret: 2 } },
];

function makeDeps(over = {}) {
  const calls = { start: [], reset: 0 };
  const state = { active: null, incidents: [], verifications: {}, events: [] };
  const deps = {
    incidents: {
      list: async () => state.incidents,
      get: async (id) => state.incidents.find((i) => i.incidentId === id) ?? null,
      getActive: async () => state.active,
      listVerifications: async (id) => state.verifications[id] ?? [],
    },
    eventLog: {
      storageStatus: { ok: true },
      dashboardView: () => ({
        readAfter: async (seq, filter) => state.events.filter((e) => e.seq > seq && (!filter || e.incidentId === filter.incidentId)),
      }),
    },
    cycleController: {
      startChaosRun: async (id) => {
        calls.start.push(id);
        if (state.active) return { conflict: true, reason: 'busy', incidentId: state.active.incidentId };
        return { runId: 'run-1', scenarioId: id ?? 'button-failure' };
      },
    },
    scenarioEngine: {
      reset: async () => {
        calls.reset += 1;
        return { snapshotId: 'snap-1', checksums: [], timestamp: '2025-01-01T00:00:00.000Z', eventId: 'evt-1' };
      },
    },
    catalog: { scenarios, has: (id) => scenarios.some((s) => s.scenarioId === id) },
    fetchHealth: async () => ({ httpStatus: 200, body: { status: 'ok' } }),
    dashboardOrigin: ORIGIN,
    ...over,
  };
  return { deps, calls, state };
}

const running = [];
async function boot(over) {
  const ctx = makeDeps(over);
  const handle = await startApiServer(createApiApp(ctx.deps));
  running.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;
  return { ...ctx, handle, base };
}
afterEach(async () => {
  while (running.length) await running.pop().close();
});

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('API server', () => {
  it('binds to 127.0.0.1 only (13.1)', async () => {
    const { handle } = await boot();
    expect(handle.host).toBe('127.0.0.1');
    expect(handle.server.address().address).toBe('127.0.0.1');
  });

  it('rejects a non-loopback dashboard origin', () => {
    expect(() => parseDashboardOrigin('https://example.com')).toThrow(ApiConfigError);
    expect(parseDashboardOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('requires its collaborators', () => {
    expect(() => createApiApp({})).toThrow(TypeError);
  });
});

describe('CORS (13.5)', () => {
  it('allows only the configured origin', async () => {
    const { base } = await boot();
    const ok = await fetch(`${base}/api/v1/scenarios`, { headers: { origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await fetch(`${base}/api/v1/scenarios`, { headers: { origin: 'http://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses state changes from another origin without touching state', async () => {
    const { base, calls } = await boot();
    const res = await post(`${base}/api/v1/reset`, {}, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(calls.reset).toBe(0);
  });

  it('answers preflight for the dashboard origin', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/v1/chaos-runs`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('GET /health (13.2, 14.8)', () => {
  it('reports ok when storage and Test_App are healthy', async () => {
    const { base } = await boot();
    const body = await (await fetch(`${base}/api/v1/health`)).json();
    expect(body.status).toBe('ok');
    expect(body.testApp.reachable).toBe(true);
  });

  it('reports storage errors', async () => {
    const { deps } = makeDeps();
    deps.eventLog.storageStatus = { ok: false, error: 'disk full', at: 'now' };
    const handle = await startApiServer(createApiApp(deps));
    running.push(handle);
    const body = await (await fetch(`http://127.0.0.1:${handle.port}/api/v1/health`)).json();
    expect(body.status).toBe('storage_error');
    expect(body.storage.ok).toBe(false);
  });

  it('reports an unreachable Test_App as degraded', async () => {
    const { base } = await boot({ fetchHealth: async () => { throw new Error('ECONNREFUSED'); } });
    const body = await (await fetch(`${base}/api/v1/health`)).json();
    expect(body.status).toBe('degraded');
    expect(body.testApp.reachable).toBe(false);
  });

  it('never leaks a secret in a response (13.6)', async () => {
    const { base } = await boot({ fetchHealth: async () => { throw new Error(`token ${SECRET} rejected`); } });
    const text = await (await fetch(`${base}/api/v1/health`)).text();
    expect(text).not.toContain(SECRET);
  });
});

describe('GET /scenarios', () => {
  it('exposes only id, label and severity', async () => {
    const { base } = await boot();
    const body = await (await fetch(`${base}/api/v1/scenarios`)).json();
    expect(body.scenarios).toEqual([
      { id: 'button-failure', label: 'Button failure', severity: 'high' },
      { id: 'api-failure', label: 'API failure', severity: 'critical' },
    ]);
  });
});

describe('POST /chaos-runs (13.3, 13.4)', () => {
  it('starts a run', async () => {
    const { base, calls } = await boot();
    const res = await post(`${base}/api/v1/chaos-runs`, { scenarioId: 'api-failure' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: 'run-1', scenarioId: 'api-failure' });
    expect(calls.start).toEqual(['api-failure']);
  });

  it('accepts an empty body', async () => {
    const { base, calls } = await boot();
    const res = await fetch(`${base}/api/v1/chaos-runs`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(calls.start).toEqual([undefined]);
  });

  it.each([
    ['extra property', { scenarioId: 'api-failure', extra: 1 }],
    ['wrong type', { scenarioId: 5 }],
    ['unknown scenario', { scenarioId: 'nope' }],
  ])('returns 400 and changes nothing for %s', async (_n, body) => {
    const { base, calls } = await boot();
    const res = await post(`${base}/api/v1/chaos-runs`, body);
    expect(res.status).toBe(400);
    expect(calls.start).toEqual([]);
  });

  it('returns 400 for malformed JSON and non-JSON content', async () => {
    const { base, calls } = await boot();
    expect((await post(`${base}/api/v1/chaos-runs`, '{bad')).status).toBe(400);
    const text = await fetch(`${base}/api/v1/chaos-runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(text.status).toBe(400);
    expect(calls.start).toEqual([]);
  });

  it('returns 409 while an Incident is non-terminal', async () => {
    const { base, state } = await boot();
    state.active = { incidentId: 'inc-1', state: 'investigating' };
    const res = await post(`${base}/api/v1/chaos-runs`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.incidentId).toBe('inc-1');
  });
});

describe('incidents and events', () => {
  it('lists, fetches and 404s Incidents', async () => {
    const { base, state } = await boot();
    state.incidents = [{ incidentId: 'inc-1', state: 'recovered' }];
    expect((await (await fetch(`${base}/api/v1/incidents`)).json()).incidents).toHaveLength(1);
    expect((await (await fetch(`${base}/api/v1/incidents/inc-1`)).json()).incidentId).toBe('inc-1');
    expect((await fetch(`${base}/api/v1/incidents/missing`)).status).toBe(404);
  });

  it('returns the latest Verification_Result or 404', async () => {
    const { base, state } = await boot();
    state.incidents = [{ incidentId: 'inc-1', state: 'recovered' }, { incidentId: 'inc-2', state: 'verifying' }];
    state.verifications['inc-1'] = [{ n: 1 }, { n: 2 }];
    expect(await (await fetch(`${base}/api/v1/incidents/inc-1/verification`)).json()).toEqual({ n: 2 });
    expect((await fetch(`${base}/api/v1/incidents/inc-2/verification`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/incidents/nope/verification`)).status).toBe(404);
  });

  it('reads events after a sequence number with validation', async () => {
    const { base, state } = await boot();
    state.events = [{ seq: 1, incidentId: 'a' }, { seq: 2, incidentId: 'b' }, { seq: 3, incidentId: 'a' }];
    expect((await (await fetch(`${base}/api/v1/events?afterSeq=1`)).json()).events.map((e) => e.seq)).toEqual([2, 3]);
    expect((await (await fetch(`${base}/api/v1/events?incidentId=a`)).json()).events.map((e) => e.seq)).toEqual([1, 3]);
    expect((await fetch(`${base}/api/v1/events?afterSeq=-1`)).status).toBe(400);
  });
});

describe('POST /reset', () => {
  it('resets when no Incident is active', async () => {
    const { base, calls } = await boot();
    const res = await post(`${base}/api/v1/reset`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).snapshotId).toBe('snap-1');
    expect(calls.reset).toBe(1);
  });

  it('rejects a body with fields and does not reset (13.3)', async () => {
    const { base, calls } = await boot();
    expect((await post(`${base}/api/v1/reset`, { force: true })).status).toBe(400);
    expect(calls.reset).toBe(0);
  });

  it('returns 409 and does not reset while an Incident is active', async () => {
    const { base, calls, state } = await boot();
    state.active = { incidentId: 'inc-1', state: 'repairing' };
    expect((await post(`${base}/api/v1/reset`, {})).status).toBe(409);
    expect(calls.reset).toBe(0);
  });
});

describe('SSE mount point (12.3 seam)', () => {
  it('answers 501 until a handler is supplied', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/v1/events/stream`);
    expect(res.status).toBe(501);
  });

  it('delegates to the supplied handler', async () => {
    const { base } = await boot({ sseHandler: (req, res) => res.status(200).type('text/plain').send('handled') });
    const res = await fetch(`${base}/api/v1/events/stream`);
    expect(await res.text()).toBe('handled');
  });
});

describe('errors', () => {
  it('hides internal error details and 404s unknown paths', async () => {
    const { deps } = makeDeps();
    deps.incidents.list = async () => { throw new Error(`boom ${SECRET}`); };
    const handle = await startApiServer(createApiApp(deps));
    running.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${base}/api/v1/incidents`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('boom');
    expect((await fetch(`${base}/api/v1/nope`)).status).toBe(404);
  });
});
