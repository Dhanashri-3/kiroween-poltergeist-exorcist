// Backend entry point (Task 15.2; Requirements 6.9, 13.7, 13.8).
//
// startBackend(options) wires the modules built in earlier tasks. It owns no logic of its own beyond
// ordering and adapters. Start order (each step runs only after the previous one succeeded):
//
//   1. Runtime settings       parsed and validated from environment variables (no secrets).
//   2. Configuration          initializeConfig(): the five config files are loaded and validated as a
//                             whole. Any problem refuses startup (13.7); nothing is bound or started.
//                             A best-effort `error` Event per problem is written first (4.4).
//   3. Event_Log              JSON storage (corrupt files preserved, error Events recorded, 18.3),
//                             File_Guard, Event_Log.
//   4. Incident_Manager       reload(): Incidents left in repairing/verifying are flagged as needing
//                             rollback verification, which blocks injection (6.9).
//   5. Monitor                constructed here. Its polling timer starts only in step 8, because a
//                             detection cannot be acted on before the Orchestrator exists.
//   6. Scenario_Engine        catalog, Snapshot service, baseline Snapshot (captured once, never
//                             replaced), Poltergeist.
//   7. Orchestrator           Exorcist, Safety_Gate, Repair_Executor, Verification_Engine and the
//                             cycle controller. Non-terminal Incidents found at startup are resumed:
//                             the controller rolls any repair back and escalates (10.11).
//   8. API                    Express app bound to 127.0.0.1 (13.1), then the Monitor starts polling.
//
// Settings (all optional, none secret):
//   BACKEND_PORT          API port, default 4200 (0 picks a free port)
//   DASHBOARD_ORIGIN      the single CORS origin, default http://127.0.0.1:5173
//   TESTAPP_URL           Test_App base URL, loopback only, default http://127.0.0.1:4100
//   BACKEND_STORAGE_DIR   storage directory, default backend/storage-data (excluded from Git)
//   MONITOR_INTERVAL_MS   health polling interval, default 2000
// The AI credential (EXORCIST_AI_API_KEY) is read by the exorcist module from the environment only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initializeConfig, ConfigError, DEFAULT_CONFIG_DIR, DEFAULT_TESTAPP_DIR } from './orchestrator/config-loader.js';
import { createFileGuard } from './file-guard/file-guard.js';
import { resolveApprovedFile } from './file-guard/path-safety.js';
import { createSnapshotService } from './file-guard/snapshots/index.js';
import { createJsonStore } from './storage/index.js';
import { createEventLog, createFileBlobWriter } from './events/event-log.js';
import { redact } from './events/redactor.js';
import { createIncidentManager, isRejected } from './incident/incident-manager.js';
import { isTerminal } from './incident/state-machine.js';
import {
  createMonitor, createHttpHealthFetcher, createGuardedEvidenceWriter, interpretHealth, DEFAULT_INTERVAL_MS,
} from './monitor/health-poller.js';
import { createPlaywrightCapturer } from './monitor/playwright-capturer.js';
import { RESULT_PASS } from './monitor/debounce.js';
import { loadScenarioCatalog, createScenarioEngine } from './scenario-engine/index.js';
import { createPoltergeist } from './poltergeist/poltergeist.js';
import { createExorcist, readAiCredential } from './exorcist/exorcist.js';
import { buildExorcistInput } from './exorcist/input-builder.js';
import { evaluate } from './safety-gate/index.js';
import { createRepairExecutor } from './repair-executor/index.js';
import { createCommandBuilder } from './verification/command-builder.js';
import { createVerificationEngine, createGuardedRawOutputWriter } from './verification/verification-engine.js';
import { createCycleController, RECOVERY_CONFIRMATION_CHECKS } from './orchestrator/cycle-controller.js';
import { createApiApp, parseDashboardOrigin, ApiConfigError } from './api/app.js';
import { createSseHandler } from './api/sse.js';
import { startApiServer } from './api/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
export const DEFAULT_STORAGE_DIR = path.join(BACKEND_DIR, 'storage-data');
export const DEFAULT_BACKEND_PORT = 4200;
export const DEFAULT_DASHBOARD_ORIGIN = 'http://127.0.0.1:5173';
export const DEFAULT_TESTAPP_URL = 'http://127.0.0.1:4100';
const STARTUP_COMPONENT = 'orchestrator';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Startup was refused. `errors` lists every problem found: [{ source, code, message }]. */
export class StartupError extends Error {
  constructor(errors) {
    super(`Startup refused: ${errors.length} problem(s). First: ${errors[0]?.message ?? 'unknown'}`);
    this.name = 'StartupError';
    this.errors = errors;
  }
}

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

// ----- 1. runtime settings -----------------------------------------------------------------------

function parseInteger(raw, name, { min, max }, problems, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(String(raw)) || Number(raw) < min || Number(raw) > max) {
    problems.push({ source: 'settings', code: 'invalid_setting', message: `${name} must be an integer from ${min} to ${max}.` });
    return fallback;
  }
  return Number(raw);
}

/** Validates the settings. Returns { settings } or throws StartupError listing every problem. */
export function resolveSettings(options = {}, env = process.env) {
  const problems = [];
  const pick = (key, envName) => (options[key] !== undefined ? options[key] : env[envName]);

  const port = options.port !== undefined
    ? parseInteger(String(options.port), 'port', { min: 0, max: 65535 }, problems, DEFAULT_BACKEND_PORT)
    : parseInteger(env.BACKEND_PORT, 'BACKEND_PORT', { min: 0, max: 65535 }, problems, DEFAULT_BACKEND_PORT);
  const intervalMs = options.monitorIntervalMs !== undefined
    ? parseInteger(String(options.monitorIntervalMs), 'monitorIntervalMs', { min: 100, max: 3_600_000 }, problems, DEFAULT_INTERVAL_MS)
    : parseInteger(env.MONITOR_INTERVAL_MS, 'MONITOR_INTERVAL_MS', { min: 100, max: 3_600_000 }, problems, DEFAULT_INTERVAL_MS);

  let dashboardOrigin = DEFAULT_DASHBOARD_ORIGIN;
  try {
    dashboardOrigin = parseDashboardOrigin(pick('dashboardOrigin', 'DASHBOARD_ORIGIN') ?? DEFAULT_DASHBOARD_ORIGIN);
  } catch (e) {
    problems.push({ source: 'settings', code: e instanceof ApiConfigError ? e.code : 'invalid_setting', message: messageOf(e) });
  }

  let testAppUrl = DEFAULT_TESTAPP_URL;
  const rawUrl = pick('testAppUrl', 'TESTAPP_URL') ?? DEFAULT_TESTAPP_URL;
  try {
    const url = new URL(String(rawUrl));
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('not loopback');
    testAppUrl = url.origin;
  } catch {
    problems.push({ source: 'settings', code: 'invalid_setting', message: 'TESTAPP_URL must be an http(s) URL on the loopback address.' });
  }

  const storageDir = path.resolve(pick('storageDir', 'BACKEND_STORAGE_DIR') ?? DEFAULT_STORAGE_DIR);
  if (problems.length > 0) throw new StartupError(problems);
  return Object.freeze({ port, intervalMs, dashboardOrigin, testAppUrl, storageDir });
}

// ----- shared helpers ----------------------------------------------------------------------------

function openStorage(storageDir, onCorruption) {
  fs.mkdirSync(storageDir, { recursive: true });
  return createJsonStore({ directory: storageDir, onCorruption });
}

async function recordCorruptionReports(eventLog, reports) {
  for (const report of reports) {
    await eventLog.append({
      type: 'error',
      component: 'storage',
      payload: {
        reason: 'storage_corruption',
        collection: report.collection,
        file: report.file,
        preservedAs: report.backupFile,
        corruption: report.reason,
        message: `A corrupt storage file was preserved as ${report.backupFile}; the store starts empty for ${report.collection}.`,
      },
    });
  }
}

/** Best effort: write one `error` Event per configuration problem, then give up silently. */
async function recordConfigProblems(settings, errors) {
  try {
    const store = openStorage(settings.storageDir);
    const eventLog = createEventLog({ storage: store, writeBlob: createFileBlobWriter(path.join(settings.storageDir, 'event-payloads')) });
    for (const e of errors) {
      await eventLog.append({
        type: 'error',
        component: STARTUP_COMPONENT,
        payload: { reason: 'config_invalid', file: e.file, code: e.code, message: e.message },
      });
    }
  } catch {
    // Startup is refused either way. The problems are in the thrown StartupError.
  }
}

/**
 * Recovery confirmation (Requirement 11.9): `checks` consecutive polls of the Test_App where every
 * health check passes. Any failed or unreachable poll ends the confirmation.
 */
function createRecoveryConfirmer({ fetchHealth, spacingMs }) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    async confirmRecovery({ checks = RECOVERY_CONFIRMATION_CHECKS } = {}) {
      let healthy = 0;
      for (let i = 0; i < checks; i += 1) {
        if (i > 0 && spacingMs > 0) await pause(spacingMs);
        let outcome;
        try {
          outcome = await fetchHealth();
        } catch {
          break;
        }
        const { results } = interpretHealth(outcome);
        if (results.size === 0 || ![...results.values()].every((r) => r === RESULT_PASS)) break;
        healthy += 1;
      }
      return { confirmed: healthy >= checks, healthyChecks: healthy };
    },
  };
}

// ----- the start sequence ------------------------------------------------------------------------

/**
 * @param {object} [options] overrides for the settings above, plus `configDir` and `testappDir`.
 * @returns {Promise<{port:number, host:string, close:()=>Promise<void>, startOrder:string[], ...}>}
 * @throws {StartupError} when the settings or any configuration file is invalid.
 */
export async function startBackend(options = {}) {
  const startOrder = [];
  const step = (name) => startOrder.push(name);

  // 1. settings
  const settings = resolveSettings(options);
  step('settings');
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const testappDir = options.testappDir ?? DEFAULT_TESTAPP_DIR;

  // 2. configuration: refuse to start on any invalid file
  let config;
  try {
    config = initializeConfig({ configDir, testappDir });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    const errors = e.errors.map((x) => ({ source: x.file, code: x.code, message: x.message }));
    await recordConfigProblems(settings, e.errors);
    throw new StartupError(errors);
  }
  step('config');

  const started = []; // cleanup callbacks, run in reverse order if a later step fails
  try {
    // 3. Event_Log (storage, File_Guard)
    const corruptionReports = [];
    const store = openStorage(settings.storageDir, (r) => corruptionReports.push(r));
    const fileGuard = createFileGuard({ testappDir: config.testappDir, approvedFiles: config.approvedFiles, storageDirs: [settings.storageDir] });
    const eventLog = createEventLog({ storage: store, writeBlob: createFileBlobWriter(path.join(settings.storageDir, 'event-payloads')) });
    await store.initialize(); // reports reach corruptionReports through onCorruption
    await recordCorruptionReports(eventLog, corruptionReports);
    step('event-log');

    // 4. Incident_Manager reload (6.9)
    const incidents = createIncidentManager({ storage: store, eventLog });
    const flagged = await incidents.reload();
    step('incident-manager-reload');

    // 5. Monitor (constructed now, polling starts in step 8)
    const fetchHealth = createHttpHealthFetcher({ baseUrl: settings.testAppUrl });
    let controller = null; // assigned in step 7; the adapter below only runs after polling starts
    const runInBackground = (incidentId) => {
      controller.runCycle(incidentId).catch((error) => {
        eventLog.append({
          type: 'error', component: STARTUP_COMPONENT, incidentId, payload: { reason: 'cycle_failed', message: messageOf(error) },
        }).catch(() => {});
      });
    };
    const monitorIncidents = {
      async report({ component, evidence }) {
        const created = await incidents.create({ component, evidenceRefs: [evidence.evidenceId] });
        if (!isRejected(created) && typeof created?.incidentId === 'string' && created.state === 'detected') runInBackground(created.incidentId);
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
      incidentManager: monitorIncidents,
      capturer: createPlaywrightCapturer({ baseUrl: settings.testAppUrl }),
      writeFile: createGuardedEvidenceWriter({ directory: path.join(settings.storageDir, 'evidence'), fileGuard }),
      intervalMs: settings.intervalMs,
      onError: (error) => {
        eventLog.append({ type: 'error', component: 'monitor', payload: { reason: 'monitor_error', message: messageOf(error) } }).catch(() => {});
      },
    });
    started.push(() => monitor.stop());
    step('monitor');

    // 6. Scenario_Engine, Snapshot service, baseline Snapshot, Poltergeist
    const catalog = await loadScenarioCatalog({ configDir, testappDir: config.testappDir, eventLog });
    const snapshotService = createSnapshotService({
      testappDir: config.testappDir, approvedFiles: config.approvedFiles, storageDir: settings.storageDir, storage: store, fileGuard,
    });
    const scenarioEngine = createScenarioEngine({
      catalog, testappDir: config.testappDir, snapshotService, fileGuard, eventLog, storage: store,
    });
    const hasBaseline = (await snapshotService.list()).some((s) => s.reason === 'baseline');
    if (!hasBaseline) {
      // A baseline taken while a repair or failure may be on disk would record a broken state as healthy.
      if ((await incidents.list()).some((i) => !isTerminal(i.state))) {
        throw new StartupError([{
          source: 'snapshots', code: 'baseline_missing',
          message: 'No baseline Snapshot exists but an Incident is not terminal. Restore the Test_App by hand and clear the storage directory.',
        }]);
      }
      await scenarioEngine.captureBaseline();
    }
    const poltergeist = createPoltergeist({
      catalogView: () => catalog.scenarios.map((s) => ({ id: s.scenarioId, label: s.label, severity: s.severity })),
      scenarioEngine,
      eventRecorder: eventLog,
    });
    step('scenario-engine');

    // 7. Orchestrator
    const exorcist = createExorcist({ fallbackEntries: config.fallbackMapping }); // stub AI client until a provider is chosen
    const executor = createRepairExecutor({
      testappDir: config.testappDir, approvedFiles: config.approvedFiles, snapshotService, fileGuard, eventLog,
    });
    const verification = createVerificationEngine({
      caller: 'orchestrator',
      commandBuilder: createCommandBuilder(config.commandTemplates),
      storage: store,
      writeRawOutput: createGuardedRawOutputWriter({ directory: path.join(settings.storageDir, 'verification-output'), fileGuard }),
      cwd: REPO_ROOT,
    });
    // Original Evidence lives in the `detection` Events, so it survives a restart.
    const loadEvidence = async (incident) => {
      const detections = await eventLog.readAfter(0, { types: ['detection'] });
      return detections
        .map((e) => e.payload?.evidence)
        .filter((ev) => ev && incident.evidenceRefs.includes(ev.evidenceId));
    };
    const readApprovedSources = () => config.approvedFiles.map((rel) => {
      const resolved = resolveApprovedFile(config.testappDir, rel);
      return resolved.ok ? { path: rel, content: fs.readFileSync(resolved.real, 'utf8') } : null;
    }).filter(Boolean);
    controller = createCycleController({
      incidents,
      eventLog,
      exorcist,
      buildInput: (incident) => buildExorcistInput(incident, eventLog, { redact, loadEvidence, readApprovedSources }),
      safetyGate: { evaluate },
      gateConfig: { actionAllowlist: config.actionAllowlist, approvedFiles: config.approvedFiles },
      executor,
      verification,
      loadEvidence,
      monitor: createRecoveryConfirmer({ fetchHealth, spacingMs: Math.min(settings.intervalMs, 1000) }),
      poltergeist,
    });
    step('orchestrator');

    // 8. API, then Monitor polling
    const app = createApiApp({
      incidents,
      eventLog,
      cycleController: controller,
      scenarioEngine,
      catalog,
      fetchHealth,
      dashboardOrigin: settings.dashboardOrigin,
      sseHandler: createSseHandler({ eventLog }),
    });
    const api = await startApiServer(app, { port: settings.port });
    started.push(() => api.close());
    step('api');

    for (const incident of await incidents.list()) {
      if (!isTerminal(incident.state)) runInBackground(incident.incidentId); // resume: roll back and escalate or re-diagnose
    }
    monitor.start();
    step('monitor-polling');

    return {
      host: api.host,
      port: api.port,
      settings,
      startOrder,
      flaggedIncidents: flagged,
      aiCredentialPresent: readAiCredential() !== undefined,
      eventLog,
      incidents,
      async close() {
        await monitor.stop();
        await api.close();
      },
    };
  } catch (error) {
    for (const undo of started.reverse()) {
      try { await undo(); } catch { /* keep unwinding */ }
    }
    throw error;
  }
}

// ----- command line ------------------------------------------------------------------------------

async function main() {
  try {
    const backend = await startBackend();
    console.log(`Backend listening on http://${backend.host}:${backend.port}/api/v1 (start order: ${backend.startOrder.join(' > ')})`);
    if (backend.flaggedIncidents.length > 0) {
      console.warn(`${backend.flaggedIncidents.length} Incident(s) need rollback verification and are being resumed.`);
    }
    const stop = (signal) => {
      console.log(`${signal} received, shutting down.`);
      backend.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  } catch (error) {
    if (error instanceof StartupError) {
      console.error(error.message);
      for (const e of error.errors) console.error(`  [${e.source}] ${e.code}: ${e.message}`);
    } else {
      console.error(`Startup failed: ${messageOf(error)}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
