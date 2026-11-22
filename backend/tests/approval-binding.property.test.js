// Feature: poltergeist-exorcist-healing-system, Property 16: Approval binding
// **Validates: Requirements 10.1**
//
// Uses the real Safety_Gate and Repair_Executor. All file writes happen in temporary directories.
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { evaluate } from '../src/safety-gate/index.js';
import { createRepairExecutor } from '../src/repair-executor/index.js';

const APPROVED = ['mock-api.js', 'public/button.js', 'public/button.css'];
const ALLOWLIST = [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }];
const CONFIG = { actionAllowlist: ALLOWLIST, approvedFiles: APPROVED };
const temps = [];

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-binding-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const dir = path.join(base, 'storage-data');
  fs.mkdirSync(path.join(testapp, 'public'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of APPROVED) fs.writeFileSync(path.join(testapp, ...f.split('/')), `original ${f}\n`);
  const fileGuard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [dir] });
  const storage = createJsonStore({ directory: dir });
  const snapshotService = createSnapshotService({ testappDir: testapp, approvedFiles: APPROVED, storageDir: dir, storage, fileGuard });
  const eventLog = createEventLog({ storage });
  const executor = createRepairExecutor({ testappDir: testapp, approvedFiles: APPROVED, snapshotService, fileGuard, eventLog });
  return { testapp, executor, snapshotService, eventLog };
}

const snapshotFiles = (testapp) =>
  Object.fromEntries(APPROVED.map((f) => [f, fs.readFileSync(path.join(testapp, ...f.split('/')), 'utf8')]));

const word = fc.stringMatching(/^[a-z]{1,12}$/);
const planArb = fc.record({
  incidentId: fc.stringMatching(/^inc-[0-9]{1,6}$/),
  actionType: fc.constant('replace_text'),
  targetFile: fc.constant('public/button.js'),
  change: fc.record({ find: fc.constant('original'), replace: word }),
  rationale: word,
});

const approveOrFail = (p) => {
  const d = evaluate(p, CONFIG);
  expect(d.approved).toBe(true);
  return d.approval;
};

// Each mutation yields a plan whose content differs from the input.
const MUTATIONS = [
  (p, s) => ({ ...p, change: { ...p.change, replace: p.change.replace + s } }),
  (p, s) => ({ ...p, rationale: p.rationale + s }),
  (p, s) => ({ ...p, incidentId: p.incidentId + s }),
  (p) => ({ ...p, targetFile: 'public/button.css' }),
  (p) => ({ ...p, actionType: 'replace_text_x' }),
  (p, s) => ({ ...p, extra: s }),
  (p) => ({ ...p, change: { find: p.change.find } }),
];

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const RUNS = { numRuns: 30 };

describe('Property 16: Approval binding', () => {
  it('accepts a plan carrying the approval issued for exactly that content, and writes only its target', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (p) => {
        const { testapp, executor } = setup();
        const result = await executor.apply(p, approveOrFail(p));
        const files = snapshotFiles(testapp);
        expect(result.target).toBe('public/button.js');
        expect(files['public/button.js']).toBe(`${p.change.replace} public/button.js\n`);
        expect(files['mock-api.js']).toBe('original mock-api.js\n');
        expect(files['public/button.css']).toBe('original public/button.css\n');
      }),
      RUNS,
    );
  });

  it('rejects any modification of the plan after approval and writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, fc.integer({ min: 0, max: MUTATIONS.length - 1 }), word, async (p, which, suffix) => {
        const { testapp, executor, snapshotService, eventLog } = setup();
        const approval = approveOrFail(p);
        const before = snapshotFiles(testapp);
        const modified = MUTATIONS[which](p, suffix);
        await expect(executor.apply(modified, approval)).rejects.toMatchObject({ code: 'approval_invalid' });
        expect(snapshotFiles(testapp)).toEqual(before);
        expect(await snapshotService.list()).toEqual([]);
        expect(await eventLog.readAfter(0, { types: ['repair'] })).toHaveLength(0);
      }),
      RUNS,
    );
  });

  it('rejects an approval issued for a different plan and writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, planArb, async (p1, p2) => {
        fc.pre(JSON.stringify(p1) !== JSON.stringify(p2));
        const { testapp, executor, snapshotService } = setup();
        const tokenForOther = approveOrFail(p1);
        const before = snapshotFiles(testapp);
        await expect(executor.apply(p2, tokenForOther)).rejects.toMatchObject({ code: 'approval_invalid' });
        expect(snapshotFiles(testapp)).toEqual(before);
        expect(await snapshotService.list()).toEqual([]);
      }),
      RUNS,
    );
  });

  it('rejects a missing or forged approval and writes nothing', async () => {
    const forgedArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}),
      fc.string(),
      fc.record({ token: fc.stringMatching(/^[0-9a-f]{64}$/), planHash: fc.stringMatching(/^[0-9a-f]{64}$/) }),
      fc.record({ token: fc.constant('') , planHash: fc.constant('') }),
      fc.record({ token: fc.integer(), planHash: fc.integer() }),
    );
    await fc.assert(
      fc.asyncProperty(planArb, forgedArb, fc.boolean(), async (p, forged, useRealHash) => {
        const { testapp, executor, snapshotService } = setup();
        const real = approveOrFail(p);
        // A forged token may even carry the correct plan hash.
        const approval = useRealHash && forged && typeof forged === 'object' && 'token' in forged ? { ...forged, planHash: real.planHash } : forged;
        const before = snapshotFiles(testapp);
        await expect(executor.apply(p, approval)).rejects.toMatchObject({ code: 'approval_invalid' });
        expect(snapshotFiles(testapp)).toEqual(before);
        expect(await snapshotService.list()).toEqual([]);
      }),
      RUNS,
    );
  });
});
