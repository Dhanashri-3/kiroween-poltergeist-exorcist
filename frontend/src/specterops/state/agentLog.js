import { omittedPayloadBytes } from '../../state/dashboardViews.js';

/**
 * Agent activity log mapping (Phase 4B.3B). Pure: no React, no I/O, no clock.
 *
 * Every line is derived from one genuine backend Event, or from a client-side note the caller supplies
 * (for example a useLiveRefresh failure). Nothing is invented: when a payload field is missing the text
 * says less, it never fills the gap.
 *
 * The actor is chosen by `event.type` only. `event.component` is never used for the label: the real
 * backend emits `scenario-engine`, `orchestrator`, `incident_manager`, `safety-gate`, ... while the
 * fake-API fixtures use other names, so the component cannot identify an agent reliably.
 */

export const ACTORS = Object.freeze({ POLTERGEIST: 'POLTERGEIST', EXORCIST: 'EXORCIST', SYSTEM: 'SYSTEM' });

/** Approved mapping (Phase 4B.3A section 3 and the 4B.3B decisions). Any other type is SYSTEM. */
export const EVENT_ACTORS = Object.freeze({
  'chaos.selection': ACTORS.POLTERGEIST,
  'chaos.injection': ACTORS.POLTERGEIST,
  diagnosis: ACTORS.EXORCIST,
  plan: ACTORS.EXORCIST,
  repair: ACTORS.EXORCIST,
  rollback: ACTORS.EXORCIST,
  escalation: ACTORS.EXORCIST,
  recovery: ACTORS.EXORCIST,
  // Explicitly SYSTEM (listed so the decision is visible in code):
  'chaos.rejected': ACTORS.SYSTEM,
  battle_result: ACTORS.SYSTEM,
  detection: ACTORS.SYSTEM,
  transient: ACTORS.SYSTEM,
  cleared: ACTORS.SYSTEM,
  'incident.state': ACTORS.SYSTEM,
  gate: ACTORS.SYSTEM,
  verification: ACTORS.SYSTEM,
  reset: ACTORS.SYSTEM,
  security: ACTORS.SYSTEM,
  error: ACTORS.SYSTEM,
  timeout: ACTORS.SYSTEM,
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);

export function actorForEvent(event) {
  const type = isObject(event) ? event.type : null;
  return (typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_ACTORS, type))
    ? EVENT_ACTORS[type] : ACTORS.SYSTEM;
}

/** `rule_based` is the fallback mapping, never AI reasoning. Other sources are shown verbatim. */
export function describeSource(source) {
  const s = str(source);
  if (s === null) return null;
  return s === 'rule_based' ? 'rule-based fallback' : `source: ${s}`;
}

const withSuffix = (text, part) => (part ? `${text} ${part}` : text);
const inParens = (v) => (v ? `(${v})` : null);

/**
 * One line of text for an Event. `outcomeFor(incidentId)` is optional and returns the reducer outcome;
 * it is used only to mark a `recovered` state that has no passing verification.
 */
export function describeEvent(event, { outcomeFor } = {}) {
  if (!isObject(event)) return 'Unreadable event.';
  const p = isObject(event.payload) ? event.payload : {};
  if (omittedPayloadBytes(p) !== null) return `${event.type} event recorded (payload omitted).`;
  const incident = str(event.incidentId);
  switch (event.type) {
    case 'chaos.selection':
      return str(p.scenarioId) ? `Selected scenario ${p.scenarioId}.` : 'Selected a scenario.';
    case 'chaos.injection': {
      const scenario = str(p.scenarioId) ? `scenario ${p.scenarioId}` : 'a scenario';
      return str(p.targetComponent)
        ? `Injected ${scenario} into component ${p.targetComponent}.`
        : `Injected ${scenario}.`;
    }
    case 'chaos.rejected':
      return withSuffix('Chaos request rejected.', str(p.reason) ? `Reason: ${p.reason}.` : null);
    case 'battle_result':
      // Never repeat a winner claim: outcomes come only from verified Incident state.
      return 'Battle result event recorded. Outcomes are shown only from verified Incident state.';
    case 'detection': {
      const check = str(p.failingComponent) ?? str(p.check) ?? str(event.component);
      return check ? `Monitor reported a failing check: ${check}.` : 'Monitor reported a failing check.';
    }
    case 'transient':
      return `Transient failure on ${str(p.check) ?? str(event.component) ?? 'a check'}; no Incident opened.`;
    case 'cleared':
      return `Check ${str(p.check) ?? str(event.component) ?? 'unknown'} passed again.`;
    case 'incident.state': {
      const to = str(p.to) ?? 'unknown';
      let text = `Incident ${incident ?? 'unknown'} state: ${to}.`;
      if (to === 'recovered' && typeof outcomeFor === 'function' && incident && outcomeFor(incident) !== 'recovered') {
        text += ' Not verified.';
      }
      return text;
    }
    case 'diagnosis': {
      const status = str(p.status) ?? 'recorded';
      const cause = isObject(p.diagnosis) ? str(p.diagnosis.rootCause) : null;
      const head = `${withSuffix(`Diagnosis ${status}`, inParens(describeSource(p.source)))}.`;
      return withSuffix(head, cause ? `Root cause: ${cause}` : null);
    }
    case 'plan': {
      const source = inParens(describeSource(p.source));
      if (p.rejected === true) return `${withSuffix('Repair plan rejected by validation', source)}.`;
      const plan = isObject(p.plan) ? p.plan : {};
      const what = [str(plan.actionType), str(plan.targetFile) ? `on ${plan.targetFile}` : null].filter(Boolean).join(' ');
      return `${withSuffix(what ? `Repair plan proposed: ${what}` : 'Repair plan proposed', source)}.`;
    }
    case 'gate':
      return `Safety Gate decision: ${str(p.decision) ?? 'recorded'}.`;
    case 'repair':
      return withSuffix(`Repair written${str(p.target) ? ` to ${p.target}` : ''}.`, str(p.snapshotId) ? `Snapshot ${p.snapshotId}.` : null);
    case 'verification': {
      const overall = str(p.overall) ?? 'recorded';
      const checks = Array.isArray(p.checks) ? p.checks.filter(isObject) : null;
      const passed = checks ? checks.filter((c) => c.outcome === 'pass').length : null;
      return withSuffix(`Verification ${overall}.`, checks ? `${passed} of ${checks.length} checks passed.` : null);
    }
    case 'rollback':
      return withSuffix(`Rollback ${str(p.status) ?? 'recorded'}.`, str(p.reason) ? `Reason: ${p.reason}.` : null);
    case 'escalation':
      return withSuffix('Escalated to a human.', str(p.reason) ? `Reason: ${p.reason}.` : null);
    case 'recovery': {
      const parts = [str(p.verificationId) ? `verification ${p.verificationId}` : null,
        int(p.healthyChecks) !== null ? `${p.healthyChecks} healthy checks` : null].filter(Boolean);
      return parts.length ? `Recovery confirmed: ${parts.join(', ')}.` : 'Recovery confirmed.';
    }
    case 'reset':
      return 'Reset event recorded.';
    case 'security':
      return withSuffix('File Guard security event.', str(p.reason) ? `Reason: ${p.reason}.` : null);
    case 'error':
      return withSuffix(`Error${str(p.stage) ? ` during ${p.stage}` : ''}.`, str(p.message) ?? str(p.reason));
    case 'timeout':
      return `Timeout${str(p.stage) ? ` during ${p.stage}` : ''}.`;
    default:
      return `${String(event.type)} event recorded.`;
  }
}

const SYSTEM_PREFIX = /^\[SYSTEM\]\s*/;

/**
 * Builds the visible log lines.
 *   events     reducer timeline (ascending by seq)
 *   notes      client-side notes: { id, text, afterSeq }. Placed right after the Event with seq afterSeq.
 *   watermark  highest seq treated as history (null = nothing is live yet). Only lines above it are `live`.
 *   limit      keep the newest N lines
 * Returns [{ key, actor, text, seq, type, live, source: 'event' | 'client' }].
 */
export function buildLogLines({ events = [], notes = [], watermark = null, outcomeFor, limit = 50 } = {}) {
  const items = [];
  let order = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObject(e) || !Number.isInteger(e.seq)) continue;
    items.push({
      pos: e.seq, order: order++,
      line: {
        key: `e-${e.seq}`, actor: actorForEvent(e), text: describeEvent(e, { outcomeFor }), seq: e.seq,
        type: e.type, live: watermark !== null && e.seq > watermark, source: 'event',
      },
    });
  }
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!isObject(n) || str(n.text) === null) continue;
    const after = Number.isInteger(n.afterSeq) ? n.afterSeq : -1;
    items.push({
      pos: after + 0.5, order: order++,
      line: {
        key: `n-${n.id ?? order}`, actor: ACTORS.SYSTEM, text: n.text.replace(SYSTEM_PREFIX, ''), seq: null,
        type: 'client', live: true, source: 'client',
      },
    });
  }
  items.sort((a, b) => a.pos - b.pos || a.order - b.order);
  const lines = items.map((i) => i.line);
  return limit > 0 ? lines.slice(-limit) : lines;
}
