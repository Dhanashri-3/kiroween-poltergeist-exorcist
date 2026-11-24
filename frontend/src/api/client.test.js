import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError, loadSnapshot } from './client.js';
import { reduce, initialState } from '../state/dashboardReducer.js';

const reply = (status, body, { raw } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (raw !== undefined ? raw : JSON.stringify(body)),
});

function setup(response) {
  const fetchImpl = vi.fn(async () => (typeof response === 'function' ? response() : response));
  return { fetchImpl, client: createApiClient({ baseUrl: 'http://test/api/v1', fetchImpl }) };
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

describe('requests', () => {
  it('GETs each endpoint under the base URL', async () => {
    const { client, fetchImpl } = setup(reply(200, { scenarios: [], incidents: [], events: [] }));
    await client.getHealth();
    await client.getScenarios();
    await client.getIncidents();
    await client.getIncident('a');
    await client.getVerification('a');
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      'http://test/api/v1/health',
      'http://test/api/v1/scenarios',
      'http://test/api/v1/incidents',
      'http://test/api/v1/incidents/a',
      'http://test/api/v1/incidents/a/verification',
    ]);
    expect(fetchImpl.mock.calls.every((c) => c[1].method === 'GET' && c[1].body === undefined)).toBe(true);
  });

  it('encodes the incident id', async () => {
    const { client, fetchImpl } = setup(reply(200, {}));
    await client.getIncident('a/b?c#d');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://test/api/v1/incidents/a%2Fb%3Fc%23d');
  });

  it('sends afterSeq only for non-negative integers, and incidentId when set', async () => {
    const { client, fetchImpl } = setup(reply(200, { events: [] }));
    await client.getEvents({ afterSeq: 5, incidentId: 'x y' });
    await client.getEvents({ afterSeq: 0 });
    await client.getEvents({ afterSeq: -1 });
    await client.getEvents({ afterSeq: 1.5 });
    await client.getEvents({ afterSeq: '3' });
    await client.getEvents();
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      'http://test/api/v1/events?afterSeq=5&incidentId=x+y',
      'http://test/api/v1/events?afterSeq=0',
      'http://test/api/v1/events',
      'http://test/api/v1/events',
      'http://test/api/v1/events',
      'http://test/api/v1/events',
    ]);
  });

  it('POSTs chaos-runs with JSON content type and scenarioId or empty body', async () => {
    const { client, fetchImpl } = setup(reply(202, { runId: 'r1', scenarioId: 's1' }));
    const result = await client.startChaosRun('s1');
    await client.startChaosRun();
    expect(result).toEqual({ runId: 'r1', scenarioId: 's1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://test/api/v1/chaos-runs');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"scenarioId":"s1"}');
    expect(fetchImpl.mock.calls[1][1].body).toBe('{}');
  });

  it('POSTs reset with an empty JSON body', async () => {
    const { client, fetchImpl } = setup(reply(200, {}));
    await client.reset();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://test/api/v1/reset');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('defaults to the configured relative base URL', async () => {
    const fetchImpl = vi.fn(async () => reply(200, {}));
    await createApiClient({ fetchImpl }).getHealth();
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/health');
  });
});

describe('error mapping', () => {
  it('maps an error body to ApiError', async () => {
    const { client } = setup(reply(409, { error: { code: 'incident_active', message: 'busy', details: { incidentId: 'i1' } } }));
    const err = await client.startChaosRun('s').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'incident_active', message: 'busy', details: { incidentId: 'i1' } });
  });

  it('maps 400 unknown_scenario', async () => {
    const { client } = setup(reply(400, { error: { code: 'unknown_scenario', message: 'nope' } }));
    await expect(client.startChaosRun('x')).rejects.toMatchObject({ status: 400, code: 'unknown_scenario' });
  });

  it('maps fetch rejection to network_error with status 0', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const client = createApiClient({ baseUrl: '/x', fetchImpl });
    await expect(client.getHealth()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('maps non-JSON success body to invalid_response', async () => {
    const { client } = setup(reply(200, null, { raw: '<html>' }));
    await expect(client.getHealth()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });

  it('maps wrong-shaped success body to invalid_response', async () => {
    const { client } = setup(reply(200, { events: 'nope' }));
    await expect(client.getEvents()).rejects.toMatchObject({ code: 'invalid_response' });
    const bad = setup(reply(202, { nothing: true }));
    await expect(bad.client.startChaosRun()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps a non-JSON error body to invalid_response keeping the status', async () => {
    const { client } = setup(reply(502, null, { raw: 'Bad gateway' }));
    await expect(client.getHealth()).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('rethrows aborts unchanged', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = createApiClient({ baseUrl: '/x', fetchImpl: async () => { throw abort; } });
    await expect(client.getHealth()).rejects.toBe(abort);
  });
});

describe('loadSnapshot', () => {
  it('dispatches api actions and reports the highest seq', async () => {
    const events = [makeEvent(1), makeEvent(4), makeEvent(2)];
    const bodies = {
      '/health': { status: 'ok', testApp: {}, storage: {} },
      '/scenarios': { scenarios: [{ id: 's', label: 'S', severity: 'low' }] },
      '/incidents': { incidents: [] },
      '/events': { events },
    };
    const fetchImpl = async (url) => reply(200, bodies[new URL(url, 'http://t').pathname.replace('/api/v1', '')]);
    const client = createApiClient({ baseUrl: '/api/v1', fetchImpl });
    const dispatch = vi.fn();
    const result = await loadSnapshot({ client, dispatch });
    expect(result).toEqual({ errors: [], maxSeq: 4 });
    expect(dispatch.mock.calls.map((c) => c[0].endpoint).sort()).toEqual(['events', 'health', 'incidents', 'scenarios']);
    expect(dispatch.mock.calls.every((c) => c[0].kind === 'api')).toBe(true);
  });

  it('keeps going when one endpoint fails and collects the error', async () => {
    const fetchImpl = async (url) => (url.endsWith('/scenarios')
      ? reply(500, { error: { code: 'internal_error', message: 'boom' } })
      : reply(200, { status: 'ok', testApp: {}, incidents: [], events: [] }));
    const client = createApiClient({ baseUrl: '/api/v1', fetchImpl });
    const dispatch = vi.fn();
    const result = await loadSnapshot({ client, dispatch });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].endpoint).toBe('scenarios');
    expect(result.errors[0].error.code).toBe('internal_error');
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('dispatches nothing once aborted', async () => {
    const controller = new AbortController();
    const client = createApiClient({ baseUrl: '/api/v1', fetchImpl: async () => reply(200, { events: [], scenarios: [], incidents: [] }) });
    const dispatch = vi.fn();
    const pending = loadSnapshot({ client, dispatch, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it('feeds responses into the real reducer', async () => {
    const e = makeEvent(3);
    const fetchImpl = async (url) => {
      if (url.endsWith('/events')) return reply(200, { events: [e, e] });
      if (url.endsWith('/health')) return reply(200, { status: 'ok', testApp: { up: true } });
      if (url.endsWith('/scenarios')) return reply(200, { scenarios: [{ id: 's', label: 'S', severity: 'low' }] });
      return reply(200, { incidents: [] });
    };
    let state = initialState;
    await loadSnapshot({
      client: createApiClient({ baseUrl: '/api/v1', fetchImpl }),
      dispatch: (a) => { state = reduce(state, a); },
    });
    expect(state.events.map((x) => x.seq)).toEqual([3]);
    expect(state.health.status).toBe('ok');
    expect(state.scenarios).toHaveLength(1);
  });
});
