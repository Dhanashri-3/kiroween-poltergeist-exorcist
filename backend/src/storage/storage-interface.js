// Storage interface (Task 3.1, Requirement 18.4).
// This module is the abstraction. It has no file system code and no dependency on the Event_Log,
// so a different store can replace the local JSON files without touching callers.
//
// Interface (all methods are async; `collection` is one of COLLECTIONS):
//   get(collection, key)                 -> record | null
//   put(collection, key, record)         -> record      upsert by key; keeps first-insert position
//   append(collection, record, key?)     -> record      add at the end; key is optional
//   list(collection)                     -> record[]    insertion order
//
// Corruption is reported as structured StorageCorruptionReport objects, never by calling an
// Event_Log. The owner of the store collects them with drainCorruptionReports() or an
// `onCorruption` callback and records an `error` Event (Requirement 18.3).

export const COLLECTIONS = Object.freeze(['events', 'incidents', 'verifications', 'snapshots']);

export const STORAGE_ERROR_CODES = Object.freeze({
  INVALID_COLLECTION: 'invalid_collection',
  INVALID_KEY: 'invalid_key',
  INVALID_RECORD: 'invalid_record',
  UNSAFE_PATH: 'unsafe_path',
  WRITE_FAILED: 'write_failed',
  READ_FAILED: 'read_failed',
  RECOVERY_FAILED: 'recovery_failed',
});

export class StorageError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
  }
}

/**
 * @typedef {Object} StorageCorruptionReport
 * @property {'storage_corruption'} kind
 * @property {string} collection       collection name
 * @property {string} file             base name of the corrupt file, e.g. "events.json"
 * @property {string|null} backupFile  base name of the preserved copy, e.g. "events.json.corrupt-20250101T000000.000Z"
 * @property {string} reason           why the file was rejected (parse_error | invalid_structure | unreadable)
 * @property {string} detail           human-readable detail, never file contents
 * @property {string} detectedAt       ISO timestamp
 */

export function isValidCollection(name) {
  return typeof name === 'string' && COLLECTIONS.includes(name);
}

export function assertCollection(name) {
  if (!isValidCollection(name)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_COLLECTION,
      `Unknown collection. Expected one of: ${COLLECTIONS.join(', ')}.`,
    );
  }
}

export function assertKey(key) {
  // eslint-disable-next-line no-control-regex
  if (typeof key !== 'string' || key.length === 0 || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new StorageError(STORAGE_ERROR_CODES.INVALID_KEY, 'Key must be a non-empty string of at most 200 characters without control characters.');
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidAt(path, why) {
  return new StorageError(STORAGE_ERROR_CODES.INVALID_RECORD, `Record contains a value that is not JSON-compatible (${why}) at ${path}.`);
}

// Recursively checks that JSON.stringify would keep the value exactly as given.
// `ancestors` holds the objects on the current path, so shared (non-circular) references stay valid.
function assertJsonCompatible(value, path, ancestors) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw invalidAt(path, 'non-finite number');
    return;
  }
  if (type !== 'object') throw invalidAt(path, type); // undefined, function, symbol, bigint
  if (ancestors.has(value)) throw invalidAt(path, 'circular reference');
  const isArray = Array.isArray(value);
  if (isArray) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidAt(path, 'custom array');
  } else if (!isPlainObject(value)) {
    throw invalidAt(path, 'non-plain object');
  }
  ancestors.add(value);
  if (isArray) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw invalidAt(`${path}[${i}]`, 'sparse array hole');
      assertJsonCompatible(value[i], `${path}[${i}]`, ancestors);
    }
  } else {
    if (Object.getOwnPropertySymbols(value).length > 0) throw invalidAt(path, 'symbol key');
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!('value' in descriptor)) throw invalidAt(`${path}.${key}`, 'accessor property');
      assertJsonCompatible(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Returns a JSON-safe deep copy of a plain-object record, or throws INVALID_RECORD. */
export function cloneRecord(record) {
  if (!isPlainObject(record)) {
    throw new StorageError(STORAGE_ERROR_CODES.INVALID_RECORD, 'Record must be a plain object.');
  }
  try {
    assertJsonCompatible(record, 'record', new Set());
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(STORAGE_ERROR_CODES.INVALID_RECORD, 'Record is not JSON serializable.', { cause: error });
  }
  let text;
  try {
    text = JSON.stringify(record);
  } catch (error) {
    throw new StorageError(STORAGE_ERROR_CODES.INVALID_RECORD, 'Record is not JSON serializable.', { cause: error });
  }
  if (typeof text !== 'string') throw new StorageError(STORAGE_ERROR_CODES.INVALID_RECORD, 'Record is not JSON serializable.');
  return JSON.parse(text);
}
