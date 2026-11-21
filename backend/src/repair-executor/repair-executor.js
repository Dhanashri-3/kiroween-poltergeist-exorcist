// Repair_Executor (Task 8.5, Requirements 10.1-10.5, 10.7, 10.9).
//
//   apply(plan, approval)  1. verify the approval token belongs to exactly this plan content (10.1)
//                          2. Snapshot ALL Approved_Files with checksums through the shared Snapshot service (10.2)
//                          3. write ONLY the plan's single target file, through File_Guard, caller
//                             "repair-executor" (10.3)
//                          4. record a `repair` Event: incident ID, target, Snapshot ID, pre/post checksums (10.5)
//                          If the change cannot be applied after the Snapshot exists, the Snapshot is restored
//                          and an `error` Event is recorded (10.7).
//   restore(snapshotId)    restores the Snapshot and returns the checksums read back from disk for comparison.
//
// The change is a {find, replace} pair: the first occurrence of `find` is replaced by `replace`.
// No shell, no generic write function and no path parameter is exposed (10.4): the only exported
// capabilities are apply() and restore(). Snapshots are never deleted (10.9; the Snapshot service retains them).
// This module imports neither the Scenario_Engine nor any agent module.
import fs from 'node:fs';
import path from 'node:path';
import { verifyApproval as defaultVerifyApproval } from '../safety-gate/safety-gate.js';
import { resolveApprovedFile } from '../file-guard/path-safety.js';
import { sha256Hex } from '../file-guard/snapshots/snapshot-service.js';

export const REPAIR_EXECUTOR_WRITE_CALLER = 'repair-executor';
export const REPAIR_EXECUTOR_COMPONENT = 'repair-executor';

export class RepairExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RepairExecutorError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {object} options
 * @param {string} options.testappDir
 * @param {string[]} options.approvedFiles
 * @param {{create: Function, restore: Function}} options.snapshotService shared Snapshot service
 * @param {{assertWritable: Function}} options.fileGuard
 * @param {{append: Function}} options.eventLog
 * @param {(plan: object, approval: object) => boolean} [options.verifyApproval] defaults to the Safety_Gate check
 */
export function createRepairExecutor(options = {}) {
  const { testappDir, approvedFiles, snapshotService, fileGuard, eventLog, verifyApproval = defaultVerifyApproval } = options;
  if (typeof testappDir !== 'string' || testappDir === '') throw new TypeError('testappDir must be a non-empty string');
  if (!Array.isArray(approvedFiles) || approvedFiles.length === 0) throw new TypeError('approvedFiles must be a non-empty array');
  for (const m of ['create', 'restore']) {
    if (typeof snapshotService?.[m] !== 'function') throw new TypeError(`snapshotService.${m}() is required`);
  }
  if (typeof fileGuard?.assertWritable !== 'function') throw new TypeError('fileGuard.assertWritable is required');
  if (typeof eventLog?.append !== 'function') throw new TypeError('eventLog.append is required');
  if (typeof verifyApproval !== 'function') throw new TypeError('verifyApproval must be a function');

  const approved = Object.freeze([...approvedFiles]);
  const testappRoot = path.resolve(testappDir);

  async function recordError(incidentId, payload) {
    try {
      await eventLog.append({
        type: 'error',
        component: REPAIR_EXECUTOR_COMPONENT,
        incidentId: typeof incidentId === 'string' && incidentId !== '' ? incidentId : null,
        payload,
      });
    } catch {
      // Recording the error must not mask the original failure.
    }
  }

  const fail = async (incidentId, code, message, extra = {}) => {
    await recordError(incidentId, { reason: code, message, ...extra });
    return new RepairExecutorError(code, message, extra);
  };

  function readTarget(rel) {
    const resolved = resolveApprovedFile(testappRoot, rel);
    if (!resolved.ok) throw new RepairExecutorError('read_failed', `Cannot read ${rel}: ${resolved.code}.`);
    return { real: resolved.real, data: fs.readFileSync(resolved.real) };
  }

  /**
   * @returns {Promise<{incidentId: string, target: string, snapshotId: string,
   *   preChecksum: string, postChecksum: string, snapshotChecksums: {path:string, checksum:string}[], eventId: string}>}
   */
  async function apply(plan, approval) {
    const incidentId = isObject(plan) ? plan.incidentId : null;

    // 10.1: the token must match this exact plan content.
    let valid = false;
    try {
      valid = verifyApproval(plan, approval) === true;
    } catch {
      valid = false;
    }
    if (!valid) throw await fail(incidentId, 'approval_invalid', 'Repair_Plan is not covered by a Safety_Gate approval for the same content.');

    const target = plan.targetFile;
    const change = plan.change;
    if (typeof target !== 'string' || !approved.includes(target)) {
      throw await fail(incidentId, 'target_not_approved', 'Target is not an Approved_File.');
    }
    if (!isObject(change) || typeof change.find !== 'string' || change.find === '' || typeof change.replace !== 'string') {
      throw await fail(incidentId, 'invalid_change', 'Change must be a {find, replace} pair with a non-empty find.');
    }

    // 10.2: Snapshot of all Approved_Files before anything is written.
    let snapshot;
    try {
      snapshot = await snapshotService.create('repair');
    } catch (e) {
      throw await fail(incidentId, 'snapshot_failed', `Snapshot could not be created: ${messageOf(e)}`);
    }
    const snapshotId = snapshot.snapshotId;
    const snapshotChecksums = snapshot.files.map((f) => ({ path: f.path, checksum: f.checksum }));

    let preChecksum;
    let postChecksum;
    try {
      const { data } = readTarget(target);
      preChecksum = sha256Hex(data);
      const current = data.toString('utf8');
      const at = current.indexOf(change.find);
      if (at === -1) throw new RepairExecutorError('find_not_present', `Text to replace was not found in ${target}.`);
      const next = current.slice(0, at) + change.replace + current.slice(at + change.find.length);

      // 10.3: the single target, through the File_Guard.
      const decision = fileGuard.assertWritable(path.join(testappRoot, ...target.split('/')), REPAIR_EXECUTOR_WRITE_CALLER);
      if (!decision.allowed) throw new RepairExecutorError('write_denied', `File_Guard denied the write: ${decision.code}.`);
      try {
        fs.writeFileSync(decision.realPath, next, 'utf8');
      } catch (e) {
        throw new RepairExecutorError('write_failed', `Write failed (${e?.code ?? 'error'}).`);
      }
      postChecksum = sha256Hex(readTarget(target).data);
    } catch (e) {
      // 10.7: restore the Snapshot, then record the error.
      let restored = null;
      let restoreError = null;
      try {
        restored = await snapshotService.restore(snapshotId);
      } catch (re) {
        restoreError = messageOf(re);
      }
      const code = e instanceof RepairExecutorError ? e.code : 'apply_failed';
      throw await fail(incidentId, code, messageOf(e), {
        target,
        snapshotId,
        restored: restored ? restored.matches === true : false,
        ...(restoreError ? { restoreError } : {}),
      });
    }

    // 10.5: the repair Event. If it cannot be recorded the repair is not reported as done.
    let event;
    try {
      event = await eventLog.append({
        type: 'repair',
        component: REPAIR_EXECUTOR_COMPONENT,
        incidentId,
        payload: { incidentId, target, snapshotId, preChecksum, postChecksum, snapshotChecksums },
      });
    } catch (e) {
      let restoreError = null;
      try {
        await snapshotService.restore(snapshotId);
      } catch (re) {
        restoreError = messageOf(re);
      }
      throw await fail(incidentId, 'event_failed', `repair Event could not be recorded: ${messageOf(e)}`, {
        target,
        snapshotId,
        ...(restoreError ? { restoreError } : {}),
      });
    }
    return { incidentId, target, snapshotId, preChecksum, postChecksum, snapshotChecksums, eventId: event?.id ?? null };
  }

  /** Restore a Snapshot; returns {snapshotId, restored, expected, matches, mismatches} (checksums read back from disk). */
  async function restore(snapshotId) {
    if (typeof snapshotId !== 'string' || snapshotId === '') throw new RepairExecutorError('invalid_snapshot_id', 'snapshotId must be a non-empty string.');
    return snapshotService.restore(snapshotId);
  }

  return Object.freeze({ apply, restore });
}
