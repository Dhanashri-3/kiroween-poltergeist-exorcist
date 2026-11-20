import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createFileGuard,
  createFileGuardForTesting,
  DEFAULT_APPROVED_FILE_CALLERS,
  DEFAULT_STORAGE_CALLERS,
  AGENT_CALLERS,
} from '../src/file-guard/file-guard.js';
import { validate } from '../src/contracts/index.js';

const APPROVED = ['mock-api.js', 'public/button.js', 'public/button.css'];
const FIXED = new Date('2025-01-02T03:04:05.000Z');
const temps = [];

function setup(extra = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-guard-')));
  temps.push(base);
  const testapp = path.join(base, 'testapp');
  const store = path.join(base, 'storage-data');
  const outside = path.join(base, 'outside');
  for (const d of [path.join(testapp, 'public'), store, outside]) fs.mkdirSync(d, { recursive: true });
  for (const f of [...APPROVED, 'server.js', 'health.js', 'package.json', '.env']) fs.writeFileSync(path.join(testapp, f), 'x');
  fs.writeFileSync(path.join(store, 'events.json'), '[]');
  const guard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store], now: () => FIXED, ...extra });
  return { base, testapp, store, outside, guard };
}

function link(target, p, type) {
  try { fs.symlinkSync(target, p, type); return true; } catch { return false; }
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

describe('File_Guard allow cases', () => {
  it('allows an approved file for an approved-file caller and returns the real path', () => {
    const { testapp, guard } = setup();
    const r = guard.assertWritable(path.join(testapp, 'public', 'button.js'), 'repair-executor');
    expect(r.allowed).toBe(true);
    expect(r.realPath).toBe(path.join(testapp, 'public', 'button.js'));
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'scenario-engine').allowed).toBe(true);
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'snapshot-service').allowed).toBe(true);
  });

  it('allows existing and new files in a storage directory for storage callers', () => {
    const { store, guard } = setup();
    expect(guard.assertWritable(path.join(store, 'events.json'), 'storage').allowed).toBe(true);
    expect(guard.assertWritable(path.join(store, 'new-file.tmp'), 'storage').allowed).toBe(true);
    expect(guard.assertWritable(path.join(store, 'snapshots', 'deep', 's.json'), 'snapshot-service').allowed).toBe(true);
  });
});

describe('File_Guard path denials', () => {
  it('denies testapp files that are not approved or are sensitive', () => {
    const { testapp, guard } = setup();
    for (const f of ['server.js', 'health.js', 'package.json', '.env', 'public/other.js']) {
      const r = guard.assertWritable(path.join(testapp, ...f.split('/')), 'repair-executor');
      expect(r.allowed, f).toBe(false);
    }
    expect(guard.assertWritable(path.join(testapp, 'public', 'other.js'), 'repair-executor').code).toBe('not_approved');
    expect(guard.assertWritable(path.join(testapp, '.env'), 'repair-executor').code).toBe('sensitive_file');
  });

  it('denies sensitive names inside the storage directory', () => {
    const { store, guard } = setup();
    expect(guard.assertWritable(path.join(store, '.env.local'), 'storage').code).toBe('sensitive_file');
    expect(guard.assertWritable(path.join(store, '.git', 'config'), 'storage').code).toBe('sensitive_file');
  });

  it('denies traversal, outside absolute paths, relative paths and UNC/device paths', () => {
    const { testapp, outside, guard } = setup();
    expect(guard.assertWritable(`${testapp}${path.sep}public${path.sep}..${path.sep}mock-api.js`, 'repair-executor').code).toBe('traversal');
    expect(guard.assertWritable(path.join(outside, 'a.js'), 'repair-executor').code).toBe('outside_allowed_roots');
    expect(guard.assertWritable('public/button.js', 'repair-executor').code).toBe('not_absolute');
    expect(guard.assertWritable('\\\\server\\share\\a.js', 'repair-executor').code).toBe('unc_or_device_path');
    expect(guard.assertWritable('//server/share/a.js', 'repair-executor').code).toBe('unc_or_device_path');
    expect(guard.assertWritable(`${path.join(testapp, 'mock-api.js')}:stream`, 'repair-executor').allowed).toBe(false);
  });

  it('denies directories as write targets', () => {
    const { testapp, store, guard } = setup();
    expect(guard.assertWritable(path.join(testapp, 'public'), 'repair-executor').code).toBe('is_directory');
    expect(guard.assertWritable(store, 'storage').code).toBe('is_directory');
  });

  it('denies NUL, empty and non-string input', () => {
    const { testapp, guard } = setup();
    for (const bad of [`${path.join(testapp, 'mock-api.js')}\0.txt`, '', undefined, null, 42, {}, ['a']]) {
      const r = guard.assertWritable(bad, 'repair-executor');
      expect(r.allowed).toBe(false);
      expect(r.code).toBe('invalid_path');
    }
  });

  it.runIf(process.platform === 'win32')('allows case variants only of the exact approved file (Windows)', () => {
    const { testapp, guard } = setup();
    expect(guard.assertWritable(path.join(testapp, 'PUBLIC', 'Button.JS'), 'repair-executor').allowed).toBe(true);
    expect(guard.assertWritable(path.join(testapp, 'SERVER.JS'), 'repair-executor').allowed).toBe(false);
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js.'), 'repair-executor').allowed).toBe(false);
  });
});

describe('File_Guard symlink and junction escapes', () => {
  it('denies an approved file that is a symlink to an outside file', (ctx) => {
    const { testapp, outside, guard } = setup();
    const target = path.join(outside, 'evil.js');
    fs.writeFileSync(target, 'x');
    fs.rmSync(path.join(testapp, 'mock-api.js'));
    if (!link(target, path.join(testapp, 'mock-api.js'), 'file')) return ctx.skip();
    const r = guard.assertWritable(path.join(testapp, 'mock-api.js'), 'repair-executor');
    expect(r.allowed).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('denies a directory junction/symlink inside testapp pointing outside', (ctx) => {
    const { testapp, outside, guard } = setup();
    fs.rmSync(path.join(testapp, 'public'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'button.js'), 'x');
    if (!link(outside, path.join(testapp, 'public'), 'junction')) return ctx.skip();
    const r = guard.assertWritable(path.join(testapp, 'public', 'button.js'), 'repair-executor');
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('symlink_escape');
  });

  it('denies a storage subdirectory link pointing outside, for existing and new files', (ctx) => {
    const { store, outside, guard } = setup();
    if (!link(outside, path.join(store, 'escape'), 'junction')) return ctx.skip();
    expect(guard.assertWritable(path.join(store, 'escape', 'new.json'), 'storage').code).toBe('symlink_escape');
    fs.writeFileSync(path.join(outside, 'old.json'), '{}');
    expect(guard.assertWritable(path.join(store, 'escape', 'old.json'), 'storage').code).toBe('symlink_escape');
  });

  it('denies a storage file symlink and a dangling symlink', (ctx) => {
    const { store, outside, guard } = setup();
    const target = path.join(outside, 't.json');
    fs.writeFileSync(target, '{}');
    if (!link(target, path.join(store, 'l.json'), 'file')) return ctx.skip();
    expect(guard.assertWritable(path.join(store, 'l.json'), 'storage').allowed).toBe(false);
    fs.rmSync(target);
    expect(guard.assertWritable(path.join(store, 'l.json'), 'storage').allowed).toBe(false);
  });
});

describe('File_Guard caller restrictions', () => {
  it('denies missing, empty and non-string callers', () => {
    const { testapp, guard } = setup();
    for (const c of [undefined, null, '', '  ', 7, {}]) {
      expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), c).code).toBe('invalid_caller');
    }
  });

  it('denies agent callers and unknown callers with distinct codes', () => {
    const { testapp, store, guard } = setup();
    for (const c of ['poltergeist', 'exorcist']) {
      expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), c).code).toBe('agent_caller');
      expect(guard.assertWritable(path.join(store, 'events.json'), c).code).toBe('agent_caller');
    }
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'someone').code).toBe('unknown_caller');
  });

  it('restricts each root to its own callers', () => {
    const { testapp, store, guard } = setup();
    expect(guard.assertWritable(path.join(store, 'events.json'), 'scenario-engine').code).toBe('caller_not_permitted');
    expect(guard.assertWritable(path.join(store, 'events.json'), 'repair-executor').code).toBe('caller_not_permitted');
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'storage').code).toBe('caller_not_permitted');
  });
});

describe('File_Guard denial event data', () => {
  it('carries deterministic security event data that fits the Event contract', () => {
    const { testapp, guard } = setup();
    const target = path.join(testapp, 'server.js');
    const a = guard.assertWritable(target, 'repair-executor');
    const b = guard.assertWritable(target, 'repair-executor');
    expect(a).toEqual(b);
    expect(a.allowed).toBe(false);
    expect(a.detectedAt).toBe(FIXED.toISOString());
    expect(a.caller).toBe('repair-executor');
    expect(a.resolvedPath).toBe(target);
    expect(a.event.type).toBe('security');
    expect(a.event.payload).toMatchObject({ action: 'write_denied', code: a.code, caller: 'repair-executor' });
    const full = { id: randomUUID(), seq: 0, ...a.event };
    expect(validate('Event', full)).toEqual({ valid: true, errors: [] });
  });

  it('redacts and truncates the requested path and survives odd input', () => {
    const { guard } = setup();
    const long = `/${'a'.repeat(5000)}\0\n`;
    const r = guard.assertWritable(long, { toString() { throw new Error('boom'); } });
    expect(r.allowed).toBe(false);
    expect(r.requestedPath.length).toBeLessThan(260);
    expect(r.requestedPath).not.toMatch(/[\x00-\x1f]/); // eslint-disable-line no-control-regex
    expect(r.caller).toBeNull();
    expect(validate('Event', { id: randomUUID(), seq: 1, ...r.event }).valid).toBe(true);
    expect(guard.assertWritable(Symbol('s'), 'storage').requestedPath).toBe('[non-string:symbol]');
  });
});

describe('File_Guard fail-closed and isolation', () => {
  it('denies when the file system throws', () => {
    const { testapp } = setup();
    const broken = { ...fs, lstatSync: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
    const guard = createFileGuardForTesting({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [], now: () => FIXED }, { fs: broken });
    const r = guard.assertWritable(path.join(testapp, 'mock-api.js'), 'repair-executor');
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('fs_error');
  });

  it('denies when a configured root is missing', () => {
    const { base, store } = setup();
    const guard = createFileGuard({ testappDir: path.join(base, 'nope'), approvedFiles: APPROVED, storageDirs: [store] });
    expect(guard.assertWritable(path.join(base, 'nope', 'mock-api.js'), 'repair-executor').allowed).toBe(false);
  });

  it('rejects invalid configuration', () => {
    expect(() => createFileGuard({})).toThrow(TypeError);
    expect(() => createFileGuard({ testappDir: 'x', storageDirs: [1] })).toThrow(TypeError);
  });

  it('source has no Event_Log, storage implementation or agent imports', () => {
    const src = fs.readFileSync(new URL('../src/file-guard/file-guard.js', import.meta.url), 'utf8');
    const specifiers = [...src.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(['./path-safety.js', 'node:fs', 'node:path']);
    expect(specifiers.join(' ')).not.toMatch(/events|storage|poltergeist|exorcist/);
  });
});

describe('File_Guard missing storage directory', () => {
  function setupMissing() {
    const s = setup();
    fs.rmSync(s.store, { recursive: true, force: true });
    return s;
  }

  it('still allows Approved_Files writes when the configured storage dir does not exist', () => {
    const { testapp, guard } = setupMissing();
    const r = guard.assertWritable(path.join(testapp, 'public', 'button.css'), 'repair-executor');
    expect(r.allowed).toBe(true);
    expect(guard.assertWritable(path.join(testapp, 'public', 'other.js'), 'repair-executor').code).toBe('not_approved');
  });

  it('allows storage writes (including nested new paths) when the storage root does not exist yet', () => {
    const { store, guard } = setupMissing();
    for (const caller of ['storage', 'snapshot-service']) {
      expect(guard.assertWritable(path.join(store, 'events.json'), caller).allowed, caller).toBe(true);
      const r = guard.assertWritable(path.join(store, 'snapshots', 'deep', 's.json'), caller);
      expect(r.allowed, caller).toBe(true);
      expect(r.realPath).toBe(path.join(store, 'snapshots', 'deep', 's.json'));
    }
    expect(fs.existsSync(store)).toBe(false);
  });

  it('allows storage writes when several missing levels precede the storage root', () => {
    const { base, testapp } = setup();
    const deep = path.join(base, 'a', 'b', 'storage-data');
    const guard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [deep] });
    expect(guard.assertWritable(path.join(deep, 'x', 'y.json'), 'storage').allowed).toBe(true);
  });

  it('denies writes outside the missing root: sibling with shared prefix, traversal, other paths', () => {
    const { base, store, guard } = setupMissing();
    expect(guard.assertWritable(path.join(`${store}-evil`, 'x.json'), 'storage').code).toBe('outside_allowed_roots');
    expect(guard.assertWritable(path.join(base, 'unconfigured', 'x.json'), 'storage').code).toBe('outside_allowed_roots');
    expect(guard.assertWritable(path.join(base, 'outside', 'x.json'), 'snapshot-service').code).toBe('outside_allowed_roots');
    expect(guard.assertWritable(`${store}${path.sep}..${path.sep}outside${path.sep}x.json`, 'storage').code).toBe('traversal');
    expect(guard.assertWritable(store, 'storage').allowed).toBe(false);
  });

  it('denies a missing storage root whose existing ancestor is a link pointing outside', (ctx) => {
    const { base, testapp, outside } = setup();
    const linked = path.join(base, 'linked');
    if (!link(outside, linked, 'junction')) return ctx.skip();
    const root = path.join(linked, 'storage-data');
    const guard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [root] });
    const r = guard.assertWritable(path.join(root, 'sub', 'x.json'), 'storage');
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('symlink_escape');
    expect(fs.existsSync(path.join(outside, 'storage-data'))).toBe(false);
  });

  it('keeps the caller check for a missing-root storage path', () => {
    const { store, guard } = setupMissing();
    expect(guard.assertWritable(path.join(store, 'x.json'), 'scenario-engine').code).toBe('caller_not_permitted');
    expect(guard.assertWritable(path.join(store, 'x.json'), 'repair-executor').code).toBe('caller_not_permitted');
    expect(guard.assertWritable(path.join(store, 'x.json'), 'exorcist').code).toBe('agent_caller');
    expect(guard.assertWritable(path.join(store, 'x.json'), 'someone').code).toBe('unknown_caller');
  });

  it('fails closed with fs_error, only for storage decisions, when a storage root cannot be resolved', () => {
    const { base, testapp, store } = setup();
    const root = path.join(base, 'broken-root');
    let armed = false; // fault is injected only after creation: root validation itself fails closed
    const flaky = {
      ...fs,
      lstatSync: (p, ...rest) => {
        if (armed && String(p).startsWith(root)) throw Object.assign(new Error('x'), { code: 'EIO' });
        return fs.lstatSync(p, ...rest);
      },
    };
    const guard = createFileGuardForTesting({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [root, store] }, { fs: flaky });
    armed = true;
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'repair-executor').allowed).toBe(true);
    expect(guard.assertWritable(path.join(root, 'x.json'), 'storage').code).toBe('fs_error');
    expect(guard.assertWritable(path.join(store, 'x.json'), 'storage').allowed).toBe(true);
  });

  it('denies a storage root that exists but is a file', () => {
    const { base, testapp } = setup();
    const file = path.join(base, 'afile');
    fs.writeFileSync(file, 'x');
    const guard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [file] });
    expect(guard.assertWritable(path.join(file, 'x.json'), 'storage').allowed).toBe(false);
  });
});

describe('File_Guard fixed caller policy', () => {
  const OVERRIDES = [
    { agentCallers: [] },
    { approvedFileCallers: ['exorcist', 'poltergeist'] },
    { approvedFileCallers: ['scenario-engine'] },
    { storageCallers: ['exorcist'] },
    { storageCallers: ['poltergeist', 'storage'] },
  ];

  it('throws TypeError when any removed caller-override option is supplied', () => {
    const { testapp, store } = setup();
    for (const o of OVERRIDES) {
      expect(() => createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store], ...o })).toThrow(TypeError);
    }
    expect(() => createFileGuard({ testappDir: testapp, agentCallers: undefined })).toThrow(TypeError);
  });

  it('agents stay denied with agent_caller (guard built without overrides)', () => {
    const { testapp, store, guard } = setup();
    for (const c of ['exorcist', 'poltergeist']) {
      expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), c).code).toBe('agent_caller');
      expect(guard.assertWritable(path.join(store, 'events.json'), c).code).toBe('agent_caller');
    }
  });

  it('exported policy constants are frozen and mutation attempts do not change policy', () => {
    expect(Object.isFrozen(DEFAULT_APPROVED_FILE_CALLERS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STORAGE_CALLERS)).toBe(true);
    expect(Object.isFrozen(AGENT_CALLERS)).toBe(true);
    const { testapp, store, guard } = setup();
    for (const arr of [DEFAULT_APPROVED_FILE_CALLERS, DEFAULT_STORAGE_CALLERS]) {
      expect(() => arr.push('exorcist')).toThrow(TypeError);
    }
    expect(() => AGENT_CALLERS.pop()).toThrow(TypeError);
    expect(() => { DEFAULT_STORAGE_CALLERS[0] = 'exorcist'; }).toThrow(TypeError);
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'exorcist').code).toBe('agent_caller');
    expect(guard.assertWritable(path.join(store, 'events.json'), 'exorcist').code).toBe('agent_caller');
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'storage').code).toBe('caller_not_permitted');
  });

  it('allowed caller sets contain no agent name', () => {
    for (const agent of AGENT_CALLERS) {
      expect(DEFAULT_APPROVED_FILE_CALLERS).not.toContain(agent);
      expect(DEFAULT_STORAGE_CALLERS).not.toContain(agent);
    }
  });
});

describe('File_Guard storage root validation at creation', () => {
  const make = (testapp, roots, factory = createFileGuard) => () => factory({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: roots });

  it('rejects a filesystem root', () => {
    const { testapp } = setup();
    expect(make(testapp, [path.parse(os.tmpdir()).root])).toThrow(TypeError);
    expect(make(testapp, [path.parse(os.tmpdir()).root])).toThrow(/filesystem root/);
  });

  it.runIf(process.platform === 'win32')('rejects drive-root forms C: and C:/ (Windows)', () => {
    const { testapp } = setup();
    const drive = path.parse(os.tmpdir()).root.slice(0, 2);
    expect(make(testapp, [drive])).toThrow(TypeError);
    expect(make(testapp, [`${drive}/`])).toThrow(TypeError);
  });

  it('rejects a storage root equal to, inside, or containing Test_App', () => {
    const { base, testapp } = setup();
    expect(make(testapp, [testapp])).toThrow(/Test_App/);
    expect(make(testapp, [path.join(testapp, 'data')])).toThrow(/inside the Test_App/);
    expect(make(testapp, [path.join(testapp, 'public')])).toThrow(TypeError);
    expect(make(testapp, [base])).toThrow(/contain or equal/);
    expect(make(testapp, [path.dirname(base)])).toThrow(TypeError);
    expect(make(testapp, [`${testapp}${path.sep}.`])).toThrow(TypeError);
  });

  it('accepts siblings that only share a name prefix with Test_App or each other', () => {
    const { base, testapp } = setup();
    for (const name of ['testapp-data', 'testapp2']) {
      const g = make(testapp, [path.join(base, name)])();
      expect(g.assertWritable(path.join(base, name, 'x.json'), 'storage').allowed).toBe(true);
    }
    const prefixed = createFileGuard({ testappDir: path.join(base, 'testapp2'), approvedFiles: APPROVED, storageDirs: [path.join(base, 'testapp')] });
    expect(prefixed.assertWritable(path.join(base, 'testapp', 'x.json'), 'storage').allowed).toBe(true);
  });

  it('keeps a valid missing storage root accepted and writable', () => {
    const { base, testapp } = setup();
    const root = path.join(base, 'not', 'yet', 'there');
    const g = make(testapp, [root])();
    expect(g.assertWritable(path.join(root, 'n', 'e.json'), 'storage').allowed).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('rejects the whole creation when one of several roots is invalid', () => {
    const { base, testapp, store } = setup();
    expect(make(testapp, [store, path.join(base, 'ok2'), path.join(testapp, 'data')])).toThrow(TypeError);
    expect(make(testapp, [path.join(testapp, 'data'), store])).toThrow(TypeError);
  });

  it.runIf(process.platform === 'win32')('applies case-insensitive comparison on Windows', () => {
    const { base, testapp } = setup();
    expect(make(testapp.toUpperCase(), [path.join(testapp, 'data')])).toThrow(TypeError);
    expect(make(testapp, [path.join(testapp.toUpperCase(), 'DATA')])).toThrow(TypeError);
    expect(make(testapp, [testapp.toLowerCase()])).toThrow(TypeError);
    expect(make(testapp, [base.toUpperCase()])).toThrow(TypeError);
    expect(make(testapp.toLowerCase(), [base.toUpperCase()])).toThrow(TypeError);
    // case folding must not turn a different name into a match
    expect(make(testapp, [path.join(base, 'TESTAPP2')])).not.toThrow();
  });

  it('rejects a storage root that is a link to a directory inside Test_App', (ctx) => {
    const { base, testapp } = setup();
    const linked = path.join(base, 'linked-store');
    if (!link(path.join(testapp, 'public'), linked, 'junction')) return ctx.skip();
    expect(make(testapp, [linked])).toThrow(TypeError);
    expect(make(testapp, [path.join(linked, 'sub')])).toThrow(TypeError);
  });

  it('rejects a storage root whose real path contains Test_App', (ctx) => {
    const { base, testapp } = setup();
    const linked = path.join(base, 'linked-parent');
    if (!link(base, linked, 'junction')) return ctx.skip();
    expect(make(testapp, [linked])).toThrow(TypeError);
  });

  it('rejects a Test_App reached through a link when the storage root is its real location', (ctx) => {
    const { base, testapp } = setup();
    const linkedApp = path.join(base, 'linked-app');
    if (!link(testapp, linkedApp, 'junction')) return ctx.skip();
    expect(make(linkedApp, [path.join(testapp, 'data')])).toThrow(TypeError);
  });

  it('fails closed when resolution errors during validation', () => {
    const { base, testapp } = setup();
    const broken = { ...fs, lstatSync: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
    expect(() => createFileGuardForTesting({ testappDir: testapp, storageDirs: [path.join(base, 'ok')] }, { fs: broken })).toThrow(TypeError);
  });

  it('the test factory applies the same storage-root validation', () => {
    const { testapp } = setup();
    expect(make(testapp, [testapp], createFileGuardForTesting)).toThrow(TypeError);
    expect(make(testapp, [path.parse(os.tmpdir()).root], createFileGuardForTesting)).toThrow(TypeError);
  });
});

describe('File_Guard file system is not injectable through the public factory', () => {
  const lying = { lstatSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, realpathSync: (p) => p };

  it('throws TypeError when fs is supplied, including fs: undefined', () => {
    const { testapp, store } = setup();
    const base = { testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store] };
    expect(() => createFileGuard({ ...base, fs })).toThrow(TypeError);
    expect(() => createFileGuard({ ...base, fs: undefined })).toThrow(TypeError);
    expect(() => createFileGuard({ ...base, fs: null })).toThrow(TypeError);
    expect(() => createFileGuardForTesting({ ...base, fs })).toThrow(TypeError);
  });

  it('a lying fs cannot be used to build a guard that allows an outside path', () => {
    const { testapp, store, outside } = setup();
    let guard = null;
    expect(() => { guard = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store], fs: lying }); }).toThrow(TypeError);
    expect(guard).toBeNull();
    const real = createFileGuard({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store] });
    expect(real.assertWritable(path.join(outside, 'a.js'), 'repair-executor').code).toBe('outside_allowed_roots');
  });

  it('the test factory works with a fake fs and still decides with the shared logic', () => {
    const { testapp, store, outside } = setup();
    const guard = createFileGuardForTesting({ testappDir: testapp, approvedFiles: APPROVED, storageDirs: [store], now: () => FIXED }, { fs: { ...fs } });
    expect(guard.assertWritable(path.join(testapp, 'mock-api.js'), 'repair-executor').allowed).toBe(true);
    const r = guard.assertWritable(path.join(outside, 'a.js'), 'repair-executor');
    expect(r.code).toBe('outside_allowed_roots');
    expect(r.detectedAt).toBe(FIXED.toISOString());
    const clock = createFileGuardForTesting({ testappDir: testapp, approvedFiles: APPROVED }, { now: () => FIXED });
    expect(clock.assertWritable(path.join(outside, 'a.js'), 'repair-executor').detectedAt).toBe(FIXED.toISOString());
  });
});
