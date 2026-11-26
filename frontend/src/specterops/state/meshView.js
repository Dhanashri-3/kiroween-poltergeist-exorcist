/**
 * Defense Mesh view model (Phase 4B.3B). Pure: no React, no I/O.
 *
 * Each card shows one Test_App health check exactly as the backend reported it (GET /health ->
 * testApp.components[key]) and, separately, the newest Incident whose recorded component is that key.
 * No metric, percentage, uptime or latency is produced: the backend reports none.
 *
 * Inputs:
 *   health     the reducer's health (GET /health response) or null
 *   incidents  [{ incidentId, component, outcome, lastSeq }] supplied by the caller from reducer selectors.
 *              `component` is the Incident record's component (null while the record is not loaded yet).
 *              `outcome` is selectIncidentOutcome(). `lastSeq` (optional) orders Incidents; higher is newer.
 */

export const MESH_CARDS = Object.freeze([
  Object.freeze({ code: '01', name: 'Neural Core', key: 'dataPanel', icon: 'cpu' }),
  Object.freeze({ code: '02', name: 'Edge Firewall', key: 'button', icon: 'shield' }),
  Object.freeze({ code: '03', name: 'Vault Auth', key: 'card', icon: 'key' }),
  Object.freeze({ code: '04', name: 'System Layout', key: 'layout', icon: 'grid' }),
]);

export const CARD_KEYS = Object.freeze(MESH_CARDS.map((c) => c.key));

/** Outcome text. Wording avoids any recovery claim that the reducer has not confirmed. */
export const OUTCOME_LABELS = Object.freeze({
  none: 'State not reported yet',
  active: 'Incident open',
  rolled_back: 'Rolled back, not recovered',
  escalated: 'Escalated, not recovered',
  unverified_recovery_claim: 'Recovery claimed, not verified',
  recovered: 'Verified recovery',
});

const OPEN_OUTCOMES = new Set(['active', 'rolled_back', 'unverified_recovery_claim']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

export const outcomeLabel = (outcome) => OUTCOME_LABELS[outcome] ?? `Outcome: ${String(outcome)}`;

/**
 * Normalizes one component entry. Real Test_App: { status: 'ok' } | { status: 'fail', error }.
 * Fake fixtures may use a plain string ('ok'). Anything else gives status null.
 */
export function normalizeComponentHealth(components, key) {
  const value = isObject(components) ? components[key] : undefined;
  const status = (isObject(value) ? str(value.status) : null) ?? (typeof value === 'string' && value !== '' ? value : null);
  const error = isObject(value) ? str(value.error) : null;
  return { status, error };
}

/** state: 'nominal' (ok), 'breached' (fail), 'unknown' (any other reported value), 'unavailable' (nothing reported). */
function healthFor(health, key) {
  if (!isObject(health) || !isObject(health.testApp)) {
    return { state: 'unavailable', status: null, error: null, note: 'No health data yet.' };
  }
  if (health.testApp.reachable === false) {
    return { state: 'unavailable', status: null, error: null, note: 'Test_App unreachable.' };
  }
  if (!isObject(health.testApp.components)) {
    return { state: 'unavailable', status: null, error: null, note: 'Component health not reported.' };
  }
  const { status, error } = normalizeComponentHealth(health.testApp.components, key);
  if (status === null) return { state: 'unavailable', status: null, error: null, note: 'Not reported.' };
  if (status === 'ok') return { state: 'nominal', status, error, note: null };
  if (status === 'fail') return { state: 'breached', status, error, note: null };
  return { state: 'unknown', status, error, note: null };
}

function cleanIncidents(incidents) {
  return (Array.isArray(incidents) ? incidents : [])
    .map((i, index) => (isObject(i) && str(i.incidentId)
      ? {
        incidentId: i.incidentId,
        component: str(i.component),
        outcome: str(i.outcome) ?? 'none',
        lastSeq: Number.isInteger(i.lastSeq) ? i.lastSeq : -1,
        index,
      }
      : null))
    .filter(Boolean);
}

const newestFirst = (a, b) => b.lastSeq - a.lastSeq || b.index - a.index;

function badgeFor(healthState, outcome) {
  if (healthState === 'breached') return { tone: 'breached', text: 'BREACHED // FAULT' };
  if (outcome && OPEN_OUTCOMES.has(outcome)) return { tone: 'breached', text: 'INCIDENT OPEN' };
  if (outcome === 'escalated') return { tone: 'escalated', text: 'ESCALATED' };
  if (outcome === 'recovered') return { tone: 'verified', text: 'PATCHED // VERIFIED' };
  if (healthState === 'nominal') return { tone: 'nominal', text: 'NOMINAL' };
  if (healthState === 'unknown') return { tone: 'unknown', text: 'STATUS REPORTED' };
  return { tone: 'unavailable', text: 'UNAVAILABLE' };
}

export function deriveMeshView({ health = null, incidents = [] } = {}) {
  const list = cleanIncidents(incidents).sort(newestFirst);
  const cards = MESH_CARDS.map((card) => {
    const h = healthFor(health, card.key);
    const latest = list.find((i) => i.component === card.key) ?? null;
    const outcome = latest ? latest.outcome : null;
    return {
      ...card,
      health: h,
      incident: latest ? { incidentId: latest.incidentId, outcome, label: outcomeLabel(outcome) } : null,
      badge: badgeFor(h.state, outcome),
      damaged: h.state === 'breached' || (outcome !== null && OPEN_OUTCOMES.has(outcome)),
      verified: outcome === 'recovered',
    };
  });
  const appLevel = list
    .filter((i) => i.component === null || !CARD_KEYS.includes(i.component))
    .map((i) => ({
      incidentId: i.incidentId,
      component: i.component,
      outcome: i.outcome,
      label: outcomeLabel(i.outcome),
      scope: i.component === 'app' ? 'Whole Test_App'
        : i.component ? `Component ${i.component}` : 'Component not reported yet',
    }));
  return { cards, appLevel };
}
