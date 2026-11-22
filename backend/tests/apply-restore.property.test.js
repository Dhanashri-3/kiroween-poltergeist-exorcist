// Feature: poltergeist-exorcist-healing-system, Property 17: Apply and restore round trip
// **Validates: Requirements 10.8, 12.3**
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

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const text = fc.string({ maxLength: 60 });
// Target content with a non-empty substring that is guaranteed to be present.
const targetArb = fc
  .tuple(text, fc.string({ minLength: 1, maxLength: 12 }), text)
  .map(([head, find, tail]) => ({ content: head + find + tail, find }));

describe('Property 17: Apply and restore round trip', () => {
  it('apply then restore returns every Approved_File to its pre-change checksum', async () => {
    await fc.assert(
      fc.asyncProperty(targetArb, text, text, text, async (target, replace, otherA, otherB) => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p17-')));
        temps.push(base);
        const testapp = path.join(base, 'testapp');
        const dir = path.join(base, 'storage-data');
        fs.mkdirSync(path.join(testapp, 'public'), { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
        const contents = { 'mock-api.js': otherA, 'public/button.js': target.content, 'public/button.css': otherB };
        for (const f of APPROVED) fs.writeFileSync(path.join(testapp, ...f.split('/')), contents[f], 'utf8');
        const onDisk = () =>
          Object.fromEntries(APPROVED.map((f) => [f, sha(fs.readFileSync(path.join(testapp, ...f.split('/'))))]));

        const fileGuard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [dir] });
        const storage = createJsonStore({ directory: dir });
        const snapshotService = createSnapshotService({ testappDir: testapp, approvedFiles: APPROVED, storageDir: dir, storage, fileGuard });
        const eventLog = createEventLog({ storage });
        const executor = createRepairExecutor({ testappDir: testapp, approvedFiles: APPROVED, snapshotService, fileGuard, eventLog });

        const plan = {
          incidentId: 'inc-1',
          actionType: 'replace_text',
          targetFile: 'public/button.js',
          change: { find: target.find, replace },
          rationale: 'property test',
        };
        const decision = evaluate(plan, { actionAllowlist: ALLOWLIST, approvedFiles: APPROVED });
        if (!decision.approved) return; // Only approved plans are in scope.

        const pre = onDisk();
        const result = await executor.apply(plan, decision.approval);
        expect(result.preChecksum).toBe(pre['public/button.js']);
        expect(result.postChecksum).toBe(onDisk()['public/button.js']);

        const restored = await executor.restore(result.snapshotId);
        expect(restored.matches).toBe(true);
        expect(onDisk()).toEqual(pre);
        // The Snapshot's recorded checksums equal the restored checksums.
        for (const { path: p, checksum } of result.snapshotChecksums) expect(checksum).toBe(pre[p]);
      }),
      { numRuns: 25 },
    );
  }, 60000);
});
