// Task 12.3: SSE stream and replay (Requirements 14.3, 14.4, 14.5). Real Event_Log, real Express app, real socket.
import { afterEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';
import { createSseHandler } from '../src/api/sse.js';
import { createEventLog } from '../src/events/event-log.js';

function memoryStorage() {
  const rows = [];
  return {
    rows,
    async append(collection, record) { rows.push(structuredClone(record)); return record; },
    async list() { return structuredClone(rows); },
  };
}

const input = (type = 'detection', extra = {}) => ({ type, component: 'monitor', incidentId: null, runId: null, payload: { n: 1 }, ...extra });

const running = [];
afterEach(async () => {
  while (running.length) await running.pop()();
});

async function boot() {
  const eventLog = createEventLog({ storage: memoryStorage() });
  const scenarios = [{ scenarioId: 's', label: 'S', severity: 'high' }];
  const app = createApiApp({
    incidents: { list: async () => [], get: async () => null, getActive: async () => null, listVerifications: async () => [] },
    eventLog,
    cycleController: { startChaosRun: async () => ({ runId: 'r', scenarioId: 's' }) },
    scenarioEngine: { reset: async () => ({}) },
    catalog: { scenarios, has: () => true },
    fetchHealth: async () => ({ httpStatus: 200, body: {} }),
    dashboardOrigin: 'http://127.0.0.1:5173',
    sseHandler: createSseHandler({ eventLog, heartbeatMs: 50 }),
  });
  const handle = await startApiServer(app);
  running.push(() => handle.close());
  return { eventLog, base: `http://127.0.0.1:${handle.port}/api/v1/events/stream` };
}

/** Opens a stream and collects parsed messages. */
async function open(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const messages = [];
  const waiters = [];
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
          const id = /^id: (\d+)$/m.exec(raw);
          const data = /^data: (.*)$/m.exec(raw);
          if (id && data) messages.push({ id: Number(id[1]), event: JSON.parse(data[1]), at: Date.now() });
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (count, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (messages.length < count) {
      if (Date.now() > deadline) throw new Error(`timeout: got ${messages.length} of ${count}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 20); });
    }
  };
  const close = () => controller.abort();
  running.push(async () => close());
  return { res, messages, waitFor, close };
}

describe('SSE stream', () => {
  it('uses text/event-stream and emits id: <seq> for each event', async () => {
    const { eventLog, base } = await boot();
    await eventLog.append(input());
    const s = await open(base);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    await s.waitFor(1);
    expect(s.messages[0].id).toBe(1);
    expect(s.messages[0].event.seq).toBe(1);
  });

  it('replays greater sequence numbers in order from Last-Event-ID, then delivers live events', async () => {
    const { eventLog, base } = await boot();
    for (let i = 0; i < 5; i += 1) await eventLog.append(input());
    const s = await open(base, { 'Last-Event-ID': '2' });
    await s.waitFor(3);
    await eventLog.append(input('cleared'));
    await s.waitFor(4);
    expect(s.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
  });

  it('honors afterSeq and uses the larger of afterSeq and Last-Event-ID', async () => {
    const { eventLog, base } = await boot();
    for (let i = 0; i < 4; i += 1) await eventLog.append(input());
    const a = await open(`${base}?afterSeq=3`);
    await a.waitFor(1);
    const b = await open(`${base}?afterSeq=1`, { 'Last-Event-ID': '3' });
    await b.waitFor(1);
    expect(a.messages.map((m) => m.id)).toEqual([4]);
    expect(b.messages.map((m) => m.id)).toEqual([4]);
  });

  it('rejects an invalid afterSeq with 400', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}?afterSeq=abc`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  it('delivers a new event within 1 second of persistence', async () => {
    const { eventLog, base } = await boot();
    const s = await open(base);
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    await eventLog.append(input());
    await s.waitFor(1);
    expect(s.messages[0].at - start).toBeLessThan(1000);
  });

  it('has no gaps or duplicates when events are appended while connecting', async () => {
    const { eventLog, base } = await boot();
    for (let i = 0; i < 5; i += 1) await eventLog.append(input());
    const connecting = open(base);
    const writing = Promise.all(Array.from({ length: 20 }, () => eventLog.append(input())));
    const s = await connecting;
    await writing;
    await s.waitFor(25);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.messages.map((m) => m.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('streams the Dashboard view, which includes chaos events', async () => {
    const { eventLog, base } = await boot();
    await eventLog.append(input('chaos.injection'));
    const s = await open(base);
    await s.waitFor(1);
    expect(s.messages[0].event.type).toBe('chaos.injection'); // Dashboard view includes chaos events
  });

  it('removes the subscriber when the client disconnects', async () => {
    const { eventLog, base } = await boot();
    expect(eventLog._subscribers.size).toBe(0);
    const s = await open(base);
    await new Promise((r) => setTimeout(r, 100));
    expect(eventLog._subscribers.size).toBe(1);
    s.close();
    const deadline = Date.now() + 2000;
    while (eventLog._subscribers.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(eventLog._subscribers.size).toBe(0);
  });
});
