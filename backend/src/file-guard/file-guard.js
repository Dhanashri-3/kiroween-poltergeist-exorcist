// File_Guard (Task 3.3): the single choke point for every write the System performs.
// assertWritable(path, caller) allows a write only if the resolved REAL path is
//   (a) exactly one of the configured Approved_Files inside the Test_App directory, or
//   (b) a file located inside one of the configured storage directories,
// and the caller is permitted to write to that kind of root. Every other request is denied with a
// structured result carrying the data for a `security` Event (Requirement 17.4). Policy denials
// are returned, not thrown. Any file system error fails closed (denied, never allowed).
//
// This module has no Event_Log, storage, agent or network dependency. The caller that receives a
// denial hands `denial.event` to the Event_Log; the guard itself records nothing.
//
// Caller policy (fixed, module-level frozen constants; NOT overridable through options):
//   approved-file writes : scenario-engine, repair-executor, snapshot-service
//   storage-dir writes   : storage, snapshot-service
//   agents (poltergeist, exorcist) are always denied first with code `agent_caller`; any other
//   caller is denied with `unknown_caller`. Supplying approvedFileCallers, storageCallers or
//   agentCallers to createFileGuard throws a TypeError.
//
// A configured storage directory that does not exist yet is allowed: its real location is resolved
// as realpath(nearest existing ancestor) + remaining tail, and that ancestor chain must not be
// redirected by a symlink/junction (otherwise `symlink_escape`).
// Paths must be absolute. Relative paths are denied (`not_absolute`) rather than guessed at.
import fs from 'node:fs';
import path from 'node:path';
import { checkRelativePathSyntax, checkSensitiveFile } from './path-safety.js';

export const DEFAULT_APPROVED_FILE_CALLERS = Object.freeze(['scenario-engine', 'repair-executor', 'snapshot-service']);
export const DEFAULT_STORAGE_CALLERS = Object.freeze(['storage', 'snapshot-service']);
export const AGENT_CALLERS = Object.freeze(['poltergeist', 'exorcist']);

const APPROVED_CALLER_SET = new Set(DEFAULT_APPROVED_FILE_CALLERS);
const STORAGE_CALLER_SET = new Set(DEFAULT_STORAGE_CALLERS);
const AGENT_CALLER_SET = new Set(AGENT_CALLERS);
const REMOVED_OPTIONS = Object.freeze(['approvedFileCallers', 'storageCallers', 'agentCallers']);

// Module-level invariant: an agent name must never be an allowed caller.
for (const agent of AGENT_CALLER_SET) {
  if (APPROVED_CALLER_SET.has(agent) || STORAGE_CALLER_SET.has(agent)) {
    throw new Error(`File_Guard policy error: agent "${agent}" must not be an allowed caller.`);
  }
}

const MAX_PATH_LENGTH = 1024;
const MAX_LOGGED_LENGTH = 200;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

const fold = (p) => (FOLD ? p.toLowerCase() : p);
const sameOrInside = (child, parent) => {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const strictlyInside = (child, parent) => sameOrInside(child, parent) && fold(path.normalize(child)) !== fold(path.normalize(parent));

/** Redact for logging: type-safe, control characters replaced, truncated. Never file contents. */
function redactPath(value) {
  if (typeof value !== 'string') return `[non-string:${value === null ? 'null' : typeof value}]`;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return clean.length > MAX_LOGGED_LENGTH ? `${clean.slice(0, MAX_LOGGED_LENGTH)}...[truncated]` : clean;
}

function redactCaller(value) {
  if (typeof value !== 'string') return null;
  return redactPath(value).slice(0, 80);
}

/** Real path of `p` even if missing: realpath(nearest existing ancestor) + tail. Throws TypeError on any error (fail closed). */
function realOrAncestor(p, fsImpl) {
  const tail = [];
  let cur = p;
  for (;;) {
    let exists = true;
    try {
      fsImpl.lstatSync(cur);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw new TypeError(`Cannot resolve "${redactPath(p)}" while validating storage roots.`);
      exists = false;
    }
    if (exists) {
      let real;
      try {
        real = fsImpl.realpathSync(cur);
      } catch {
        throw new TypeError(`Cannot resolve "${redactPath(p)}" while validating storage roots.`);
      }
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) throw new TypeError(`Cannot resolve "${redactPath(p)}": no existing ancestor.`);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/** Reject storage roots that are a filesystem root, or that contain, equal or lie inside Test_App. */
function validateStorageRoots(rawRoots, lexicalRoots, testappRoot, fsImpl) {
  if (lexicalRoots.length === 0) return;
  const testappVariants = [testappRoot, realOrAncestor(testappRoot, fsImpl)];
  lexicalRoots.forEach((lexical, i) => {
    const label = redactPath(rawRoots[i]);
    const variants = [lexical, realOrAncestor(lexical, fsImpl)];
    for (const v of variants) {
      if (path.parse(v).root === v) throw new TypeError(`storageDirs entry "${label}" must not be a filesystem root.`);
    }
    if (isDriveRootForm(rawRoots[i])) throw new TypeError(`storageDirs entry "${label}" must not be a filesystem root.`);
    for (const s of variants) {
      for (const t of testappVariants) {
        if (sameOrInside(t, s)) throw new TypeError(`storageDirs entry "${label}" must not contain or equal the Test_App directory.`);
        if (sameOrInside(s, t)) throw new TypeError(`storageDirs entry "${label}" must not be inside the Test_App directory.`);
      }
    }
  });
}

class Denied extends Error {
  constructor(code, reason, resolvedPath) {
    super(reason);
    this.code = code;
    this.resolvedPath = resolvedPath ?? null;
  }
}

// The real file system, captured once at module load. Production callers cannot replace it.
const REAL_FS = fs;

/** Path with the drive-root forms `C:`, `C:/`, `C:\` (Windows only), which resolve to a drive root or drive cwd. */
const isDriveRootForm = (raw) => process.platform === 'win32' && /^[A-Za-z]:[\\/]*$/.test(raw);

/**
 * @param {object} options
 * @param {string} options.testappDir Test_App directory.
 * @param {string[]} options.approvedFiles Approved_Files, forward-slash paths relative to testappDir.
 * @param {string[]} options.storageDirs Storage directories (absolute).
 * @param {() => Date} [options.now] Injectable clock (does not affect the path policy).
 * The caller policy is fixed; passing approvedFileCallers, storageCallers or agentCallers throws TypeError.
 * The file system is not injectable: an own `fs` property (even undefined) throws TypeError.
 * Storage roots are validated at creation (TypeError): not a filesystem root, not containing, equal to
 * or inside the Test_App directory (lexically and by real path).
 */
export function createFileGuard(options = {}) {
  if (options !== null && typeof options === 'object' && Object.hasOwn(options, 'fs')) {
    throw new TypeError('createFileGuard option "fs" is not supported: the file system cannot be injected.');
  }
  return buildFileGuard(options, REAL_FS, options?.now);
}

/**
 * TEST-ONLY factory. Same validation and the same decision logic as createFileGuard, but the file
 * system (and optionally the clock) is supplied through `deps`. Never use from production code.
 * @param {object} options Same as createFileGuard (must not contain `fs`).
 * @param {{fs?: object, now?: () => Date}} [deps] fs needs lstatSync and realpathSync.
 */
export function createFileGuardForTesting(options = {}, deps = {}) {
  if (options !== null && typeof options === 'object' && Object.hasOwn(options, 'fs')) {
    throw new TypeError('createFileGuardForTesting: pass fs through the second argument, not options.');
  }
  return buildFileGuard(options, deps.fs ?? REAL_FS, deps.now ?? options?.now);
}

function buildFileGuard(options, fsImpl, nowOption) {
  for (const key of REMOVED_OPTIONS) {
    if (options !== null && typeof options === 'object' && Object.hasOwn(options, key)) {
      throw new TypeError(`createFileGuard option "${key}" is not supported: the caller policy is fixed.`);
    }
  }
  const {
    testappDir,
    approvedFiles = [],
    storageDirs = [],
  } = options;
  const now = nowOption ?? (() => new Date());

  if (typeof testappDir !== 'string' || testappDir === '') throw new TypeError('testappDir must be a non-empty string');
  if (!Array.isArray(approvedFiles)) throw new TypeError('approvedFiles must be an array');
  if (!Array.isArray(storageDirs)) throw new TypeError('storageDirs must be an array');
  for (const d of storageDirs) if (typeof d !== 'string' || d === '') throw new TypeError('storageDirs entries must be non-empty strings');

  const approvedSet = Object.freeze(approvedFiles.filter((f) => checkRelativePathSyntax(f).ok && checkSensitiveFile(f).ok));
  const approvedCallers = APPROVED_CALLER_SET;
  const storageCallerSet = STORAGE_CALLER_SET;
  const agentSet = AGENT_CALLER_SET;
  const testappRoot = path.resolve(testappDir);
  const storageRoots = storageDirs.map((d) => path.resolve(d));

  validateStorageRoots(storageDirs, storageRoots, testappRoot, fsImpl);

  const realpath = (p) => fsImpl.realpathSync(p);

  /** Real path of `p` even if it does not exist yet: realpath of the nearest existing ancestor + tail. */
  function resolveReal(p) {
    const tail = [];
    let cur = p;
    for (;;) {
      let st = null;
      try {
        st = fsImpl.lstatSync(cur);
      } catch (e) {
        if (e?.code === 'ENOTDIR') throw new Denied('not_a_directory', 'A path component is not a directory.');
        if (e?.code !== 'ENOENT') throw new Denied('fs_error', 'File system error while resolving the path.');
      }
      if (st) {
        let real;
        try {
          real = realpath(cur);
        } catch (e) {
          if (e?.code === 'ENOENT') throw new Denied('dangling_symlink', 'Path contains a dangling symbolic link.');
          throw new Denied('fs_error', 'File system error while resolving the path.');
        }
        return { real: tail.length ? path.join(real, ...tail.reverse()) : real, exists: tail.length === 0, stat: tail.length === 0 ? st : null };
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw new Denied('fs_error', 'No existing ancestor directory.');
      tail.push(path.basename(cur));
      cur = parent;
    }
  }

  function realRoot(root) {
    try {
      const real = realpath(root);
      if (!fsImpl.lstatSync(real).isDirectory()) throw new Denied('fs_error', 'Configured root is not a directory.');
      return real;
    } catch (e) {
      if (e instanceof Denied) throw e;
      throw new Denied('fs_error', 'Configured root cannot be resolved.');
    }
  }

  /**
   * Real location of a configured storage root, which may not exist yet. An existing root must be a
   * directory. A missing root is realpath(nearest existing ancestor) + tail; `redirected` is true when
   * that ancestor chain is changed by a symlink/junction (real differs from the configured path).
   */
  function resolveStorageRoot(root) {
    const { real, exists } = resolveReal(root);
    if (exists) {
      let isDir = false;
      try {
        isDir = fsImpl.lstatSync(real).isDirectory();
      } catch {
        throw new Denied('fs_error', 'Configured root cannot be resolved.');
      }
      if (!isDir) throw new Denied('fs_error', 'Configured root is not a directory.');
      return { real, redirected: false };
    }
    return { real, redirected: fold(path.normalize(real)) !== fold(path.normalize(root)) };
  }

  function checkCaller(caller) {
    if (typeof caller !== 'string' || caller.trim() === '') throw new Denied('invalid_caller', 'Caller must be a non-empty string.');
    if (agentSet.has(caller)) throw new Denied('agent_caller', 'Agents may not write files.');
    if (!approvedCallers.has(caller) && !storageCallerSet.has(caller)) throw new Denied('unknown_caller', 'Caller is not recognised.');
  }

  function checkSyntax(candidate) {
    if (typeof candidate !== 'string') throw new Denied('invalid_path', 'Path must be a string.');
    if (candidate === '') throw new Denied('invalid_path', 'Path must not be empty.');
    if (candidate.includes('\0')) throw new Denied('invalid_path', 'Path contains a NUL byte.');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(candidate)) throw new Denied('invalid_path', 'Path contains a control character.');
    if (candidate.length > MAX_PATH_LENGTH) throw new Denied('invalid_path', 'Path is too long.');
    if (candidate.startsWith('\\\\') || candidate.startsWith('//')) throw new Denied('unc_or_device_path', 'UNC and device paths are not allowed.');
    if (!path.isAbsolute(candidate)) throw new Denied('not_absolute', 'Path must be absolute.');
    const rest = candidate.replace(/^[A-Za-z]:/, '');
    if (rest.includes(':')) throw new Denied('invalid_path', 'Path contains ":" (alternate data stream).');
    if (/[*?"<>|]/.test(rest)) throw new Denied('invalid_path', 'Path contains a wildcard or reserved character.');
    for (const seg of candidate.split(/[\\/]/)) {
      if (seg === '..') throw new Denied('traversal', 'Path contains a ".." segment.');
      if (seg !== '' && seg !== '.' && (seg.endsWith('.') || seg.endsWith(' '))) {
        throw new Denied('invalid_path', 'A path segment ends with "." or a space.');
      }
    }
  }

  const isStorageSensitive = (relSegments) => relSegments.some((s) => {
    const l = s.toLowerCase();
    return l === '.git' || l === 'node_modules' || l.startsWith('.env');
  });

  function decide(candidate, caller) {
    checkCaller(caller);
    checkSyntax(candidate);
    const lexical = path.resolve(candidate);
    const { real, exists, stat } = resolveReal(lexical);

    if (exists && stat.isSymbolicLink()) throw new Denied('symlink', 'Target is a symbolic link.', real);
    if (exists && stat.isDirectory()) throw new Denied('is_directory', 'Target is a directory.', real);
    if (exists && !stat.isFile()) throw new Denied('not_a_file', 'Target is not a regular file.', real);

    // Storage directories.
    let escapedStorage = false;
    // A storage-root resolution problem only affects storage decisions, never Approved_Files.
    let storageError = null;
    for (const root of storageRoots) {
      let rr;
      try {
        const resolved = resolveStorageRoot(root);
        if (resolved.redirected) {
          if (strictlyInside(lexical, root)) escapedStorage = true;
          continue;
        }
        rr = resolved.real;
      } catch (e) {
        if (!(e instanceof Denied)) throw e;
        storageError ??= e;
        continue;
      }
      if (strictlyInside(real, rr)) {
        const rel = path.relative(rr, real).split(path.sep);
        if (isStorageSensitive(rel)) throw new Denied('sensitive_file', 'Sensitive file names are not writable.', real);
        if (!storageCallerSet.has(caller)) throw new Denied('caller_not_permitted', 'Caller may not write to storage directories.', real);
        return real;
      }
      if (strictlyInside(lexical, path.resolve(root))) escapedStorage = true;
    }

    // Approved_Files.
    const rt = realRoot(testappRoot);
    if (strictlyInside(real, rt)) {
      const relSegments = path.relative(rt, real).split(path.sep);
      const rel = relSegments.join('/');
      if (!checkSensitiveFile(rel).ok) throw new Denied('sensitive_file', 'Sensitive file names are not writable.', real);
      const match = approvedSet.some((f) => fold(path.join(rt, ...f.split('/'))) === fold(real));
      if (!match) throw new Denied('not_approved', 'File is not an Approved_File.', real);
      if (!approvedCallers.has(caller)) throw new Denied('caller_not_permitted', 'Caller may not write Approved_Files.', real);
      return real;
    }
    if (storageError) throw new Denied(storageError.code, storageError.message, real);
    if (escapedStorage || strictlyInside(lexical, testappRoot)) {
      throw new Denied('symlink_escape', 'Path resolves outside the allowed root (symlink or junction).', real);
    }
    throw new Denied('outside_allowed_roots', 'Path is outside the Approved_Files and storage directories.', real);
  }

  /**
   * @returns {{allowed: true, realPath: string, caller: string}
   *   | {allowed: false, code: string, reason: string, caller: string|null, requestedPath: string,
   *      resolvedPath: string|null, detectedAt: string,
   *      event: {type: 'security', component: 'file-guard', incidentId: null, runId: null, ts: string, payload: object}}}
   */
  function assertWritable(candidate, caller) {
    try {
      return { allowed: true, realPath: decide(candidate, caller), caller };
    } catch (e) {
      const denied = e instanceof Denied ? e : new Denied('fs_error', 'Unexpected error; failing closed.');
      let detectedAt;
      try {
        detectedAt = new Date(now()).toISOString();
      } catch {
        detectedAt = new Date(0).toISOString();
      }
      const requestedPath = redactPath(candidate);
      const callerOut = redactCaller(caller);
      const resolvedPath = denied.resolvedPath ? redactPath(denied.resolvedPath) : null;
      return {
        allowed: false,
        code: denied.code,
        reason: denied.message,
        caller: callerOut,
        requestedPath,
        resolvedPath,
        detectedAt,
        event: {
          type: 'security',
          component: 'file-guard',
          incidentId: null,
          runId: null,
          ts: detectedAt,
          payload: { action: 'write_denied', code: denied.code, reason: denied.message, caller: callerOut, requestedPath, resolvedPath },
        },
      };
    }
  }

  return Object.freeze({ assertWritable });
}
