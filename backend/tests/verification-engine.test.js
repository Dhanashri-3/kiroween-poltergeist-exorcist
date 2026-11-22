import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandBuilder } from '../src/verification/command-builder.js';
import { validate } from '../src/contracts/index.js';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import {
  aggregate,
  originalFailingCheckRan,
  createVerificationEngine,
  createGuardedRawOutputWriter,
  VerificationError,
} from '../src/verification/verification-engine.js';

const COMPONENTS = ['button', 'layout', 'dataPanel', 'card'];
// Real child processes: `node -e <script> [component]`.
const tpl = (templateId, script, timeoutMs = 10000) => ({
  templateId,
  executable: process.execPath,
  args: ['-e', script],
  allowedParams: COMPONENTS,
  timeoutMs,
});
const PASS = 'console.log("all good")';
const FAIL = 'console.error("1 test failed"); process.exit(1)';
const TOOLING = 'process.exit(3)';
const SLEEP = 'setTimeout(()=>{}, 60000)';

const check = (kind, outcome, coversComponent = 'button') => ({
  checkId: `${kind}:${coversComponent}`, kind, coversComponent, outcome, rawOutputRef: 'ref',
});
const evidence = (...failed) => ({
  healthCheckResults: [
    { healthCheckId: 'app', status: 'pass' },
    ...COMPONENTS.map((c) => ({ healthCheckId: c, status: failed.includes(c) ? 'fail' : 'pass' })),
  ],
});

describe('aggregate (pure)', () => {
  const allPass = [check('health', 'pass'), check('vitest', 'pass'), check('playwright', 'pass')];

  it('passes when all pass and a check covering the originally failing component ran', () => {
    expect(aggregate(allPass, evidence('button'))).toBe('pass');
  });

  it.each(['fail', 'error', 'timeout'])('fails when any check is %s', (bad) => {
    expect(aggregate([check('health', 'pass'), check('vitest', bad), check('playwright', 'pass')], evidence('button'))).toBe('fail');
  });

  it('fails when no check covers the component that failed in the Evidence', () => {
    expect(aggregate(allPass, evidence('card'))).toBe('fail');
    expect(originalFailingCheckRan(allPass, evidence('card'))).toBe(false);
  });

  it('fails when the Evidence has no failed check, or malformed input', () => {
    expect(aggregate(allPass, evidence())).toBe('fail');
    expect(aggregate(allPass, undefined)).toBe('fail');
    expect(aggregate([], evidence('button'))).toBe('fail');
    expect(aggregate(undefined, evidence('button'))).toBe('fail');
    expect(aggregate([null], evidence('button'))).toBe('fail');
  });
});

describe('Verification_Engine', () => {
  let tmp;
  let stored;
  let storage;
  let writeRawOutput;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    stored = new Map();
    storage = { put: async (c, k, r) => { stored.set(`${c}/${k}`, r); return r; } };
    writeRawOutput = async (name, data) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, data);
      return p;
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const engineFor = (scripts, extra = {}) => createVerificationEngine({
    caller: 'orchestrator',
    commandBuilder: createCommandBuilder([
      tpl('Health_Check', scripts[0], extra.timeouts?.[0]),
      tpl('Vitest', scripts[1], extra.timeouts?.[1]),
      tpl('Playwright', scripts[2], extra.timeouts?.[2]),
    ]),
    storage,
    writeRawOutput,
    cwd: tmp,
    ...extra.options,
  });
  const incident = { incidentId: 'inc-1', component: 'button', attemptNo: 2 };

  it('runs all three checks as real processes, stores raw output and a valid passing result', async () => {
    const result = await engineFor([PASS, PASS, PASS]).verify(incident, evidence('button'));
    expect(result.overall).toBe('pass');
    expect(result.originalFailingCheckRan).toBe(true);
    expect(result.checks.map((c) => [c.kind, c.outcome])).toEqual([['health', 'pass'], ['vitest', 'pass'], ['playwright', 'pass']]);
    expect(fs.readFileSync(result.checks[0].rawOutputRef, 'utf8')).toContain('all good');
    expect(validate('VerificationResult', result)).toEqual({ valid: true, errors: [] });
    expect(stored.get(`verifications/${result.verificationId}`)).toEqual(result);
  });

  it('returns fail and lists the failing check when a check fails', async () => {
    const result = await engineFor([PASS, FAIL, PASS]).verify(incident, evidence('button'));
    expect(result.overall).toBe('fail');
    expect(result.checks.find((c) => c.outcome === 'fail').kind).toBe('vitest');
    expect(fs.readFileSync(result.checks[1].rawOutputRef, 'utf8')).toContain('1 test failed');
  });

  it('returns fail for a tooling error (unexpected exit code) and for a missing executable', async () => {
    const r1 = await engineFor([PASS, TOOLING, PASS]).verify(incident, evidence('button'));
    expect(r1.checks[1].outcome).toBe('error');
    expect(r1.overall).toBe('fail');

    const engine = createVerificationEngine({
      caller: 'orchestrator',
      commandBuilder: createCommandBuilder(['Health_Check', 'Vitest', 'Playwright'].map((id) => ({
        templateId: id, executable: path.join(tmp, 'no-such-binary'), args: [], allowedParams: COMPONENTS, timeoutMs: 5000,
      }))),
      storage, writeRawOutput, cwd: tmp,
    });
    const r2 = await engine.verify(incident, evidence('button'));
    expect(r2.overall).toBe('fail');
    expect(r2.checks.every((c) => c.outcome === 'error')).toBe(true);
  });

  it('records a per-check timeout and fails', async () => {
    const result = await engineFor([PASS, SLEEP, PASS], { timeouts: [10000, 300, 10000] }).verify(incident, evidence('button'));
    expect(result.checks[1].outcome).toBe('timeout');
    expect(result.overall).toBe('fail');
  });

  it('cancels the run at the overall limit, skips later checks and returns fail', async () => {
    const started = Date.now();
    const result = await engineFor([PASS, SLEEP, PASS], { options: { overallTimeoutMs: 400 } }).verify(incident, evidence('button'));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(result.overall).toBe('fail');
    expect(result.checks.map((c) => [c.kind, c.outcome])).toEqual([['health', 'pass'], ['vitest', 'timeout']]);
    expect(stored.get(`verifications/${result.verificationId}`).overall).toBe('fail');
  });

  it('fails when raw output cannot be stored', async () => {
    writeRawOutput = async () => { throw new Error('disk full'); };
    const result = await engineFor([PASS, PASS, PASS]).verify(incident, evidence('button'));
    expect(result.checks.every((c) => c.outcome === 'error' && c.rawOutputRef === 'unavailable')).toBe(true);
    expect(result.overall).toBe('fail');
  });

  it('fails when no check covers the originally failing component', async () => {
    const result = await engineFor([PASS, PASS, PASS]).verify(incident, evidence('card'));
    expect(result.originalFailingCheckRan).toBe(false);
    expect(result.overall).toBe('fail');
  });

  it('rejects a component outside the enum before starting any process', async () => {
    await expect(engineFor([PASS, PASS, PASS]).verify({ incidentId: 'i', component: 'x; rm -rf /' }, evidence()))
      .rejects.toMatchObject({ code: 'invalid_component' });
    expect(stored.size).toBe(0);
  });

  it('refuses to be created for any caller other than the orchestrator', () => {
    for (const caller of ['exorcist', 'repair-executor', 'poltergeist', undefined, '']) {
      expect(() => createVerificationEngine({
        caller, commandBuilder: { build() {} }, storage, writeRawOutput, cwd: tmp,
      })).toThrow(VerificationError);
    }
  });

  it('writes raw output through the File_Guard into a storage directory', async () => {
    const testappDir = path.join(tmp, 'testapp');
    const storageDir = path.join(tmp, 'store');
    fs.mkdirSync(testappDir);
    fs.mkdirSync(storageDir);
    const fileGuard = createFileGuard({ testappDir, approvedFiles: [], storageDirs: [storageDir] });
    const write = createGuardedRawOutputWriter({ directory: path.join(storageDir, 'verification'), fileGuard });
    const engine = createVerificationEngine({
      caller: 'orchestrator',
      commandBuilder: createCommandBuilder([tpl('Health_Check', PASS), tpl('Vitest', PASS), tpl('Playwright', PASS)]),
      storage, writeRawOutput: write, cwd: tmp,
    });
    const result = await engine.verify(incident, evidence('button'));
    expect(result.overall).toBe('pass');
    expect(result.checks[0].rawOutputRef.startsWith(fs.realpathSync(storageDir))).toBe(true);
    await expect(write('../escape.log', 'x')).rejects.toThrow();
  });
});
