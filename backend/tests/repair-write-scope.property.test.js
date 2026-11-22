// Feature: poltergeist-exorcist-healing-system, Property 3: Write scope and snapshot-first
// **Validates: Requirements 10.2, 10.3, 10.7, 17.1, 17.7**
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
import { evaluate } from '../src/safety-gate/index.js';
import { createRepairExecutor } from '../src/repair-executor/index.js';

const APPROVED = ['mock-api.js', 'public/button.js', 'public/button.css'];
const ALLOWLIST = [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }];
const temps = [];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const abs = (testapp, f) => path.join(testapp, ...f.split('/'));

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const text = fc.string({ maxLength: 60 });
const targetArb = fc
  .tuple(text, fc.string({ minLength: 1, maxLength: 12 }), text)
  .map(([head, find, tail]) => ({ content: head + find + tail, find }));

function build({ testapp, dir, wrapGuard }) {
  const realGuard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [dir] });
  const fileGuard = wrapGuard ? wrapGuard(realGuard) : realGuard;
  const storage = createJsonStore({ directory: dir });
  const realSnapshots = createSnapshotService({ testappDir: testapp, approvedFiles: APPROVED, storageDir: dir, storage, fileGuard });
  const order = [];
  const snapshotService = {
    ...realSnapshots,
    create: async (...a) => {
      const r = await realSnapshots.create(...a);
      order.push('snapshot');
      return r;
    },
  };
  const guardSpy = {
    assertWritable: (p, caller) => {
      const d = fileGuard.assertWritable(p, caller);
      if (caller === 'repair-executor') order.push(`write:${path.relative(testapp, p).split(path.sep).join('/')}`);
      return d;
    },
  };
  const eventLog = createEventLog({ storage });
  const executor = createRepairExecutor({ testappDir: testapp, approvedFiles: APPROVED, snapshotService, fileGuard: guardSpy, eventLog });
  return { executor, realGuard, realSnapshots, order };
}

function fixture(target, otherA, otherB) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const dir = path.join(base, 'storage-data');
  fs.mkdirSync(path.join(testapp, 'public'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const contents = { 'mock-api.js': otherA, 'public/button.js': target.content, 'public/button.css': otherB };
  for (const f of APPROVED) fs.writeFileSync(abs(testapp, f), contents[f], 'utf8');
  const onDisk = () => Object.fromEntries(APPROVED.map((f) => [f, sha(fs.readFileSync(abs(testapp, f)))]));
  return { base, testapp, dir, onDisk };
}

const mkPlan = (target, replace) => ({
  incidentId: 'inc-1',
  actionType: 'replace_text',
  targetFile: 'public/button.js',
  change: { find: target.find, replace },
  rationale: 'property test',
});

describe('Property 3: Write scope and snapshot-first', () => {
  it('snapshots all Approved_Files first and writes only the single plan target', async () => {
    await fc.assert(
      fc.asyncProperty(targetArb, text, text, text, async (target, replace, otherA, otherB) => {
        const { testapp, dir, onDisk } = fixture(target, otherA, otherB);
        const { executor, realSnapshots, order } = build({ testapp, dir });
        const plan = mkPlan(target, replace);
        const decision = evaluate(plan, { actionAllowlist: ALLOWLIST, approvedFiles: APPROVED });
        if (!decision.approved) return;

        const pre = onDisk();
        const result = await executor.apply(plan, decision.approval);

        // Snapshot of every Approved_File exists and holds the pre-operation checksums.
        const snap = await realSnapshots.get(result.snapshotId);
        expect(snap.files.map((f) => f.path)).toEqual(APPROVED);
        for (const f of snap.files) expect(f.checksum).toBe(pre[f.path]);
        // The Snapshot was created before the (only) write authorisation.
        expect(order).toEqual(['snapshot', 'write:public/button.js']);

        // Only the target file may differ.
        const post = onDisk();
        expect(post['mock-api.js']).toBe(pre['mock-api.js']);
        expect(post['public/button.css']).toBe(pre['public/button.css']);
        expect(post['public/button.js']).toBe(result.postChecksum);
      }),
      { numRuns: 25 },
    );
  }, 60000);

  it('restores every Approved_File to its pre-operation checksum when a failure occurs partway', async () => {
    const mode = fc.constantFrom('find_missing', 'write_failed_after_other_files_corrupted');
    await fc.assert(
      fc.asyncProperty(targetArb, text, text, text, mode, async (target, replace, otherA, otherB, failure) => {
        const { testapp, dir, onDisk } = fixture(target, otherA, otherB);
        let armed = false;
        const wrapGuard = (guard) => ({
          assertWritable: (p, caller) => {
            if (armed && caller === 'repair-executor') {
              // Simulate a real partial write: damage other Approved_Files, then point the write at an unwritable path.
              fs.writeFileSync(abs(testapp, 'mock-api.js'), 'CORRUPTED', 'utf8');
              fs.writeFileSync(abs(testapp, 'public/button.css'), 'CORRUPTED', 'utf8');
              return { allowed: true, realPath: path.join(testapp, 'no-such-dir', 'x.js') };
            }
            return guard.assertWritable(p, caller);
          },
        });
        const { executor, order } = build({ testapp, dir, wrapGuard });
        const plan = mkPlan(target, replace);
        if (failure === 'find_missing') plan.change.find = `${target.find}\u0000absent`;
        else armed = true;
        const decision = evaluate(plan, { actionAllowlist: ALLOWLIST, approvedFiles: APPROVED });
        if (!decision.approved) return;

        const pre = onDisk();
        await expect(executor.apply(plan, decision.approval)).rejects.toMatchObject({
          code: failure === 'find_missing' ? 'find_not_present' : 'write_failed',
          restored: true,
        });
        armed = false;
        expect(order[0]).toBe('snapshot');
        expect(onDisk()).toEqual(pre);
      }),
      { numRuns: 25 },
    );
  }, 60000);

  it('denies writes to any path outside the Approved_Files via the File_Guard', async () => {
    const outside = fc.oneof(
      fc.constantFrom('package.json', '.env', '../outside.txt', 'public/other.js', 'public/../../escape.js', '.git/config'),
      fc.stringMatching(/^[a-z]{1,8}\.(js|css|txt)$/).filter((n) => !APPROVED.includes(n)),
    );
    await fc.assert(
      fc.asyncProperty(outside, async (rel) => {
        const { testapp, dir } = fixture({ content: 'x', find: 'x' }, 'a', 'b');
        const { realGuard } = build({ testapp, dir });
        const decision = realGuard.assertWritable(path.join(testapp, ...rel.split('/')), 'repair-executor');
        expect(decision.allowed).toBe(false);
      }),
      { numRuns: 40 },
    );
  }, 60000);
});
