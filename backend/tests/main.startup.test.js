// Task 15.2: backend entry point. Requirements 6.9, 13.7, 13.8.
// Real modules throughout. The Test_App is not started (the Monitor only polls once an hour here),
// and the real testapp/ is never written: all storage goes to a temporary directory.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { startBackend, StartupError, resolveSettings } from '../src/main.js';
import { DEFAULT_CONFIG_DIR } from '../src/orchestrator/config-loader.js';

const ONE_HOUR = 3_600_000;
const tmpDirs = [];
const running = [];

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function copyConfig() {
  const dir = path.join(tmp('cfg-'), 'config');
  fs.cpSync(DEFAULT_CONFIG_DIR, dir, { recursive: true });
  return dir;
}

const base = (storageDir, extra = {}) => ({ storageDir, port: 0, monitorIntervalMs: ONE_HOUR, ...extra });

async function start(options) {
  const backend = await startBackend(options);
  running.push(backend);
  return backend;
}

afterEach(async () => {
  while (running.length) await running.pop().close();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

describe('backend entry point: refuses to start on invalid configuration (13.7)', () => {
  it('rejects a malformed config file, binds nothing and records an error Event', async () => {
    const configDir = copyConfig();
    fs.writeFileSync(path.join(configDir, 'approved-files.json'), '{ not json');
    const storageDir = path.join(tmp('store-'), 'data');

    const error = await startBackend(base(storageDir, { configDir })).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(StartupError);
    expect(error.errors.some((e) => e.source === 'approved-files.json' && e.code === 'malformed_json')).toBe(true);

    const events = JSON.parse(fs.readFileSync(path.join(storageDir, 'events.json'), 'utf8'));
    const recorded = events.entries.map((x) => x.record);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((e) => e.type === 'error' && e.payload.reason === 'config_invalid')).toBe(true);
    // nothing but the Event_Log was created: no snapshots, no incidents
    expect(fs.existsSync(path.join(storageDir, 'snapshots.json'))).toBe(false);
    expect(fs.existsSync(path.join(storageDir, 'incidents.json'))).toBe(false);
  });

  it('rejects a missing config file', async () => {
    const configDir = copyConfig();
    fs.rmSync(path.join(configDir, 'scenario-catalog.json'));
    const error = await startBackend(base(path.join(tmp('store-'), 'data'), { configDir })).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.errors.some((e) => e.code === 'missing_file' && e.source === 'scenario-catalog.json')).toBe(true);
  });

  it('rejects a scenario that targets a file outside the Approved_Files', async () => {
    const configDir = copyConfig();
    const file = path.join(configDir, 'scenario-catalog.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.scenarios[0].targetFiles = ['server.js'];
    fs.writeFileSync(file, JSON.stringify(doc));
    const error = await startBackend(base(path.join(tmp('store-'), 'data'), { configDir })).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.errors.some((e) => e.code === 'not_approved')).toBe(true);
  });

  it('rejects an invalid Dashboard origin before touching storage', async () => {
    const storageDir = path.join(tmp('store-'), 'data');
    const error = await startBackend(base(storageDir, { dashboardOrigin: 'https://example.com' })).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.errors[0].source).toBe('settings');
    expect(fs.existsSync(storageDir)).toBe(false);
  });

  it('rejects a non-loopback Test_App URL and a bad port', () => {
    expect(() => resolveSettings({ testAppUrl: 'http://example.com:4100' }, {})).toThrow(StartupError);
    expect(() => resolveSettings({ port: 70000 }, {})).toThrow(StartupError);
    expect(resolveSettings({}, {}).port).toBe(4200);
  });
});

describe('backend entry point: valid start', () => {
  it('starts in the documented order, serves the API on 127.0.0.1 and stops cleanly', async () => {
    const storageDir = path.join(tmp('store-'), 'data');
    const backend = await start(base(storageDir));

    expect(backend.startOrder).toEqual([
      'settings', 'config', 'event-log', 'incident-manager-reload', 'monitor', 'scenario-engine', 'orchestrator', 'api', 'monitor-polling',
    ]);
    expect(backend.host).toBe('127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${backend.port}/api/v1/scenarios`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios.map((s) => s.id).sort()).toEqual([
      'api-failure', 'button-failure', 'component-disappearance', 'layout-corruption', 'loading-failure', 'styling-failure',
    ]);

    // the baseline Snapshot exists and is the only one: nothing was injected
    const snapshots = JSON.parse(fs.readFileSync(path.join(storageDir, 'snapshots.json'), 'utf8')).entries.map((x) => x.record);
    expect(snapshots.filter((s) => s.reason === 'baseline')).toHaveLength(1);

    const port = backend.port;
    await backend.close();
    running.pop();
    expect(await portIsFree(port)).toBe(true);
  });

  it('reloads Incidents on restart: one left in `repairing` is flagged and blocks injection (6.9)', async () => {
    const storageDir = path.join(tmp('store-'), 'data');
    const first = await start(base(storageDir));
    await first.close();
    running.pop();

    // a persisted Incident that was mid-repair when the process stopped
    const now = new Date().toISOString();
    const incident = {
      incidentId: 'inc-restart-1', state: 'repairing', detectedAt: now, component: 'button', evidenceRefs: [], plans: [],
      gateDecisions: [], attempts: [], attemptCount: 0, needsRollbackVerification: false, updatedAt: now,
    };
    const file = path.join(storageDir, 'incidents.json');
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, entries: [] };
    doc.entries.push({ key: incident.incidentId, record: incident });
    fs.writeFileSync(file, JSON.stringify(doc));

    const second = await start(base(storageDir));
    expect(second.flaggedIncidents.map((i) => i.incidentId)).toEqual(['inc-restart-1']);
    const events = await second.eventLog.readAfter(0, { types: ['error'] });
    expect(events.some((e) => e.incidentId === 'inc-restart-1' && /rollback verification required/.test(e.payload.message))).toBe(true);
  });
});
