// Path safety helpers for configuration paths (Task 2.2).
// A path is accepted only if it is a plain relative path with forward-slash segments that
// resolves, after symlink resolution, to a regular file strictly inside the Test_App root.
// Unsafe input is rejected, never corrected or normalised into something acceptable.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Syntactic validation of a Test_App-relative path. Pure, no file system access.
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function checkRelativePathSyntax(candidate) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (typeof candidate !== 'string') return fail('not_string', 'Path must be a string.');
  if (candidate.length === 0) return fail('empty', 'Path must not be empty.');
  if (candidate.length > 260) return fail('too_long', 'Path is longer than 260 characters.');
  if (candidate.includes('\0')) return fail('null_byte', 'Path contains a null byte.');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(candidate)) return fail('control_character', 'Path contains a control character.');
  if (candidate !== candidate.trim()) return fail('whitespace', 'Path has leading or trailing whitespace.');
  if (candidate.includes('\\')) return fail('backslash', 'Path must use forward slashes only.');
  if (candidate.includes(':')) return fail('colon', 'Path must not contain ":" (drive letter or alternate data stream).');
  if (candidate.startsWith('/')) return fail('absolute', 'Path must be relative (no leading "/" or UNC prefix).');
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    return fail('absolute', 'Path must be relative.');
  }
  if (/[*?"<>|]/.test(candidate)) return fail('wildcard_or_reserved', 'Path contains a wildcard or reserved character.');
  const segments = candidate.split('/');
  for (const segment of segments) {
    if (segment === '') return fail('empty_segment', 'Path contains an empty segment or a trailing slash.');
    if (segment === '.' || segment === '..') return fail('traversal', 'Path contains a "." or ".." segment.');
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return fail('trailing_dot_or_space', 'A path segment ends with "." or a space.');
    }
  }
  return { ok: true };
}

const isStrictlyInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Resolve a Test_App-relative path and prove it stays inside the real Test_App directory.
 * Uses path.resolve + path.relative for lexical containment and realpath for symlink/junction
 * containment. The target must exist and be a regular (non-symlink) file.
 * @returns {{ok: true, relative: string, absolute: string, real: string}
 *          | {ok: false, code: string, message: string}}
 */
export function resolveApprovedFile(testappDir, candidate) {
  const syntax = checkRelativePathSyntax(candidate);
  if (!syntax.ok) return syntax;
  const fail = (code, message) => ({ ok: false, code, message });

  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(testappDir));
    if (!fs.statSync(realRoot).isDirectory()) return fail('root_not_directory', 'Test_App root is not a directory.');
  } catch {
    return fail('root_missing', 'Test_App root directory does not exist.');
  }

  const absolute = path.resolve(realRoot, ...candidate.split('/'));
  if (!isStrictlyInside(absolute, realRoot)) {
    return fail('outside_root', 'Path resolves outside the Test_App directory.');
  }

  let lst;
  try {
    lst = fs.lstatSync(absolute);
  } catch {
    return fail('not_found', 'File does not exist inside the Test_App directory.');
  }
  if (lst.isSymbolicLink()) return fail('symlink', 'Path is a symbolic link.');
  if (!lst.isFile()) return fail('not_a_file', 'Path is not a regular file.');

  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return fail('not_found', 'File could not be resolved.');
  }
  if (!isStrictlyInside(real, realRoot)) {
    return fail('outside_root', 'Path resolves outside the Test_App directory (symlink or junction).');
  }
  // A symlinked or junctioned intermediate directory that stays inside the root would still let
  // one file be reached through several names; the approved path must be the real path.
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  if (fold(path.normalize(real)) !== fold(path.normalize(absolute))) {
    return fail('symlink', 'Path traverses a symbolic link or junction.');
  }
  return { ok: true, relative: candidate, absolute, real };
}

// ---------------------------------------------------------------------------------------------
// Sensitive targets and action/file compatibility.

const SENSITIVE_DIRECTORIES = new Set([
  'node_modules', 'frontend', 'backend', '.kiro', '.git', 'tests', '__tests__', 'e2e',
]);
const SENSITIVE_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml',
]);
// Files the verification itself depends on: repairing them could make a broken app report healthy.
const VERIFICATION_CRITICAL_BASENAMES = new Set(['health.js', 'server.js']);
const SENSITIVE_EXTENSIONS = new Set(['.json', '.yml', '.yaml', '.toml', '.ini']);

/**
 * Reject targets that must never be repairable: environment files, package manifests and lock
 * files, node_modules, configuration files, test files and the frontend/backend/.kiro/.git trees.
 * Pure and case-insensitive. Expects a syntactically valid relative path.
 * @returns {{ok: true} | {ok: false, code: 'sensitive_file', message: string}}
 */
export function checkSensitiveFile(candidate) {
  const fail = (message) => ({ ok: false, code: 'sensitive_file', message });
  if (typeof candidate !== 'string') return fail('Path must be a string.');
  const segments = candidate.toLowerCase().split('/');
  const base = segments[segments.length - 1];
  for (const dir of segments.slice(0, -1)) {
    if (SENSITIVE_DIRECTORIES.has(dir)) return fail(`Path is under the protected directory "${dir}/".`);
  }
  if (SENSITIVE_DIRECTORIES.has(base)) return fail(`Path names the protected location "${base}".`);
  if (VERIFICATION_CRITICAL_BASENAMES.has(base)) {
    return fail(`"${base}" is verification-critical (it produces the health verdict or serves it) and is not approvable.`);
  }
  if (base.startsWith('.env')) return fail('Environment files are not approvable.');
  if (SENSITIVE_BASENAMES.has(base)) return fail(`"${base}" is a package manifest or package manager config.`);
  if (base.startsWith('.')) return fail('Dot-files are configuration and are not approvable.');
  if (/\.config\.[a-z]+$/.test(base) || /^(tsconfig|jsconfig)[^/]*$/.test(base)) return fail('Configuration files are not approvable.');
  const ext = path.posix.extname(base);
  if (SENSITIVE_EXTENSIONS.has(ext)) return fail(`"${ext}" files are configuration or data and are not approvable.`);
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return fail('Test files are not approvable.');
  return { ok: true };
}

/**
 * Action type / file compatibility: replace_text edits .js files only, replace_style_rule edits
 * .css files only and replace_mock_api_handler edits exactly mock-api.js.
 */
export function actionFileCompatible(actionType, file) {
  if (typeof file !== 'string') return false;
  const lower = file.toLowerCase();
  if (actionType === 'replace_text') return lower.endsWith('.js');
  if (actionType === 'replace_style_rule') return lower.endsWith('.css');
  if (actionType === 'replace_mock_api_handler') return file === 'mock-api.js';
  return false;
}
