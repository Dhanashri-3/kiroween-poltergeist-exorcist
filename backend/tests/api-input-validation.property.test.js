// Feature: poltergeist-exorcist-healing-system, Property 22: API input validation
// **Validates: Requirements 13.3**
// For any request body that fails validation, the API answers 400 with a structured error body and
// changes nothing: no chaos run started, no reset, no Event appended. Real Express app, real socket.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createApiApp } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';

const ORIGIN = 'http://127.0.0.1:5173';
const scenarios = [
  { scenarioId: 'button-failure', label: 'Button failure', severity: 'high' },
  { scenarioId: 'api-failure', label: 'API failure', severity: 'critical' },
];
const catalogIds = new Set(scenarios.map((s) => s.scenarioId));

const calls = { start: [], reset: 0 };
const state = { events: [{ seq: 1 }, { seq: 2 }], incidents: [] };
let handle;
let base;

beforeAll(async () => {
  const deps = {
    incidents: {
      list: async () => state.incidents,
      get: async () => null,
      getActive: async () => null,
      listVerifications: async () => [],
    },
    eventLog: { storageStatus: { ok: true }, dashboardView: () => ({ readAfter: async () => state.events }) },
    cycleController: {
      startChaosRun: async (id) => {
        calls.start.push(id);
        state.incidents.push({ incidentId: 'x' });
        return { runId: 'run-1', scenarioId: id ?? 'button-failure' };
      },
    },
    scenarioEngine: {
      reset: async () => {
        calls.reset += 1;
        return { snapshotId: 's', checksums: [], timestamp: '2025-01-01T00:00:00.000Z', eventId: 'e' };
      },
    },
    catalog: { scenarios, has: (id) => catalogIds.has(id) },
    fetchHealth: async () => ({ httpStatus: 200, body: {} }),
    dashboardOrigin: ORIGIN,
  };
  handle = await startApiServer(createApiApp(deps));
  base = `http://127.0.0.1:${handle.port}/api/v1`;
});
afterAll(async () => {
  await handle?.close();
});

const send = (path, rawBody, contentType = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body: rawBody });

const snapshotState = () => JSON.stringify({ calls, events: state.events, incidents: state.incidents });

async function expectRejected(path, rawBody, contentType) {
  const before = snapshotState();
  const res = await send(path, rawBody, contentType);
  const body = await res.json();
  expect(res.status).toBe(400);
  expect(typeof body.error).toBe('object');
  expect(typeof body.error.code).toBe('string');
  expect(body.error.code.length).toBeGreaterThan(0);
  expect(typeof body.error.message).toBe('string');
  expect(snapshotState()).toBe(before);
  // The read side confirms nothing was appended or created.
  const events = await (await fetch(`${base}/events`)).json();
  expect(events.events.length).toBe(2);
  const incidents = await (await fetch(`${base}/incidents`)).json();
  expect(incidents.incidents.length).toBe(0);
}

const extraKey = fc.string({ minLength: 1, maxLength: 12 });
const anyJson = fc.jsonValue();
// Bodies that are not JSON objects, plus text that is not JSON at all.
const nonObjectJson = fc.oneof(
  fc.array(anyJson, { maxLength: 4 }).map((v) => JSON.stringify(v)),
  fc.string().map((v) => JSON.stringify(v)),
  fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean()).map((v) => JSON.stringify(v)),
  fc.constant('null'),
  fc.constantFrom('{', '{"a":', 'not json', '{"scenarioId":}', '[1,'),
);

const badScenarioIdValue = fc.oneof(
  fc.integer(), fc.boolean(), fc.constant(null), fc.constant(''),
  fc.array(fc.string(), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 5 }), fc.integer(), { maxKeys: 3 }),
);
const unknownScenarioString = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => !catalogIds.has(s));

const invalidChaosBody = fc.oneof(
  nonObjectJson,
  badScenarioIdValue.map((v) => JSON.stringify({ scenarioId: v })),
  unknownScenarioString.map((v) => JSON.stringify({ scenarioId: v })),
  fc.tuple(extraKey.filter((k) => k !== 'scenarioId' && k !== '__proto__'), anyJson, fc.boolean()).map(([k, v, withId]) =>
    JSON.stringify({ ...(withId ? { scenarioId: 'button-failure' } : {}), [k]: v })),
);

const invalidResetBody = fc.oneof(
  nonObjectJson,
  fc.tuple(extraKey.filter((k) => k !== '__proto__'), anyJson).map(([k, v]) => JSON.stringify({ [k]: v })),
);

describe('Property 22: API input validation', () => {
  it('POST /chaos-runs rejects any invalid body with 400 and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(invalidChaosBody, async (raw) => {
        await expectRejected('/chaos-runs', raw);
      }),
      { numRuns: 100 },
    );
    expect(calls.start).toEqual([]);
  });

  it('POST /reset rejects any invalid body with 400 and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(invalidResetBody, async (raw) => {
        await expectRejected('/reset', raw);
      }),
      { numRuns: 100 },
    );
    expect(calls.reset).toBe(0);
  });

  it('rejects non-JSON content types that carry a body, on both endpoints', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('/chaos-runs', '/reset'),
        fc.constantFrom('text/plain', 'application/x-www-form-urlencoded', 'application/xml'),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (path, type, raw) => {
          await expectRejected(path, raw, type);
        },
      ),
      { numRuns: 50 },
    );
    expect(calls.start).toEqual([]);
    expect(calls.reset).toBe(0);
  });
});
