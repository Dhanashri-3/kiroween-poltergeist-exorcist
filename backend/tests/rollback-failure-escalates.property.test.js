import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager } from '../src/incident/incident-manager.js';
import { evaluate } from '../src/safety-gate/safety-gate.js';
import { createCycleController, ESCALATION_REASONS } from '../src/orchestrator/cycle-controller.js';
import { RETRY_BUDGET } from '../src/orchestrator/retry-policy.js';

// Feature: poltergeist-exorcist-healing-system, Property 21: Rollback failure escalates
// **Validates: Requirements 12.4, 12.6**
//
// Real Event_Log, Incident_Manager, Safety_Gate and cycle controller. The Repair_Executor and Verification_Engine
// are scripted: every attempt applies a distinct, gate-approved plan and fails verification. The rollback after
// attempt `failAt` restores checksums that differ from the Snapshot checksums (or `failAt` is null: every
// rollback is verified and the Retry_Budget is exhausted, which exercises the escalation payload alone).

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: new Map() };
  return {
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { data[c].push(structuredClone(rec)); return rec; },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

const GATE_CONFIG = {
  actionAllowlist: [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }],
  approvedFiles: ['public/button.js'],
};

const plan = (incidentId, n) => ({
  incidentId, actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'BROKEN', replace: `FIXED_${n}` }, rationale: `repair attempt ${n}`,
});

const checksum = (n) => `${String(n).padStart(2, '0')}`.repeat(32); // 64 hex characters

// Ways the restored state can differ from the Snapshot checksums.
const MISMATCHES = ['flag_false', 'different_checksum', 'file_missing', 'restore_throws'];

async function runScenario({ failAt, mismatch }) {
  const storage = memoryStorage();
  const eventLog = createEventLog({ storage });
  const incidents = createIncidentManager({ storage, eventLog });
  const calls = { apply: 0, restore: 0 };
  const appliedPlans = [];
  const results = [];

  const executor = {
    async apply(p) {
      calls.apply += 1;
      appliedPlans.push(p);
      // the real Repair_Executor records a `repair` Event; the Incident_Manager requires it before `verifying`
      await eventLog.append({
        type: 'repair', component: 'repair_executor', incidentId: p.incidentId,
        payload: { status: 'completed', snapshotId: `snap-${calls.apply}`, targetFile: p.targetFile },
      });
      return { snapshotId: `snap-${calls.apply}`, snapshotChecksums: [{ path: 'public/button.js', checksum: checksum(calls.apply) }] };
    },
    async restore() {
      calls.restore += 1;
      const n = calls.restore;
      const expected = [{ path: 'public/button.js', checksum: checksum(n) }];
      if (n !== failAt) return { matches: true, expected, restored: structuredClone(expected), mismatches: [] };
      if (mismatch === 'restore_throws') throw new Error('restore I/O failure');
      if (mismatch === 'flag_false') return { matches: false, expected, restored: [{ path: 'public/button.js', checksum: checksum(n + 50) }], mismatches: ['public/button.js'] };
      if (mismatch === 'file_missing') return { matches: false, expected, restored: [], mismatches: ['public/button.js'] };
      // matches claims true but the checksums themselves differ
      return { matches: true, expected, restored: [{ path: 'public/button.js', checksum: checksum(n + 50) }], mismatches: [] };
    },
  };

  const verification = {
    async verify(ref) {
      const result = {
        verificationId: `ver-${results.length + 1}`,
        incidentId: ref.incidentId,
        attemptNo: ref.attemptNo,
        overall: 'fail',
        checks: [],
      };
      results.push(result);
      await storage.put('verifications', result.verificationId, result); // the real engine persists its results
      return result;
    },
  };

  let planNo = 0;
  const exorcist = {
    async diagnose(input) {
      return { outcome: 'ok', source: 'ai', diagnosis: {
        incidentId: input.incidentId, component: 'button', suspectedFile: 'public/button.js', location: 'line 1', rootCause: 'broken handler',
        confidence: 0.9, evidenceUsed: ['health:button'], status: 'ok',
      } };
    },
    async plan(d, input) {
      planNo += 1;
      return { outcome: 'ok', source: 'ai', plan: plan(input.incidentId, planNo) };
    },
  };

  const controller = createCycleController({
    incidents, eventLog, exorcist, executor, verification, gateConfig: GATE_CONFIG,
    safetyGate: { evaluate },
    monitor: { async confirmRecovery() { return { confirmed: false, healthyChecks: 0 }; } },
    poltergeist: { async startRun() { return { runId: 'r', scenarioId: 's' }; } },
    buildInput: async (i) => ({ incidentId: i.incidentId, component: i.component, evidence: [], sources: [], priorAttempts: [] }),
    loadEvidence: async () => ({ healthCheckResults: [] }),
    diagnosisTimeoutMs: 1000,
  });

  const inc = await incidents.create({ component: 'button', evidenceRefs: ['ev-1'] });
  const result = await controller.runCycle(inc.incidentId);
  const stored = await incidents.get(inc.incidentId);
  const events = (await storage.list('events')).filter((e) => e.incidentId === inc.incidentId);
  return { inc, result, stored, events, calls, appliedPlans, results };
}

describe('Property 21: Rollback failure escalates', () => {
  it('a rollback whose restored checksums differ from the Snapshot escalates with a rollback-failure Event and a complete escalation Event', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: RETRY_BUDGET }),
        fc.constantFrom(...MISMATCHES),
        async (failAt, mismatch) => {
          const { inc, result, stored, events, calls, appliedPlans, results } = await runScenario({ failAt, mismatch });

          // 12.4: the Incident is escalated, never rolled_back after the failed rollback
          expect(result.outcome).toBe('escalated');
          expect(stored.state).toBe('escalated');
          const states = events.filter((e) => e.type === 'incident.state').map((e) => e.payload.to);
          expect(states.at(-1)).toBe('escalated');
          expect(states.filter((s) => s === 'rolled_back').length).toBe(failAt - 1);

          // 12.4: a rollback-failure Event is recorded, and precedes the escalation
          const failures = events.filter((e) => e.type === 'rollback' && e.payload.status === 'failed');
          expect(failures.length).toBe(1);
          expect(failures[0].payload.snapshotId).toBe(`snap-${failAt}`);
          const escalations = events.filter((e) => e.type === 'escalation');
          expect(escalations.length).toBe(1);
          expect(failures[0].seq).toBeLessThan(escalations[0].seq);

          // no automated repair after the failed rollback
          expect(calls.apply).toBe(failAt);
          expect(calls.restore).toBe(failAt);

          // 12.6: the escalation Event carries Incident_ID, every attempt's Repair_Plan, every Verification_Result, the reason
          const p = escalations[0].payload;
          expect(p.incidentId).toBe(inc.incidentId);
          expect(p.reason).toBe(ESCALATION_REASONS.ROLLBACK_CHECKSUM_MISMATCH);
          expect(p.plans).toEqual(appliedPlans);
          expect(p.plans.length).toBe(failAt);
          expect(p.verificationResults).toEqual(results);
          expect(p.verificationResults.length).toBe(failAt);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('an escalation after budget exhaustion also carries Incident_ID, every Repair_Plan, every Verification_Result and the reason', async () => {
    const { inc, result, events, appliedPlans, results } = await runScenario({ failAt: null, mismatch: 'flag_false' });
    expect(result.outcome).toBe('escalated');
    const escalations = events.filter((e) => e.type === 'escalation');
    expect(escalations.length).toBe(1);
    const p = escalations[0].payload;
    expect(p.incidentId).toBe(inc.incidentId);
    expect(typeof p.reason).toBe('string');
    expect(p.reason).not.toBe('');
    expect(p.plans).toEqual(appliedPlans);
    expect(p.plans.length).toBe(RETRY_BUDGET);
    expect(p.verificationResults).toEqual(results);
    expect(events.some((e) => e.type === 'rollback' && e.payload.status === 'failed')).toBe(false);
  });
});
