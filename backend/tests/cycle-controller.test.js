// Task 11.3: cycle controller unit tests. Real Event_Log, Incident_Manager and Safety_Gate; the
// Exorcist, Repair_Executor file system, Verification_Engine and Monitor are in-memory test doubles
// that behave like the real ones (snapshot/restore on a file map, pass only if the file is fixed).
import { describe, it, expect } from 'vitest';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager } from '../src/incident/incident-manager.js';
import { evaluate, verifyApproval } from '../src/safety-gate/safety-gate.js';
import { createCycleController, isConflict, sameChecksums } from '../src/orchestrator/cycle-controller.js';

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: new Map() };
  const state = { failAppend: false };
  return {
    state,
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) {
      if (state.failAppend) throw new Error('disk full');
      data[c].push(structuredClone(rec));
      return rec;
    },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

const sum = (text) => `sum:${text}`;
const GATE_CONFIG = {
  actionAllowlist: [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }],
  approvedFiles: ['public/button.js'],
};
const goodPlan = (incidentId, replace = 'FIXED') => ({
  incidentId, actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'BROKEN', replace }, rationale: 'repair the button',
});
const diagnosis = (incidentId, status = 'ok', confidence = 0.9) => ({
  incidentId, component: 'button', suspectedFile: 'public/button.js', location: 'line 1', rootCause: 'broken handler',
  confidence, evidenceUsed: ['health:button'], status,
});

function world({ plans, diag, source = 'ai', diagnoseImpl, monitorConfirms = true, restoreCorrupts = false } = {}) {
  const storage = memoryStorage();
  const eventLog = createEventLog({ storage });
  const incidents = createIncidentManager({ storage, eventLog });
  const files = { 'public/button.js': 'BROKEN' };
  const snapshots = new Map();
  const calls = { apply: 0, restore: 0, verify: 0, gate: 0 };
  const queue = [...(plans ?? [])];

  const checksums = () => Object.entries(files).map(([path, text]) => ({ path, checksum: sum(text) }));
  const executor = {
    async apply(plan, approval) {
      calls.apply += 1;
      if (!verifyApproval(plan, approval)) throw Object.assign(new Error('approval invalid'), { code: 'approval_invalid' });
      const snapshotId = `snap-${calls.apply}`;
      snapshots.set(snapshotId, { ...files });
      const snapshotChecksums = checksums();
      files[plan.targetFile] = files[plan.targetFile].replace(plan.change.find, plan.change.replace);
      await eventLog.append({
        type: 'repair', component: 'repair-executor', incidentId: plan.incidentId,
        payload: { incidentId: plan.incidentId, target: plan.targetFile, snapshotId, snapshotChecksums },
      });
      return { incidentId: plan.incidentId, snapshotId, snapshotChecksums };
    },
    async restore(snapshotId) {
      calls.restore += 1;
      const saved = snapshots.get(snapshotId);
      for (const k of Object.keys(files)) delete files[k];
      Object.assign(files, saved);
      if (restoreCorrupts) files['public/button.js'] = 'CORRUPT';
      const expected = Object.entries(saved).map(([path, text]) => ({ path, checksum: sum(text) }));
      const restored = checksums();
      const mismatches = restored.filter((r, i) => r.checksum !== expected[i].checksum).map((r) => r.path);
      return { snapshotId, restored, expected, matches: mismatches.length === 0, mismatches };
    },
  };
  const verification = {
    async verify(incident) {
      calls.verify += 1;
      const pass = files['public/button.js'].includes('FIXED');
      const result = {
        verificationId: `ver-${calls.verify}`, incidentId: incident.incidentId, attemptNo: incident.attemptNo,
        checks: [{ checkId: 'health:button', kind: 'health', coversComponent: 'button', outcome: pass ? 'pass' : 'fail', rawOutputRef: 'ref' }],
        originalFailingCheckRan: true, overall: pass ? 'pass' : 'fail', startedAt: new Date().toISOString(), durationMs: 1,
      };
      await storage.put('verifications', result.verificationId, result);
      return result;
    },
  };
  const exorcist = {
    async diagnose(input) {
      if (diagnoseImpl) return diagnoseImpl(input);
      return { outcome: 'ok', source, diagnosis: diag ? diag(input.incidentId) : diagnosis(input.incidentId, source === 'rule_based' ? 'rule_based' : 'ok') };
    },
    async plan(d, input) {
      const next = queue.shift();
      if (!next) return { outcome: 'no_source', reason: 'no_different_plan' };
      return { outcome: 'ok', source, plan: typeof next === 'function' ? next(input.incidentId) : next };
    },
  };
  const safetyGate = { evaluate(plan, config) { calls.gate += 1; return evaluate(plan, config); } };
  const monitor = { async confirmRecovery() { return monitorConfirms ? { confirmed: true, healthyChecks: 3 } : { confirmed: false, healthyChecks: 1 }; } };
  const started = [];
  const poltergeist = { async startRun(req) { started.push(req); return { runId: 'run-1', scenarioId: req.scenarioId ?? 'button-break' }; } };

  const controller = createCycleController({
    incidents, eventLog, exorcist, safetyGate, executor, verification, monitor, poltergeist,
    gateConfig: GATE_CONFIG,
    buildInput: async (incident) => ({ incidentId: incident.incidentId, component: incident.component, evidence: [], sources: [], priorAttempts: [] }),
    loadEvidence: async () => ({ healthCheckResults: [{ healthCheckId: 'button', status: 'fail' }] }),
    diagnosisTimeoutMs: 50,
  });

  const events = async () => storage.list('events');
  const create = async () => incidents.create({ component: 'button', evidenceRefs: ['ev-1'] });
  return { storage, eventLog, incidents, files, snapshots, calls, controller, events, create, started };
}

const states = (events, id) => events.filter((e) => e.type === 'incident.state' && e.incidentId === id).map((e) => e.payload.to);
const typesOf = (events, id) => events.filter((e) => e.incidentId === id).map((e) => e.type);

describe('cycle controller', () => {
  it('drives detected -> recovered with each stage Event recorded in order', async () => {
    const w = world({ plans: [(id) => goodPlan(id)] });
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result.outcome).toBe('recovered');
    const evs = await w.events();
    expect(states(evs, inc.incidentId)).toEqual(['detected', 'investigating', 'planned', 'repairing', 'verifying', 'recovered']);
    const order = typesOf(evs, inc.incidentId);
    const pos = (t, from = 0) => order.indexOf(t, from);
    expect(pos('diagnosis')).toBeGreaterThan(-1);
    expect(pos('plan')).toBeGreaterThan(pos('diagnosis'));
    expect(pos('gate')).toBeGreaterThan(pos('plan'));
    expect(pos('repair')).toBeGreaterThan(pos('gate'));
    expect(pos('verification')).toBeGreaterThan(pos('repair'));
    expect(pos('recovery')).toBeGreaterThan(pos('verification'));
    // repairing is entered before the executor wrote the repair Event
    const seq = (pred) => evs.find(pred).seq;
    expect(seq((e) => e.type === 'incident.state' && e.payload.to === 'repairing')).toBeLessThan(seq((e) => e.type === 'repair'));
    expect(seq((e) => e.type === 'incident.state' && e.payload.to === 'verifying')).toBeGreaterThan(seq((e) => e.type === 'repair'));
    expect(w.files['public/button.js']).toBe('FIXED');
    const stored = await w.incidents.get(inc.incidentId);
    expect(stored.attempts).toHaveLength(1);
    expect(stored.gateDecisions[0]).not.toHaveProperty('approval');
  });

  it('rolls back wrong repairs, tries at most three times, then escalates with full evidence', async () => {
    const w = world({ plans: [(id) => goodPlan(id, 'WRONG1'), (id) => goodPlan(id, 'WRONG2'), (id) => goodPlan(id, 'WRONG3'), (id) => goodPlan(id, 'WRONG4')] });
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result).toMatchObject({ outcome: 'escalated', reason: 'retry_budget_exhausted' });
    expect(w.calls.apply).toBe(3);
    expect(w.calls.restore).toBe(3);
    expect(w.files['public/button.js']).toBe('BROKEN');
    const evs = await w.events();
    expect(states(evs, inc.incidentId)).toEqual([
      'detected', 'investigating', 'planned', 'repairing', 'verifying', 'rolled_back',
      'investigating', 'planned', 'repairing', 'verifying', 'rolled_back',
      'investigating', 'planned', 'repairing', 'verifying', 'rolled_back', 'escalated',
    ]);
    const rollbacks = evs.filter((e) => e.type === 'rollback');
    expect(rollbacks).toHaveLength(3);
    expect(rollbacks.every((e) => e.payload.status === 'verified')).toBe(true);
    const esc = evs.find((e) => e.type === 'escalation');
    expect(esc.payload.incidentId).toBe(inc.incidentId);
    expect(esc.payload.plans).toHaveLength(3);
    expect(esc.payload.verificationResults).toHaveLength(3);
    expect(esc.payload.reason).toBe('retry_budget_exhausted');
    expect(w.snapshots.size).toBe(3); // snapshots preserved
    expect((await w.controller.runCycle(inc.incidentId)).outcome).toBe('already_terminal');
    expect(w.calls.apply).toBe(3);
  });

  it('never reaches recovered for a plan whose verification fails (cosmetic plan)', async () => {
    const w = world({ plans: [(id) => goodPlan(id, 'HIDDEN'), (id) => goodPlan(id, 'HIDDEN2'), (id) => goodPlan(id, 'HIDDEN3')] });
    const inc = await w.create();
    await w.controller.runCycle(inc.incidentId);
    expect((await w.incidents.get(inc.incidentId)).state).toBe('escalated');
    expect(states(await w.events(), inc.incidentId)).not.toContain('recovered');
  });

  it('retries with a different plan after a failed verification and recovers', async () => {
    const w = world({ plans: [(id) => goodPlan(id, 'WRONG'), (id) => goodPlan(id)] });
    const inc = await w.create();
    expect((await w.controller.runCycle(inc.incidentId)).outcome).toBe('recovered');
    expect(w.calls.apply).toBe(2);
    expect((await w.incidents.get(inc.incidentId)).attemptCount).toBe(1);
  });

  it('counts an identical repeated plan as a rejected attempt', async () => {
    const w = world({ plans: [(id) => goodPlan(id, 'WRONG'), (id) => goodPlan(id, 'WRONG'), (id) => goodPlan(id)] });
    const inc = await w.create();
    expect((await w.controller.runCycle(inc.incidentId)).outcome).toBe('recovered');
    expect(w.calls.apply).toBe(2);
    expect((await w.incidents.get(inc.incidentId)).attemptCount).toBe(2);
  });

  it('does not call the executor when the Safety_Gate rejects an AI plan, and counts the attempt', async () => {
    const bad = (id) => ({ ...goodPlan(id), targetFile: 'public/card.js' });
    const w = world({ plans: [bad, bad2(), bad3()] });
    function bad2() { return (id) => ({ ...goodPlan(id, 'x'), targetFile: 'public/card.js' }); }
    function bad3() { return (id) => ({ ...goodPlan(id, 'y'), targetFile: 'public/card.js' }); }
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result).toMatchObject({ outcome: 'escalated', reason: 'retry_budget_exhausted' });
    expect(w.calls.apply).toBe(0);
    expect(w.calls.gate).toBe(3);
    const gates = (await w.events()).filter((e) => e.type === 'gate');
    expect(gates.every((e) => e.payload.decision === 'rejected')).toBe(true);
  });

  it('escalates without a substitute plan when the Safety_Gate rejects a Fallback_Mapping plan', async () => {
    const bad = (id) => ({ ...goodPlan(id), targetFile: 'public/card.js' });
    const w = world({ source: 'rule_based', plans: [bad, (id) => goodPlan(id)] });
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result).toMatchObject({ outcome: 'escalated', reason: 'rule_based_plan_rejected' });
    expect(w.calls.apply).toBe(0);
    expect((await w.events()).filter((e) => e.type === 'plan')).toHaveLength(1);
  });

  it('escalates on an inconclusive diagnosis without an attempt being applied', async () => {
    const w = world({ diag: (id) => diagnosis(id, 'inconclusive', 0.2), plans: [(id) => goodPlan(id)] });
    const inc = await w.create();
    expect(await w.controller.runCycle(inc.incidentId)).toMatchObject({ outcome: 'escalated', reason: 'inconclusive_diagnosis' });
    expect(w.calls.apply).toBe(0);
  });

  it('records a timeout Event and escalates when the Diagnosis exceeds the limit', async () => {
    const w = world({ diagnoseImpl: () => new Promise(() => {}) });
    const inc = await w.create();
    expect(await w.controller.runCycle(inc.incidentId)).toMatchObject({ outcome: 'escalated', reason: 'diagnosis_timeout' });
    expect((await w.events()).some((e) => e.type === 'timeout' && e.payload.stage === 'diagnosis')).toBe(true);
  });

  it('records an error Event and escalates when there is no repair source', async () => {
    const w = world({ diagnoseImpl: async () => ({ outcome: 'no_source', reason: 'ai_unavailable_no_mapping_match' }) });
    const inc = await w.create();
    expect(await w.controller.runCycle(inc.incidentId)).toMatchObject({ outcome: 'escalated', reason: 'no_repair_source' });
    expect((await w.events()).some((e) => e.type === 'error' && e.incidentId === inc.incidentId && e.component === 'orchestrator')).toBe(true);
  });

  it('does not report recovery when the Monitor does not confirm healthy checks', async () => {
    const w = world({ plans: [(id) => goodPlan(id)], monitorConfirms: false });
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result.outcome).toBe('escalated');
    expect(states(await w.events(), inc.incidentId)).not.toContain('recovered');
  });

  it('escalates with a rollback-failure Event when restored checksums differ, skipping rolled_back', async () => {
    const w = world({ plans: [(id) => goodPlan(id, 'WRONG')], restoreCorrupts: true });
    const inc = await w.create();
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result).toMatchObject({ outcome: 'escalated', reason: 'rollback_checksum_mismatch' });
    const evs = await w.events();
    expect(states(evs, inc.incidentId)).not.toContain('rolled_back');
    expect(evs.some((e) => e.type === 'rollback' && e.payload.status === 'failed')).toBe(true);
    expect(evs.find((e) => e.type === 'escalation').payload.reason).toBe('rollback_checksum_mismatch');
  });

  it('stops, rolls back and escalates when the Event_Log becomes unwritable mid-cycle', async () => {
    const w = world({ plans: [(id) => goodPlan(id)] });
    const inc = await w.create();
    const original = w.eventLog.append.bind(w.eventLog);
    w.eventLog.append = async (e) => {
      if (e.type === 'verification') w.storage.state.failAppend = true;
      return original(e);
    };
    const result = await w.controller.runCycle(inc.incidentId);
    expect(result.outcome).toBe('escalated');
    expect(result.reason).toBe('event_log_write_failure');
    expect(result.escalationRecorded).toBe(false);
    expect(w.files['public/button.js']).toBe('BROKEN'); // rolled back
    expect((await w.incidents.get(inc.incidentId)).state).toBe('escalated');
  });

  it('startChaosRun returns a conflict while an Incident is non-terminal and starts a run otherwise', async () => {
    const w = world({ plans: [(id) => goodPlan(id)] });
    expect(await w.controller.startChaosRun('button-break')).toEqual({ runId: 'run-1', scenarioId: 'button-break' });
    const inc = await w.create();
    const conflict = await w.controller.startChaosRun();
    expect(isConflict(conflict)).toBe(true);
    expect(conflict.incidentId).toBe(inc.incidentId);
    expect(w.started).toHaveLength(1);
    await w.controller.runCycle(inc.incidentId);
    expect(isConflict(await w.controller.startChaosRun())).toBe(false);
  });
});

describe('sameChecksums', () => {
  it('requires identical non-empty path/checksum sets', () => {
    expect(sameChecksums([{ path: 'a', checksum: '1' }], [{ path: 'a', checksum: '1' }])).toBe(true);
    expect(sameChecksums([{ path: 'a', checksum: '1' }], [{ path: 'a', checksum: '2' }])).toBe(false);
    expect(sameChecksums([], [])).toBe(false);
    expect(sameChecksums(null, [])).toBe(false);
  });
});
