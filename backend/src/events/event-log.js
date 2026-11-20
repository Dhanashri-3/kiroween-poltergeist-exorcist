// Event_Log and publisher (Task 3.6, Requirements 14.1, 14.2, 14.6, 14.7, 14.8, 14.10).
//
// append(input): assign seq under a mutex -> build Event -> redact -> enforce 64 KB limit ->
// validate (Ajv) -> persist through the Storage interface -> publish to subscribers.
// If persisting fails nothing is published and an EventLogStorageError is thrown (Requirement 14.8).
//
// This module depends only on the Storage *interface* (injected), never on the JSON implementation.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate } from '../contracts/index.js';
import { redact } from './redactor.js';

export const MAX_EVENT_BYTES = 64 * 1024;
export const EVENTS_COLLECTION = 'events';

export class EventLogStorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EventLogStorageError';
    this.code = 'storage_error';
  }
}

export class EventValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'EventValidationError';
    this.code = 'invalid_event';
    this.errors = errors;
  }
}

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Default writer for oversized payloads: atomic write of a JSON file under `directory`. */
export function createFileBlobWriter(directory) {
  return async function writeBlob(name, text) {
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
    return name;
  };
}

// ----- filters and typed views ------------------------------------------------------------

/**
 * @typedef {Object} EventFilter
 * @property {string[]} [types]                 only these types
 * @property {string[]} [excludeTypePrefixes]   drop types starting with any of these (e.g. 'chaos.')
 * @property {string|null} [incidentId]
 * @property {string|null} [runId]
 * @property {string} [component]
 * @property {(event:object)=>boolean} [predicate]
 */
export function matchesFilter(event, filter) {
  if (!filter) return true;
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.excludeTypePrefixes && filter.excludeTypePrefixes.some((p) => event.type.startsWith(p))) return false;
  if (filter.incidentId !== undefined && event.incidentId !== filter.incidentId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.component !== undefined && event.component !== filter.component) return false;
  if (filter.predicate && !filter.predicate(event)) return false;
  return true;
}

export const CHAOS_PREFIX = 'chaos.';
/** Types the Exorcist input builder may see about an Incident (its own prior attempts). */
export const EXORCIST_VISIBLE_TYPES = Object.freeze(['diagnosis', 'plan', 'gate', 'repair', 'verification', 'rollback']);

/** Filter for every non-Dashboard consumer: never `chaos.*`. */
export const NON_CHAOS_FILTER = Object.freeze({ excludeTypePrefixes: Object.freeze([CHAOS_PREFIX]) });

// ----- Event_Log --------------------------------------------------------------------------

export class EventLog {
  /**
   * @param {object} options
   * @param {object} options.storage     Storage interface (get/put/append/list)
   * @param {(name:string,text:string)=>Promise<string>} [options.writeBlob] writes an oversized payload file
   * @param {() => Date} [options.now]
   * @param {() => string} [options.idFactory]
   * @param {number} [options.maxEventBytes]
   */
  constructor({ storage, writeBlob, now = () => new Date(), idFactory = randomUUID, maxEventBytes = MAX_EVENT_BYTES } = {}) {
    if (!storage || typeof storage.append !== 'function' || typeof storage.list !== 'function') {
      throw new TypeError('EventLog requires a Storage interface with append() and list().');
    }
    this.storage = storage;
    this.writeBlob = writeBlob;
    this.now = now;
    this.idFactory = idFactory;
    this.maxEventBytes = maxEventBytes;
    this._queue = Promise.resolve(); // mutex
    this._nextSeq = null;
    this._subscribers = new Set();
    this._storageError = null;
  }

  /** Storage health for /health (Requirement 14.8): null when the last write succeeded. */
  get storageStatus() {
    return this._storageError
      ? { ok: false, error: this._storageError.message, at: this._storageError.at }
      : { ok: true };
  }

  /**
   * Append an Event. `input`: { type, component, incidentId?, runId?, payload? }.
   * Resolves with the persisted Event after it was published.
   */
  append(input) {
    const run = this._queue.then(() => this._appendLocked(input));
    this._queue = run.catch(() => {}); // keep the mutex usable after a failure
    return run;
  }

  async _appendLocked(input) {
    if (!isPlainObject(input)) throw new EventValidationError('Event input must be an object.');
    const seq = await this._reserveSeq();
    const id = this.idFactory();

    let payload = redact(input.payload ?? {});
    if (!isPlainObject(payload)) payload = { value: payload }; // redactor may return a marker string

    let event = {
      id,
      seq,
      ts: this.now().toISOString(),
      type: input.type,
      component: input.component,
      incidentId: input.incidentId ?? null,
      runId: input.runId ?? null,
      payload,
    };

    if (byteLength(event) > this.maxEventBytes) {
      event = { ...event, payload: await this._moveToReference(event) };
    }

    const result = validate('Event', event);
    if (!result.valid) {
      throw new EventValidationError(`Invalid event: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`, result.errors);
    }

    try {
      await this.storage.append(EVENTS_COLLECTION, event, `${seq}`.padStart(12, '0'));
    } catch (cause) {
      const error = new EventLogStorageError('Event_Log could not persist the event.', { cause });
      error.at = this.now().toISOString();
      this._storageError = error;
      throw error; // nothing published, seq not consumed
    }
    this._storageError = null;
    this._nextSeq = seq + 1;
    this._publish(event);
    return event;
  }

  async _reserveSeq() {
    if (this._nextSeq === null) {
      let all;
      try {
        all = await this.storage.list(EVENTS_COLLECTION);
      } catch (cause) {
        const error = new EventLogStorageError('Event_Log could not read existing events.', { cause });
        error.at = this.now().toISOString();
        this._storageError = error;
        throw error;
      }
      this._nextSeq = all.reduce((max, e) => (Number.isInteger(e?.seq) && e.seq > max ? e.seq : max), 0) + 1;
    }
    return this._nextSeq;
  }

  async _moveToReference(event) {
    const text = JSON.stringify(event.payload);
    const name = `${event.id}.payload.json`;
    if (typeof this.writeBlob !== 'function') {
      throw new EventLogStorageError('Payload exceeds the size limit and no blob writer is configured.');
    }
    let ref;
    try {
      ref = await this.writeBlob(name, text);
    } catch (cause) {
      const error = new EventLogStorageError('Event_Log could not persist the referenced payload file.', { cause });
      error.at = this.now().toISOString();
      this._storageError = error;
      throw error;
    }
    return { ref, bytes: Buffer.byteLength(text, 'utf8') };
  }

  // ----- publisher ----------------------------------------------------------------------

  /** Subscribe to newly persisted events. Returns an unsubscribe function. */
  subscribe(listener, filter) {
    const entry = { listener, filter };
    this._subscribers.add(entry);
    return () => this._subscribers.delete(entry);
  }

  _publish(event) {
    for (const { listener, filter } of [...this._subscribers]) {
      if (!matchesFilter(event, filter)) continue;
      try {
        listener(structuredClone(event));
      } catch {
        // A faulty subscriber must not affect the log or other subscribers.
      }
    }
  }

  // ----- reading ------------------------------------------------------------------------

  /** Events with seq greater than `seq`, ascending, matching `filter`. */
  async readAfter(seq = 0, filter) {
    const all = await this.storage.list(EVENTS_COLLECTION);
    return all
      .filter((e) => e.seq > seq && matchesFilter(e, filter))
      .sort((a, b) => a.seq - b.seq);
  }

  /** Typed views (information barrier). Each returns { readAfter, subscribe }. */
  dashboardView() {
    return this._view();
  }

  /** Incident_Manager and other non-Dashboard consumers: never `chaos.*`. */
  nonChaosView() {
    return this._view(NON_CHAOS_FILTER);
  }

  incidentManagerView() {
    return this._view(NON_CHAOS_FILTER);
  }

  /** Exorcist input builder: only the given Incident's own prior attempts. */
  exorcistView(incidentId) {
    if (typeof incidentId !== 'string' || incidentId === '') throw new TypeError('exorcistView requires an incidentId.');
    return this._view({ types: [...EXORCIST_VISIBLE_TYPES], incidentId });
  }

  /** Monitor: reads no events at all. */
  monitorView() {
    return {
      readAfter: async () => [],
      subscribe: () => () => {},
    };
  }

  _view(base) {
    const combine = (extra) => ({
      ...(base ?? {}),
      ...(extra ?? {}),
      types: extra?.types && base?.types ? extra.types.filter((t) => base.types.includes(t)) : (extra?.types ?? base?.types),
      excludeTypePrefixes: [...(base?.excludeTypePrefixes ?? []), ...(extra?.excludeTypePrefixes ?? [])],
    });
    return {
      readAfter: (seq, extra) => this.readAfter(seq, combine(extra)),
      subscribe: (listener, extra) => this.subscribe(listener, combine(extra)),
    };
  }
}

export function createEventLog(options) {
  return new EventLog(options);
}
