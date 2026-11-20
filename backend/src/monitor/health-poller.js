// Monitor: health polling and evidence capture (Task 5.4; Requirements 5.1, 5.2, 5.4, 5.7, 14.7).
//
// Every `intervalMs` (default 2000) the Monitor fetches the Test_App /health endpoint, advances
// one debounce window per check (the four components plus the `app` availability check) with the
// pure `step()` from debounce.js and acts on what it emits:
//   detection -> capture Evidence, record a `detection` Event, report to the Incident_Manager
//   transient -> record a `transient` Event
//   cleared   -> record a `cleared` Event
//
// Information barrier (Requirement 5.2): the Monitor's only inputs are the Test_App health
// response and the injected capturer. It never reads the Event_Log (it only appends to it), and it
// never imports poltergeist/ or exorcist/. All collaborators are injected so tests need no browser.
//
// Writes: Evidence files go through the injected `writeFile`. Production wiring should use
// createGuardedEvidenceWriter(), which asks the File_Guard before each write.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../events/redactor.js';
import {
  step,
  createWindow,
  EMIT_DETECTION,
  EMIT_TRANSIENT,
  EMIT_CLEARED,
  RESULT_PASS,
  RESULT_FAIL,
  RESULT_UNREACHABLE
} from './debounce.js';

export const DEFAULT_INTERVAL_MS = 2000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
export const APP_CHECK = 'app';
export const MONITOR_COMPONENT = 'monitor';
export const UNAVAILABLE = 'unavailable';
export const MAX_CONSOLE_ERRORS = 100;
export const MAX_CONSOLE_ERROR_CHARS = 2000;

/** Default health fetcher: resolves { httpStatus, body } or rejects when the app is unreachable. */
export function createHttpHealthFetcher({ baseUrl, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new TypeError('baseUrl is required.');
  const url = new URL('/health', baseUrl).href;
  return async function fetchHealth() {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body };
  };
}

/**
 * Evidence file writer that asks the File_Guard before every write and writes atomically.
 * `caller` must be a name the File_Guard permits for storage directories.
 */
export function createGuardedEvidenceWriter({ directory, fileGuard, caller = 'storage' }) {
  if (!fileGuard || typeof fileGuard.assertWritable !== 'function') throw new TypeError('fileGuard is required.');
  const dir = path.resolve(directory);
  return async function writeEvidenceFile(name, data) {
    if (name !== path.basename(name)) throw new Error('Evidence file name must not contain a path.');
    const target = path.join(dir, name);
    const decision = fileGuard.assertWritable(target, caller);
    if (!decision.allowed) {
      const error = new Error(`File_Guard denied evidence write: ${decision.code}`);
      error.denial = decision;
      throw error;
    }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${decision.realPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, decision.realPath);
    return decision.realPath;
  };
}

/** Turn a /health outcome into per-check results. Returns { results: Map<check,status>, items }. */
export function interpretHealth(outcome) {
  const results = new Map();
  const items = [];
  const body = outcome?.body;
  const components = body && typeof body === 'object' && body.components && typeof body.components === 'object' ? body.components : null;

  // `app` covers availability and a well-formed response only; component failures are reported
  // by the component checks, so one broken component yields one detection.
  const appOk = outcome?.httpStatus === 200 && Boolean(components);
  results.set(APP_CHECK, appOk ? RESULT_PASS : RESULT_FAIL);
  items.push({
    healthCheckId: APP_CHECK,
    status: appOk ? 'pass' : 'fail',
    error: appOk ? null : `HTTP ${outcome?.httpStatus}${components ? '' : ' with no component results'}`
  });

  if (components) {
    for (const [name, value] of Object.entries(components)) {
      const ok = value && value.status === 'ok';
      results.set(name, ok ? RESULT_PASS : RESULT_FAIL);
      items.push({
        healthCheckId: name,
        status: ok ? 'pass' : 'fail',
        error: ok ? null : String((value && value.error) ?? 'component not ok')
      });
    }
  }
  return { results, items };
}

function boundErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list.slice(0, MAX_CONSOLE_ERRORS).map((e) => String(e).slice(0, MAX_CONSOLE_ERROR_CHARS));
}

/**
 * @param {object} deps
 * @param {() => Promise<{httpStatus:number, body:any}>} deps.fetchHealth rejects when unreachable
 * @param {{append:(e:object)=>Promise<object>}} deps.eventLog append-only use; never read
 * @param {{report:(d:object)=>any, hasOpenIncident?:(check:string)=>boolean|Promise<boolean>}} deps.incidentManager
 * @param {{capture:(a:{component:string})=>Promise<{consoleErrors:string[], domSnapshot:string, screenshot:Buffer|Uint8Array}>}} [deps.capturer]
 * @param {(name:string, data:string|Uint8Array)=>Promise<string>} deps.writeFile returns the stored path
 * @param {number} [deps.intervalMs]
 * @param {(error:Error)=>void} [deps.onError]
 */
export function createMonitor({
  fetchHealth,
  eventLog,
  incidentManager,
  capturer,
  writeFile,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => new Date(),
  idFactory = randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {}
} = {}) {
  if (typeof fetchHealth !== 'function') throw new TypeError('fetchHealth is required.');
  if (!eventLog || typeof eventLog.append !== 'function') throw new TypeError('eventLog.append is required.');
  if (!incidentManager || typeof incidentManager.report !== 'function') throw new TypeError('incidentManager.report is required.');
  if (typeof writeFile !== 'function') throw new TypeError('writeFile is required.');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be a positive number.');

  const windows = new Map();
  let timer = null;
  let running = false;
  let busy = null;

  async function captureEvidence(component, items) {
    const evidenceId = idFactory();
    const capturedAt = now().toISOString();
    const evidence = {
      evidenceId,
      healthCheckResults: redact(items),
      consoleErrors: [],
      domSnapshotRef: UNAVAILABLE,
      screenshotPath: UNAVAILABLE,
      capturedAt
    };
    const problems = [];
    let captured = null;
    if (capturer) {
      try {
        captured = await capturer.capture({ component });
      } catch (e) {
        problems.push(`capture failed: ${e?.message ?? e}`);
      }
    } else {
      problems.push('no capturer configured');
    }
    if (captured) {
      evidence.consoleErrors = redact(boundErrors(captured.consoleErrors));
      if (typeof captured.domSnapshot === 'string') {
        try {
          evidence.domSnapshotRef = await writeFile(`${evidenceId}.dom.html`, redact(captured.domSnapshot));
        } catch (e) {
          problems.push(`dom snapshot not stored: ${e?.message ?? e}`);
        }
      }
      if (captured.screenshot) {
        try {
          evidence.screenshotPath = await writeFile(`${evidenceId}.png`, captured.screenshot);
        } catch (e) {
          problems.push(`screenshot not stored: ${e?.message ?? e}`);
        }
      }
    }
    if (problems.length) evidence.captureProblems = problems;
    return evidence;
  }

  async function handleEmit(check, emit, items, detectedAt) {
    if (emit.type === EMIT_DETECTION) {
      const evidence = await captureEvidence(check, items);
      const payload = { check, kind: emit.kind, evidence };
      await eventLog.append({ type: 'detection', component: check, payload });
      await incidentManager.report({ component: check, kind: emit.kind, evidence, detectedAt });
    } else if (emit.type === EMIT_TRANSIENT) {
      await eventLog.append({ type: 'transient', component: check, payload: { check } });
    } else if (emit.type === EMIT_CLEARED) {
      await eventLog.append({ type: 'cleared', component: check, payload: { check } });
    }
  }

  /** One polling cycle. Never throws; problems go to onError. */
  async function tick() {
    const detectedAt = now().toISOString();
    let results;
    let items;
    try {
      const outcome = await fetchHealth();
      ({ results, items } = interpretHealth(outcome));
    } catch (e) {
      results = new Map([[APP_CHECK, RESULT_UNREACHABLE]]);
      items = [{ healthCheckId: APP_CHECK, status: 'unreachable', error: String(e?.message ?? e) }];
    }

    for (const [check, status] of results) {
      try {
        let open = false;
        if (typeof incidentManager.hasOpenIncident === 'function') open = Boolean(await incidentManager.hasOpenIncident(check));
        const out = step(windows.get(check) ?? createWindow(), status, open);
        windows.set(check, out.window);
        for (const emit of out.emit) await handleEmit(check, emit, items, detectedAt);
      } catch (e) {
        onError(e);
      }
    }
  }

  function schedule() {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      busy = tick();
      await busy;
      busy = null;
      schedule();
    }, intervalMs);
  }

  return {
    tick,
    intervalMs,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (busy) await busy;
    },
    get running() {
      return running;
    }
  };
}
