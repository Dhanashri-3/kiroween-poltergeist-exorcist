// Incident_Manager (Task 6.4; Requirements 6.1, 6.5-6.9, 10.11, 11.7-11.9).
//
// Depends only on the Storage interface and the Event_Log (both injected) and on the state machine
// table. Information barrier: Events are read only through the Event_Log's non-chaos view, and any
// `chaos.*` event is ignored defensively.

import { randomUUID } from 'node:crypto';
import { validate } from '../contracts/index.js';
import { checkTransition, isTerminal } from './state-machine.js';

export const INCIDENTS_COLLECTION = 'incidents';
export const VERIFICATIONS_COLLECTION = 'verifications';
export const MANAGER_COMPONENT = 'incident_manager';
export const RECOVERY_CONFIRMATION_CHECKS = 3;

const rejected = (reason) => ({ rejected: true, reason });
export const isRejected = (value) => value?.rejected === true;

export class IncidentManager {
  /**
   * @param {object} options
   * @param {object} options.storage   Storage interface (get/put/append/list)
   * @param {object} options.eventLog  Event_Log (append + nonChaosView)
   * @param {() => Date} [options.now]
   * @param {() => string} [options.idFactory]
   */
  constructor({ storage, eventLog, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (!storage || typeof storage.put !== 'function' || typeof storage.list !== 'function') {
      throw new TypeError('IncidentManager requires a Storage interface.');
    }
    if (!eventLog || typeof eventLog.append !== 'function' || typeof eventLog.nonChaosView !== 'function') {
      throw new TypeError('IncidentManager requires an Event_Log.');
    }
    this.storage = storage;
    this.eventLog = eventLog;
    this.events = eventLog.nonChaosView(); // information barrier: never chaos.*
    this.now = now;
    this.idFactory = idFactory;
    this._queue = Promise.resolve();
  }

  _serial(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _error(incidentId, message, details = {}) {
    await this.eventLog.append({
      type: 'error',
      component: MANAGER_COMPONENT,
      incidentId: incidentId ?? null,
      payload: { message, ...details },
    });
  }

  async _save(incident) {
    const checked = validate('Incident', incident);
    if (!checked.valid) {
      throw new Error(`Invalid incident: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    }
    await this.storage.put(INCIDENTS_COLLECTION, incident.incidentId, incident);
  }

  // ----- queries --------------------------------------------------------------------------

  async get(incidentId) {
    return this.storage.get(INCIDENTS_COLLECTION, incidentId);
  }

  async list() {
    return this.storage.list(INCIDENTS_COLLECTION);
  }

  async getActive() {
    const all = await this.list();
    return all.find((i) => !isTerminal(i.state)) ?? null;
  }

  /** True while injection must be refused: a non-terminal Incident or one needing rollback verification. */
  async injectionBlocked() {
    const all = await this.list();
    return all.some((i) => !isTerminal(i.state) || i.needsRollbackVerification === true);
  }

  // ----- create / attach ------------------------------------------------------------------

  /**
   * create(detection) -> Incident | Rejected. If a non-terminal Incident exists for the same
   * component the evidence is attached instead (no duplicate, Requirement 6.6); a non-terminal
   * Incident for another component rejects the request (Requirement 6.7).
   */
  create(detection) {
    return this._serial(async () => {
      const component = detection?.component;
      const evidenceRefs = detection?.evidenceRefs ?? [];
      if (typeof component !== 'string' || component === '' || !Array.isArray(evidenceRefs)) {
        await this._error(null, 'create rejected: detection needs a component and evidenceRefs');
        return rejected('invalid detection');
      }
      const active = await this.getActive();
      if (active) {
        if (active.component === component) return this._attach(active, evidenceRefs);
        const reason = `a non-terminal Incident (${active.incidentId}) already exists`;
        await this._error(null, `create rejected: ${reason}`, { component });
        return rejected(reason);
      }
      const ts = this.now().toISOString();
      const incident = {
        incidentId: this.idFactory(),
        state: 'detected',
        detectedAt: ts,
        component,
        evidenceRefs: [...evidenceRefs],
        plans: [],
        gateDecisions: [],
        attempts: [],
        attemptCount: 0,
        needsRollbackVerification: false,
        updatedAt: ts,
      };
      await this._save(incident);
      await this.eventLog.append({
        type: 'incident.state',
        component: MANAGER_COMPONENT,
        incidentId: incident.incidentId,
        payload: { from: null, to: 'detected', actor: 'monitor' },
      });
      return incident;
    });
  }

  attach(incidentId, evidence) {
    return this._serial(async () => {
      const incident = await this.get(incidentId);
      if (!incident) {
        await this._error(incidentId, 'attach rejected: unknown incident');
        return rejected('unknown incident');
      }
      if (isTerminal(incident.state)) {
        await this._error(incidentId, 'attach rejected: incident is terminal');
        return rejected('incident is terminal');
      }
      const refs = Array.isArray(evidence) ? evidence : evidence?.evidenceRefs ?? [];
      return this._attach(incident, refs);
    });
  }

  async _attach(incident, refs) {
    const merged = [...incident.evidenceRefs];
    for (const ref of refs) if (!merged.includes(ref)) merged.push(ref);
    const updated = { ...incident, evidenceRefs: merged, updatedAt: this.now().toISOString() };
    await this._save(updated);
    return updated;
  }

  // ----- transitions ----------------------------------------------------------------------

  /**
   * transition(id, to, actor, context) -> Incident | Rejected.
   * context: { rollbackVerified, executorCompleted, healthyChecks, terminalReason }
   */
  transition(incidentId, to, actor = 'orchestrator', context = {}) {
    return this._serial(async () => {
      const incident = await this.get(incidentId);
      if (!incident) {
        await this._error(incidentId, 'transition rejected: unknown incident');
        return rejected('unknown incident');
      }
      const from = incident.state;
      const reasonOut = async (reason) => {
        await this._error(incidentId, `transition rejected: ${reason}`, { from, to, actor });
        return rejected(reason);
      };

      // `verifying` needs a completed executor record found in the Event_Log (Requirement 10.11).
      let ctx = { ...context };
      if (to === 'verifying') {
        ctx = { ...ctx, executorCompleted: await this._hasExecutorRecord(incidentId) };
      }
      const check = checkTransition(from, to, ctx);
      if (!check.ok) return reasonOut(check.reason);

      if (incident.needsRollbackVerification && to === 'verifying') {
        return reasonOut('incident needs rollback verification before it can resume to verifying');
      }
      if (to === 'recovered') {
        const proof = await this._recoveryProof(incidentId, ctx);
        if (!proof.ok) return reasonOut(proof.reason);
      }

      const updated = { ...incident, state: to, updatedAt: this.now().toISOString() };
      if (to === 'rolled_back') updated.needsRollbackVerification = false;
      if (isTerminal(to) && typeof context.terminalReason === 'string' && context.terminalReason) {
        updated.terminalReason = context.terminalReason;
      }
      await this._save(updated);
      await this.eventLog.append({
        type: 'incident.state',
        component: MANAGER_COMPONENT,
        incidentId,
        payload: { from, to, actor },
      });
      return updated;
    });
  }

  async _readIncidentEvents(incidentId) {
    const events = await this.events.readAfter(0, { incidentId });
    return events.filter((e) => !e.type.startsWith('chaos.'));
  }

  async _hasExecutorRecord(incidentId) {
    const events = await this._readIncidentEvents(incidentId);
    return events.some((e) => e.type === 'repair' && e.payload?.status !== 'failed' && e.payload?.error === undefined);
  }

  async _recoveryProof(incidentId, ctx) {
    const all = await this.storage.list(VERIFICATIONS_COLLECTION);
    const passed = all.some((v) => v.incidentId === incidentId && v.overall === 'pass');
    if (!passed) return { ok: false, reason: 'recovered requires a stored Verification_Result with overall=pass' };
    if (!Number.isInteger(ctx.healthyChecks) || ctx.healthyChecks < RECOVERY_CONFIRMATION_CHECKS) {
      return { ok: false, reason: `recovered requires ${RECOVERY_CONFIRMATION_CHECKS} consecutive passing Health_Checks from the Monitor` };
    }
    return { ok: true };
  }

  // ----- restart --------------------------------------------------------------------------

  /** Startup: flag Incidents left in repairing or verifying as needing rollback verification. */
  reload() {
    return this._serial(async () => {
      const all = await this.list();
      const flagged = [];
      for (const incident of all) {
        if (['repairing', 'verifying'].includes(incident.state) && !incident.needsRollbackVerification) {
          const updated = { ...incident, needsRollbackVerification: true, updatedAt: this.now().toISOString() };
          await this._save(updated);
          await this.eventLog.append({
            type: 'error',
            component: MANAGER_COMPONENT,
            incidentId: incident.incidentId,
            payload: { message: 'restart with incident in progress: rollback verification required', state: incident.state },
          });
          flagged.push(updated);
        } else if (incident.needsRollbackVerification) {
          flagged.push(incident);
        }
      }
      return flagged;
    });
  }

  /** Clears the rollback-verification flag after a rollback check passed (checksums equal snapshot). */
  markRollbackVerified(incidentId) {
    return this._serial(async () => {
      const incident = await this.get(incidentId);
      if (!incident) return rejected('unknown incident');
      const updated = { ...incident, needsRollbackVerification: false, updatedAt: this.now().toISOString() };
      await this._save(updated);
      return updated;
    });
  }
}

export function createIncidentManager(options) {
  return new IncidentManager(options);
}
