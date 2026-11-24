/**
 * Dashboard reducer (task 14.2; Requirements 14.11, 15.1, 15.2, 15.3, 15.5, 15.6, 15.8, 15.12).
 *
 * Pure: no I/O, no timers, no clock, no randomness, no React, no styling. All state is derived
 * from Events and API responses only. Nothing here is precomputed as a success outcome.
 * Constants below are copied from docs/api.md and docs/event-schema.md (no backend imports).
 *
 * INPUT SHAPE (divergence note: the task text says `reduce(state, event | apiResponse)`; the
 * input is a tagged action so Events and responses can be told apart unambiguously):
 *   { kind: 'event', event }                       one Event (docs/api.md "Event shape")
 *   { kind: 'api', endpoint, response }            endpoint is one of:
 *       'health'        GET /health                       -> { status, testApp, storage }
 *       'scenarios'     GET /scenarios                    -> { scenarios: [...] }
 *       'incidents'     GET /incidents                    -> { incidents: [Incident] }
 *       'incident'      GET /incidents/:id                -> Incident
 *       'events'        GET /events                       -> { events: [Event] }  (batch)
 *       'verification'  GET /incidents/:id/verification   -> Verification_Result
 *   { kind: 'chaos-start-requested' }              local UI action, no-op (Req 15.8)
 *   { kind: 'reset-requested' }                    local UI action, no-op (Req 15.8)
 * Anything else, or an invalid payload, is ignored: the same state object is returned.
 *
 * STATE SHAPE (plain JSON data):
 *   health:         last health response or null
 *   scenarios:      array of { id, label, severity } (public catalog fields)
 *   events:         timeline, ascending by seq, each seq once (first seen is kept)
 *   apiIncidents:   { [incidentId]: Incident } as last returned by the API
 *   apiVerifications: { [incidentId]: Verification_Result } as last returned by the API
 *
 * EVENT VALIDATION: an Event must match the Event schema (all fields, no extra properties,
 * integer seq >= 0, UUID id, ISO-8601 ts, known type, non-empty component, incidentId/runId
 * non-empty string or null, object payload). Events that do not (including unknown types)
 * are ignored and never enter the timeline.
 *
 * OUTCOME RULES (see selectIncidentOutcome):
 *   - Current Incident state = `payload.to` of the highest-seq `incident.state` Event for that
 *     Incident (order independent). Only when no such Event exists is the API Incident state used.
 *   - `recovered` requires state === 'recovered' AND a `verification` Event with
 *     payload.overall === 'pass' for that Incident. State 'recovered' without it gives
 *     `unverified_recovery_claim`. API verification responses and health never give recovery.
 *   - `escalated` and `rolled_back` are separate outcomes.
 */

export const EVENT_TYPES = Object.freeze([
  'chaos.selection', 'chaos.injection', 'chaos.rejected', 'detection', 'transient', 'cleared',
  'incident.state', 'diagnosis', 'plan', 'gate', 'repair', 'verification', 'rollback',
  'escalation', 'recovery', 'battle_result', 'reset', 'security', 'error', 'timeout',
]);

export const INCIDENT_STATES = Object.freeze([
  'detected', 'investigating', 'planned', 'repairing', 'verifying', 'recovered', 'rolled_back', 'escalated',
]);

export const OUTCOMES = Object.freeze({
  NONE: 'none',
  ACTIVE: 'active',
  RECOVERED: 'recovered',
  ESCALATED: 'escalated',
  ROLLED_BACK: 'rolled_back',
  UNVERIFIED_RECOVERY_CLAIM: 'unverified_recovery_claim',
});

const EVENT_KEYS = ['id', 'seq', 'ts', 'type', 'component', 'incidentId', 'runId', 'payload'];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const initialState = Object.freeze({
  health: null,
  scenarios: Object.freeze([]),
  events: Object.freeze([]),
  apiIncidents: Object.freeze({}),
  apiVerifications: Object.freeze({}),
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const clone = (v) => JSON.parse(JSON.stringify(v));

export function isValidEvent(e) {
  if (!isObject(e)) return false;
  const keys = Object.keys(e);
  if (keys.length !== EVENT_KEYS.length || !EVENT_KEYS.every((k) => keys.includes(k))) return false;
  return (
    typeof e.id === 'string' && UUID.test(e.id) &&
    Number.isInteger(e.seq) && e.seq >= 0 &&
    typeof e.ts === 'string' && ISO.test(e.ts) &&
    EVENT_TYPES.includes(e.type) &&
    isNonEmptyString(e.component) &&
    (e.incidentId === null || isNonEmptyString(e.incidentId)) &&
    (e.runId === null || isNonEmptyString(e.runId)) &&
    isObject(e.payload)
  );
}

function isValidIncident(i) {
  return isObject(i) && isNonEmptyString(i.incidentId) && INCIDENT_STATES.includes(i.state);
}

// Insert validated events into the sorted timeline. Returns the same array if nothing was added.
function addEvents(events, candidates) {
  let next = events;
  for (const candidate of candidates) {
    if (!isValidEvent(candidate)) continue;
    let lo = 0;
    let hi = next.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (next[mid].seq < candidate.seq) lo = mid + 1; else hi = mid;
    }
    if (lo < next.length && next[lo].seq === candidate.seq) continue; // duplicate: first seen kept
    if (next === events) next = events.slice();
    next.splice(lo, 0, clone(candidate));
  }
  return next;
}

function reduceApi(state, endpoint, response) {
  if (!isObject(response)) return state;
  switch (endpoint) {
    case 'health':
      if (!['ok', 'degraded', 'storage_error'].includes(response.status) || !isObject(response.testApp)) return state;
      return { ...state, health: clone(response) };
    case 'scenarios': {
      if (!Array.isArray(response.scenarios)) return state;
      const scenarios = response.scenarios.filter((s) => isObject(s) && isNonEmptyString(s.id)).map(clone);
      return { ...state, scenarios };
    }
    case 'incidents': {
      if (!Array.isArray(response.incidents)) return state;
      const apiIncidents = { ...state.apiIncidents };
      for (const i of response.incidents) if (isValidIncident(i)) apiIncidents[i.incidentId] = clone(i);
      return { ...state, apiIncidents };
    }
    case 'incident':
      if (!isValidIncident(response)) return state;
      return { ...state, apiIncidents: { ...state.apiIncidents, [response.incidentId]: clone(response) } };
    case 'events': {
      if (!Array.isArray(response.events)) return state;
      const events = addEvents(state.events, response.events);
      return events === state.events ? state : { ...state, events };
    }
    case 'verification':
      if (!isNonEmptyString(response.incidentId) || !isNonEmptyString(response.verificationId) ||
          !['pass', 'fail'].includes(response.overall)) return state;
      return { ...state, apiVerifications: { ...state.apiVerifications, [response.incidentId]: clone(response) } };
    default:
      return state;
  }
}

export function reduce(state = initialState, action) {
  if (!isObject(action)) return state;
  switch (action.kind) {
    case 'event': {
      const events = addEvents(state.events, [action.event]);
      return events === state.events ? state : { ...state, events };
    }
    case 'api':
      return reduceApi(state, action.endpoint, action.response);
    case 'chaos-start-requested':
    case 'reset-requested':
      return state; // Req 15.8: nothing displayed changes until Events or API responses arrive
    default:
      return state;
  }
}

// ----- selectors (pure, derived from state only) ---------------------------------------------

export function selectTimeline(state) {
  return state.events;
}

export function selectHealth(state) {
  return state.health;
}

function incidentEvents(state, incidentId) {
  return state.events.filter((e) => e.incidentId === incidentId);
}

/** Incident ids seen in Events or API responses. */
export function selectIncidentIds(state) {
  const ids = new Set(Object.keys(state.apiIncidents));
  for (const e of state.events) if (e.incidentId !== null) ids.add(e.incidentId);
  return [...ids].sort();
}

/** The Incident of the highest-seq Event that has one, else the newest API Incident, else null. */
export function selectCurrentIncidentId(state) {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    if (state.events[i].incidentId !== null) return state.events[i].incidentId;
  }
  const api = Object.values(state.apiIncidents);
  if (api.length === 0) return null;
  api.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : a.incidentId < b.incidentId ? 1 : -1));
  return api[0].incidentId;
}

export function selectIncidentState(state, incidentId) {
  const events = incidentEvents(state, incidentId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'incident.state' && INCIDENT_STATES.includes(e.payload.to)) return e.payload.to;
  }
  return state.apiIncidents[incidentId]?.state ?? null;
}

/** The `verification` Event with overall=pass for the Incident (highest seq), or null. */
export function selectPassingVerification(state, incidentId) {
  const events = incidentEvents(state, incidentId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'verification' && e.payload.overall === 'pass' &&
        (e.payload.incidentId === undefined || e.payload.incidentId === incidentId)) return e;
  }
  return null;
}

export function selectIncidentOutcome(state, incidentId) {
  if (!isNonEmptyString(incidentId)) return OUTCOMES.NONE;
  const current = selectIncidentState(state, incidentId);
  if (current === null) return OUTCOMES.NONE;
  if (current === 'recovered') {
    return selectPassingVerification(state, incidentId) ? OUTCOMES.RECOVERED : OUTCOMES.UNVERIFIED_RECOVERY_CLAIM;
  }
  if (current === 'escalated') return OUTCOMES.ESCALATED;
  if (current === 'rolled_back') return OUTCOMES.ROLLED_BACK;
  return OUTCOMES.ACTIVE;
}

/** Everything the Incident panel needs (Req 15.3), derived from Events with API data as fallback. */
export function selectIncidentView(state, incidentId) {
  const api = state.apiIncidents[incidentId] ?? null;
  const events = incidentEvents(state, incidentId);
  const last = (type) => {
    for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === type) return events[i];
    return null;
  };
  const ofType = (type) => events.filter((e) => e.type === type);
  const diagnosisEvent = last('diagnosis');
  const verificationEvent = last('verification');
  const escalationEvent = last('escalation');
  const outcome = selectIncidentOutcome(state, incidentId);
  if (outcome === OUTCOMES.NONE && api === null && events.length === 0) return null;
  return {
    incidentId,
    state: selectIncidentState(state, incidentId),
    outcome,
    component: api?.component ?? null,
    diagnosis: diagnosisEvent?.payload.diagnosis ?? api?.diagnosis ?? null,
    plans: ofType('plan').map((e) => e.payload),
    gateDecisions: ofType('gate').map((e) => e.payload),
    attemptCount: api?.attemptCount ?? ofType('repair').length,
    verification: verificationEvent?.payload ?? state.apiVerifications[incidentId] ?? null,
    recoveryVerification: selectPassingVerification(state, incidentId)?.payload ?? null,
    rollbacks: ofType('rollback').map((e) => e.payload),
    escalation: escalationEvent?.payload ?? null,
    terminalReason: escalationEvent?.payload.reason ?? api?.terminalReason ?? null,
  };
}
