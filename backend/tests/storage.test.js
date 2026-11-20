// Task 3.1 tests for the Storage interface and local JSON store. Temporary directories only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COLLECTIONS, StorageError, createJsonStore, JsonFileStore } from '../src/storage/index.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mk = (extra = {}) => createJsonStore({ directory: dir, sleep: async () => {}, ...extra });
const files = () => fs.readdirSync(dir).sort();
const rejectsCode = async (promise, code) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(StorageError);
  expect(err.code).toBe(code);
};

describe('collections', () => {
  it('supports exactly events, incidents, verifications, snapshots', () => {
    expect([...COLLECTIONS]).toEqual(['events', 'incidents', 'verifications', 'snapshots']);
  });
});

describe.each(COLLECTIONS)('operations on %s', (collection) => {
  it('get/put/append/list work and persist across store instances', async () => {
    const s = mk();
    expect(await s.list(collection)).toEqual([]);
    expect(await s.get(collection, 'a')).toBeNull();
    await s.put(collection, 'a', { n: 1, nested: { x: [1, 2] } });
    await s.append(collection, { n: 2 });
    await s.append(collection, { n: 3 }, 'c');
    await s.put(collection, 'a', { n: 10 }); // upsert keeps position

    const s2 = mk();
    expect(await s2.get(collection, 'a')).toEqual({ n: 10 });
    expect(await s2.get(collection, 'c')).toEqual({ n: 3 });
    expect(await s2.get(collection, 'missing')).toBeNull();
    expect(await s2.list(collection)).toEqual([{ n: 10 }, { n: 2 }, { n: 3 }]);
    expect(files()).toEqual([`${collection}.json`]);
  });
});

describe('missing and empty collections', () => {
  it('returns empty results and creates no file or directory on read', async () => {
    const sub = path.join(dir, 'not-yet');
    const s = createJsonStore({ directory: sub });
    expect(await s.list('events')).toEqual([]);
    expect(fs.existsSync(sub)).toBe(false);
    await s.append('events', { a: 1 });
    expect(fs.existsSync(path.join(sub, 'events.json'))).toBe(true);
  });

  it('treats an empty collection file as corrupt', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), '');
    const s = mk();
    expect(await s.list('events')).toEqual([]);
    expect(s.drainCorruptionReports()).toHaveLength(1);
  });

  it('keeps stored records independent of caller objects', async () => {
    const s = mk();
    const rec = { a: { b: 1 } };
    await s.put('incidents', 'i', rec);
    rec.a.b = 99;
    const got = await s.get('incidents', 'i');
    expect(got).toEqual({ a: { b: 1 } });
    got.a.b = 5;
    expect(await s.get('incidents', 'i')).toEqual({ a: { b: 1 } });
  });

  it('serializes concurrent appends without losing records', async () => {
    const s = mk();
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.append('events', { i })));
    expect((await s.list('events')).map((r) => r.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

describe('atomic writes', () => {
  it('writes a temp file then renames it, leaving no temp files', async () => {
    const calls = [];
    const real = fsp;
    const spy = {
      ...real,
      lstat: real.lstat, readFile: real.readFile, mkdir: real.mkdir, unlink: real.unlink,
      writeFile: async (p, ...r) => { calls.push(['write', path.basename(p)]); return real.writeFile(p, ...r); },
      rename: async (a, b) => { calls.push(['rename', path.basename(a), path.basename(b)]); return real.rename(a, b); },
    };
    const s = mk({ fs: spy });
    await s.put('events', 'k', { v: 1 });
    expect(calls[0][0]).toBe('write');
    expect(calls[0][1]).toMatch(/^events\.json\..*\.tmp$/);
    expect(calls[1]).toEqual(['rename', calls[0][1], 'events.json']);
    expect(files()).toEqual(['events.json']);
  });

  it('leaves the previous file intact and removes the temp file when the write fails', async () => {
    const s = mk();
    await s.put('events', 'k', { v: 1 });
    const failing = {
      ...fsp,
      lstat: fsp.lstat, readFile: fsp.readFile, mkdir: fsp.mkdir, unlink: fsp.unlink, rename: fsp.rename,
      writeFile: async (p, data, enc) => { await fsp.writeFile(p, String(data).slice(0, 5), enc); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    };
    const s2 = mk({ fs: failing });
    await rejectsCode(s2.put('events', 'k', { v: 2 }), 'write_failed');
    expect(files()).toEqual(['events.json']);
    expect(await mk().get('events', 'k')).toEqual({ v: 1 });
  });
});

describe('rename retry', () => {
  const renamer = (failures, code) => {
    let n = 0;
    return { count: () => n, fs: { ...fsp, lstat: fsp.lstat, readFile: fsp.readFile, mkdir: fsp.mkdir, unlink: fsp.unlink, writeFile: fsp.writeFile,
      rename: async (a, b) => { n += 1; if (n <= failures) throw Object.assign(new Error('locked'), { code }); return fsp.rename(a, b); } } };
  };

  it('retries transient EPERM and succeeds', async () => {
    const r = renamer(2, 'EPERM');
    const delays = [];
    const s = mk({ fs: r.fs, sleep: async (ms) => { delays.push(ms); } });
    await s.put('snapshots', 's1', { ok: true });
    expect(r.count()).toBe(3);
    expect(delays).toHaveLength(2);
    expect(await mk().get('snapshots', 's1')).toEqual({ ok: true });
  });

  it('gives up after the bounded number of attempts, cleans up and reports write_failed', async () => {
    const r = renamer(Infinity, 'EBUSY');
    const s = mk({ fs: r.fs, renameAttempts: 4 });
    await rejectsCode(s.put('snapshots', 's1', { ok: true }), 'write_failed');
    expect(r.count()).toBe(4);
    expect(files()).toEqual([]);
  });

  it('does not retry non-transient errors', async () => {
    const r = renamer(Infinity, 'ENOENT');
    const s = mk({ fs: r.fs });
    await rejectsCode(s.put('events', 'k', { a: 1 }), 'write_failed');
    expect(r.count()).toBe(1);
    expect(files()).toEqual([]);
  });
});

describe('corrupt JSON recovery', () => {
  const fixedNow = () => new Date('2025-01-02T03:04:05.678Z');

  it('preserves the corrupt file, starts empty and reports a structured error', async () => {
    fs.writeFileSync(path.join(dir, 'incidents.json'), '{"version":1,"entries":[');
    const seen = [];
    const s = mk({ now: fixedNow, onCorruption: (r) => seen.push(r) });
    expect(await s.list('incidents')).toEqual([]);

    const backup = 'incidents.json.corrupt-20250102T030405.678Z';
    expect(files()).toEqual([backup]);
    expect(fs.readFileSync(path.join(dir, backup), 'utf8')).toBe('{"version":1,"entries":[');

    const expected = {
      kind: 'storage_corruption', collection: 'incidents', file: 'incidents.json', backupFile: backup,
      reason: 'parse_error', detail: expect.any(String), detectedAt: '2025-01-02T03:04:05.678Z',
    };
    expect(seen).toEqual([expected]);
    expect(s.drainCorruptionReports()).toEqual([expected]);
    expect(s.drainCorruptionReports()).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('"version":1,"entries":[');

    // Reading again does not re-report, and the store is writable afterwards.
    await s.append('incidents', { ok: 1 });
    expect(s.drainCorruptionReports()).toEqual([]);
    expect(await mk().list('incidents')).toEqual([{ ok: 1 }]);
  });

  it('treats valid JSON with the wrong structure as corrupt', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), '[1,2,3]');
    const s = mk();
    expect(await s.list('events')).toEqual([]);
    const [report] = s.drainCorruptionReports();
    expect(report.reason).toBe('invalid_structure');
  });

  it('treats an unreadable path as corrupt (a directory in place of the file)', async () => {
    fs.mkdirSync(path.join(dir, 'verifications.json'));
    const s = mk({ now: fixedNow });
    expect(await s.list('verifications')).toEqual([]);
    expect(s.drainCorruptionReports()[0].reason).toBe('unreadable');
    expect(files()).toEqual(['verifications.json.corrupt-20250102T030405.678Z']);
  });

  it('never overwrites an earlier backup made in the same millisecond', async () => {
    const s = mk({ now: fixedNow });
    fs.writeFileSync(path.join(dir, 'events.json'), 'bad1');
    await s.list('events');
    fs.writeFileSync(path.join(dir, 'events.json'), 'bad2');
    await s.list('events');
    const backups = files();
    expect(backups).toEqual(['events.json.corrupt-20250102T030405.678Z', 'events.json.corrupt-20250102T030405.678Z-1']);
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe('bad1');
  });

  it('initialize() recovers all corrupt collections at startup and returns the reports', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), 'x');
    fs.writeFileSync(path.join(dir, 'snapshots.json'), '{');
    const reports = await mk().initialize();
    expect(reports.map((r) => r.collection).sort()).toEqual(['events', 'snapshots']);
  });

  it('refuses to continue when the corrupt file cannot be preserved', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), 'bad');
    const s = mk({ fs: { ...fsp, lstat: fsp.lstat, readFile: fsp.readFile, rename: async () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); } } });
    await rejectsCode(s.list('events'), 'recovery_failed');
    expect(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).toBe('bad');
  });

  it('does not depend on an Event_Log module', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/storage/json-store.js'), 'utf8')
      + fs.readFileSync(path.resolve(import.meta.dirname, '../src/storage/storage-interface.js'), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*events/);
  });
});

describe('invalid input and unsafe paths', () => {
  it.each(['', 'Events', 'events.json', '../events', 'events/../x', 'C:\\x', '__proto__', 'constructor', 'toString', null, undefined, 5])(
    'rejects collection %j', async (name) => {
      const s = mk();
      await rejectsCode(s.get(name, 'k'), 'invalid_collection');
      await rejectsCode(s.put(name, 'k', {}), 'invalid_collection');
      await rejectsCode(s.append(name, {}), 'invalid_collection');
      await rejectsCode(s.list(name), 'invalid_collection');
      expect(files()).toEqual([]);
    });

  it.each(['', null, 5, 'a\nb', 'x'.repeat(201)])('rejects key %j', async (key) => {
    await rejectsCode(mk().put('events', key, {}), 'invalid_key');
  });

  it.each([null, 'str', 5, [1], undefined, () => 1])('rejects non-object record %j', async (rec) => {
    await rejectsCode(mk().append('events', rec), 'invalid_record');
  });

  class Custom { constructor() { this.a = 1; } }
  const nonPlain = {
    Date: () => new Date(),
    Map: () => new Map([['a', 1]]),
    Set: () => new Set([1]),
    'class instance': () => new Custom(),
    'array': () => [{ a: 1 }],
    'Object.create(proto)': () => Object.create({ inherited: 1 }),
  };

  it.each(Object.keys(nonPlain))('rejects %s record without creating a file', async (name) => {
    const s = mk();
    await rejectsCode(s.append('events', nonPlain[name]()), 'invalid_record');
    await rejectsCode(s.put('events', 'k', nonPlain[name]()), 'invalid_record');
    expect(files()).toEqual([]);
  });

  it.each(Object.keys(nonPlain))('rejected %s record leaves existing file unchanged', async (name) => {
    const s = mk();
    await s.put('events', 'k', { ok: true });
    const file = path.join(dir, 'events.json');
    const before = fs.readFileSync(file, 'utf8');
    const names = files();
    await rejectsCode(s.append('events', nonPlain[name]()), 'invalid_record');
    await rejectsCode(s.put('events', 'k', nonPlain[name]()), 'invalid_record');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(files()).toEqual(names);
  });

  it('accepts ordinary and null-prototype objects, returning plain objects', async () => {
    const s = mk();
    const np = Object.create(null); np.x = 1;
    const r1 = await s.append('events', { a: 1 });
    const r2 = await s.append('events', np);
    for (const r of [r1, r2]) { expect(r).not.toBeNull(); expect(typeof r).toBe('object'); expect(Array.isArray(r)).toBe(false); }
    expect(r2).toEqual({ x: 1 });
  });

  it('rejects circular and BigInt records', async () => {
    const c = {}; c.self = c;
    await rejectsCode(mk().append('events', c), 'invalid_record');
    await rejectsCode(mk().append('events', { n: 1n }), 'invalid_record');
  });

  const circularNested = () => { const c = { a: [] }; c.a.push({ back: c }); return { wrap: c }; };
  const nestedInvalid = {
    Date: () => ({ a: { d: new Date() } }),
    Map: () => ({ a: [new Map()] }),
    Set: () => ({ a: new Set([1]) }),
    'class instance': () => ({ a: { b: new Custom() } }),
    'custom prototype': () => ({ a: Object.create({ inherited: 1 }) }),
    undefined: () => ({ a: { b: undefined } }),
    'undefined in array': () => ({ a: [1, undefined] }),
    'sparse array': () => ({ a: [1, , 3] }), // eslint-disable-line no-sparse-arrays
    function: () => ({ a: { f: () => 1 } }),
    symbol: () => ({ a: [Symbol('s')] }),
    BigInt: () => ({ a: { n: 1n } }),
    NaN: () => ({ a: { n: NaN } }),
    Infinity: () => ({ a: [Infinity] }),
    '-Infinity': () => ({ a: { n: -Infinity } }),
    'circular object': () => circularNested(),
    'circular array': () => { const arr = []; arr.push(arr); return { arr }; },
  };

  it.each(Object.keys(nestedInvalid))('rejects nested %s without creating a file', async (name) => {
    const s = mk();
    await rejectsCode(s.append('events', nestedInvalid[name]()), 'invalid_record');
    await rejectsCode(s.put('events', 'k', nestedInvalid[name]()), 'invalid_record');
    expect(files()).toEqual([]);
  });

  it.each(Object.keys(nestedInvalid))('rejected nested %s leaves existing file unchanged', async (name) => {
    const s = mk();
    await s.put('events', 'k', { ok: true });
    const file = path.join(dir, 'events.json');
    const before = fs.readFileSync(file, 'utf8');
    await rejectsCode(s.append('events', nestedInvalid[name]()), 'invalid_record');
    await rejectsCode(s.put('events', 'k', nestedInvalid[name]()), 'invalid_record');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(files()).toEqual(['events.json']);
  });

  it('accepts valid nested arrays, objects and null-prototype objects', async () => {
    const s = mk();
    const inner = Object.create(null); inner.deep = [null, 'x', true, 1.5, -2, 0];
    const shared = { s: 1 };
    const rec = { str: 's', n: null, arr: [1, [2, [3, { z: [] }]], inner], obj: { a: { b: {} } }, r1: shared, r2: shared };
    const stored = await s.put('incidents', 'i', rec);
    const expected = JSON.parse(JSON.stringify(rec));
    expect(stored).toEqual(expected);
    expect(await mk().get('incidents', 'i')).toEqual(expected);
  });

  it('rejects an invalid storage directory', () => {
    for (const d of ['', '   ', undefined, 'a\0b']) expect(() => new JsonFileStore({ directory: d })).toThrow(StorageError);
  });

  it('refuses a symbolic-link collection file', async (ctx) => {
    const target = path.join(dir, 'outside.json');
    fs.writeFileSync(target, '{}');
    try { fs.symlinkSync(target, path.join(dir, 'events.json')); } catch { ctx.skip(); return; }
    await rejectsCode(mk().list('events'), 'unsafe_path');
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  });
});
