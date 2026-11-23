// HTTP API (Task 12.1; Requirements 13.1-13.6, 14.8).
//
// createApiApp(deps) builds the Express application. It owns no state: every collaborator is injected
// and every operation goes through the existing modules (Orchestrator cycle controller, Incident_Manager,
// Event_Log, Scenario_Engine). Request bodies are validated with the contracts validate helper before
// anything else happens, so a rejected request changes nothing (13.3).
//
// Dependencies:
//   incidents        Incident_Manager: list(), get(id), getActive(), listVerifications(id)
//   eventLog         Event_Log: dashboardView().readAfter(seq, filter), storageStatus
//   cycleController  Orchestrator: startChaosRun(scenarioId?) -> {runId, scenarioId} | {conflict: true, ...}
//   scenarioEngine   Scenario_Engine: reset()
//   catalog          ScenarioCatalog (scenarios[] with scenarioId, label, severity, has(id))
//   fetchHealth      () -> Promise<{httpStatus, body}> for the Test_App health endpoint (rejects when unreachable)
//   dashboardOrigin  the single allowed CORS origin, an http loopback origin such as http://127.0.0.1:5173
//   sseHandler       (req, res, next) handler for GET /api/v1/events/stream (Task 12.3). Until it is supplied
//                    the route answers 501 not_implemented; nothing is simulated.
//
// Every response body is passed through the Redactor so a Secret can never leave in a response (13.6).

import express from 'express';
import { validate } from '../contracts/index.js';
import { redact } from '../events/redactor.js';

export const API_PREFIX = '/api/v1';
export const API_HOST = '127.0.0.1';
export const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class ApiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiConfigError';
    this.code = 'api_config_invalid';
  }
}

/** Accepts only a bare http(s) loopback origin (no path, query or credentials). Returns it normalized. */
export function parseDashboardOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ApiConfigError('dashboardOrigin must be a valid origin such as http://127.0.0.1:5173.');
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || !bare) {
    throw new ApiConfigError('dashboardOrigin must be an http(s) origin on the loopback address.');
  }
  return url.origin;
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errorBody = (code, message, details) => ({ error: { code, message, ...(details === undefined ? {} : { details }) } });

/** Public fields of a catalog entry; never targets, transforms or the expected repair. */
const toPublicScenario = (s) => ({ id: s.scenarioId, label: s.label, severity: s.severity });

function parseAfterSeq(raw) {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) {
    throw new ApiError(400, 'invalid_query', 'afterSeq must be a non-negative integer.', [{ path: '/afterSeq', keyword: 'type', message: 'must be a non-negative integer' }]);
  }
  return Number(raw);
}

function parseOptionalString(raw, name) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '' || raw.length > 200) {
    throw new ApiError(400, 'invalid_query', `${name} must be a non-empty string.`, [{ path: `/${name}`, keyword: 'type', message: 'must be a non-empty string' }]);
  }
  return raw;
}

function requireDep(cond, name) {
  if (!cond) throw new TypeError(`createApiApp: ${name} is required`);
}

export function createApiApp(deps = {}) {
  const { incidents, eventLog, cycleController, scenarioEngine, catalog, fetchHealth, sseHandler } = deps;
  requireDep(typeof incidents?.list === 'function' && typeof incidents?.get === 'function'
    && typeof incidents?.getActive === 'function' && typeof incidents?.listVerifications === 'function', 'incidents');
  requireDep(typeof eventLog?.dashboardView === 'function', 'eventLog');
  requireDep(typeof cycleController?.startChaosRun === 'function', 'cycleController.startChaosRun');
  requireDep(typeof scenarioEngine?.reset === 'function', 'scenarioEngine.reset');
  requireDep(Array.isArray(catalog?.scenarios) && typeof catalog?.has === 'function', 'catalog');
  requireDep(typeof fetchHealth === 'function', 'fetchHealth');
  requireDep(sseHandler === undefined || typeof sseHandler === 'function', 'sseHandler (function)');
  const allowedOrigin = parseDashboardOrigin(deps.dashboardOrigin);

  const app = express();
  app.disable('x-powered-by');

  // Start and reset change files and Incident flow, so they never run at the same time.
  let mutationQueue = Promise.resolve();
  const exclusive = (fn) => {
    const run = mutationQueue.then(fn);
    mutationQueue = run.catch(() => {});
    return run;
  };

  const send = (res, status, body) => res.status(status).json(redact(body));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ----- CORS (13.5): only the configured Dashboard origin -----------------------------------
  app.use((req, res, next) => {
    const origin = req.get('origin');
    res.set('Vary', 'Origin');
    if (origin === undefined) return next();
    if (origin !== allowedOrigin) {
      // No CORS headers for anyone else. Refuse state changes and preflights outright.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 403, errorBody('origin_not_allowed', 'This origin is not allowed.'));
      }
      return next();
    }
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
      res.set('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    return next();
  });

  // ----- body parsing -------------------------------------------------------------------------
  app.use((req, res, next) => {
    const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
    if (hasBody && !req.is('application/json')) {
      return send(res, 400, errorBody('invalid_content_type', 'Request bodies must be application/json.'));
    }
    return next();
  });
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));

  /** Validate a body against a contract schema; throws a 400 ApiError and nothing else happens. */
  const checkBody = (schemaName, body) => {
    const result = validate(schemaName, body === undefined ? {} : body);
    if (!result.valid) throw new ApiError(400, 'invalid_request', 'The request body failed schema validation.', result.errors);
    return body === undefined ? {} : body;
  };

  const router = express.Router();

  // ----- health (13.2, 14.8) ------------------------------------------------------------------
  router.get('/health', wrap(async (req, res) => {
    let testApp;
    try {
      const { httpStatus, body } = await fetchHealth();
      const components = body && typeof body === 'object' && !Array.isArray(body) ? body.components ?? body : null;
      testApp = { reachable: true, httpStatus, components: components ?? null };
    } catch (e) {
      testApp = { reachable: false, httpStatus: null, components: null, error: e instanceof Error ? e.message : String(e) };
    }
    const storage = eventLog.storageStatus ?? { ok: true };
    const testAppOk = testApp.reachable && testApp.httpStatus === 200;
    const status = !storage.ok ? 'storage_error' : testAppOk ? 'ok' : 'degraded';
    return send(res, 200, { status, testApp, storage });
  }));

  // ----- scenarios (public fields only) ------------------------------------------------------
  router.get('/scenarios', (req, res) => send(res, 200, { scenarios: catalog.scenarios.map(toPublicScenario) }));

  // ----- chaos runs (13.3, 13.4) --------------------------------------------------------------
  router.post('/chaos-runs', wrap(async (req, res) => {
    const body = checkBody('ChaosRunRequest', req.body);
    if (body.scenarioId !== undefined && !catalog.has(body.scenarioId)) {
      throw new ApiError(400, 'unknown_scenario', 'The scenario is not in the Scenario_Catalog.', [{ path: '/scenarioId', keyword: 'enum', message: 'must be a catalog scenario ID' }]);
    }
    const result = await exclusive(() => cycleController.startChaosRun(body.scenarioId));
    if (result?.conflict === true) {
      return send(res, 409, errorBody('incident_active', result.reason ?? 'An Incident is not yet terminal.', { incidentId: result.incidentId ?? null }));
    }
    return send(res, 202, { runId: result.runId, scenarioId: result.scenarioId });
  }));

  // ----- incidents ----------------------------------------------------------------------------
  router.get('/incidents', wrap(async (req, res) => send(res, 200, { incidents: await incidents.list() })));

  router.get('/incidents/:id', wrap(async (req, res) => {
    const incident = await incidents.get(req.params.id);
    if (!incident) throw new ApiError(404, 'incident_not_found', 'No Incident has that ID.');
    return send(res, 200, incident);
  }));

  router.get('/incidents/:id/verification', wrap(async (req, res) => {
    const incident = await incidents.get(req.params.id);
    if (!incident) throw new ApiError(404, 'incident_not_found', 'No Incident has that ID.');
    const results = await incidents.listVerifications(req.params.id);
    if (results.length === 0) throw new ApiError(404, 'verification_not_found', 'This Incident has no Verification_Result yet.');
    return send(res, 200, results[results.length - 1]);
  }));

  // ----- events -------------------------------------------------------------------------------
  // Registered before any parameterised route; the SSE handler is the Task 12.3 hook.
  router.get('/events/stream', (req, res, next) => {
    if (typeof sseHandler === 'function') return sseHandler(req, res, next);
    return send(res, 501, errorBody('not_implemented', 'The event stream is not available yet.'));
  });

  router.get('/events', wrap(async (req, res) => {
    const afterSeq = parseAfterSeq(req.query.afterSeq);
    const incidentId = parseOptionalString(req.query.incidentId, 'incidentId');
    const filter = incidentId === undefined ? undefined : { incidentId };
    const events = await eventLog.dashboardView().readAfter(afterSeq, filter);
    return send(res, 200, { events });
  }));

  // ----- reset --------------------------------------------------------------------------------
  router.post('/reset', wrap(async (req, res) => {
    checkBody('ResetRequest', req.body);
    const outcome = await exclusive(async () => {
      const active = await incidents.getActive();
      if (active) return { conflict: active };
      return { result: await scenarioEngine.reset() };
    });
    if (outcome.conflict) {
      return send(res, 409, errorBody('incident_active', 'The Test_App cannot be reset while an Incident is not terminal.', { incidentId: outcome.conflict.incidentId }));
    }
    const { snapshotId, checksums, timestamp, eventId } = outcome.result;
    return send(res, 200, { reset: true, snapshotId, checksums, timestamp, eventId });
  }));

  app.use(API_PREFIX, router);

  // ----- errors -------------------------------------------------------------------------------
  app.use((req, res) => send(res, 404, errorBody('not_found', 'No such endpoint.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.end();
    if (err instanceof ApiError) return send(res, err.status, errorBody(err.code, err.message, err.details));
    if (err?.type === 'entity.parse.failed') return send(res, 400, errorBody('invalid_json', 'The request body is not valid JSON.'));
    if (err?.type === 'entity.too.large') return send(res, 413, errorBody('payload_too_large', 'The request body is too large.'));
    if (err?.code === 'storage_error') return send(res, 503, errorBody('storage_error', 'The Event_Log could not persist data.'));
    if (err?.code === 'unknown_scenario') return send(res, 400, errorBody('unknown_scenario', 'The scenario is not in the Scenario_Catalog.'));
    return send(res, 500, errorBody('internal_error', 'The request could not be completed.'));
  });

  return app;
}
