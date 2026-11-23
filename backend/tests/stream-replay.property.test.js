// Feature: poltergeist-exorcist-healing-system, Property 26: Stream replay
// **Validates: Requirements 14.4**
// Real Event_Log, real Express app, real socket (same harness style as sse.test.js).
import { afterEach, describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createApiApp } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';
import { createSseHandler } from '../src/api/sse.js';
import { createEventLog } from '../src/events/event-log.js';
import { EVENT_TYPES } from '../src/contracts/common.js';

function memoryStorage() {
  const rows = [];
  return {
    async append(_c, record) { rows.push(structuredClone(record)); return record; },
    async list() { return structuredClone(rows); },
  };
}

const inputArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  component: fc.constantFrom('monitor', 'poltergeist', 'exorcist', 'incident-manager'),
  incidentId: fc.constant(null),
  runId: fc.constant(null),
  payload: fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.integer()),
});

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function boot(eventLog) {
  const app = createApiApp({
    incidents: { list: async () => [], get: async () => null, getActive: async () => null, listVerifications: async () => [] },
    eventLog,
    cycleController: { startChaosRun: async () => ({ runId: 'r', scenarioId: 's' }) },
    scenarioEngine: { reset: async () => ({}) },
    catalog: { scenarios: [{ scenarioId: 's', label: 'S', severity: 'high' }], has: () => true },
    fetchHealth: async () => ({ httpStatus: 200, body: {} }),
    dashboardOrigin: 'http://127.0.0.1:5173',
    sseHandler: createSseHandler({ eventLog, heartbeatMs: 1000 }),
  });
  const handle = await startApiServer(app);
  cleanups.push(() => handle.close());
  return `http://127.0.0.1:${handle.port}/api/v1/events/stream`;
}

/** Opens a stream; resolves once headers arrive (the handler has subscribed by then). */
async function open(url, headers) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const ids = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = /^id: (\d+)$/m.exec(raw);
          if (m) ids.push(Number(m[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (count, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (ids.length < count) {
      if (Date.now() > deadline) throw new Error(`timeout: got ${ids.length} of ${count}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ids, waitFor, close: () => controller.abort() };
}

describe('Property 26: Stream replay', () => {
  it('delivers exactly the events with seq > last-seen in ascending order, then live events, with no gaps or duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(inputArb, { minLength: 0, maxLength: 8 }), // events already in the log
        fc.array(inputArb, { minLength: 0, maxLength: 4 }), // events appended after connecting
        fc.integer({ min: 0, max: 12 }), // last-seen sequence number (may exceed the log)
        fc.constantFrom('header', 'query', 'both'),
        async (existing, live, lastSeen, via) => {
          const eventLog = createEventLog({ storage: memoryStorage() });
          for (const e of existing) await eventLog.append(e);
          const base = await boot(eventLog);

          let url = base;
          const headers = {};
          if (via === 'header') headers['Last-Event-ID'] = String(lastSeen);
          else if (via === 'query') url = `${base}?afterSeq=${lastSeen}`;
          else {
            url = `${base}?afterSeq=${lastSeen}`;
            headers['Last-Event-ID'] = String(Math.max(0, lastSeen - 1));
          }

          const s = await open(url, headers);
          for (const e of live) await eventLog.append(e);

          const total = existing.length + live.length;
          const expected = [];
          for (let seq = lastSeen + 1; seq <= total; seq += 1) expected.push(seq);

          if (expected.length > 0) await s.waitFor(expected.length);
          await new Promise((r) => setTimeout(r, 30)); // allow any stray duplicate to arrive
          s.close();

          expect(s.ids).toEqual(expected);
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);
});
