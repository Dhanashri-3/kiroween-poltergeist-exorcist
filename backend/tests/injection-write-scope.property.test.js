// Feature: poltergeist-exorcist-healing-system, Property 3: Write scope and snapshot-first
// (injection and rollback operations; repair operations are covered by repair-write-scope.property.test.js)
// **Validates: Requirements 3.1, 3.2, 3.5, 17.1, 17.4, 17.7**
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { createScenarioEngine } from '../src/scenario-engine/index.js';

const APPROVED = ['a.js', 'b.js', 'c.js'];
const temps = [];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const abs = (testapp, f) => path.join(testapp, ...f.split('/'));

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

// Lowercase filler never contains the uppercase markers, so every find text is present exactly where expected.
const filler = fc.stringMatching(/^[a-z0-9 ]{0,30}$/);
const contentsArb = fc.tuple(filler, filler, filler).map(([a, b, c]) => ({
  'a.js': `${a}MARK${b}`,
  'b.js': `${b}MARK${c}`,
  'c.js': `${c}MARK${a}`,
}));
const targetsArb = fc.subarray(APPROVED, { minLength: 1, maxLength: 3 });

const stepsFor = (files, find, replace) => files.map((file) => ({ file, find, replace }));
const scenarioFor = (files) => ({
  scenarioId: 'prop-scenario',
  targetComponent: 'button',
  targetFiles: files,
  injection: { type: 'replace_text', steps: stepsFor(files, 'MARK', 'BAD') },
  reversal: { type: 'replace_text', steps: stepsFor(files, 'BAD', 'MARK') },
});

function fixture(contents, scenario, { wrapGuard } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3i-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const dir = path.join(base, 'storage-data');
  fs.mkdirSync(testapp, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(contents)) fs.writeFileSync(abs(testapp, f), c, 'utf8');
  fs.writeFileSync(abs(testapp, 'extra.txt'), 'not approved', 'utf8');

  const realGuard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [dir] });
  const storage = createJsonStore({ directory: dir });
  const realSnapshots = createSnapshotService({ testappDir: testapp, approvedFiles: APPROVED, storageDir: dir, storage, fileGuard: realGuard });
  const order = [];
  const snapshotService = {
    ...realSnapshots,
    create: async (...a) => {
      const r = await realSnapshots.create(...a);
      order.push('snapshot');
      return r;
    },
  };
  const engineGuard = {
    assertWritable: (p, caller) => {
      const d = wrapGuard ? wrapGuard(realGuard).assertWritable(p, caller) : realGuard.assertWritable(p, caller);
      if (caller === 'scenario-engine') order.push(`write:${path.relative(testapp, p).split(path.sep).join('/')}`);
      return d;
    },
  };
  const eventLog = createEventLog({ storage });
  const engine = createScenarioEngine({
    catalog: { get: () => scenario },
    testappDir: testapp,
    snapshotService,
    fileGuard: engineGuard,
    eventLog,
    storage,
  });
  const onDisk = () => Object.fromEntries(APPROVED.map((f) => [f, sha(fs.readFileSync(abs(testapp, f)))]));
  return { engine, realGuard, realSnapshots, eventLog, order, onDisk, testapp, dir };
}

describe('Property 3: Write scope and snapshot-first (injection and rollback)', () => {
  it('snapshots all Approved_Files first and injection and reversal write only the scenario files', async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, targetsArb, async (contents, files) => {
        const t = fixture(contents, scenarioFor(files));
        const pre = t.onDisk();

        const rec = await t.engine.inject('prop-scenario', 'run-1');
        const snap = await t.realSnapshots.get(rec.snapshotId);
        expect(snap.files.map((f) => f.path)).toEqual(APPROVED);
        for (const f of snap.files) expect(f.checksum).toBe(pre[f.path]);
        // The Snapshot precedes every write, and writes are authorised only for the scenario files.
        expect(t.order).toEqual(['snapshot', ...files.map((f) => `write:${f}`)]);

        const post = t.onDisk();
        for (const f of APPROVED) {
          if (files.includes(f)) expect(post[f]).not.toBe(pre[f]);
          else expect(post[f]).toBe(pre[f]);
        }

        // Rollback (reversal) writes only the same designated files and restores the checksums.
        t.order.length = 0;
        await t.engine.reverse('prop-scenario');
        expect(t.order).toEqual(files.map((f) => `write:${f}`));
        expect(t.onDisk()).toEqual(pre);
      }),
      { numRuns: 25 },
    );
  }, 90000);

  it('reset (rollback to baseline) restores every Approved_File checksum', async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, targetsArb, async (contents, files) => {
        const t = fixture(contents, scenarioFor(files));
        const pre = t.onDisk();
        await t.engine.captureBaseline();
        await t.engine.inject('prop-scenario', 'run-1');
        await t.engine.reset();
        expect(t.onDisk()).toEqual(pre);
      }),
      { numRuns: 15 },
    );
  }, 90000);

  it('denies paths that are not Approved_Files, with a security Event, and changes nothing', async () => {
    // 'extra.txt' exists in the Test_App but is not an Approved_File.
    await fc.assert(
      fc.asyncProperty(contentsArb, fc.subarray(APPROVED, { maxLength: 2 }), async (contents, approvedPart) => {
        const files = [...approvedPart, 'extra.txt'];
        const scenario = {
          ...scenarioFor(files),
          injection: {
            type: 'replace_text',
            steps: [...stepsFor(approvedPart, 'MARK', 'BAD'), { file: 'extra.txt', find: 'not', replace: 'now' }],
          },
        };
        const t = fixture(contents, scenario);
        const pre = t.onDisk();
        const extraBefore = fs.readFileSync(abs(t.testapp, 'extra.txt'), 'utf8');

        await expect(t.engine.inject('prop-scenario', 'run-1')).rejects.toMatchObject({ code: 'injection_failed', restored: true });
        expect(t.onDisk()).toEqual(pre);
        expect(fs.readFileSync(abs(t.testapp, 'extra.txt'), 'utf8')).toBe(extraBefore);
        // No engine write was authorised: the guard denied the whole plan before any write.
        const events = await t.eventLog.readAfter(0);
        const security = events.filter((e) => e.type === 'security');
        expect(security).toHaveLength(1);
        expect(security[0].payload).toMatchObject({ action: 'write_denied', code: 'not_approved' });
        expect(events.some((e) => e.type === 'chaos.injection')).toBe(false);
      }),
      { numRuns: 15 },
    );
  }, 90000);

  it('File_Guard denies any requested path outside Approved_Files and storage with a security Event', async () => {
    const outside = fc.oneof(
      fc.constantFrom('extra.txt', 'package.json', '.env', '../outside.txt', 'sub/other.js', 'a.js/../../escape.js', '.git/config', 'node_modules/x.js'),
      fc.stringMatching(/^[a-z]{1,8}\.(js|css|txt)$/).filter((n) => !APPROVED.includes(n)),
    );
    await fc.assert(
      fc.asyncProperty(contentsArb, outside, async (contents, rel) => {
        const t = fixture(contents, scenarioFor(['a.js']));
        const decision = t.realGuard.assertWritable(path.join(t.testapp, ...rel.split('/')), 'scenario-engine');
        expect(decision.allowed).toBe(false);
        expect(decision.event.type).toBe('security');
        expect(decision.event.payload.action).toBe('write_denied');
      }),
      { numRuns: 40 },
    );
  }, 90000);

  it('a step outside the scenario designated files writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, async (contents) => {
        const scenario = { ...scenarioFor(['a.js']), injection: { type: 'replace_text', steps: stepsFor(['a.js', 'b.js'], 'MARK', 'BAD') } };
        const t = fixture(contents, scenario);
        const pre = t.onDisk();
        await expect(t.engine.inject('prop-scenario', 'run-1')).rejects.toMatchObject({ code: 'injection_failed', restored: true });
        expect(t.order.filter((o) => o.startsWith('write:'))).toEqual([]);
        expect(t.onDisk()).toEqual(pre);
      }),
      { numRuns: 15 },
    );
  }, 90000);

  it('restores every Approved_File to its pre-operation checksum when injection fails partway', async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, fc.constantFrom(1, 2, 3), async (contents, failAt) => {
        let writes = 0;
        const wrapGuard = (guard) => ({
          assertWritable: (p, caller) => {
            if (caller === 'scenario-engine') {
              writes += 1;
              if (writes === failAt) return guard.assertWritable(path.join(path.dirname(p), 'extra.txt'), caller);
            }
            return guard.assertWritable(p, caller);
          },
        });
        const t = fixture(contents, scenarioFor(APPROVED), { wrapGuard });
        const pre = t.onDisk();
        await expect(t.engine.inject('prop-scenario', 'run-1')).rejects.toMatchObject({ code: 'injection_failed', restored: true });
        expect(t.order[0]).toBe('snapshot');
        expect(t.onDisk()).toEqual(pre);
        const events = await t.eventLog.readAfter(0);
        expect(events.some((e) => e.type === 'security')).toBe(true);
      }),
      { numRuns: 15 },
    );
  }, 90000);

  it('restores written files when a write fails partway during rollback (reversal)', async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, fc.constantFrom(2, 3), async (contents, failAt) => {
        const t = fixture(contents, scenarioFor(APPROVED));
        await t.engine.inject('prop-scenario', 'run-1');
        const injected = t.onDisk();
        const realWrite = fs.writeFileSync;
        let calls = 0;
        fs.writeFileSync = (...args) => {
          if (String(args[0]).startsWith(t.testapp)) {
            calls += 1;
            if (calls === failAt) throw new Error('disk full');
          }
          return realWrite(...args);
        };
        try {
          await expect(t.engine.reverse('prop-scenario')).rejects.toMatchObject({ code: 'reversal_failed' });
        } finally {
          fs.writeFileSync = realWrite;
        }
        // The failed reversal leaves the Approved_Files exactly as they were before it started.
        expect(t.onDisk()).toEqual(injected);
      }),
      { numRuns: 10 },
    );
  }, 90000);
});
