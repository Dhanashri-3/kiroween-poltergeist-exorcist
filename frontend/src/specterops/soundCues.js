/**
 * Sound cue selection (Phase 4B.4B). No React, no audio, no I/O.
 *
 * Input is the reducer timeline (validated Events, unique by seq), the history watermark from
 * useHistoryWatermark (null = nothing is live) and the reducer's authoritative outcome selector.
 *
 * Rules:
 *   - Only Events with seq > watermark are eligible. A null watermark makes nothing eligible.
 *   - Each seq is handled once. A handled Event never produces a cue later, whatever happens.
 *   - When `canPlay` is false (muted, hidden tab, audio off) eligible Events are still consumed, so nothing
 *     is queued and nothing plays later.
 *   - The success cue is never derived from a single Event. A live `incident.state -> recovered` Event puts its
 *     Incident on a pending list; the cue is emitted once, when outcomeFor(incidentId) === 'recovered' (state
 *     recovered AND a passing verification for that Incident, see selectIncidentOutcome). While the outcome is
 *     still `unverified_recovery_claim` the Incident stays pending, so a verification that arrives later is
 *     picked up. Any other outcome removes it. discardPending() drops all pending Incidents for good.
 *   - At most one success cue per Incident.
 */

export const CUES = Object.freeze({
  POLTERGEIST: 'poltergeist',
  DIAGNOSE: 'diagnose',
  REPAIR_START: 'repair-start',
  REPAIR_DONE: 'repair-done',
  VERIFY_PASS: 'verify-pass',
  VERIFY_FAIL: 'verify-fail',
  ROLLBACK: 'rollback',
  ESCALATE: 'escalate',
  RECOVERED: 'recovered',
});

const RECOVERED_OUTCOME = 'recovered';
const UNVERIFIED_OUTCOME = 'unverified_recovery_claim';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v !== '';

/**
 * The per-Event cue, or null. Never returns the success cue: that one needs the authoritative outcome.
 * Silent by design: chaos.selection, chaos.rejected, detection, transient, cleared, plan, gate, recovery,
 * battle_result, reset, security, error, timeout, and incident.state other than repairing / escalated.
 */
export function cueForEvent(event) {
  if (!isObject(event)) return null;
  const p = isObject(event.payload) ? event.payload : {};
  switch (event.type) {
    case 'chaos.injection': return CUES.POLTERGEIST;
    case 'diagnosis': return CUES.DIAGNOSE;
    case 'repair': return CUES.REPAIR_DONE;
    case 'verification':
      if (p.overall === 'pass') return CUES.VERIFY_PASS;
      if (p.overall === 'fail') return CUES.VERIFY_FAIL;
      return null;
    case 'rollback': return CUES.ROLLBACK;
    case 'incident.state':
      if (p.to === 'repairing') return CUES.REPAIR_START;
      if (p.to === 'escalated') return CUES.ESCALATE;
      return null;
    default: return null;
  }
}

/** Stateful bookkeeping for one App instance. */
export function createCueTracker() {
  const handled = new Set(); // seqs already considered
  const pending = new Set(); // incidentIds with a live recovered claim awaiting the authoritative outcome
  const decided = new Set(); // incidentIds whose success cue was played or discarded

  function discardPending() {
    for (const id of pending) decided.add(id);
    pending.clear();
  }

  /**
   * Consumes newly eligible Events and returns the cues to play now, in order: [{ key, cue, seq }].
   * `outcomeFor(incidentId)` must be the reducer's selectIncidentOutcome bound to the current state.
   */
  function next({ events = [], watermark = null, outcomeFor, canPlay = false } = {}) {
    if (!Number.isInteger(watermark)) return [];
    if (!canPlay) discardPending();
    const out = [];
    for (const e of Array.isArray(events) ? events : []) {
      if (!isObject(e) || !Number.isInteger(e.seq) || e.seq <= watermark || handled.has(e.seq)) continue;
      handled.add(e.seq);
      if (!canPlay) {
        // Dropped, not queued. A recovered claim seen now can never sound later.
        if (e.type === 'incident.state' && e.payload?.to === 'recovered' && isId(e.incidentId)) decided.add(e.incidentId);
        continue;
      }
      const cue = cueForEvent(e);
      if (cue) out.push({ key: `e:${e.seq}`, cue, seq: e.seq });
      if (e.type === 'incident.state' && e.payload?.to === 'recovered' && isId(e.incidentId) && !decided.has(e.incidentId)) {
        pending.add(e.incidentId);
      }
    }
    if (canPlay && typeof outcomeFor === 'function') {
      for (const id of [...pending]) {
        const outcome = outcomeFor(id);
        if (outcome === RECOVERED_OUTCOME) {
          pending.delete(id);
          decided.add(id);
          out.push({ key: `recovered:${id}`, cue: CUES.RECOVERED, seq: null });
        } else if (outcome !== UNVERIFIED_OUTCOME) {
          pending.delete(id); // the claim no longer stands (for example a later state); never a success
          decided.add(id);
        }
      }
    }
    return out;
  }

  return Object.freeze({
    next,
    discardPending,
    pendingCount: () => pending.size,
  });
}

export default createCueTracker;
