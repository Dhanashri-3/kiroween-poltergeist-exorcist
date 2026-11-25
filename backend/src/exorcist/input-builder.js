// Exorcist input builder (Task 10.1, Requirements 3.8, 7.1, 7.4, 17.3).
//
// buildExorcistInput(incident, eventLog, deps) returns the ONLY data the Exorcist may see:
//   - evidence:      the Incident's Evidence (contract fields only)
//   - sources:       a read-only, redacted view of the Approved_Files (never .env* or .git/)
//   - priorAttempts: the Incident's own failed plans and their Verification_Results
//
// Information barrier: the output is assembled from an explicit allow-list of fields, so scenario
// IDs, injection methods and chaos.* Event data cannot be carried through by accident. Events are
// read only through the Event_Log's Exorcist view (which excludes chaos.*), and any chaos.* event
// is dropped again here as a second guard.
//
// Import rule: this module may import only contracts/ and its own directory, so the Redactor,
// the Evidence store and the Approved_File reader are injected through `deps`:
//   deps.redact(value)              -> deep-redacted copy (the Redactor from events/)
//   deps.loadEvidence(incident)     -> Evidence | Evidence[] | undefined (sync or async)
//   deps.readApprovedSources()      -> [{ path, content }] for the Approved_Files (sync or async)

const CHAOS_PREFIX = 'chaos.';
const SUCCESS_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded', 'recovered']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True for .env* files and anything under a .git directory (case-insensitive, either slash). */
export function isDenylistedSourcePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  const segments = candidate.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  if (segments.includes('.git')) return true;
  return segments.length > 0 && segments[segments.length - 1].startsWith('.env');
}

function pick(source, keys) {
  const out = {};
  if (!isObject(source)) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = structuredClone(source[key]);
  return out;
}

const EVIDENCE_KEYS = ['evidenceId', 'incidentId', 'healthCheckResults', 'consoleErrors', 'domSnapshotRef', 'screenshotPath', 'capturedAt'];
const PLAN_KEYS = ['incidentId', 'actionType', 'targetFile', 'change', 'rationale'];
const ATTEMPT_KEYS = ['attemptNo', 'planHash', 'snapshotId', 'verificationId', 'outcome'];
const VERIFICATION_KEYS = ['verificationId', 'incidentId', 'attemptNo', 'checks', 'originalFailingCheckRan', 'overall', 'startedAt', 'durationMs'];
const CHECK_KEYS = ['checkId', 'kind', 'coversComponent', 'outcome', 'rawOutputRef'];

function toVerification(payload) {
  const v = pick(payload, VERIFICATION_KEYS);
  if (Array.isArray(v.checks)) v.checks = v.checks.map((c) => pick(c, CHECK_KEYS));
  return v;
}

async function loadEvidence(incident, deps) {
  if (typeof deps.loadEvidence !== 'function') return [];
  const raw = await deps.loadEvidence(incident);
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list
    .filter((e) => isObject(e) && (e.incidentId === undefined || e.incidentId === incident.incidentId))
    // Evidence is captured before the Incident exists, so it may lack an incidentId; bind it to this Incident.
    .map((e) => ({ ...pick(e, EVIDENCE_KEYS), incidentId: incident.incidentId }));
}

async function loadSources(deps) {
  if (typeof deps.readApprovedSources !== 'function') return [];
  const raw = await deps.readApprovedSources();
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => isObject(f) && typeof f.path === 'string' && typeof f.content === 'string' && !isDenylistedSourcePath(f.path))
    .map((f) => ({ path: f.path, content: f.content }));
}

async function loadOwnEvents(incident, eventLog) {
  const view = typeof eventLog?.exorcistView === 'function'
    ? eventLog.exorcistView(incident.incidentId)
    : eventLog?.nonChaosView?.();
  if (!view || typeof view.readAfter !== 'function') return [];
  const events = await view.readAfter(0);
  return (Array.isArray(events) ? events : []).filter(
    (e) => isObject(e)
      && typeof e.type === 'string'
      && !e.type.startsWith(CHAOS_PREFIX)
      && e.incidentId === incident.incidentId
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * @param {object} incident Incident (contract shape); only its own data is used.
 * @param {object} eventLog Event_Log (provides exorcistView(incidentId)).
 * @param {{redact: Function, loadEvidence?: Function, readApprovedSources?: Function}} deps
 * @returns {Promise<{incidentId: string, component: string, evidence: object[], sources: Array<{path: string, content: string}>, priorAttempts: object[]}>}
 */
export async function buildExorcistInput(incident, eventLog, deps = {}) {
  if (!isObject(incident) || typeof incident.incidentId !== 'string' || incident.incidentId === '') {
    throw new TypeError('buildExorcistInput requires an Incident with an incidentId.');
  }
  if (typeof deps.redact !== 'function') {
    throw new TypeError('buildExorcistInput requires deps.redact (the Redactor).');
  }

  const [evidence, sources, events] = await Promise.all([
    loadEvidence(incident, deps),
    loadSources(deps),
    loadOwnEvents(incident, eventLog),
  ]);

  const verifications = events.filter((e) => e.type === 'verification' && isObject(e.payload)).map((e) => toVerification(e.payload));
  const plans = Array.isArray(incident.plans) ? incident.plans : [];
  const attempts = Array.isArray(incident.attempts) ? incident.attempts : [];

  const priorAttempts = [];
  attempts.forEach((attempt, index) => {
    if (!isObject(attempt)) return;
    const verification = verifications.find((v) => v.verificationId !== undefined && v.verificationId === attempt.verificationId)
      ?? verifications.find((v) => v.attemptNo === attempt.attemptNo);
    const failed = verification ? verification.overall !== 'pass' : !SUCCESS_OUTCOMES.has(String(attempt.outcome).toLowerCase());
    if (!failed) return;
    const entry = { ...pick(attempt, ATTEMPT_KEYS), plan: pick(plans[(attempt.attemptNo ?? index + 1) - 1] ?? plans[index], PLAN_KEYS) };
    if (verification) entry.verification = verification;
    priorAttempts.push(entry);
  });

  const output = deps.redact({
    incidentId: incident.incidentId,
    component: incident.component,
    evidence,
    sources: sources.map((s) => ({ path: s.path, content: s.content })),
    priorAttempts,
  });
  return deepFreeze(output);
}
