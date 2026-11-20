// Task 4.3: injection, reversal and reset (Requirements 3.1-3.8). Uses a real copy of the Test_App,
// the real File_Guard, Snapshot service, JSON store and Event_Log.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { loadScenarioCatalog, createScenarioEngine, UnknownScenarioError, ScenarioEngineError } from '../src/scenario-engine/index.js';
import { DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR } from '../src/orchestrator/config-loader.js';

const temps = [];
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

async function setup({ guard } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-')));
  temps.push(base);
  const testappDir = path.join(base, 'testapp');
  const storageDir = path.join(base, 'storage-data');
  fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.mkdirSync(storageDir, { recursive: true });
  const approvedFiles = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'approved-files.json'), 'utf8')).files;
  const fileGuard = guard ?? createFileGuard({ testappDir, approvedFiles, storageDirs: [storageDir] });
  const storage = createJsonStore({ directory: storageDir });
  const snapshotService = createSnapshotService({ testappDir, approvedFiles, storageDir, storage, fileGuard });
  const eventLog = createEventLog({ storage });
  const catalog = await loadScenarioCatalog();
  const engine = createScenarioEngine({ catalog, testappDir, snapshotService, fileGuard, eventLog, storage });
  const events = async () => eventLog.readAfter(0);
  const sums = () => snapshotService.currentChecksums();
  return { engine, events, sums, testappDir, storage, snapshotService, catalog, approvedFiles, storageDir, eventLog };
}

describe('Scenario_Engine', () => {
  it('snapshots first, modifies only the scenario files and records chaos.injection', async () => {
    const t = await setup();
    const before = t.sums();
    const rec = await t.engine.inject('button-failure', 'run-1');
    const after = t.sums();

    const changed = after.filter((c, i) => c.checksum !== before[i].checksum).map((c) => c.path);
    expect(changed).toEqual(['public/button.js']);
    expect(fs.readFileSync(path.join(t.testappDir, 'public', 'button.js'), 'utf8')).toContain('count = count;');

    const snap = await t.snapshotService.get(rec.snapshotId);
    expect(snap.reason).toBe('injection');
    expect(snap.files).toHaveLength(t.approvedFiles.length);
    expect(snap.files.map((f) => f.checksum)).toEqual(before.map((c) => c.checksum));

    const [ev] = (await t.events()).filter((e) => e.type === 'chaos.injection');
    expect(ev.runId).toBe('run-1');
    expect(ev.payload).toMatchObject({
      scenarioId: 'button-failure',
      targetComponent: 'button',
      files: ['public/button.js'],
      snapshotId: rec.snapshotId,
    });
    expect(ev.payload.preChecksums).toEqual([before.find((c) => c.path === 'public/button.js')]);
    expect(ev.payload.postChecksums).toEqual([after.find((c) => c.path === 'public/button.js')]);
    expect(ev.payload.timestamp).toEqual(expect.any(String));
  });

  it('round trip: inject then reverse restores baseline checksums for every scenario', async () => {
    const t = await setup();
    const baseline = t.sums();
    for (const id of t.catalog.ids) {
      await t.engine.inject(id, `run-${id}`);
      expect(t.sums()).not.toEqual(baseline);
      await t.engine.reverse(id);
      expect(t.sums()).toEqual(baseline);
    }
  });

  it('rejects unknown scenarios with no file or event change', async () => {
    const t = await setup();
    const before = t.sums();
    await expect(t.engine.inject('nope', 'r')).rejects.toBeInstanceOf(UnknownScenarioError);
    expect(t.sums()).toEqual(before);
    expect(await t.events()).toEqual([]);
  });

  it('rejects injection while an Incident is non-terminal and records chaos.rejected', async () => {
    const t = await setup();
    await t.storage.put('incidents', 'inc-1', { incidentId: 'inc-1', state: 'repairing' });
    const before = t.sums();
    await expect(t.engine.inject('api-failure', 'r2')).rejects.toMatchObject({ code: 'incident_active' });
    expect(t.sums()).toEqual(before);
    expect((await t.snapshotService.list())).toEqual([]);
    const evs = await t.events();
    expect(evs.map((e) => e.type)).toEqual(['chaos.rejected']);

    // rolled_back is transient (Requirement 6.3), so injection is still rejected.
    await t.storage.put('incidents', 'inc-1', { incidentId: 'inc-1', state: 'rolled_back' });
    await expect(t.engine.inject('api-failure', 'r2b')).rejects.toMatchObject({ code: 'incident_active' });
    expect((await t.events()).filter((e) => e.type === 'chaos.rejected')).toHaveLength(2);

    await t.storage.put('incidents', 'inc-1', { incidentId: 'inc-1', state: 'escalated' });
    await expect(t.engine.inject('api-failure', 'r2c')).resolves.toMatchObject({ scenarioId: 'api-failure' });
    await t.engine.reverse('api-failure');

    await t.storage.put('incidents', 'inc-1', { incidentId: 'inc-1', state: 'recovered' });
    await expect(t.engine.inject('api-failure', 'r3')).resolves.toMatchObject({ scenarioId: 'api-failure' });
  });

  it('restores the Snapshot and records an error Event when injection fails midway', async () => {
    // Guard denies the second file written; use a scenario with two steps on two files via a custom catalog.
    const t = await setup();
    const scenario = {
      ...t.catalog.get('button-failure'),
      scenarioId: 'two-files',
      targetFiles: ['public/button.js', 'public/button.css'],
      injection: {
        type: 'replace_text',
        steps: [
          { file: 'public/button.js', find: 'count = nextCount(count);', replace: 'count = count;' },
          { file: 'public/button.css', find: '#test-button {', replace: '#test-btn {' },
        ],
      },
    };
    const realGuard = createFileGuard({ testappDir: t.testappDir, approvedFiles: t.approvedFiles, storageDirs: [t.storageDir] });
    let engineWrites = 0;
    const flaky = {
      assertWritable: (p, caller) => {
        if (caller === 'scenario-engine') {
          engineWrites += 1;
          if (engineWrites === 2) return { allowed: false, code: 'forced', reason: 'forced', caller, requestedPath: p, resolvedPath: null, detectedAt: new Date().toISOString() };
        }
        return realGuard.assertWritable(p, caller);
      },
    };
    const approvedFiles = t.approvedFiles;
    const snapshotService = createSnapshotService({ testappDir: t.testappDir, approvedFiles, storageDir: t.storageDir, storage: t.storage, fileGuard: realGuard });
    const catalog = { get: () => scenario };
    const engine = createScenarioEngine({ catalog, testappDir: t.testappDir, snapshotService, fileGuard: flaky, eventLog: t.eventLog, storage: t.storage });
    const before = t.sums();
    await expect(engine.inject('two-files', 'r')).rejects.toMatchObject({ code: 'injection_failed', restored: true, cause: { code: 'write_denied' } });
    expect(t.sums()).toEqual(before);
    expect((await t.events()).filter((e) => e.type === 'error')[0].payload).toMatchObject({ reason: 'injection_failed', scenarioId: 'two-files' });
  });

  it('restores files written before a mid-write failure', async () => {
    const t = await setup();
    const before = t.sums();
    const realWrite = fs.writeFileSync;
    let calls = 0;
    const scenario = {
      ...t.catalog.get('button-failure'),
      targetFiles: ['public/button.js', 'public/button.css'],
      injection: {
        type: 'replace_text',
        steps: [
          { file: 'public/button.js', find: 'count = nextCount(count);', replace: 'count = count;' },
          { file: 'public/button.css', find: '#test-button {', replace: '#test-btn {' },
        ],
      },
    };
    const engine = createScenarioEngine({
      catalog: { get: () => scenario }, testappDir: t.testappDir, snapshotService: t.snapshotService,
      fileGuard: createFileGuard({ testappDir: t.testappDir, approvedFiles: t.approvedFiles, storageDirs: [t.storageDir] }),
      eventLog: t.eventLog, storage: t.storage,
    });
    fs.writeFileSync = (...args) => {
      if (String(args[0]).includes('testapp') && args[2] === 'utf8') {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
      }
      return realWrite(...args);
    };
    try {
      await expect(engine.inject('x', 'r')).rejects.toMatchObject({ code: 'injection_failed', restored: true });
    } finally {
      fs.writeFileSync = realWrite;
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(t.sums()).toEqual(before);
    const err = (await t.events()).find((e) => e.type === 'error');
    expect(err.payload).toMatchObject({ reason: 'injection_failed', restored: true, message: 'disk full' });
  });

  it('reset restores the baseline and records a reset Event', async () => {
    const t = await setup();
    const baseline = t.sums();
    await t.engine.captureBaseline();
    await t.engine.inject('layout-corruption', 'r');
    await t.engine.inject('api-failure', 'r');
    expect(t.sums()).not.toEqual(baseline);
    const res = await t.engine.reset();
    expect(t.sums()).toEqual(baseline);
    expect(res.checksums).toEqual(baseline);
    expect((await t.events()).filter((e) => e.type === 'reset')).toHaveLength(1);
  });

  it('reset without a baseline fails with an error Event and changes nothing', async () => {
    const t = await setup();
    await expect(t.engine.reset()).rejects.toMatchObject({ code: 'no_baseline' });
    expect((await t.events()).map((e) => e.type)).toEqual(['error']);
  });

  it('does not import the Monitor, Exorcist or Incident_Manager', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/scenario-engine/scenario-engine.js'), 'utf8');
    const specs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const s of specs) expect(s).not.toMatch(/monitor|exorcist|incident|poltergeist/);
    expect(ScenarioEngineError).toBeDefined();
  });
});
