import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService, SnapshotError } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';

const APPROVED = ['mock-api.js', 'public/button.js', 'public/button.css'];
const temps = [];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function setup({ guardApproved = APPROVED, serviceApproved = APPROVED } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const store = path.join(base, 'storage-data');
  fs.mkdirSync(path.join(testapp, 'public'), { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  for (const f of APPROVED) fs.writeFileSync(path.join(testapp, ...f.split('/')), `original ${f}\n`);
  const fileGuard = createFileGuard({ testappDir: testapp, approvedFiles: guardApproved, storageDirs: [store] });
  const storage = createJsonStore({ directory: store });
  const service = createSnapshotService({ testappDir: testapp, approvedFiles: serviceApproved, storageDir: store, storage, fileGuard });
  return { testapp, store, service, storage };
}

const read = (testapp, rel) => fs.readFileSync(path.join(testapp, ...rel.split('/')), 'utf8');

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

describe('Snapshot service', () => {
  it('snapshots all Approved_Files with SHA-256 checksums and stores a valid record', async () => {
    const { testapp, service, storage } = setup();
    const snap = await service.create('baseline');
    expect(snap.reason).toBe('baseline');
    expect(snap.files.map((f) => f.path)).toEqual(APPROVED);
    for (const f of snap.files) expect(f.checksum).toBe(sha(read(testapp, f.path)));
    expect(await storage.get('snapshots', snap.snapshotId)).toEqual(snap);
  });

  it('restores mutated files and returns restored checksums equal to the Snapshot checksums', async () => {
    const { testapp, service } = setup();
    const snap = await service.create('injection');
    fs.writeFileSync(path.join(testapp, 'mock-api.js'), 'broken');
    fs.writeFileSync(path.join(testapp, 'public', 'button.css'), 'also broken');
    expect(service.currentChecksums().map((c) => c.checksum)).not.toEqual(snap.files.map((f) => f.checksum));

    const result = await service.restore(snap.snapshotId);
    expect(result.matches).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.restored).toEqual(snap.files.map(({ path: p, checksum }) => ({ path: p, checksum })));
    expect(read(testapp, 'mock-api.js')).toBe('original mock-api.js\n');
    expect(service.currentChecksums()).toEqual(result.restored);
  });

  it('retains snapshots after restore and across several creations', async () => {
    const { service } = setup();
    const a = await service.create('baseline');
    const b = await service.create('repair');
    await service.restore(a.snapshotId);
    const ids = (await service.list()).map((s) => s.snapshotId);
    expect(ids).toEqual([a.snapshotId, b.snapshotId]);
    expect(await service.get(a.snapshotId)).toEqual(a);
  });

  it('denies writes outside the Approved_Files through the File_Guard and writes nothing', async () => {
    // The service is configured with an extra file the File_Guard does not approve.
    const { testapp, service } = setup({ guardApproved: ['mock-api.js', 'public/button.js'], serviceApproved: APPROVED });
    const snap = await service.create('baseline');
    fs.writeFileSync(path.join(testapp, 'mock-api.js'), 'changed');
    fs.writeFileSync(path.join(testapp, 'public', 'button.css'), 'changed');
    await expect(service.restore(snap.snapshotId)).rejects.toMatchObject({ code: 'write_denied' });
    expect(read(testapp, 'mock-api.js')).toBe('changed');
    expect(read(testapp, 'public/button.css')).toBe('changed');
  });

  it('denies snapshot content writes when the storage directory is not a File_Guard storage dir', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-')));
    temps.push(base);
    const testapp = path.join(base, 'testapp');
    fs.mkdirSync(testapp);
    fs.writeFileSync(path.join(testapp, 'mock-api.js'), 'x');
    const guarded = path.join(base, 'guarded');
    const other = path.join(base, 'other');
    fs.mkdirSync(guarded);
    fs.mkdirSync(other);
    const fileGuard = createFileGuard({ testappDir: testapp, approvedFiles: ['mock-api.js'], storageDirs: [guarded] });
    const service = createSnapshotService({
      testappDir: testapp, approvedFiles: ['mock-api.js'], storageDir: other, storage: createJsonStore({ directory: guarded }), fileGuard,
    });
    const err = await service.create('baseline').catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err.code).toBe('write_denied');
    expect(fs.existsSync(path.join(other, 'snapshot-content'))).toBe(false);
  });

  it('refuses to restore when stored content no longer matches its checksum', async () => {
    const { testapp, store, service } = setup();
    const snap = await service.create('baseline');
    fs.writeFileSync(path.join(store, ...snap.files[0].contentRef.split('/')), 'tampered');
    fs.writeFileSync(path.join(testapp, 'mock-api.js'), 'changed');
    await expect(service.restore(snap.snapshotId)).rejects.toMatchObject({ code: 'content_corrupt' });
    expect(read(testapp, 'mock-api.js')).toBe('changed');
  });

  it('rejects an unknown reason and an unknown snapshot', async () => {
    const { service } = setup();
    await expect(service.create('nope')).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(service.restore('missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});
