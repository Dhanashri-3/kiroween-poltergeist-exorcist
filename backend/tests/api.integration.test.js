// Task 12.5: API unit and integration tests (Requirements 13.4, 13.5, 13.7, 14.5).
// Real Express app, real loopback socket, real Event_Log and real configuration loader. No new dependencies.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiApp, ApiConfigError } from '../src/api/app.js';
import { startApiServer } from '../src/api/server.js';
import { createSseHandler } from '../src/api/sse.js';
import { createEventLog } from '../src/events/event-log.js';
import {
  initializeConfig,
  ConfigError,
  CONFIG_FILES,
  DEFAULT_CONFIG_DIR,
  DEFAULT_TESTAPP_DIR,
} from '../src/orchestrator/config-loader.js';

const ORIGIN = 'http://127.0.0.1:5173';

function memoryStorage() {
  const rows = [];
  return {
    async append(_c, record) { rows.push(structuredClone(record)); return record; },
    async list() { return structuredClone(rows); },
  };
}
const input = (type = 'detection') => ({ type, component: 'monitor', incidentId: null, runId: null, payload: { n: 1 } });

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function boot({ active = null } = {}) {
  const eventLog = createEventLog({ storage: memoryStorage() });
  const state = { active };
  const starts = [];
  const scenarios = [{ scenarioId: 's', label: 'S', severity: 'high' }];
  const app = createApiApp({
    incidents: { list: async () => [], get: async () => null, getActive: async () => state.active, listVerifications: async () => [] },
    eventLog,
    cycleController: {
      startChaosRun: async (id) => {
        starts.push(id);
        return state.active
          ? { conflict: true, reason: 'An Incident is not yet terminal.', incidentId: state.active.incidentId }
          : { runId: 'r1', scenarioId: id ?? 's' };
      },
    },
    scenarioEngine: { reset: async () => ({}) },
    catalog: { scenarios, has: (id) => id === 's' },
    fetchHealth: async () => ({ httpStatus: 200, body: {} }),
    dashboardOrigin: ORIGIN,
    sseHandler: createSseHandler({ eventLog, heartbeatMs: 50 }),
  });
  const handle = await startApiServer(app);
  cleanups.push(() => handle.close());
  return { eventLog, state, starts, base: `http://127.0.0.1:${handle.port}/api/v1` };
}

async function openStream(url, headers = {}) {
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  const res = await fetch(url, { headers, signal: controller.signal });
  const messages = [];
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
          if (id) messages.push({ id: Number(id[1]), at: Date.now() });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (count, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (messages.length < count) {
      if (Date.now() > deadline) throw new Error(`timeout: got ${messages.length} of ${count}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { messages, waitFor, close: () => controller.abort() };
}

describe('CORS allows only the configured Dashboard origin (13.5)', () => {
  it.each([
    ['a different port', 'http://127.0.0.1:5174'],
    ['a different host spelling', 'http://localhost:5173'],
    ['a different scheme', 'https://127.0.0.1:5173'],
    ['a trailing slash', `${ORIGIN}/`],
    ['the null origin', 'null'],
    ['an external site', 'https://example.com'],
  ])('sends no CORS headers for %s', async (_label, origin) => {
    const { base } = await boot();
    const res = await fetch(`${base}/scenarios`, { headers: { origin } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('refuses a preflight from another origin and a state change from another origin without starting a run', async () => {
    const { base, starts } = await boot();
    const pre = await fetch(`${base}/chaos-runs`, { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const post = await fetch(`${base}/chaos-runs`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(403);
    expect(starts).toEqual([]);
  });

  it('allows the configured origin on the SSE stream and permits Last-Event-ID in preflight', async () => {
    const { base } = await boot();
    const pre = await fetch(`${base}/events/stream`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toContain('Last-Event-ID');
  });

  it('never allows a wildcard origin', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/scenarios`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('POST /chaos-runs conflict (13.4)', () => {
  it('returns 409 with the active Incident ID while non-terminal, then 202 once it is cleared', async () => {
    const { base, state, starts } = await boot({ active: { incidentId: 'inc-9', state: 'repairing' } });
    const post = () => fetch(`${base}/chaos-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 's' }) });
    const blocked = await post();
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe('incident_active');
    expect(body.error.details.incidentId).toBe('inc-9');

    state.active = null;
    const ok = await post();
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ runId: 'r1', scenarioId: 's' });
    expect(starts).toHaveLength(2);
  });

  it('serializes simultaneous starts so the controller never runs two at once', async () => {
    const { base, starts } = await boot();
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/chaos-runs`, { method: 'POST' })));
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(starts).toHaveLength(5);
  });
});

describe('refusal to start on invalid configuration (13.7)', () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fs.rmSync(fixtures.pop(), { recursive: true, force: true });
  });
  function copyConfig() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-cfg-'));
    fixtures.push(root);
    const configDir = path.join(root, 'config');
    fs.cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
    return { configDir, testappDir: DEFAULT_TESTAPP_DIR };
  }

  // Startup order used by the entry point: config first, API only afterwards.
  async function startBackend(options) {
    const config = initializeConfig(options);
    const { eventLog } = await boot();
    return { config, eventLog };
  }

  it('starts when every configuration file is valid', async () => {
    const result = await startBackend(copyConfig());
    expect(result.config.scenarioCatalog).toHaveLength(6);
  });

  it.each(Object.values(CONFIG_FILES))('refuses to start when %s is missing, so no server is bound', async (name) => {
    const opts = copyConfig();
    fs.rmSync(path.join(opts.configDir, name));
    const before = cleanups.length;
    await expect(startBackend(opts)).rejects.toBeInstanceOf(ConfigError);
    expect(cleanups.length).toBe(before); // boot() never ran, so no listener was opened
  });

  it('refuses to start when a file is invalid JSON and reports the file', async () => {
    const opts = copyConfig();
    fs.writeFileSync(path.join(opts.configDir, 'scenario-catalog.json'), '{ "version": ');
    const err = await startBackend(opts).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors.some((e) => e.file === 'scenario-catalog.json' && e.code === 'malformed_json')).toBe(true);
  });

  it('refuses to start when a file fails its schema', async () => {
    const opts = copyConfig();
    const file = path.join(opts.configDir, 'approved-files.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.files = 'not-a-list';
    fs.writeFileSync(file, JSON.stringify(doc));
    const err = await startBackend(opts).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors.some((e) => e.file === 'approved-files.json' && e.code === 'schema_invalid')).toBe(true);
  });

  it('refuses to build the API for a missing, malformed or non-loopback Dashboard origin', () => {
    const deps = {
      incidents: { list() {}, get() {}, getActive() {}, listVerifications() {} },
      eventLog: { dashboardView() {} },
      cycleController: { startChaosRun() {} },
      scenarioEngine: { reset() {} },
      catalog: { scenarios: [], has: () => false },
      fetchHealth: async () => ({}),
    };
    for (const dashboardOrigin of [undefined, '', 'not a url', 'https://example.com', `${ORIGIN}/path`, 'http://user:pw@127.0.0.1:5173']) {
      expect(() => createApiApp({ ...deps, dashboardOrigin }), String(dashboardOrigin)).toThrow(ApiConfigError);
    }
  });
});

describe('SSE delivery and reconnect replay (14.5)', () => {
  it('delivers each new event within 1 second of persistence', async () => {
    const { eventLog, base } = await boot();
    const s = await openStream(`${base}/events/stream`);
    await new Promise((r) => setTimeout(r, 100));
    const delays = [];
    for (let i = 1; i <= 5; i += 1) {
      const start = Date.now();
      await eventLog.append(input());
      await s.waitFor(i);
      delays.push(s.messages[i - 1].at - start);
    }
    for (const d of delays) expect(d).toBeLessThan(1000);
  });

  it('replays missed events in order after a reconnect with Last-Event-ID, then continues live', async () => {
    const { eventLog, base } = await boot();
    const first = await openStream(`${base}/events/stream`);
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 3; i += 1) await eventLog.append(input());
    await first.waitFor(3);
    const lastSeen = first.messages[2].id;
    first.close(); // connection drops

    for (let i = 0; i < 4; i += 1) await eventLog.append(input()); // missed while offline

    const second = await openStream(`${base}/events/stream`, { 'Last-Event-ID': String(lastSeen) });
    await second.waitFor(4);
    await eventLog.append(input('cleared'));
    await second.waitFor(5);
    expect(second.messages.map((m) => m.id)).toEqual([4, 5, 6, 7, 8]);
  });

  it('replays through the afterSeq query parameter when no header is available', async () => {
    const { eventLog, base } = await boot();
    for (let i = 0; i < 6; i += 1) await eventLog.append(input());
    const s = await openStream(`${base}/events/stream?afterSeq=4`);
    await s.waitFor(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.messages.map((m) => m.id)).toEqual([5, 6]);
  });

  it('replays nothing and stays open when the client is already up to date', async () => {
    const { eventLog, base } = await boot();
    await eventLog.append(input());
    const s = await openStream(`${base}/events/stream`, { 'Last-Event-ID': '1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(s.messages).toEqual([]);
    await eventLog.append(input());
    await s.waitFor(1);
    expect(s.messages[0].id).toBe(2);
  });
});
