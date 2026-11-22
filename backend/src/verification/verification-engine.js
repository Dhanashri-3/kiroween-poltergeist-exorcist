// Verification_Engine (Task 9.3, Requirements 11.1-11.6, 11.10-11.12 and 19.8).
//
//   verify(incident, evidence) -> Verification_Result
//
// Runs the Health_Check, Vitest and Playwright command templates (built only by the command
// builder, so only a template ID and a component from the fixed enum reach a process) as real
// child processes with no shell, stores each check's raw output in a file referenced from the
// result, aggregates, and saves the Verification_Result in the `verifications` collection.
//
// Time limits: each check is bounded by its template timeoutMs and the whole run by 120 seconds
// (Requirement 11.10). When the run limit passes, the running check is killed (with its process
// tree), no later check starts, and the result is `fail` (Requirement 11.11).
//
// Access (Requirement 11.12): the engine can only be constructed for the caller "orchestrator".
// Any other caller name (including "exorcist" and "repair-executor") is refused. The Exorcist and
// Repair_Executor never import this module, and no agent text reaches a command.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../events/redactor.js';

export const ORCHESTRATOR_CALLER = 'orchestrator';
export const OVERALL_TIMEOUT_MS = 120_000;
export const APP_COMPONENT = 'app';
export const VERIFICATIONS_COLLECTION = 'verifications';
export const MAX_RAW_OUTPUT_CHARS = 1_000_000;

/** Check order and the command template each kind runs. */
export const CHECK_KINDS = Object.freeze([
  Object.freeze({ kind: 'health', templateId: 'Health_Check' }),
  Object.freeze({ kind: 'vitest', templateId: 'Vitest' }),
  Object.freeze({ kind: 'playwright', templateId: 'Playwright' }),
]);

export class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

// ----- pure aggregation -----------------------------------------------------------------------

/** Component IDs whose health check failed in the original Evidence. */
export function failedComponentsInEvidence(evidence) {
  const failed = new Set();
  const items = Array.isArray(evidence?.healthCheckResults) ? evidence.healthCheckResults : [];
  for (const item of items) {
    if (item && typeof item === 'object' && typeof item.healthCheckId === 'string' && item.status === 'fail') {
      failed.add(item.healthCheckId);
    }
  }
  return failed;
}

/**
 * True when some check in this run covers a component that failed in the original Evidence.
 * Every check in `checkResults` ran in this run, so presence means "ran now".
 */
export function originalFailingCheckRan(checkResults, evidence) {
  if (!Array.isArray(checkResults)) return false;
  const failed = failedComponentsInEvidence(evidence);
  return checkResults.some((c) => c && typeof c === 'object' && failed.has(c.coversComponent));
}

/**
 * Pure aggregation (Requirements 11.3-11.6). Returns `pass` only if there is at least one check,
 * every check has outcome `pass` (so none failed, errored or timed out), and a check covering a
 * component that failed in the Evidence ran. Fails closed on malformed input.
 * @returns {'pass'|'fail'}
 */
export function aggregate(checkResults, evidence) {
  if (!Array.isArray(checkResults) || checkResults.length === 0) return 'fail';
  for (const c of checkResults) {
    if (typeof c !== 'object' || c === null || c.outcome !== 'pass') return 'fail';
  }
  return originalFailingCheckRan(checkResults, evidence) ? 'pass' : 'fail';
}

// ----- process running ------------------------------------------------------------------------

function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

/**
 * Run one command (executable + argument array, no shell).
 * Resolves, never rejects: { status: 'exit'|'timeout'|'cancelled'|'spawn_error', exitCode, output }.
 */
export function runCommand({ executable, args, cwd, timeoutMs, signal, env }) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer = null;
    let child;

    const append = (chunk) => {
      if (output.length < MAX_RAW_OUTPUT_CHARS) output += chunk.toString('utf8').slice(0, MAX_RAW_OUTPUT_CHARS - output.length);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output, ...result });
    };
    const onAbort = () => {
      cancelled = true;
      if (child) killTree(child);
    };

    if (signal?.aborted) {
      finish({ status: 'cancelled', exitCode: null });
      return;
    }
    try {
      child = spawn(executable, args, {
        cwd,
        env: env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      output += `spawn failed: ${e?.code ?? e?.message ?? 'error'}`;
      finish({ status: 'spawn_error', exitCode: null });
      return;
    }
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      output += `\nprocess error: ${e?.code ?? e?.message ?? 'error'}`;
      finish({ status: 'spawn_error', exitCode: null });
    });
    child.on('close', (code) => {
      if (timedOut) finish({ status: 'timeout', exitCode: code });
      else if (cancelled) finish({ status: 'cancelled', exitCode: code });
      else finish({ status: 'exit', exitCode: code });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // If the process ignores the kill, do not wait for it forever.
        setTimeout(() => finish({ status: 'timeout', exitCode: null }), 2000).unref?.();
      }, timeoutMs);
    }
  });
}

/** Exit 0 = pass, exit 1 = the check ran and failed, anything else = tooling error. */
function outcomeOf(run) {
  if (run.status === 'timeout' || run.status === 'cancelled') return 'timeout';
  if (run.status === 'spawn_error') return 'error';
  if (run.exitCode === 0) return 'pass';
  if (run.exitCode === 1) return 'fail';
  return 'error';
}

// ----- raw output files -----------------------------------------------------------------------

/**
 * Raw output writer that asks the File_Guard before every write and writes atomically.
 * `caller` must be one the File_Guard permits for storage directories.
 * @returns {(name: string, data: string) => Promise<string>} resolves to the stored path
 */
export function createGuardedRawOutputWriter({ directory, fileGuard, caller = 'storage' }) {
  if (!fileGuard || typeof fileGuard.assertWritable !== 'function') throw new TypeError('fileGuard is required.');
  if (typeof directory !== 'string' || directory === '') throw new TypeError('directory is required.');
  const dir = path.resolve(directory);
  return async function writeRawOutput(name, data) {
    if (name !== path.basename(name)) throw new Error('Raw output file name must not contain a path.');
    const target = path.join(dir, name);
    const decision = fileGuard.assertWritable(target, caller);
    if (!decision.allowed) {
      const error = new Error(`File_Guard denied raw output write: ${decision.code}`);
      error.denial = decision;
      throw error;
    }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${decision.realPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, decision.realPath);
    return decision.realPath;
  };
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');

// ----- engine ---------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.caller must be "orchestrator"
 * @param {{build: (templateId: string, param?: string) => {executable: string, args: string[], timeoutMs: number}}} options.commandBuilder
 * @param {{put: Function}} options.storage Storage interface (Verification_Result saved in `verifications`)
 * @param {(name: string, data: string) => Promise<string>} options.writeRawOutput returns the file reference
 * @param {string} options.cwd working directory of the commands (repository root)
 * @param {number} [options.overallTimeoutMs] 120000 by default
 */
export function createVerificationEngine(options = {}) {
  const {
    caller,
    commandBuilder,
    storage,
    writeRawOutput,
    cwd,
    overallTimeoutMs = OVERALL_TIMEOUT_MS,
    env,
    now = () => new Date(),
    clock = () => Date.now(),
    idGenerator = () => `ver-${randomUUID()}`,
  } = options;

  if (caller !== ORCHESTRATOR_CALLER) {
    throw new VerificationError('caller_not_permitted', 'Only the Orchestrator may use the Verification_Engine.');
  }
  if (typeof commandBuilder?.build !== 'function') throw new TypeError('commandBuilder.build is required');
  if (typeof storage?.put !== 'function') throw new TypeError('storage.put is required');
  if (typeof writeRawOutput !== 'function') throw new TypeError('writeRawOutput is required');
  if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd must be a non-empty string');
  if (!Number.isFinite(overallTimeoutMs) || overallTimeoutMs <= 0 || overallTimeoutMs > OVERALL_TIMEOUT_MS) {
    throw new TypeError(`overallTimeoutMs must be between 1 and ${OVERALL_TIMEOUT_MS}`);
  }

  /**
   * @param {{incidentId: string, component: string, attemptNo?: number}} incident
   * @param {object} evidence original Incident Evidence (healthCheckResults with healthCheckId/status)
   */
  async function verify(incident, evidence) {
    const incidentId = incident?.incidentId;
    const component = incident?.component;
    const attemptNo = incident?.attemptNo ?? 1;
    if (typeof incidentId !== 'string' || incidentId === '') throw new VerificationError('invalid_incident', 'incidentId is required.');
    if (typeof component !== 'string' || component === '') throw new VerificationError('invalid_incident', 'component is required.');
    if (!Number.isInteger(attemptNo) || attemptNo < 1) throw new VerificationError('invalid_incident', 'attemptNo must be a positive integer.');

    // Build every command first: an unknown component fails here, before any process starts.
    // Only Health_Check takes the component; Vitest and Playwright run their full suites.
    const param = component === APP_COMPONENT ? undefined : component;
    const plan = CHECK_KINDS.map(({ kind, templateId }) => {
      let command;
      try {
        command = commandBuilder.build(templateId, templateId === 'Health_Check' ? param : undefined);
      } catch (e) {
        throw new VerificationError('invalid_component', e?.message ?? 'Command could not be built.');
      }
      return { kind, checkId: `${kind}:${component}`, command };
    });

    const verificationId = idGenerator();
    const startedAt = now().toISOString();
    const startedMs = clock();
    const controller = new AbortController();
    const overallTimer = setTimeout(() => controller.abort(), overallTimeoutMs);
    const checks = [];

    try {
      for (const { kind, checkId, command } of plan) {
        if (controller.signal.aborted) break; // run limit passed: no further check starts
        const remaining = Math.max(1, overallTimeoutMs - (clock() - startedMs));
        const run = await runCommand({
          executable: command.executable,
          args: command.args,
          cwd,
          env,
          timeoutMs: Math.min(command.timeoutMs, remaining),
          signal: controller.signal,
        });
        let outcome = outcomeOf(run);
        const text = [
          `check: ${checkId}`,
          `command: ${command.executable} ${command.args.length} args`,
          `status: ${run.status}`,
          `exitCode: ${run.exitCode}`,
          '--- output ---',
          run.output,
        ].join('\n');
        let rawOutputRef;
        try {
          rawOutputRef = await writeRawOutput(`${safeName(verificationId)}-${safeName(checkId)}.log`, redact(text));
          if (typeof rawOutputRef !== 'string' || rawOutputRef === '') throw new Error('empty reference');
        } catch {
          rawOutputRef = 'unavailable';
          outcome = 'error'; // a check whose output cannot be stored is not a verified pass
        }
        checks.push({ checkId, kind, coversComponent: component, outcome, rawOutputRef });
      }
    } finally {
      clearTimeout(overallTimer);
    }

    const timedOutOverall = controller.signal.aborted;
    const complete = checks.length === plan.length;
    const result = {
      verificationId,
      incidentId,
      attemptNo,
      checks,
      originalFailingCheckRan: originalFailingCheckRan(checks, evidence),
      // An incomplete run (cancelled at the 120 s limit) can never pass.
      overall: timedOutOverall || !complete ? 'fail' : aggregate(checks, evidence),
      startedAt,
      durationMs: Math.max(0, clock() - startedMs),
    };
    await storage.put(VERIFICATIONS_COLLECTION, verificationId, result);
    return result;
  }

  return Object.freeze({ verify });
}
