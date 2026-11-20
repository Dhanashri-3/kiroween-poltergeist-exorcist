// Shared Snapshot service (Task 4.1, Requirements 3.1, 10.2, 10.9, 17.7).
// Used by both the Scenario_Engine and the Repair_Executor, which therefore never import each other.
//
//   create(reason)          Snapshot of ALL Approved_Files with SHA-256 checksums. File content is kept
//                           under the storage directory; the record goes to the `snapshots` collection.
//   restore(snapshotId)     Writes every snapshotted file back and returns the checksums read back from
//                           disk, plus a per-file comparison with the Snapshot checksums.
//   currentChecksums()      Checksums of the Approved_Files as they are now.
//
// Every write (snapshot content and restored Approved_Files) goes through File_Guard.assertWritable with
// caller "snapshot-service". A denial throws SnapshotError(code "write_denied"); nothing is written for a
// denied path. Snapshots are never deleted (retained for the demo session).
// The Storage object only needs get/put/list (the Storage interface); no JSON implementation is imported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validate } from '../../contracts/index.js';
import { checkRelativePathSyntax, checkSensitiveFile, resolveApprovedFile } from '../path-safety.js';

export const SNAPSHOT_CALLER = 'snapshot-service';
export const SNAPSHOT_REASONS = Object.freeze(['injection', 'repair', 'baseline']);
export const SNAPSHOT_CONTENT_DIR = 'snapshot-content';

export class SnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * @param {object} options
 * @param {string} options.testappDir      Test_App directory (Approved_Files are relative to it).
 * @param {string[]} options.approvedFiles Approved_Files, forward-slash paths relative to testappDir.
 * @param {string} options.storageDir      Storage directory for snapshot content; must be one of the File_Guard storageDirs.
 * @param {{get: Function, put: Function, list: Function}} options.storage Storage interface.
 * @param {{assertWritable: Function}} options.fileGuard File_Guard.
 * @param {() => Date} [options.now]
 * @param {() => string} [options.idGenerator]
 */
export function createSnapshotService(options = {}) {
  const { testappDir, approvedFiles, storageDir, storage, fileGuard, now = () => new Date(), idGenerator = () => `snap-${crypto.randomUUID()}` } = options;
  if (typeof testappDir !== 'string' || testappDir === '') throw new TypeError('testappDir must be a non-empty string');
  if (typeof storageDir !== 'string' || storageDir === '') throw new TypeError('storageDir must be a non-empty string');
  if (!Array.isArray(approvedFiles) || approvedFiles.length === 0) throw new TypeError('approvedFiles must be a non-empty array');
  for (const f of approvedFiles) {
    if (!checkRelativePathSyntax(f).ok || !checkSensitiveFile(f).ok) throw new TypeError(`Unsafe approved file path: ${JSON.stringify(f)}`);
  }
  for (const m of ['get', 'put', 'list']) {
    if (typeof storage?.[m] !== 'function') throw new TypeError(`storage must implement ${m}()`);
  }
  if (typeof fileGuard?.assertWritable !== 'function') throw new TypeError('fileGuard.assertWritable is required');

  const files = Object.freeze([...approvedFiles]);
  const testappRoot = path.resolve(testappDir);
  const contentRoot = path.resolve(storageDir);

  const approvedAbsolute = (rel) => path.join(testappRoot, ...rel.split('/'));

  /** Guarded write: returns the real path, or throws write_denied without writing. */
  function guardWrite(absolutePath) {
    const decision = fileGuard.assertWritable(absolutePath, SNAPSHOT_CALLER);
    if (!decision.allowed) {
      throw new SnapshotError('write_denied', `File_Guard denied the write: ${decision.code}.`, { denial: decision });
    }
    return decision.realPath;
  }

  function readApproved(rel) {
    const resolved = resolveApprovedFile(testappRoot, rel);
    if (!resolved.ok) throw new SnapshotError('read_failed', `Approved file cannot be read: ${rel} (${resolved.code}).`);
    try {
      return fs.readFileSync(resolved.real);
    } catch (e) {
      throw new SnapshotError('read_failed', `Approved file cannot be read: ${rel} (${e?.code ?? 'error'}).`);
    }
  }

  /** Checksums of the Approved_Files right now: [{path, checksum}] in Approved_Files order. */
  function currentChecksums() {
    return files.map((rel) => ({ path: rel, checksum: sha256Hex(readApproved(rel)) }));
  }

  async function create(reason) {
    if (!SNAPSHOT_REASONS.includes(reason)) {
      throw new SnapshotError('invalid_reason', `reason must be one of: ${SNAPSHOT_REASONS.join(', ')}.`);
    }
    const snapshotId = idGenerator();
    const contents = files.map((rel) => ({ rel, data: readApproved(rel) }));
    const entries = [];
    // Plan and guard every content write before touching the disk.
    const planned = contents.map(({ rel, data }, index) => {
      const contentRef = `${SNAPSHOT_CONTENT_DIR}/${snapshotId}/${index}`;
      const target = path.join(contentRoot, SNAPSHOT_CONTENT_DIR, snapshotId, String(index));
      return { rel, data, contentRef, target, real: guardWrite(target) };
    });
    for (const p of planned) {
      try {
        fs.mkdirSync(path.dirname(p.real), { recursive: true });
        fs.writeFileSync(p.real, p.data);
      } catch (e) {
        throw new SnapshotError('write_failed', `Snapshot content could not be written (${e?.code ?? 'error'}).`);
      }
      entries.push({ path: p.rel, checksum: sha256Hex(p.data), contentRef: p.contentRef });
    }
    const record = { snapshotId, createdAt: new Date(now()).toISOString(), reason, files: entries };
    const check = validate('Snapshot', record);
    if (!check.valid) throw new SnapshotError('invalid_record', `Snapshot record failed validation: ${check.errors[0]?.message}.`);
    await storage.put('snapshots', snapshotId, record);
    return record;
  }

  async function get(snapshotId) {
    return storage.get('snapshots', snapshotId);
  }

  async function list() {
    return storage.list('snapshots');
  }

  /**
   * Restore every file of the Snapshot. Nothing is written unless all content is present with a matching
   * checksum and every target is allowed by the File_Guard. The returned checksums are read back from disk.
   * @returns {{snapshotId: string, restored: {path:string, checksum:string}[], expected: {path:string, checksum:string}[], matches: boolean, mismatches: string[]}}
   */
  async function restore(snapshotId) {
    const record = await storage.get('snapshots', snapshotId);
    if (!record) throw new SnapshotError('not_found', 'Snapshot not found.');
    const valid = validate('Snapshot', record);
    if (!valid.valid) throw new SnapshotError('invalid_record', 'Stored Snapshot is invalid.');

    const plan = record.files.map((f) => {
      if (!files.includes(f.path)) throw new SnapshotError('not_approved', `Snapshot file is not an Approved_File: ${f.path}.`);
      const contentPath = path.resolve(contentRoot, ...f.contentRef.split('/'));
      const rel = path.relative(contentRoot, contentPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SnapshotError('invalid_record', 'Snapshot content reference escapes the storage directory.');
      let data;
      try {
        data = fs.readFileSync(contentPath);
      } catch {
        throw new SnapshotError('content_missing', `Snapshot content is missing for ${f.path}.`);
      }
      if (sha256Hex(data) !== f.checksum) throw new SnapshotError('content_corrupt', `Snapshot content does not match its checksum for ${f.path}.`);
      return { path: f.path, data, real: guardWrite(approvedAbsolute(f.path)) };
    });

    for (const p of plan) {
      try {
        fs.writeFileSync(p.real, p.data);
      } catch (e) {
        throw new SnapshotError('write_failed', `Restore of ${p.path} failed (${e?.code ?? 'error'}).`);
      }
    }

    const expected = record.files.map((f) => ({ path: f.path, checksum: f.checksum }));
    const restored = record.files.map((f) => ({ path: f.path, checksum: sha256Hex(readApproved(f.path)) }));
    const mismatches = restored.filter((r, i) => r.checksum !== expected[i].checksum).map((r) => r.path);
    return { snapshotId, restored, expected, matches: mismatches.length === 0, mismatches };
  }

  return Object.freeze({ create, restore, get, list, currentChecksums });
}
