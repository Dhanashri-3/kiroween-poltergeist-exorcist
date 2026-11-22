// Orchestrator cycle controller (Task 11.3).
// Requirements: 7.7, 8.4, 9.8, 10.6, 10.10, 11.7, 11.9, 12.2-12.10, 14.8, 16.1, 16.2, 16.4, 16.5, 16.7, 16.11, 17.8.
//
// createCycleController(deps) returns { runCycle, startChaosRun }.
//
//   runCycle(incidentId)   drives an Incident from `detected` (or `investigating`) to `recovered` or
//                          `escalated`. Every stage Event is recorded before the next stage begins.
//   startChaosRun(id?)     { runId, scenarioId } or { conflict: true, reason, incidentId }.
//
// The controller does no file I/O itself. Everything it touches arrives through these injected objects:
//
//   incidents       Incident_Manager: get, getActive, injectionBlocked, transition, recordProgress,
//                   listVerifications
//   eventLog        Event_Log: append
//   exorcist        { diagnose(input), plan(diagnosis, input) } (outcome 'ok' | 'no_source')
//   buildInput      (incident) => Exorcist input (evidence, sources, priorAttempts)
//   safetyGate      { evaluate(plan, config) }
//   gateConfig      object or () => object: { actionAllowlist, approvedFiles, resolveTarget? }
//   executor        Repair_Executor: { apply(plan, approval), restore(snapshotId) }
//   verification    Verification_Engine: { verify(incident, evidence) }
//   loadEvidence    (incident) => Evidence | Evidence[]  (original failing Evidence)
//   monitor         { confirmRecovery({ component, checks }) => { confirmed, healthyChecks } }
//                   The Monitor's confirmation of consecutive passing Health_Checks (Requirement 11.9).
//   poltergeist     { startRun({ scenarioId? }) => { runId, scenarioId } }
//
// Evidence and Snapshots are never deleted here: an escalated Incident keeps both until a manual reset.

import { decideAfterFailure, DECISIONS, RETRY_BUDGET } from './retry-policy.js';
import { recordGateDecision } from './gate-recorder.js';
import { validateDiagnosis, validateRepairPlan } from '../exorcist/validators.js';
import { hashPlan } from '../safety-gate/safety-gate.js';
import { isTerminal } from '../incident/state-machine.js';

export const ORCHESTRATOR_COMPONENT = 'orchestrator';
export const DIAGNOSIS_TIMEOUT_MS = 60_000;
export const RECOVERY_CONFIRMATION_CHECKS = 3;

export const ESCALATION_REASONS = Object.freeze({
  RETRY_BUDGET_EXHAUSTED: 'retry_budget_exhausted',
  INCONCLUSIVE_DIAGNOSIS: 'inconclusive_diagnosis',
  DIAGNOSIS_TIMEOUT: 'diagnosis_timeout',
  NO_REPAIR_SOURCE: 'no_repair_source',
  RULE_BASED_PLAN_REJECTED: 'rule_based_plan_rejected',
  ROLLBACK_CHECKSUM_MISMATCH: 'rollback_checksum_mismatch',
  EVENT_LOG_WRITE_FAILURE: 'event_log_write_failure',
  UNHANDLED_ERROR: 'unhandled_error',
  RESUMED_MID_CYCLE: 'resumed_mid_cycle',
});

const TIMED_OUT = Symbol('timed_out');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

class CycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CycleError';
    this.code = code;
  }
}

const isEventLogFailure = (e) => e?.code === 'storage_error' || e?.name === 'EventLogStorageError' || e?.code === 'event_failed';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  promise.catch(() => {}); // a late rejection after the timeout must not be unhandled
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True when both lists hold the same path -> checksum pairs. */
export function sameChecksums(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return false;
  const left = new Map(a.map((x) => [x?.path, x?.checksum]));
  if (left.size !== a.length) return false;
  return b.every((x) => typeof x?.checksum === 'string' && left.get(x?.path) === x.checksum);
}

export function isConflict(value) {
  return value?.conflict === true;
}

export function createCycleController(deps = {}) {
  const {
    incidents, eventLog, exorcist, buildInput, safetyGate, gateConfig, executor, verification, loadEvidence, monitor, poltergeist,
    diagnosisTimeoutMs = DIAGNOSIS_TIMEOUT_MS,
  } = deps;

  const need = (ok, name) => { if (!ok) throw new TypeError(`${name} is required`); };
  need(typeof incidents?.transition === 'function' && typeof incidents?.recordProgress === 'function', 'incidents (Incident_Manager)');
  need(typeof eventLog?.append === 'function', 'eventLog.append');
  need(typeof exorcist?.diagnose === 'function' && typeof exorcist?.plan === 'function', 'exorcist.diagnose/plan');
  need(typeof buildInput === 'function', 'buildInput');
  need(typeof safetyGate?.evaluate === 'function', 'safetyGate.evaluate');
  need(gateConfig !== undefined, 'gateConfig');
  need(typeof executor?.apply === 'function' && typeof executor?.restore === 'function', 'executor.apply/restore');
  need(typeof verification?.verify === 'function', 'verification.verify');
  need(typeof loadEvidence === 'function', 'loadEvidence');
  need(typeof monitor?.confirmRecovery === 'function', 'monitor.confirmRecovery');
  need(Number.isFinite(diagnosisTimeoutMs) && diagnosisTimeoutMs > 0, 'diagnosisTimeoutMs');

  const getGateConfig = () => (typeof gateConfig === 'function' ? gateConfig() : gateConfig);
  const inFlight = new Map();

  // ----- small helpers ---------------------------------------------------------------------

  const record = (type, incidentId, payload, component = ORCHESTRATOR_COMPONENT) =>
    eventLog.append({ type, component, incidentId, payload });

  async function recordQuietly(type, incidentId, payload) {
    try {
      await record(type, incidentId, payload);
      return true;
    } catch {
      return false;
    }
  }

  async function safeGet(id) {
    try {
      return await incidents.get(id);
    } catch {
      return null;
    }
  }

  /** Transition without throwing. ok:false carries the reason; `error` is set when an Event write failed. */
  async function tryMove(id, to, context = {}) {
    try {
      const result = await incidents.transition(id, to, ORCHESTRATOR_COMPONENT, context);
      if (result?.rejected === true) return { ok: false, reason: result.reason };
      return { ok: true, incident: result };
    } catch (error) {
      const current = await safeGet(id);
      if (current?.state === to) return { ok: true, incident: current, error };
      return { ok: false, reason: messageOf(error), error };
    }
  }

  /** Transition that must succeed; anything else stops the cycle through the unhandled-error path. */
  async function move(id, to, context = {}) {
    const result = await tryMove(id, to, context);
    if (result.error) throw result.error;
    if (!result.ok) throw new CycleError('transition_rejected', `Transition to ${to} was rejected: ${result.reason}`);
    return result.incident;
  }

  async function progress(id, patch) {
    const result = await incidents.recordProgress(id, patch);
    if (result?.rejected === true) throw new CycleError('progress_rejected', `Progress not recorded: ${result.reason}`);
    return result;
  }

  const planKey = (plan) => { try { return hashPlan(plan); } catch { return JSON.stringify(plan); } };

  function rememberPlan(ctx, plan, source, outcome) {
    if (!isObject(plan)) return;
    const key = planKey(plan);
    if (!ctx.plans.some((p) => p.key === key)) ctx.plans.push({ key, plan, source, outcome });
  }

  // ----- rollback --------------------------------------------------------------------------

  /**
   * Restore the Snapshot of the applied repair and check the restored checksums against the Snapshot
   * checksums (Requirements 12.3, 12.4). Records a rollback Event with the evidence.
   * @returns {Promise<{ok: boolean, evidenceRecorded: boolean}>}
   */
  async function rollback(ctx, reason, { bestEffort = false } = {}) {
    const dirty = ctx.dirty;
    let payload;
    let ok = false;
    try {
      const result = await executor.restore(dirty.snapshotId);
      const fromSnapshot = sameChecksums(result?.restored, result?.expected);
      const fromApply = dirty.snapshotChecksums ? sameChecksums(result?.restored, dirty.snapshotChecksums) : true;
      ok = result?.matches === true && fromSnapshot && fromApply;
      payload = {
        status: ok ? 'verified' : 'failed',
        reason,
        snapshotId: dirty.snapshotId,
        expected: result?.expected ?? null,
        restored: result?.restored ?? null,
        mismatches: result?.mismatches ?? [],
      };
    } catch (error) {
      payload = { status: 'failed', reason, snapshotId: dirty.snapshotId, error: messageOf(error), mismatches: [] };
    }
    let evidenceRecorded = true;
    if (bestEffort) {
      evidenceRecorded = await recordQuietly('rollback', ctx.incidentId, payload);
    } else {
      await record('rollback', ctx.incidentId, payload);
    }
    if (ok) ctx.dirty = null;
    return { ok, evidenceRecorded };
  }

  // ----- escalation ------------------------------------------------------------------------

  async function escalate(ctx, reason, extra = {}) {
    let finalReason = reason;
    const details = { ...extra };

    // Pass through rolled_back only when the restored checksums are verified (Requirement 12.9).
    if (ctx.dirty) {
      const rolled = await rollback(ctx, reason, { bestEffort: true });
      if (rolled.ok) {
        const moved = await tryMove(ctx.incidentId, 'rolled_back', { rollbackVerified: true });
        if (!moved.ok) details.rolledBackTransition = moved.reason;
      } else {
        finalReason = ESCALATION_REASONS.ROLLBACK_CHECKSUM_MISMATCH;
        details.originalReason = reason;
        details.rollbackFailed = true;
      }
    }

    const incident = await safeGet(ctx.incidentId);
    let verificationResults = ctx.verifications;
    try {
      verificationResults = await incidents.listVerifications?.(ctx.incidentId) ?? ctx.verifications;
    } catch { /* fall back to the results seen in this cycle */ }

    const plans = [];
    const seen = new Set();
    for (const plan of [...(incident?.plans ?? []), ...ctx.plans.map((p) => p.plan)]) {
      const key = planKey(plan);
      if (!seen.has(key)) { seen.add(key); plans.push(plan); }
    }

    const payload = {
      incidentId: ctx.incidentId,
      reason: finalReason,
      plans,
      verificationResults,
      attemptCount: incident?.attemptCount ?? ctx.attemptCount,
      ...details,
    };
    const recorded = await recordQuietly('escalation', ctx.incidentId, payload);
    const moved = await tryMove(ctx.incidentId, 'escalated', { terminalReason: finalReason });
    const state = (await safeGet(ctx.incidentId))?.state ?? (moved.ok ? 'escalated' : 'unknown');
    return { outcome: 'escalated', incidentId: ctx.incidentId, state, reason: finalReason, escalationRecorded: recorded, ...(moved.ok ? {} : { transitionError: moved.reason }) };
  }

  async function failUnhandled(ctx, error) {
    const eventLogFailure = isEventLogFailure(error);
    await recordQuietly('error', ctx.incidentId, { message: messageOf(error), stage: ctx.stage, code: error?.code ?? null });
    return escalate(ctx, eventLogFailure ? ESCALATION_REASONS.EVENT_LOG_WRITE_FAILURE : ESCALATION_REASONS.UNHANDLED_ERROR, { error: messageOf(error) });
  }

  // ----- failed attempt handling -----------------------------------------------------------

  /**
   * Count the failed attempt, roll back when a repair was applied, then retry or escalate.
   * @returns {Promise<{done: true, result: object} | {done: false}>}
   */
  async function failAttempt(ctx, cause, detail = {}) {
    ctx.attemptCount += 1;
    await progress(ctx.incidentId, { attemptCount: ctx.attemptCount });
    const decision = decideAfterFailure(ctx.attemptCount, cause);

    if (ctx.dirty) {
      const rolled = await rollback(ctx, cause);
      if (!rolled.ok) {
        return { done: true, result: await escalate({ ...ctx, dirty: null }, ESCALATION_REASONS.ROLLBACK_CHECKSUM_MISMATCH, { originalReason: cause, rollbackFailed: true, ...detail }) };
      }
      await move(ctx.incidentId, 'rolled_back', { rollbackVerified: true });
    }

    if (decision === DECISIONS.ROLLBACK_AND_ESCALATE) {
      return { done: true, result: await escalate(ctx, ESCALATION_REASONS.RETRY_BUDGET_EXHAUSTED, { lastCause: cause, ...detail }) };
    }
    const current = await incidents.get(ctx.incidentId);
    if (current.state !== 'investigating') await move(ctx.incidentId, 'investigating');
    return { done: false };
  }

  async function recordAttempt(ctx, incident, plan, snapshotId, outcome, verificationId) {
    const fresh = await incidents.get(incident.incidentId);
    const attempt = {
      attemptNo: fresh.attempts.length + 1,
      planHash: planKey(plan),
      snapshotId,
      outcome,
      ...(verificationId ? { verificationId } : {}),
    };
    await progress(incident.incidentId, { attempts: [...fresh.attempts, attempt], plans: [...fresh.plans, plan] });
    return attempt;
  }

  async function currentEvidence(incident) {
    const raw = await loadEvidence(incident);
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return { healthCheckResults: list.flatMap((e) => (Array.isArray(e?.healthCheckResults) ? e.healthCheckResults : [])) };
  }

  // ----- the cycle -------------------------------------------------------------------------

  async function cycle(ctx) {
    let incident = await incidents.get(ctx.incidentId);

    // Resume after a restart: a repair may be on disk. Roll it back and escalate (Requirement 10.11).
    if (['planned', 'repairing', 'verifying'].includes(incident.state)) {
      const repairs = await eventLog.readAfter?.(0, { incidentId: ctx.incidentId, types: ['repair'] });
      const last = Array.isArray(repairs) ? repairs[repairs.length - 1] : null;
      if (last?.payload?.snapshotId) {
        ctx.dirty = { snapshotId: last.payload.snapshotId, snapshotChecksums: last.payload.snapshotChecksums ?? null };
      }
      return escalate(ctx, ESCALATION_REASONS.RESUMED_MID_CYCLE, { resumedFrom: incident.state });
    }
    if (incident.state === 'rolled_back') await move(ctx.incidentId, 'investigating');
    if (incident.state === 'detected') await move(ctx.incidentId, 'investigating');
    ctx.attemptCount = incident.attemptCount;

    for (;;) {
      incident = await incidents.get(ctx.incidentId);

      // ---- diagnosis (7.x)
      ctx.stage = 'diagnosis';
      const input = await buildInput(incident);
      const diagnosed = await withTimeout(Promise.resolve().then(() => exorcist.diagnose(input)), diagnosisTimeoutMs);
      if (diagnosed === TIMED_OUT) {
        await record('timeout', ctx.incidentId, { stage: 'diagnosis', limitMs: diagnosisTimeoutMs });
        return escalate(ctx, ESCALATION_REASONS.DIAGNOSIS_TIMEOUT);
      }
      if (diagnosed?.outcome !== 'ok') {
        await record('error', ctx.incidentId, { message: 'No repair source for the diagnosis', stage: 'diagnosis', reason: diagnosed?.reason ?? 'no_source' });
        return escalate(ctx, ESCALATION_REASONS.NO_REPAIR_SOURCE, { sourceReason: diagnosed?.reason ?? 'no_source' });
      }
      ctx.source = diagnosed.source;
      const checked = validateDiagnosis(diagnosed.diagnosis);
      if (checked.outcome === 'inconclusive') {
        await record('diagnosis', ctx.incidentId, { status: 'inconclusive', source: ctx.source, diagnosis: checked.diagnosis });
        return escalate(ctx, ESCALATION_REASONS.INCONCLUSIVE_DIAGNOSIS);
      }
      if (checked.outcome === 'rejected') {
        await record('diagnosis', ctx.incidentId, { status: 'rejected', source: ctx.source, errors: checked.errors });
        const failed = await failAttempt(ctx, 'rejected_diagnosis', { errors: checked.errors });
        if (failed.done) return failed.result;
        continue;
      }
      const diagnosis = checked.diagnosis;
      await record('diagnosis', ctx.incidentId, { status: 'accepted', source: ctx.source, diagnosis });
      await progress(ctx.incidentId, { diagnosis });

      // ---- plan (8.x)
      ctx.stage = 'plan';
      const planned = await withTimeout(Promise.resolve().then(() => exorcist.plan(diagnosis, input)), diagnosisTimeoutMs);
      if (planned === TIMED_OUT) {
        await record('timeout', ctx.incidentId, { stage: 'plan', limitMs: diagnosisTimeoutMs });
        return escalate(ctx, ESCALATION_REASONS.DIAGNOSIS_TIMEOUT, { stage: 'plan' });
      }
      if (planned?.outcome !== 'ok') {
        await record('error', ctx.incidentId, { message: 'No repair source for the plan', stage: 'plan', reason: planned?.reason ?? 'no_source' });
        return escalate(ctx, ESCALATION_REASONS.NO_REPAIR_SOURCE, { sourceReason: planned?.reason ?? 'no_source' });
      }
      ctx.source = planned.source;
      const plan = planned.plan;
      const config = getGateConfig();
      const failedPlans = ctx.plans.map((p) => p.plan);
      const validated = validateRepairPlan(plan, { allowlist: config?.actionAllowlist ?? [], failedPlans });
      const identical = validated.identicalToFailed || planned.identicalToFailed === true;
      if (!validated.valid || identical) {
        rememberPlan(ctx, plan, ctx.source, 'rejected');
        await record('plan', ctx.incidentId, { plan: isObject(plan) ? plan : { value: String(plan) }, source: ctx.source, rejected: true, errors: validated.errors });
        if (ctx.source === 'rule_based') return escalate(ctx, ESCALATION_REASONS.RULE_BASED_PLAN_REJECTED, { errors: validated.errors });
        const failed = await failAttempt(ctx, 'rejected_plan', { errors: validated.errors });
        if (failed.done) return failed.result;
        continue;
      }
      rememberPlan(ctx, plan, ctx.source, 'planned');
      await record('plan', ctx.incidentId, { plan, source: ctx.source, rejected: false });
      await move(ctx.incidentId, 'planned');

      // ---- Safety_Gate before the executor (9.8)
      ctx.stage = 'gate';
      const decision = safetyGate.evaluate(plan, config);
      await recordGateDecision(eventLog, plan, decision);
      const { approval, ...publicDecision } = decision;
      const afterGate = await incidents.get(ctx.incidentId);
      await progress(ctx.incidentId, { gateDecisions: [...afterGate.gateDecisions, publicDecision] });
      if (!decision.approved || !approval) {
        if (ctx.source === 'rule_based') {
          // 16.11: no substitute plan.
          return escalate(ctx, ESCALATION_REASONS.RULE_BASED_PLAN_REJECTED, { gateReasons: decision.reasons });
        }
        const failed = await failAttempt(ctx, 'rejected_plan', { gateReasons: decision.reasons });
        if (failed.done) return failed.result;
        continue;
      }

      // ---- repair (10.6)
      ctx.stage = 'repair';
      await move(ctx.incidentId, 'repairing');
      let repair;
      try {
        repair = await executor.apply(plan, approval);
      } catch (error) {
        if (typeof error?.snapshotId === 'string' && error.snapshotId !== '') {
          ctx.dirty = { snapshotId: error.snapshotId, snapshotChecksums: null };
        }
        if (isEventLogFailure(error)) throw error;
        await recordQuietly('error', ctx.incidentId, { message: messageOf(error), stage: 'repair', code: error?.code ?? null });
        if (!ctx.dirty) return escalate(ctx, ESCALATION_REASONS.UNHANDLED_ERROR, { error: messageOf(error) });
        await recordAttempt(ctx, incident, plan, ctx.dirty.snapshotId, 'apply_error');
        const failed = await failAttempt(ctx, 'apply_error', { error: messageOf(error) });
        if (failed.done) return failed.result;
        continue;
      }
      ctx.dirty = { snapshotId: repair.snapshotId, snapshotChecksums: repair.snapshotChecksums ?? null };

      // ---- verification (10.10, 11.x)
      ctx.stage = 'verification';
      await move(ctx.incidentId, 'verifying');
      const evidence = await currentEvidence(incident);
      const latest = await incidents.get(ctx.incidentId);
      const result = await verification.verify(
        { incidentId: ctx.incidentId, component: latest.component, attemptNo: latest.attempts.length + 1 },
        evidence,
      );
      ctx.verifications.push(result);
      await record('verification', ctx.incidentId, result);
      await recordAttempt(ctx, latest, plan, repair.snapshotId, result.overall, result.verificationId);

      const cause = 'failed_verification';
      let detail = { verificationId: result.verificationId };
      if (result.overall === 'pass') {
        // 11.9: the Monitor must also confirm consecutive healthy checks.
        const confirmation = await monitor.confirmRecovery({ component: latest.component, checks: RECOVERY_CONFIRMATION_CHECKS });
        const healthyChecks = confirmation?.healthyChecks;
        if (confirmation?.confirmed === true && Number.isInteger(healthyChecks) && healthyChecks >= RECOVERY_CONFIRMATION_CHECKS) {
          const recovered = await tryMove(ctx.incidentId, 'recovered', { healthyChecks });
          if (recovered.error) throw recovered.error;
          if (recovered.ok) {
            await record('recovery', ctx.incidentId, { verificationId: result.verificationId, healthyChecks, snapshotId: repair.snapshotId });
            return { outcome: 'recovered', incidentId: ctx.incidentId, state: 'recovered', verificationId: result.verificationId };
          }
          detail = { ...detail, recoveryRejected: recovered.reason };
        } else {
          detail = { ...detail, monitorConfirmation: 'not_confirmed', healthyChecks: healthyChecks ?? 0 };
        }
      }
      const failed = await failAttempt(ctx, cause, detail);
      if (failed.done) return failed.result;
    }
  }

  async function run(incidentId) {
    const incident = await incidents.get(incidentId);
    if (!incident) return { outcome: 'unknown_incident', incidentId };
    if (isTerminal(incident.state)) return { outcome: 'already_terminal', incidentId, state: incident.state }; // 12.7
    const ctx = { incidentId, stage: 'start', dirty: null, plans: [], verifications: [], attemptCount: incident.attemptCount ?? 0, source: null };
    try {
      return await cycle(ctx);
    } catch (error) {
      return await failUnhandled(ctx, error);
    }
  }

  function runCycle(incidentId) {
    if (inFlight.has(incidentId)) return inFlight.get(incidentId);
    const promise = run(incidentId).finally(() => inFlight.delete(incidentId));
    inFlight.set(incidentId, promise);
    return promise;
  }

  async function startChaosRun(scenarioId) {
    need(typeof poltergeist?.startRun === 'function', 'poltergeist.startRun');
    if (await incidents.injectionBlocked()) {
      const active = await incidents.getActive();
      return {
        conflict: true,
        reason: 'A non-terminal Incident exists or needs rollback verification.',
        incidentId: active?.incidentId ?? null,
      };
    }
    const selection = await poltergeist.startRun(scenarioId === undefined || scenarioId === null ? {} : { scenarioId });
    return { runId: selection.runId, scenarioId: selection.scenarioId };
  }

  return Object.freeze({ runCycle, startChaosRun, retryBudget: RETRY_BUDGET });
}
