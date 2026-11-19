// Task 2.3: every scenario failure mode must be caught by the baseline checks (Requirement 3.7),
// and an unmodified Test_App must pass them (Requirement 1.7).
//
// For the baseline and for each scenario in the loaded catalog, a TEMPORARY COPY of testapp/ is
// made, the catalog's injection steps are applied to the copy only, and then:
//   - the Test_App server from the copy runs on an ephemeral 127.0.0.1 port and the pinned
//     Health_Check script runs against it (port 4100 in the pinned script is swapped for the
//     ephemeral port so the real Test_App on 4100 is never touched),
//   - the pinned Vitest template runs with the copy as --root, and
//   - the pinned Playwright template runs unchanged (same executable, cli.js and --config from the
//     real testapp/, so the copy needs no node_modules). playwright.config.js reads
//     TESTAPP_E2E_APP_DIR (serve the copy's server.js and write results inside the copy) and
//     TESTAPP_E2E_PORT (a fresh free loopback port per run, never 4100).
// All child processes run without a shell (execFile with an argument array).
// The real testapp/ files are never modified (checked by hashing before and after).
// Tests iterate the catalog; no scenario ID is passed to any Monitor- or Exorcist-facing code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig, DEFAULT_TESTAPP_DIR, PINNED_COMMAND_TEMPLATES } from '../src/orchestrator/config-loader.js';
import { aggregateBaseline, parsePlaywrightJson, isBrowserDetection } from '../src/verification/baseline.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const requireHere = createRequire(import.meta.url);
const loaded = loadConfig();
const catalog = loaded.ok ? loaded.config.scenarioCatalog : [];
const GENERATED_DIRS = ['node_modules', 'test-results', 'playwright-report'];
const PLAYWRIGHT_TIMEOUT_MS = 120000;
const BROWSER_CASE_TIMEOUT_MS = 240000;

function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (GENERATED_DIRS.includes(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function makeCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testapp-copy-'));
  const copy = path.join(root, 'testapp');
  fs.cpSync(DEFAULT_TESTAPP_DIR, copy, {
    recursive: true,
    filter: (src) => !GENERATED_DIRS.includes(path.basename(src)),
  });
  return { root, copy };
}

function applyInjection(copy, steps) {
  for (const step of steps) {
    const file = path.join(copy, step.file);
    const text = fs.readFileSync(file, 'utf8');
    const parts = text.split(step.find);
    if (parts.length !== 2) throw new Error(`injection find text must occur exactly once in ${step.file}`);
    fs.writeFileSync(file, parts.join(step.replace));
  }
}

function childEnv(extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_ENV'));
  return { ...base, ...extra };
}

function run(args, { env, ...options } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, env: env ?? childEnv(), timeout: 50000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), error });
    });
  });
}

/** A free loopback port (never 4100) for one Playwright run. */
async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port: p } = s.address();
        s.close(() => resolve(p));
      });
    });
    if (port !== 4100) return port;
  }
}

/** Start the copy's real server on an ephemeral port; run the pinned Health_Check script against it. */
async function runHealthCheck(copy, component) {
  const { createServer } = requireHere(path.join(copy, 'server.js'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const script = PINNED_COMMAND_TEMPLATES.Health_Check.args[1];
    if (!script.includes('127.0.0.1:4100')) throw new Error('pinned Health_Check script no longer targets 127.0.0.1:4100');
    const res = await run(['-e', script.replace('127.0.0.1:4100', `127.0.0.1:${port}`), component]);
    return { ok: res.ok, detail: (res.stderr || res.stdout).trim() };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runVitest(copy) {
  const [script, ...rest] = PINNED_COMMAND_TEMPLATES.Vitest.args;
  const args = [script, ...rest.map((a) => (a === 'testapp' ? copy : a))];
  const res = await run(args, { env: childEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }) });
  const out = res.stdout + res.stderr;
  // Record only (detection uses the exit code): failing test files from Vitest's default reporter.
  const failedFiles = [...new Set([...out.matchAll(/FAIL\s+(\S+\.test\.js)/g)].map((m) => m[1]))];
  return { ok: res.ok, failedFiles, detail: out.slice(-2000) };
}

/** Run the pinned Playwright template, unchanged, against the copy's server on a fresh port. */
async function runPlaywright(copy, envOverrides = {}) {
  const args = [...PINNED_COMMAND_TEMPLATES.Playwright.args];
  const port = await freePort();
  const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-json-'));
  const jsonFile = path.join(jsonDir, 'report.json');
  try {
    const res = await run(args, {
      timeout: PLAYWRIGHT_TIMEOUT_MS,
      env: childEnv({
        TESTAPP_E2E_APP_DIR: copy,
        TESTAPP_E2E_PORT: String(port),
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile,
        CI: '1',
        FORCE_COLOR: '0',
        ...envOverrides,
      }),
    });
    // Counts come from Playwright's JSON reporter; null when no usable report was written.
    const counts = fs.existsSync(jsonFile) ? parsePlaywrightJson(fs.readFileSync(jsonFile, 'utf8')) : null;
    return {
      ok: res.ok,
      counts,
      passed: counts ? counts.passed : 0,
      failed: counts ? counts.failed : 0,
      failedTests: counts ? counts.failedTests : [],
      detected: isBrowserDetection({ exitOk: res.ok, counts }),
      detail: (res.stdout + res.stderr).slice(-3000),
    };
  } finally {
    fs.rmSync(jsonDir, { recursive: true, force: true });
  }
}

async function evaluate(steps, component) {
  const { root, copy } = makeCopy();
  try {
    if (steps) applyInjection(copy, steps);
    const health = await runHealthCheck(copy, component);
    const vitest = await runVitest(copy);
    const playwright = await runPlaywright(copy);
    const checks = [
      { kind: 'health', outcome: health.ok ? 'pass' : 'fail' },
      { kind: 'vitest', outcome: vitest.ok ? 'pass' : 'fail' },
      { kind: 'playwright', outcome: playwright.ok ? 'pass' : 'fail' },
    ];
    return { health, vitest, playwright, overall: aggregateBaseline(checks) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

describe('baseline detection of scenario failure modes', () => {
  let realHashBefore;
  beforeAll(() => { realHashBefore = hashTree(DEFAULT_TESTAPP_DIR); });
  afterAll(() => { expect(hashTree(DEFAULT_TESTAPP_DIR)).toBe(realHashBefore); });

  it('loads the six-scenario catalog', () => {
    expect(loaded.ok, JSON.stringify(loaded.errors)).toBe(true);
    expect(catalog).toHaveLength(6);
  });

  it('unmodified Test_App: Health_Check, every Vitest test and every browser test pass, overall pass', async () => {
    const r = await evaluate(null, 'button');
    expect(r.health.ok, r.health.detail).toBe(true);
    expect(r.vitest.ok, r.vitest.detail).toBe(true);
    expect(r.playwright.ok, r.playwright.detail).toBe(true);
    expect(r.playwright.failed, r.playwright.detail).toBe(0);
    expect(r.playwright.passed, r.playwright.detail).toBeGreaterThan(0);
    expect(r.overall).toBe('pass');
  }, BROWSER_CASE_TIMEOUT_MS);

  // A broken run (config rejection) must never count as detection of a defect.
  it.each([
    ['TESTAPP_E2E_APP_DIR without server.js', (emptyDir) => ({ TESTAPP_E2E_APP_DIR: emptyDir })],
    ['TESTAPP_E2E_PORT=4100 (rejected by config)', () => ({ TESTAPP_E2E_PORT: '4100' })],
  ])('broken run is not a detection: %s', async (_name, overrides) => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testapp-empty-'));
    try {
      // For the port case the app dir is valid (has server.js), so only the port is wrong.
      if (!('TESTAPP_E2E_APP_DIR' in overrides(emptyDir))) fs.writeFileSync(path.join(emptyDir, 'server.js'), '');
      const r = await runPlaywright(emptyDir, overrides(emptyDir));
      expect(r.ok).toBe(false); // non-zero exit alone...
      expect(r.counts).toBeNull(); // ...with no executed tests reported
      expect(r.detected, r.detail).toBe(false); // ...is not a detection
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 60000);

  it.each(catalog.map((s) => [s.scenarioId, s]))('%s: Health_Check or Vitest fails, and at least one browser test fails', async (_id, scenario) => {
    const r = await evaluate(scenario.injection.steps, scenario.targetComponent);
    expect(!r.health.ok || !r.vitest.ok, 'injected defect was not detected by Health_Check or Vitest').toBe(true);
    // A real browser test failure, not a startup or config error: the reporter must count failures.
    expect(r.playwright.ok, 'injected defect was not detected by the browser tests').toBe(false);
    expect(r.playwright.counts, r.playwright.detail).not.toBeNull();
    expect(r.playwright.failed, r.playwright.detail).toBeGreaterThanOrEqual(1);
    expect(r.playwright.detected, r.playwright.detail).toBe(true);
    expect(r.overall).toBe('fail');
    // Record which detectors fired (visible with --reporter=verbose).
    console.log(`${scenario.targetComponent}: health=${r.health.ok ? 'pass' : 'FAIL'} vitest=${r.vitest.ok ? 'pass' : `FAIL [${r.vitest.failedFiles.join(', ')}]`} playwright=${r.playwright.failed} failed [${r.playwright.failedTests.join(' | ')}]`);
  }, BROWSER_CASE_TIMEOUT_MS);
});
