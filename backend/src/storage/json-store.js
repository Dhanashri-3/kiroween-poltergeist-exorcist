// Local JSON implementation of the Storage interface (Task 3.1, Requirements 18.1-18.3).
// One file per collection: <dir>/<collection>.json containing
//   { "version": 1, "entries": [ { "key": string|null, "record": object } ] }
// Writes go to a temporary file in the same directory and are renamed into place. On Windows a
// rename can fail briefly (EPERM/EACCES/EBUSY) when another process holds the target, so the
// rename is retried a few times with a short delay. Callers are serialized per store instance.
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import {
  COLLECTIONS,
  STORAGE_ERROR_CODES as CODES,
  StorageError,
  assertCollection,
  assertKey,
  cloneRecord,
} from './storage-interface.js';

export const RENAME_RETRY_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
const DEFAULT_RENAME_ATTEMPTS = 5;
const DEFAULT_RENAME_DELAY_MS = 20;
const FORMAT_VERSION = 1;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isValidDocument = (doc) =>
  doc !== null &&
  typeof doc === 'object' &&
  !Array.isArray(doc) &&
  doc.version === FORMAT_VERSION &&
  Array.isArray(doc.entries) &&
  doc.entries.every(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      (e.key === null || (typeof e.key === 'string' && e.key.length > 0)) &&
      e.record !== null &&
      typeof e.record === 'object' &&
      !Array.isArray(e.record),
  );

const timestampForName = (date) => date.toISOString().replace(/[-:]/g, '');

export class JsonFileStore {
  /**
   * @param {object} options
   * @param {string} options.directory   storage directory (created on first use)
   * @param {(report: object) => void} [options.onCorruption]  called for each corruption report
   * @param {object} [options.fs]        fs/promises-compatible object (injectable for tests)
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   * @param {() => Date} [options.now]
   * @param {number} [options.renameAttempts]
   * @param {number} [options.renameDelayMs]
   */
  constructor({
    directory,
    onCorruption,
    fs = nodeFs,
    sleep = defaultSleep,
    now = () => new Date(),
    renameAttempts = DEFAULT_RENAME_ATTEMPTS,
    renameDelayMs = DEFAULT_RENAME_DELAY_MS,
  } = {}) {
    if (typeof directory !== 'string' || directory.trim() === '' || directory.includes('\0')) {
      throw new StorageError(CODES.UNSAFE_PATH, 'Storage directory must be a non-empty path string.');
    }
    this.directory = path.resolve(directory);
    this.onCorruption = onCorruption;
    this.fs = fs;
    this.sleep = sleep;
    this.now = now;
    this.renameAttempts = Math.max(1, renameAttempts);
    this.renameDelayMs = renameDelayMs;
    this.collections = COLLECTIONS;
    this._queue = Promise.resolve();
    this._reports = [];
    this._tmpCounter = 0;
  }

  // ----- public interface -----------------------------------------------------------------

  async get(collection, key) {
    assertCollection(collection);
    assertKey(key);
    return this._serial(async () => {
      const doc = await this._load(collection);
      const entry = doc.entries.find((e) => e.key === key);
      return entry ? entry.record : null;
    });
  }

  async put(collection, key, record) {
    assertCollection(collection);
    assertKey(key);
    const copy = cloneRecord(record);
    return this._serial(async () => {
      const doc = await this._load(collection);
      const index = doc.entries.findIndex((e) => e.key === key);
      if (index >= 0) doc.entries[index] = { key, record: copy };
      else doc.entries.push({ key, record: copy });
      await this._write(collection, doc);
      return JSON.parse(JSON.stringify(copy));
    });
  }

  async append(collection, record, key = null) {
    assertCollection(collection);
    if (key !== null) assertKey(key);
    const copy = cloneRecord(record);
    return this._serial(async () => {
      const doc = await this._load(collection);
      doc.entries.push({ key, record: copy });
      await this._write(collection, doc);
      return JSON.parse(JSON.stringify(copy));
    });
  }

  async list(collection) {
    assertCollection(collection);
    return this._serial(async () => {
      const doc = await this._load(collection);
      return doc.entries.map((e) => e.record);
    });
  }

  /**
   * Check every collection now (e.g. at startup) so corruption is found and recovered early.
   * Missing files are not created.
   */
  async initialize() {
    for (const collection of COLLECTIONS) {
      await this._serial(() => this._load(collection));
    }
    return this.drainCorruptionReports();
  }

  /** Returns and clears the corruption reports collected so far. */
  drainCorruptionReports() {
    const reports = this._reports;
    this._reports = [];
    return reports;
  }

  // ----- internals ------------------------------------------------------------------------

  _serial(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  _filePath(collection) {
    // Collection is validated against a fixed list, so the name cannot contain separators.
    const file = path.join(this.directory, `${collection}.json`);
    if (path.dirname(file) !== this.directory) {
      throw new StorageError(CODES.UNSAFE_PATH, 'Collection file resolves outside the storage directory.');
    }
    return file;
  }

  async _load(collection) {
    const file = this._filePath(collection);
    let text;
    try {
      const stat = await this.fs.lstat(file);
      if (stat.isSymbolicLink()) {
        throw new StorageError(CODES.UNSAFE_PATH, `${collection}.json is a symbolic link and is refused.`);
      }
      if (!stat.isFile()) return this._recover(collection, file, 'unreadable', 'Path is not a regular file.');
      text = await this.fs.readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (error && error.code === 'ENOENT') return { version: FORMAT_VERSION, entries: [] };
      return this._recover(collection, file, 'unreadable', `File could not be read (${error && error.code ? error.code : 'error'}).`);
    }

    if (text.trim() === '') return this._recover(collection, file, 'parse_error', 'File is empty.');
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      return this._recover(collection, file, 'parse_error', `File is not valid JSON (${error.name}).`);
    }
    if (!isValidDocument(doc)) {
      return this._recover(collection, file, 'invalid_structure', 'File does not have the expected storage structure.');
    }
    return doc;
  }

  async _recover(collection, file, reason, detail) {
    const stamp = timestampForName(this.now());
    let backup = `${path.basename(file)}.corrupt-${stamp}`;
    try {
      let n = 0;
      // Never overwrite an earlier backup.
      for (;;) {
        const candidate = n === 0 ? backup : `${backup}-${n}`;
        try {
          await this.fs.lstat(path.join(this.directory, candidate));
          n += 1;
        } catch (e) {
          if (e && e.code === 'ENOENT') { backup = candidate; break; }
          throw e;
        }
      }
      await this._renameWithRetry(file, path.join(this.directory, backup));
    } catch (error) {
      throw new StorageError(
        CODES.RECOVERY_FAILED,
        `${collection}.json is corrupt and could not be preserved; refusing to overwrite it.`,
        { cause: error },
      );
    }
    const report = {
      kind: 'storage_corruption',
      collection,
      file: path.basename(file),
      backupFile: backup,
      reason,
      detail,
      detectedAt: this.now().toISOString(),
    };
    this._reports.push(report);
    if (typeof this.onCorruption === 'function') {
      try { this.onCorruption(report); } catch { /* a failing listener must not break recovery */ }
    }
    return { version: FORMAT_VERSION, entries: [] };
  }

  async _renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 1; attempt <= this.renameAttempts; attempt++) {
      try {
        await this.fs.rename(from, to);
        return;
      } catch (error) {
        lastError = error;
        if (!error || !RENAME_RETRY_CODES.includes(error.code) || attempt === this.renameAttempts) break;
        await this.sleep(this.renameDelayMs * attempt);
      }
    }
    throw lastError;
  }

  async _write(collection, doc) {
    const file = this._filePath(collection);
    const tmp = `${file}.${process.pid}-${++this._tmpCounter}.tmp`;
    try {
      await this.fs.mkdir(this.directory, { recursive: true });
      await this.fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
      await this._renameWithRetry(tmp, file);
    } catch (error) {
      try { await this.fs.unlink(tmp); } catch { /* temp file may not exist */ }
      throw new StorageError(CODES.WRITE_FAILED, `Could not write ${collection}.json.`, { cause: error });
    }
  }
}

export function createJsonStore(options) {
  return new JsonFileStore(options);
}
