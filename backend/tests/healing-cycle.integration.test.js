// Task 11.7: integration tests for the whole healing cycle with a stubbed Exorcist.
// Requirements: 14.8, 16.4, 19.5, 19.6, 19.7.
//
// REAL: cycle controller, Poltergeist, Scenario_Engine, Monitor (health polling, debounce, Evidence),
//       Incident_Manager, Event_Log, JSON storage, File_Guard, Snapshot service, Safety_Gate,
//       Repair_Executor, Verification_Engine (real Health_Check, Vitest and Playwright child
//       processes using the pinned command templates) and the Test_App (its real server.js and
//       real health checks, served from a temporary copy so the repository's testapp/ is never edited).
// STUBBED: only the Exorcist (diagnose/plan return fixed, scripted plans).
//
// Harness adapters that are NOT simulations of success:
//   - The Test_App server is restarted after every Repair_Executor apply/restore and after injection,
//     because mock-api.js is loaded once per server process (a dev server's file watcher would do this).
//   - Monitor has no confirmRecovery() yet (task 5.4 only polls), so the harness provides one that
//     performs three real consecutive /health polls and interprets them with the Monitor's own
//     interpretHealth().
//   - Two pinned command-template values are re-pointed at the temporary copy: the Health_Check
//     port (the script is pinned to 4100) and the Vitest --root. Playwright runs unchanged with
//     TESTAPP_E2E_APP_DIR / TESTAPP_E2E_PORT, exactly as baseline-detection.test.js does.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadConfig, DEFAULT_TESTAPP_DIR } from '../src/orchestrator/config-loader.js';
import { createFileGuard } from '../src/file-guard/file-guard.js';
import { createSnapshotService } from '../src/file-guard/snapshots/index.js';
import { createJsonStore } from '../src/storage/index.js';
import { createEventLog, createFileBlobWriter } from '../src/events/event-log.js';
import { createIncidentManager } from '../src/incident/incident-manager.js';
import { loadScenarioCatalog, createScenarioEngine } from '../src/scenario-engine/index.js';
import { createPoltergeist } from '../src/poltergeist/poltergeist.js';
import {
  createMonitor, createHttpHealthFetcher, createGuardedEvidenceWriter, interpretHealth,
} from '../src/monitor/health-poller.js';
import { RESULT_PASS } from '../src/monitor/debounce.js';
import { evaluate } from '../src/safety-gate/safety-gate.js';
import { createRepairExecutor } from '../src/repair-executor/index.js';
import { createCommandBuilder } from '../src/verification/command-builder.js';
import { createVerificationEngine, createGuardedRawOutputWriter } from '../src/verification/verification-engine.js';
import { createCycleController } from '../src/orchestrator/cycle-controller.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const requireHere = createRequire(import.meta.url);
const loaded = loadConfig();
if (!loaded.ok) throw new Error(`Configuration is invalid: ${JSON.stringify(loaded.errors)}`);
const config = loaded.config;
const SCENARIOS = config.scenarioCatalog;
const GENERATED_DIRS = ['node_modules', 'test-results', 'playwright-report', '.vite'];
const RUN_TIMEOUT_MS = 900_000;

// ----- small helpers ----------------------------------------------------------------------

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

function childEnv(extra) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_ENV'));
  return { ...base, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
}

// ----- the world: everything real except the Exorcist ----------------------------------------

async function createWorld() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'healing-')));
  const testappDir = path.join(base, 'testapp');
  const storageDir = path.join(base, 'storage-data');
  fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true, filter: (src) => !GENERATED_DIRS.includes(path.basename(src)) });
  fs.mkdirSync(storageDir, { recursive: true });

  const fileGuard = createFileGuard({ testappDir, approvedFiles: config.approvedFiles, storageDirs: [storageDir] });
  const rawStore = createJsonStore({ directory: storageDir });
  const failure = { eventLogUnwritable: false };
  const storage = {
    get: (...a) => rawStore.get(...a),
    put: (...a) => rawStore.put(...a),
    list: (...a) => rawStore.list(...a),
    append: (...a) => {
      if (failure.eventLogUnwritable) throw Object.assign(new Error('simulated storage failure: disk full'), { code: 'ENOSPC' });
      return rawStore.append(...a);
    },
  };
  const eventLog = createEventLog({ storage, writeBlob: createFileBlobWriter(path.join(storageDir, 'event-payloads')) });
  const incidents = createIncidentManager({ storage, eventLog });
  const snapshotService = createSnapshotService({ testappDir, approvedFiles: config.approvedFiles, storageDir, storage, fileGuard });
  const catalog = await loadScenarioCatalog({ testappDir });
  const engine = createScenarioEngine({ catalog, testappDir, snapshotService, fileGuard, eventLog, storage });

  // --- the Test_App (real server.js and health checks from the copy) ---
  const port = await freePort();
  const appRequire = createRequire(path.join(testappDir, 'server.js'));
  let server = null;
  async function startApp() {
    const prefix = testappDir.toLowerCase();
    for (const key of Object.keys(requireHere.cache)) if (key.toLowerCase().startsWith(prefix)) delete requireHere.cache[key];
    const { createServer } = appRequire(path.join(testappDir, 'server.js'));
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    // Readiness wait (like Playwright's webServer.url): fetch's connection pool may still hold a
    // keep-alive socket to the previous server process, which fails once with ECONNRESET.
    for (let i = 0; ; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        await res.arrayBuffer();
        break;
      } catch (e) {
        if (i >= 9) throw new Error(`Test_App did not become ready: ${e?.cause?.code ?? e?.message}`);
      }
    }
  }
  async function stopApp() {
    if (!server) return;
    const s = server;
    server = null;
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
  async function restartApp() {
    await stopApp();
    await startApp();
  }
  await startApp();

  // --- Monitor (real) ---
  const fetchHealth = createHttpHealthFetcher({ baseUrl: `http://127.0.0.1:${port}` });
  const evidenceByIncident = new Map();
  const monitorIncidentAdapter = {
    async report({ component, evidence }) {
      const created = await incidents.create({ component, evidenceRefs: [evidence.evidenceId] });
      if (typeof created?.incidentId === 'string') {
        evidenceByIncident.set(created.incidentId, [...(evidenceByIncident.get(created.incidentId) ?? []), evidence]);
      }
      return created;
    },
    async hasOpenIncident(check) {
      const active = await incidents.getActive();
      return active?.component === check;
    },
  };
  const monitor = createMonitor({
    fetchHealth,
    eventLog,
    incidentManager: monitorIncidentAdapter,
    writeFile: createGuardedEvidenceWriter({ directory: path.join(storageDir, 'evidence'), fileGuard }),
    onError: (e) => { throw e; },
  });
  const monitorFacade = {
    async confirmRecovery({ checks }) {
      let healthy = 0;
      for (let i = 0; i < checks; i += 1) {
        let outcome;
        try { outcome = await fetchHealth(); } catch { break; }
        const { results } = interpretHealth(outcome);
        if (![...results.values()].every((r) => r === RESULT_PASS)) break;
        healthy += 1;
      }
      return { confirmed: healthy >= checks, healthyChecks: healthy };
    },
  };

  // --- Repair_Executor (real; the wrapper only restarts the app and counts calls) ---
  const realExecutor = createRepairExecutor({ testappDir, approvedFiles: config.approvedFiles, snapshotService, fileGuard, eventLog });
  const calls = { apply: 0, restore: 0, diagnose: 0, plan: 0 };
  const executor = {
    async apply(plan, approval) {
      calls.apply += 1;
      try { return await realExecutor.apply(plan, approval); } finally { await restartApp(); }
    },
    async restore(snapshotId) {
      calls.restore += 1;
      try { return await realExecutor.restore(snapshotId); } finally { await restartApp(); }
    },
  };

  // --- Verification_Engine (real processes; pinned templates re-pointed at the copy) ---
  const playwrightPort = await freePort();
  const templates = config.commandTemplates.map((t) => {
    if (t.templateId === 'Health_Check') {
      const script = t.args[1];
      if (!script.includes('127.0.0.1:4100')) throw new Error('pinned Health_Check no longer targets 127.0.0.1:4100');
      return { ...t, args: [t.args[0], script.replace('127.0.0.1:4100', `127.0.0.1:${port}`), ...t.args.slice(2)] };
    }
    if (t.templateId === 'Vitest') return { ...t, args: t.args.map((a) => (a === 'testapp' ? testappDir : a)) };
    return t;
  });
  const verification = createVerificationEngine({
    caller: 'orchestrator',
    commandBuilder: createCommandBuilder(templates),
    storage,
    writeRawOutput: createGuardedRawOutputWriter({ directory: path.join(storageDir, 'verification-output'), fileGuard }),
    cwd: REPO_ROOT,
    env: childEnv({ TESTAPP_E2E_APP_DIR: testappDir, TESTAPP_E2E_PORT: String(playwrightPort) }),
  });

  // --- Poltergeist (real) and the stubbed Exorcist ---
  const poltergeist = createPoltergeist({
    catalogView: () => catalog.scenarios.map((s) => ({ id: s.scenarioId, label: s.label, severity: s.severity })),
    scenarioEngine: engine,
    eventRecorder: eventLog,
  });
  const planQueue = [];
  const exorcist = {
    async diagnose(input) {
      calls.diagnose += 1;
      const first = planQueue[0];
      return {
        outcome: 'ok',
        source: 'ai',
        diagnosis: {
          incidentId: input.incidentId,
          component: input.component,
          suspectedFile: first?.targetFile ?? 'public/button.js',
          location: 'unknown',
          rootCause: 'fixed stub diagnosis',
          confidence: 0.9,
          evidenceUsed: [`health:${input.component}`],
          status: 'ok',
        },
      };
    },
    async plan(_diagnosis, input) {
      calls.plan += 1;
      const next = planQueue.shift();
      if (!next) return { outcome: 'no_source', reason: 'stub_plans_exhausted' };
      return { outcome: 'ok', source: 'ai', plan: { incidentId: input.incidentId, ...next } };
    },
  };

  const controller = createCycleController({
    incidents,
    eventLog,
    exorcist,
    buildInput: async (incident) => ({ incidentId: incident.incidentId, component: incident.component, evidence: [], sources: [], priorAttempts: [] }),
    safetyGate: { evaluate },
    gateConfig: { actionAllowlist: config.actionAllowlist, approvedFiles: config.approvedFiles },
    executor,
    verification,
    loadEvidence: async (incident) => evidenceByIncident.get(incident.incidentId) ?? [],
    monitor: monitorFacade,
    poltergeist,
  });

  async function dispose() {
    await stopApp();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  return {
    base, testappDir, storage, eventLog, incidents, snapshotService, engine, monitor, controller, calls, failure,
    planQueue, fetchHealth, restartApp, dispose, catalog,
  };
}

// ----- one full battle --------------------------------------------------------------------

const ALL_RUNS = []; // every battle's outcome, for the "ends only in recovered or escalated" check

/**
 * Baseline -> Poltergeist injects -> Monitor detects -> Incident -> cycle controller drives the stub plans.
 * Returns plain data collected before the temporary world is removed.
 */
async function runBattle(scenarioId, plans, { beforeCycle } = {}) {
  const w = await createWorld();
  try {
    await w.engine.captureBaseline();
    const baselineChecksums = w.snapshotService.currentChecksums();

    // healthy app: the Monitor must stay quiet
    await w.monitor.tick();
    await w.monitor.tick();
    expect(await w.incidents.list()).toEqual([]);

    const started = await w.controller.startChaosRun(scenarioId);
    expect(started.scenarioId).toBe(scenarioId);
    await w.restartApp();
    const injectedChecksums = w.snapshotService.currentChecksums();
    expect(injectedChecksums).not.toEqual(baselineChecksums);

    // two consecutive failed polls open the Incident (5.3)
    await w.monitor.tick();
    await w.monitor.tick();
    const incident = await w.incidents.getActive();
    expect(incident, 'Monitor did not open an Incident for the injected failure').not.toBeNull();

    w.planQueue.push(...plans);
    if (beforeCycle) beforeCycle(w);
    const result = await w.controller.runCycle(incident.incidentId);

    const events = await w.eventLog.readAfter(0);
    const stored = await w.incidents.get(incident.incidentId);
    const verifications = (await w.storage.list('verifications')).filter((v) => v.incidentId === incident.incidentId);
    const snapshots = await w.snapshotService.list();
    const rawOutputs = {};
    for (const v of verifications) {
      for (const c of v.checks) {
        try { rawOutputs[c.checkId + '#' + v.attemptNo] = fs.readFileSync(c.rawOutputRef, 'utf8'); } catch { rawOutputs[c.checkId + '#' + v.attemptNo] = null; }
      }
    }
    let healthAfter = null;
    try { healthAfter = (await w.fetchHealth()).body; } catch { healthAfter = null; }
    const out = {
      scenarioId,
      component: incident.component,
      incidentId: incident.incidentId,
      result,
      incident: stored,
      allIncidents: await w.incidents.list(),
      events,
      transitions: events.filter((e) => e.type === 'incident.state' && e.incidentId === incident.incidentId).map((e) => e.payload.to),
      verifications,
      rawOutputs,
      snapshots,
      baselineChecksums,
      injectedChecksums,
      finalChecksums: w.snapshotService.currentChecksums(),
      healthAfter,
      calls: { ...w.calls },
    };
    ALL_RUNS.push(out);
    return out;
  } finally {
    await w.dispose();
  }
}

const summarize = (run) =>
  `${run.scenarioId} [component ${run.component}; detections ${run.events.filter((e) => e.type === 'detection').map((e) => `${e.payload.check}/${e.payload.kind}`).join(',')}]: `
  + `${run.result.outcome}${run.result.reason ? ` (${run.result.reason})` : ''}; states=${run.transitions.join('>')}; `
  + `verifications=${run.verifications.map((v) => `${v.overall}[${v.checks.map((c) => `${c.kind}:${c.outcome}`).join(',')}]`).join(' ')}`;

// ----- fixed plans ---------------------------------------------------------------------------

const scenarioById = (id) => SCENARIOS.find((s) => s.scenarioId === id);

/** The fixed correct plan: the catalog's expected repair for the scenario. */
function correctPlan(scenarioId) {
  const { actionType, targetFile, change } = scenarioById(scenarioId).expectedRepairAction;
  return { actionType, targetFile, change: { ...change }, rationale: 'Undo the faulty edit in the failing component.' };
}

/** A plan that applies cleanly but does not repair: it keeps the injected text and adds a comment. */
function wrongPlan(scenarioId, n) {
  const { actionType, targetFile, change } = scenarioById(scenarioId).expectedRepairAction;
  return { actionType, targetFile, change: { find: change.find, replace: `${change.find}/*attempt-${n}*/` }, rationale: `Adjust the failing component (variant ${n}).` };
}

const COSMETIC = {
  'button-failure': [
    // changes only the message text so the Health_Check output matches after two clicks
    { actionType: 'replace_text', targetFile: 'public/button.js', change: { find: "return 'Clicked ' + count + ' times';", replace: "return 'Clicked 2 times';" }, rationale: 'Make the message read correctly.' },
    // hides the component
    { actionType: 'replace_style_rule', targetFile: 'public/button.css', change: { find: '#test-button {', replace: '#test-button {\n  display: none;' }, rationale: 'Hide the broken component.' },
    { actionType: 'replace_text', targetFile: 'public/button.js', change: { find: "return 'Clicked ' + count + ' times';", replace: "return 'Clicked ' + 2 + ' times';" }, rationale: 'Make the message read correctly (variant).' },
  ],
  'layout-corruption': [
    { actionType: 'replace_style_rule', targetFile: 'public/layout.css', change: { find: 'display: inline;', replace: 'display: none;' }, rationale: 'Hide the broken layout.' },
    { actionType: 'replace_style_rule', targetFile: 'public/layout.css', change: { find: 'display: inline;', replace: 'display: inline; visibility: hidden;' }, rationale: 'Hide the broken layout (variant).' },
    { actionType: 'replace_style_rule', targetFile: 'public/layout.css', change: { find: 'display: inline;', replace: 'display: inline; opacity: 0;' }, rationale: 'Hide the broken layout (variant 2).' },
  ],
};

const sameChecks = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const types = (run, type) => run.events.filter((e) => e.type === type && e.incidentId === run.incidentId);

// ----- memoized correct-plan battles (shared by two tests) ---------------------------------------

const correctRuns = new Map();
function correctRun(scenarioId) {
  if (!correctRuns.has(scenarioId)) {
    correctRuns.set(scenarioId, runBattle(scenarioId, [correctPlan(scenarioId)]).then((run) => {
      console.log(summarize(run));
      return run;
    }));
  }
  return correctRuns.get(scenarioId);
}

// ----- tests ---------------------------------------------------------------------------------------

describe('healing cycle with a stubbed Exorcist (real everything else)', () => {
  it('loads the six-scenario catalog', () => {
    expect(SCENARIOS.map((s) => s.scenarioId).sort()).toEqual([
      'api-failure', 'button-failure', 'component-disappearance', 'layout-corruption', 'loading-failure', 'styling-failure',
    ]);
  });

  describe('a fixed correct plan ends in recovered with a stored pass Verification_Result (19.5)', () => {
    it.each(SCENARIOS.map((s) => [s.scenarioId]))('%s', async (scenarioId) => {
      const run = await correctRun(scenarioId);

      expect(run.result, summarize(run)).toMatchObject({ outcome: 'recovered', state: 'recovered' });
      expect(run.incident.state).toBe('recovered');
      expect(run.transitions).toEqual(['detected', 'investigating', 'planned', 'repairing', 'verifying', 'recovered']);

      // a stored pass Verification_Result for this Incident, from real processes
      const passes = run.verifications.filter((v) => v.overall === 'pass');
      expect(passes, summarize(run)).toHaveLength(1);
      expect(passes[0].checks.map((c) => c.kind)).toEqual(['health', 'vitest', 'playwright']);
      expect(passes[0].checks.every((c) => c.outcome === 'pass')).toBe(true);
      expect(passes[0].originalFailingCheckRan).toBe(true);
      expect(run.result.verificationId).toBe(passes[0].verificationId);
      expect(types(run, 'recovery')).toHaveLength(1);
      expect(types(run, 'rollback')).toHaveLength(0);

      // the repair really restored the pristine files, and the real app is healthy again
      expect(sameChecks(run.finalChecksums, run.baselineChecksums)).toBe(true);
      expect(run.healthAfter?.status).toBe('ok');
      expect(run.calls).toMatchObject({ apply: 1, restore: 0 });
    }, RUN_TIMEOUT_MS);
  });

  it('an incorrect plan is rolled back, tried at most three times, then escalated (19.6)', async () => {
    const scenarioId = 'layout-corruption';
    const run = await runBattle(scenarioId, [1, 2, 3, 4].map((n) => wrongPlan(scenarioId, n)));
    console.log(summarize(run));

    expect(run.result, summarize(run)).toMatchObject({ outcome: 'escalated', reason: 'retry_budget_exhausted' });
    expect(run.incident.state).toBe('escalated');
    expect(run.calls.apply).toBe(3); // never a fourth attempt
    expect(run.calls.restore).toBe(3);
    expect(types(run, 'repair')).toHaveLength(3);
    expect(run.verifications).toHaveLength(3);
    expect(run.verifications.every((v) => v.overall === 'fail')).toBe(true);
    expect(run.transitions).not.toContain('recovered');

    const rollbacks = types(run, 'rollback');
    expect(rollbacks).toHaveLength(3);
    expect(rollbacks.every((e) => e.payload.status === 'verified')).toBe(true);
    // each rollback restored exactly the checksums of its Snapshot
    for (const e of rollbacks) expect(sameChecks(e.payload.restored, e.payload.expected)).toBe(true);

    // files are back in the injected (still broken) state, not in a half-repaired state
    expect(sameChecks(run.finalChecksums, run.injectedChecksums)).toBe(true);
    expect(run.healthAfter?.status).not.toBe('ok');

    const [esc] = types(run, 'escalation');
    expect(esc.payload).toMatchObject({ incidentId: run.incidentId, reason: 'retry_budget_exhausted' });
    expect(esc.payload.plans).toHaveLength(3);
    expect(esc.payload.verificationResults).toHaveLength(3);
    expect(run.snapshots.filter((s) => s.reason === 'repair')).toHaveLength(3); // preserved for the escalated Incident
  }, RUN_TIMEOUT_MS);

  describe('a cosmetic plan (message text or hiding the component) fails verification and is never recovered (19.7)', () => {
    it.each(Object.keys(COSMETIC))('%s', async (scenarioId) => {
      const run = await runBattle(scenarioId, COSMETIC[scenarioId]);
      console.log(summarize(run));
      for (const [key, text] of Object.entries(run.rawOutputs)) {
        if (/^(vitest|playwright|health):/.test(key) && text) console.log(`--- ${scenarioId} ${key}\n${text.slice(-600)}`);
      }

      expect(run.transitions).not.toContain('recovered');
      expect(run.incident.state).not.toBe('recovered');
      expect(types(run, 'recovery')).toHaveLength(0);
      expect(run.result.outcome).toBe('escalated');
      // verification really ran for every applied cosmetic plan and failed each time
      expect(run.verifications.length).toBeGreaterThanOrEqual(1);
      expect(run.verifications.length).toBe(run.calls.apply);
      expect(run.verifications.every((v) => v.overall === 'fail')).toBe(true);
      expect(run.verifications.some((v) => v.overall === 'pass')).toBe(false);
      // each cosmetic repair was rolled back with verified checksums
      expect(types(run, 'rollback').every((e) => e.payload.status === 'verified')).toBe(true);
      expect(sameChecks(run.finalChecksums, run.injectedChecksums)).toBe(true);
    }, RUN_TIMEOUT_MS);
  });

  it('stops the cycle and rolls back when the Event_Log becomes unwritable (14.8)', async () => {
    const scenarioId = 'button-failure';
    const run = await runBattle(scenarioId, [correctPlan(scenarioId)], {
      // the Event_Log storage fails right after the repair Event is persisted
      beforeCycle: (w) => { w.eventLog.subscribe((e) => { if (e.type === 'repair') w.failure.eventLogUnwritable = true; }); },
    });
    console.log(summarize(run));

    expect(run.result).toMatchObject({ outcome: 'escalated', reason: 'event_log_write_failure', escalationRecorded: false });
    expect(run.incident.state).toBe('escalated'); // the Incident store still works, the Event_Log does not
    expect(run.calls.apply).toBe(1);
    expect(run.calls.restore).toBe(1); // rolled back
    expect(sameChecks(run.finalChecksums, run.injectedChecksums)).toBe(true); // repair undone
    expect(run.healthAfter?.status).not.toBe('ok');
    // the cycle stopped: no verification ran and nothing was recorded after the failing write
    expect(run.verifications).toHaveLength(0);
    expect(run.events.at(-1).type).toBe('repair');
    expect(run.events.some((e) => ['verification', 'recovery', 'escalation', 'rollback'].includes(e.type))).toBe(false);
    expect(run.transitions).not.toContain('recovered');
  }, RUN_TIMEOUT_MS);

  it('every Scenario ends in recovered or escalated only, never in an intermediate state', async () => {
    const runs = await Promise.all(SCENARIOS.map((s) => correctRun(s.scenarioId)));
    expect(runs.map((r) => r.scenarioId).sort()).toEqual(SCENARIOS.map((s) => s.scenarioId).sort());
    // include every battle executed in this file (incorrect, cosmetic, Event_Log failure)
    for (const run of ALL_RUNS) {
      expect(['recovered', 'escalated'], summarize(run)).toContain(run.incident.state);
      expect(['recovered', 'escalated'], summarize(run)).toContain(run.result.outcome);
      expect(run.result.state ?? run.incident.state).toBe(run.incident.state);
      for (const incident of run.allIncidents) expect(['recovered', 'escalated']).toContain(incident.state);
      // the last recorded state transition is the terminal state. Exception: when the Event_Log was
      // made unwritable, the terminal transition is stored on the Incident but cannot be logged.
      if (run.result.reason !== 'event_log_write_failure') {
        expect(run.transitions.at(-1)).toBe(run.incident.state);
        expect(run.transitions.filter((t) => t === 'recovered' || t === 'escalated')).toHaveLength(1);
      }
      // recovered only with a stored pass Verification_Result
      if (run.incident.state === 'recovered') expect(run.verifications.some((v) => v.overall === 'pass')).toBe(true);
    }
  }, RUN_TIMEOUT_MS);
});
