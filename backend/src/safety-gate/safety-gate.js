// Safety_Gate (Task 8.1, Requirements 8.2, 8.3, 9.1-9.7, 9.9).
//
// evaluate(plan, config) is a pure, deterministic function: no AI model, no file system, no
// network, no clock. Every rule R1..R7 is evaluated (no short-circuit) and recorded in the
// decision. Approval is granted only if all rules pass.
//
// config (the loaded orchestrator configuration):
//   actionAllowlist: [{actionType, allowedFiles, maxChangedLines}]
//   approvedFiles:   string[]
//   resolveTarget?:  (targetFile) => {ok:true, relative:string} | {ok:false, code?, message?}
//                    Injected by the Orchestrator (it does the I/O, e.g. File_Guard realpath).
//                    `relative` is the symlink-resolved path relative to the Test_App root. When it
//                    is absent only the lexical path is checked.
//
// On approval the decision carries an approval token: HMAC-SHA256 over the canonical plan JSON
// with a per-process random key that exists only in memory. The Repair_Executor calls
// verifyApproval(plan, approval) to prove the token belongs to the plan content it received.
// Recording the `gate` Event is done by the Orchestrator (see orchestrator/gate-recorder.js).

import crypto from 'node:crypto';
import { checkRelativePathSyntax, checkSensitiveFile, actionFileCompatible } from '../file-guard/path-safety.js';
import { redact } from '../events/redactor.js';

export const MAX_CHANGED_LINES = 50;
export const RULE_IDS = Object.freeze(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);

const PLAN_KEYS = new Set(['incidentId', 'actionType', 'targetFile', 'change', 'rationale']);
const SHELL_FIELD_NAMES = new Set([
  'shell', 'command', 'commands', 'cmd', 'script', 'scripts', 'exec', 'execute', 'run', 'args', 'argv', 'bash', 'powershell', 'sh',
]);
const DELETE_FIELD_NAMES = new Set(['delete', 'deletefile', 'delete_file', 'remove', 'removefile', 'remove_file', 'unlink', 'deleted']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- canonical JSON and hashing

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashPlan(plan) {
  return crypto.createHash('sha256').update(canonicalize(plan), 'utf8').digest('hex');
}

// In-memory only. Never written to a file, Event or log.
const PROCESS_KEY = crypto.randomBytes(32);

const sign = (key, plan) => crypto.createHmac('sha256', key).update(canonicalize(plan), 'utf8').digest('hex');

/**
 * Check that `approval` was issued by this process's gate for exactly this plan content.
 * @returns {boolean}
 */
export function verifyApproval(plan, approval, key = PROCESS_KEY) {
  if (!isObject(approval) || typeof approval.token !== 'string' || typeof approval.planHash !== 'string') return false;
  if (hashPlan(plan) !== approval.planHash) return false;
  const expected = Buffer.from(sign(key, plan), 'hex');
  let given;
  try {
    given = Buffer.from(approval.token, 'hex');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------- content helpers

function collectStrings(value, out = [], seen = new Set()) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const v of Array.isArray(value) ? value : Object.values(value)) collectStrings(v, out, seen);
  }
  return out;
}

function collectKeys(value, out = [], seen = new Set()) {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out, seen));
    else for (const [k, v] of Object.entries(value)) { out.push(k); collectKeys(v, out, seen); }
  }
  return out;
}

const lineCount = (s) => (s === '' ? 0 : s.split('\n').length);

/** For {find, replace}: max(lines(find), lines(replace)). Otherwise the largest string value. */
function changedLineCount(change) {
  if (!isObject(change)) return 0;
  if (typeof change.find === 'string' || typeof change.replace === 'string') {
    return Math.max(lineCount(change.find ?? ''), lineCount(change.replace ?? ''));
  }
  // Unknown shapes are measured by the sum of the line counts of every string they carry.
  return collectStrings(change).reduce((n, s) => n + lineCount(s), 0);
}

const SHELL_PATTERNS = [
  /\b(?:child_process|execSync|execFile(?:Sync)?|spawn(?:Sync)?|fork)\b/,
  /(?<![.\w$])(?:exec|system|popen)\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\brequire\s*\(\s*['"`](?:node:)?(?:child_process|vm|worker_threads|cluster)['"`]/,
  /\bimport\s*\(?\s*['"`](?:node:)?(?:child_process|vm|worker_threads)['"`]/,
  /\bprocess\.(?:binding|dlopen|kill)\b/,
  /(?:^|[\s;&|`(])(?:rm|rmdir|curl|wget|chmod|chown|sudo|powershell|pwsh|cmd\.exe|npm|npx|taskkill)\s+-?[\w./\\:-]/m,
  /(?:^|[\s;&|`(])(?:bash|sh|zsh)\s+-/m,
  /\b(?:bash|sh|zsh)\s+-c\b/,
  /[;&|]\s*(?:rm|curl|wget|powershell|pwsh|bash|sh)\b/,
];

const NETWORK_PATTERNS = [
  /\b(?:https?|wss?|ftp):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#\s'"`]|$))/i,
  /(?:['"`(=\s])\/\/[a-z0-9.-]+\.[a-z]{2,}/i,
  /\bnavigator\.sendBeacon\b/,
  /\bnew\s+(?:WebSocket|EventSource)\b/,
  /\bXMLHttpRequest\b/,
  /\brequire\s*\(\s*['"`](?:node:)?(?:https?|net|tls|dgram|dns|http2)['"`]/,
  /\bimport\s*\(?\s*['"`](?:node:)?(?:https?|net|tls|dgram|dns|http2)['"`]/,
  /\b(?:axios|got|superagent|node-fetch|undici)\b/,
];

const TEST_DISABLE_PATTERNS = [
  /\b(?:it|test|describe|suite)\s*\.\s*(?:skip|only|todo|fails)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /\b(?:skip|disable|bypass|ignore|remove|delete|edit|modify|comment\s+out|silence|mock\s+out)\b[^\n]{0,60}\b(?:tests?|specs?|health[\s_-]?checks?|healthz?|assertions?)\b/i,
  /\b(?:tests?|specs?|health[\s_-]?checks?|assertions?)\b[^\n]{0,60}\b(?:skip(?:ped)?|disabled?|bypass(?:ed)?|ignored?)\b/i,
  /\b(?:\.test|\.spec)\.[cm]?[jt]sx?\b/,
  /\bplaywright\.config|\bvitest\.config/i,
];

function hasSecret(text) {
  return redact(text) !== text;
}

const matchesAny = (patterns, text) => patterns.some((re) => re.test(text));

// ---------------------------------------------------------------- rules

const rule = (id, requirement, passed, reason) => ({ id, requirement, passed, reason });

function targetOf(plan) {
  return isObject(plan) && typeof plan.targetFile === 'string' ? plan.targetFile : null;
}

function evalR1(plan, config) {
  const req = '9.1';
  const allowlist = Array.isArray(config?.actionAllowlist) ? config.actionAllowlist : [];
  const type = isObject(plan) ? plan.actionType : undefined;
  if (typeof type !== 'string' || type === '') return rule('R1', req, false, 'Plan has no action type.');
  const entry = allowlist.find((e) => isObject(e) && e.actionType === type);
  if (!entry) return rule('R1', req, false, `Action type "${type}" is not in the Action_Allowlist.`);
  const target = targetOf(plan);
  if (target === null) return rule('R1', req, false, 'Plan has no target file to check against the allowlist entry.');
  if (!Array.isArray(entry.allowedFiles) || !entry.allowedFiles.includes(target)) {
    return rule('R1', req, false, `Action type "${type}" may not modify "${target}".`);
  }
  if (!actionFileCompatible(type, target)) {
    return rule('R1', req, false, `Action type "${type}" cannot be applied to this kind of file.`);
  }
  return rule('R1', req, true, `Action type "${type}" is allowlisted for this file.`);
}

function evalR2(plan, config) {
  const req = '9.2';
  const target = targetOf(plan);
  if (target === null) return rule('R2', req, false, 'Plan has no target file.');
  const approved = Array.isArray(config?.approvedFiles) ? config.approvedFiles : [];
  if (!approved.includes(target)) return rule('R2', req, false, `"${target}" is not an exact member of Approved_Files.`);
  if (typeof config?.resolveTarget === 'function') {
    let resolved;
    try {
      resolved = config.resolveTarget(target);
    } catch {
      return rule('R2', req, false, 'Target path could not be resolved.');
    }
    if (!isObject(resolved) || resolved.ok !== true || typeof resolved.relative !== 'string') {
      return rule('R2', req, false, `Target path did not resolve to a regular file inside the Test_App${resolved?.code ? ` (${resolved.code})` : ''}.`);
    }
    if (resolved.relative !== target || !approved.includes(resolved.relative)) {
      return rule('R2', req, false, `Target resolves to "${resolved.relative}", which is not the approved path.`);
    }
  }
  return rule('R2', req, true, `"${target}" is an exact Approved_File.`);
}

function evalR3(plan) {
  const req = '9.3';
  const target = targetOf(plan);
  if (target === null) return rule('R3', req, false, 'Plan has no target file path.');
  const syntax = checkRelativePathSyntax(target);
  if (!syntax.ok) return rule('R3', req, false, `Unsafe path (${syntax.code}): ${syntax.message}`);
  if (/%(?:2e|2f|5c|00)/i.test(target)) return rule('R3', req, false, 'Path contains an encoded traversal or separator.');
  return rule('R3', req, true, 'Path is a plain relative path inside the Test_App.');
}

function evalR4(plan) {
  const req = '9.4';
  const target = targetOf(plan);
  if (target === null) return rule('R4', req, false, 'Plan has no target file path.');
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const sensitive = checkSensitiveFile(normalized);
  if (!sensitive.ok) return rule('R4', req, false, `Forbidden target: ${sensitive.message}`);
  const base = normalized.toLowerCase().split('/').pop();
  if (/secret|credential|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa/.test(base)) return rule('R4', req, false, 'Forbidden target: secret material.');
  return rule('R4', req, true, 'Target is not in a forbidden category.');
}

function evalR5(plan, config) {
  const req = '9.5';
  const change = isObject(plan) ? plan.change : undefined;
  if (!isObject(change)) return rule('R5', req, false, 'Plan has no structured change.');
  const deletes = Object.entries(change).some(([k, v]) => DELETE_FIELD_NAMES.has(k.toLowerCase()) && v !== false && v !== null && v !== undefined);
  const type = typeof plan.actionType === 'string' ? plan.actionType : '';
  if (deletes || /delete|remove|unlink/i.test(type)) return rule('R5', req, false, 'The plan deletes a file.');
  const entry = (Array.isArray(config?.actionAllowlist) ? config.actionAllowlist : []).find((e) => isObject(e) && e.actionType === type);
  const entryMax = Number.isInteger(entry?.maxChangedLines) && entry.maxChangedLines > 0 ? entry.maxChangedLines : MAX_CHANGED_LINES;
  const limit = Math.min(MAX_CHANGED_LINES, entryMax);
  const lines = changedLineCount(change);
  if (lines > limit) return rule('R5', req, false, `Change touches ${lines} lines; the limit is ${limit}.`);
  return rule('R5', req, true, `Change touches ${lines} lines (limit ${limit}) and deletes no file.`);
}

function evalR6(plan) {
  const req = '9.6';
  const change = isObject(plan) ? plan.change : undefined;
  if (!isObject(change)) return rule('R6', req, false, 'Plan has no structured change to inspect.');
  const strings = collectStrings(change);
  const text = strings.join('\n');
  // Each string is also scanned alone so a secret split across joined values cannot appear by accident.
  if (strings.some(hasSecret) || hasSecret(text)) return rule('R6', req, false, 'Change content contains a Secret pattern.');
  if (matchesAny(SHELL_PATTERNS, text)) return rule('R6', req, false, 'Change content contains a shell command.');
  if (matchesAny(NETWORK_PATTERNS, text)) return rule('R6', req, false, 'Change content contains an external network call.');
  if (matchesAny(TEST_DISABLE_PATTERNS, text)) return rule('R6', req, false, 'Change content disables or edits a test or Health_Check.');
  return rule('R6', req, true, 'Change content has no Secret, shell, external network or test-disable pattern.');
}

function evalR7(plan) {
  const req = '8.2, 8.3';
  if (!isObject(plan)) return rule('R7', req, false, 'Plan is not an object.');
  const problems = [];
  const target = plan.targetFile;
  if (typeof target !== 'string' || target === '') problems.push('plan must name exactly one target file as a string');
  else if (/[\n\r,;|*?]|\s/.test(target)) problems.push('targetFile appears to name more than one file');
  for (const k of Object.keys(plan)) {
    if (!PLAN_KEYS.has(k)) problems.push(`unexpected plan field "${k}"`);
  }
  for (const k of [...Object.keys(plan), ...collectKeys(plan.change)]) {
    if (SHELL_FIELD_NAMES.has(k.toLowerCase())) problems.push(`shell field "${k}" is not allowed`);
  }
  if (isObject(plan.change) && (Array.isArray(plan.change.files) || Array.isArray(plan.change.targets) || 'targetFile' in plan.change)) {
    problems.push('change must not name additional target files');
  }
  if (problems.length > 0) return rule('R7', req, false, [...new Set(problems)].join('; ') + '.');
  return rule('R7', req, true, 'Plan has exactly one target file and no shell field.');
}

// ---------------------------------------------------------------- evaluate

function safeEval(fn, id, req) {
  try {
    return fn();
  } catch {
    // Anything unexpected fails closed.
    return rule(id, req, false, 'Rule could not be evaluated.');
  }
}

/**
 * Evaluate a Repair_Plan.
 * @returns {{approved: boolean, planHash: string|null, rules: Array<{id,requirement,passed,reason}>,
 *            reasons: string[], approval: {token: string, planHash: string}|null}}
 */
export function evaluate(plan, config, { key = PROCESS_KEY } = {}) {
  const rules = [
    safeEval(() => evalR1(plan, config), 'R1', '9.1'),
    safeEval(() => evalR2(plan, config), 'R2', '9.2'),
    safeEval(() => evalR3(plan), 'R3', '9.3'),
    safeEval(() => evalR4(plan), 'R4', '9.4'),
    safeEval(() => evalR5(plan, config), 'R5', '9.5'),
    safeEval(() => evalR6(plan), 'R6', '9.6'),
    safeEval(() => evalR7(plan), 'R7', '8.2, 8.3'),
  ];
  const approved = rules.every((r) => r.passed);
  let planHash = null;
  try {
    planHash = isObject(plan) ? hashPlan(plan) : null;
  } catch {
    planHash = null;
  }
  const reasons = rules.filter((r) => !r.passed).map((r) => `${r.id}: ${r.reason}`);
  const approval = approved && planHash ? { token: sign(key, plan), planHash } : null;
  return { approved, planHash, rules, reasons, approval };
}
