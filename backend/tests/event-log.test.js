import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventLog, createFileBlobWriter, EventLogStorageError, EventValidationError, MAX_EVENT_BYTES } from '../src/events/event-log.js';
import { createJsonStore } from '../src/storage/index.js';

function memoryStorage({ failAppend = false } = {}) {
  const rows = [];
  return {
    rows,
    fail: failAppend,
    async append(collection, record) {
      if (this.fail) throw new Error('disk full');
      rows.push(structuredClone(record));
      return record;
    },
    async list() { return structuredClone(rows); },
  };
}

const input = (type = 'detection', extra = {}) => ({ type, component: 'monitor', incidentId: null, runId: null, payload: { n: 1 }, ...extra });

describe('EventLog', () => {
  it('assigns strictly increasing seq under concurrency and persists all required fields', async () => {
    const storage = memoryStorage();
    const log = createEventLog({ storage });
    const events = await Promise.all(Array.from({ length: 25 }, () => log.append(input())));
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(storage.rows.map((e) => e.seq)).toEqual(seqs);
    expect(Object.keys(storage.rows[0]).sort()).toEqual(['component', 'id', 'incidentId', 'payload', 'runId', 'seq', 'ts', 'type']);
  });

  it('continues numbering after existing events', async () => {
    const storage = memoryStorage();
    await createEventLog({ storage }).append(input());
    const second = await createEventLog({ storage }).append(input());
    expect(second.seq).toBe(2);
  });

  it('redacts secrets before persisting and publishing', async () => {
    const storage = memoryStorage();
    const log = createEventLog({ storage });
    const seen = [];
    log.subscribe((e) => seen.push(e));
    await log.append(input('error', { payload: { msg: 'key sk-abcdefghijklmnopqrstuvwxyz123456 used' } }));
    expect(JSON.stringify(storage.rows)).not.toContain('sk-abcdef');
    expect(JSON.stringify(seen)).not.toContain('sk-abcdef');
  });

  it('stores payloads over 64 KB as a referenced file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
    try {
      const storage = memoryStorage();
      const log = createEventLog({ storage, writeBlob: createFileBlobWriter(dir) });
      const big = 'x'.repeat(MAX_EVENT_BYTES + 10);
      const e = await log.append(input('error', { payload: { big } }));
      expect(Object.keys(e.payload)).toContain('ref');
      expect(Buffer.byteLength(JSON.stringify(storage.rows[0]))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      expect(JSON.parse(fs.readFileSync(path.join(dir, e.payload.ref), 'utf8')).big).toBe(big);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes only after persisting, and publishes nothing when persisting fails', async () => {
    const storage = memoryStorage();
    const log = createEventLog({ storage });
    const order = [];
    log.subscribe((e) => order.push(['pub', e.seq, storage.rows.length]));
    await log.append(input());
    expect(order).toEqual([['pub', 1, 1]]);

    storage.fail = true;
    await expect(log.append(input())).rejects.toBeInstanceOf(EventLogStorageError);
    expect(order).toHaveLength(1);
    expect(log.storageStatus.ok).toBe(false);

    storage.fail = false;
    const next = await log.append(input());
    expect(next.seq).toBe(2); // failed append did not consume a sequence number
    expect(log.storageStatus.ok).toBe(true);
  });

  it('rejects invalid events without persisting', async () => {
    const storage = memoryStorage();
    const log = createEventLog({ storage });
    await expect(log.append(input('not-a-type'))).rejects.toBeInstanceOf(EventValidationError);
    expect(storage.rows).toHaveLength(0);
  });

  it('isolates faulty subscribers and supports unsubscribe', async () => {
    const log = createEventLog({ storage: memoryStorage() });
    const got = [];
    log.subscribe(() => { throw new Error('boom'); });
    const off = log.subscribe((e) => got.push(e.seq));
    await log.append(input());
    off();
    await log.append(input());
    expect(got).toEqual([1]);
  });

  it('readAfter returns events with greater seq in ascending order, with filters', async () => {
    const log = createEventLog({ storage: memoryStorage() });
    await log.append(input('chaos.injection'));
    await log.append(input('detection', { incidentId: 'inc-1' }));
    await log.append(input('diagnosis', { incidentId: 'inc-1' }));
    expect((await log.readAfter(1)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await log.readAfter(0, { types: ['diagnosis'] })).map((e) => e.seq)).toEqual([3]);
    expect((await log.readAfter(3))).toEqual([]);
  });

  it('typed views enforce the information barrier', async () => {
    const log = createEventLog({ storage: memoryStorage() });
    await log.append(input('chaos.selection'));
    await log.append(input('detection', { incidentId: 'inc-1' }));
    await log.append(input('diagnosis', { incidentId: 'inc-1' }));
    await log.append(input('diagnosis', { incidentId: 'inc-2' }));
    expect((await log.dashboardView().readAfter(0)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await log.nonChaosView().readAfter(0)).map((e) => e.type)).toEqual(['detection', 'diagnosis', 'diagnosis']);
    expect((await log.incidentManagerView().readAfter(0, { types: ['chaos.selection'] }))).toEqual([]);
    expect((await log.exorcistView('inc-1').readAfter(0)).map((e) => e.seq)).toEqual([3]);
    expect(await log.monitorView().readAfter(0)).toEqual([]);

    const live = [];
    log.nonChaosView().subscribe((e) => live.push(e.type));
    await log.append(input('chaos.injection'));
    await log.append(input('cleared'));
    expect(live).toEqual(['cleared']);
  });

  it('works with the real JSON store through the Storage interface', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-json-'));
    try {
      const log = createEventLog({ storage: createJsonStore({ directory: dir }) });
      await log.append(input());
      await log.append(input('cleared'));
      expect((await log.readAfter(0)).map((e) => e.seq)).toEqual([1, 2]);
      const reopened = createEventLog({ storage: createJsonStore({ directory: dir }) });
      expect((await reopened.append(input())).seq).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
