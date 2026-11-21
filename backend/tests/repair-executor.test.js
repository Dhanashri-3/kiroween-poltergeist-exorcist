import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog } from '../src/events/event-log.js';
import { evaluate } from '../src/safety-gate/index.js';
import * as executorModule from '../src/repair-executor/index.js';

const { createRepairExecutor } = executorModule;
const APPROVED = ['mock-api.js', 'public/button.js', 'public/button.css'];
const ALLOWLIST = [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }];
const temps = [];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function setup({ guardApproved = APPROVED, eventLog: customLog } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const dir = path.join(base, 'storage-data');
  fs.mkdirSync(path.join(testapp, 'public'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of APPROVED) fs.writeFileSync(path.join(testapp, ...f.split('/')), `original ${f}\n`);
  const fileGuard = createFileGuard({ testappDir: testapp, approvedFiles: guardApproved, storageDirs: [dir] });
  const storage = createJsonStore({ directory: dir });
  const snapshotService = createSnapshotService({ testappDir: testapp, approvedFiles: APPROVED, storageDir: dir, storage, fileGuard });
  const eventLog = customLog ?? createEventLog({ storage });
  const executor = createRepairExecutor({ testappDir: testapp, approvedFiles: APPROVED, snapshotService, fileGuard, eventLog });
  return { testapp, executor, snapshotService, eventLog, storage };
}

const plan = (over = {}) => ({
  incidentId: 'inc-1',
  actionType: 'replace_text',
  targetFile: 'public/button.js',
  change: { find: 'original', replace: 'fixed' },
  rationale: 'restore button text',
  ...over,
});
const approve = (p) => {
  const d = evaluate(p, { actionAllowlist: ALLOWLIST, approvedFiles: APPROVED });
  expect(d.approved).toBe(true);
  return d.approval;
};
const read = (testapp, rel) => fs.readFileSync(path.join(testapp, ...rel.split('/')), 'utf8');

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

describe('Repair_Executor', () => {
  it('applies an approved plan, snapshots first and records a repair Event', async () => {
    const { testapp, executor, eventLog, snapshotService } = setup();
    const p = plan();
    const before = read(testapp, 'public/button.js');
    const result = await executor.apply(p, approve(p));

    expect(read(testapp, 'public/button.js')).toBe('fixed public/button.js\n');
    expect(read(testapp, 'mock-api.js')).toBe('original mock-api.js\n');
    expect(result.preChecksum).toBe(sha(before));
    expect(result.postChecksum).toBe(sha('fixed public/button.js\n'));
    const snap = await snapshotService.get(result.snapshotId);
    expect(snap.reason).toBe('repair');
    expect(snap.files.map((f) => f.path)).toEqual(APPROVED);

    const events = await eventLog.readAfter(0, { types: ['repair'] });
    expect(events).toHaveLength(1);
    expect(events[0].incidentId).toBe('inc-1');
    expect(events[0].payload).toMatchObject({
      target: 'public/button.js',
      snapshotId: result.snapshotId,
      preChecksum: result.preChecksum,
      postChecksum: result.postChecksum,
    });
  });

  it('rejects a plan modified after approval, writes nothing and creates no Snapshot', async () => {
    const { testapp, executor, snapshotService, eventLog } = setup();
    const p = plan();
    const approval = approve(p);
    await expect(executor.apply(plan({ change: { find: 'original', replace: 'evil' } }), approval)).rejects.toMatchObject({ code: 'approval_invalid' });
    await expect(executor.apply(p, null)).rejects.toMatchObject({ code: 'approval_invalid' });
    await expect(executor.apply(p, { ...approval, token: '00'.repeat(32) })).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(read(testapp, 'public/button.js')).toBe('original public/button.js\n');
    expect(await snapshotService.list()).toEqual([]);
    expect((await eventLog.readAfter(0, { types: ['repair'] })).length).toBe(0);
    expect((await eventLog.readAfter(0, { types: ['error'] })).length).toBe(3);
  });

  it('restores the Snapshot and records an error Event when the File_Guard denies the write', async () => {
    // The guard does not approve button.js, so the write is denied after the Snapshot exists.
    const { testapp, executor, eventLog, snapshotService } = setup({ guardApproved: ['mock-api.js', 'public/button.css'] });
    // Snapshot restore also needs the guard to allow every file, so the restore itself fails here;
    // the target must still be unchanged and the error recorded.
    const p = plan();
    await expect(executor.apply(p, approve(p))).rejects.toMatchObject({ code: 'write_denied' });
    expect(read(testapp, 'public/button.js')).toBe('original public/button.js\n');
    const errors = await eventLog.readAfter(0, { types: ['error'] });
    expect(errors).toHaveLength(1);
    expect(errors[0].incidentId).toBe('inc-1');
    expect(errors[0].payload.reason).toBe('write_denied');
    expect((await snapshotService.list()).length).toBe(1);
    expect((await eventLog.readAfter(0, { types: ['repair'] })).length).toBe(0);
  });

  it('records an error and leaves the file unchanged when the find text is absent', async () => {
    const { testapp, executor, eventLog } = setup();
    const p = plan({ change: { find: 'not there', replace: 'x' } });
    await expect(executor.apply(p, approve(p))).rejects.toMatchObject({ code: 'find_not_present' });
    expect(read(testapp, 'public/button.js')).toBe('original public/button.js\n');
    const errors = await eventLog.readAfter(0, { types: ['error'] });
    expect(errors[0].payload).toMatchObject({ reason: 'find_not_present', restored: true });
  });

  it('restore(snapshotId) round-trips to the pre-change checksums', async () => {
    const { testapp, executor, snapshotService } = setup();
    const pre = snapshotService.currentChecksums();
    const p = plan();
    const result = await executor.apply(p, approve(p));
    expect(snapshotService.currentChecksums()).not.toEqual(pre);
    const restored = await executor.restore(result.snapshotId);
    expect(restored.matches).toBe(true);
    expect(restored.restored).toEqual(pre);
    expect(read(testapp, 'public/button.js')).toBe('original public/button.js\n');
    await expect(executor.restore('')).rejects.toMatchObject({ code: 'invalid_snapshot_id' });
  });

  it('exposes only apply and restore (no shell, no general write)', () => {
    const { executor } = setup();
    expect(Object.keys(executor).sort()).toEqual(['apply', 'restore']);
    const exportNames = Object.keys(executorModule);
    const dangerous = /^(exec|execSync|execFile|spawn|spawnSync|fork|shell|runCommand|run|system|writeFile|writeFileSync|write|writeAnywhere)$/i;
    expect(exportNames.filter((k) => dangerous.test(k))).toEqual([]);
    expect(exportNames.sort()).toEqual([
      'REPAIR_EXECUTOR_COMPONENT',
      'REPAIR_EXECUTOR_WRITE_CALLER',
      'RepairExecutorError',
      'createRepairExecutor',
    ]);
  });
});
