import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager } from '../src/incident/incident-manager.js';
import { evaluate } from '../src/safety-gate/safety-gate.js';
import { createCycleController } from '../src/orchestrator/cycle-controller.js';
import { RETRY_BUDGET } from '../src/orchestrator/retry-policy.js';

// Feature: poltergeist-exorcist-healing-system, Property 15: Rejection does not execute
// **Validates: Requirements 9.8**
//
// Real Event_Log, Incident_Manager, Safety_Gate and cycle controller. The Repair_Executor is a spy.
// The Exorcist offers exactly one AI plan that the real Safety_Gate rejects, then has no further plan,
// so the cycle ends after the first rejection and the attempt count can be read from the Incident.

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

const basePlan = (incidentId) => ({
  incidentId, actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'BROKEN', replace: 'FIXED' }, rationale: 'repair the button',
});

// Each mutation yields a plan the real Safety_Gate must reject.
const arbRejected = fc.oneof(
  fc.constantFrom('public/card.js', 'public/other.js', 'mock-api.js', '.env', 'package.json').map((f) => (p) => ({ ...p, targetFile: f })),
  fc.constantFrom("const k = 'sk-abcdefghijklmnopqrstuvwx';", "require('child_process').exec('ls')", "fetch('https://evil.example.com/x')")
    .map((x) => (p) => ({ ...p, change: { ...p.change, replace: `FIXED\n${x}` } })),
  fc.integer({ min: 21, max: 40 }).map((n) => (p) => ({ ...p, change: { ...p.change, replace: Array.from({ length: n }, (_, i) => `line${i}`).join('\n') } })),
);

async function runRejected(mutate, priorAttempts) {
  const storage = memoryStorage();
  const eventLog = createEventLog({ storage });
  const incidents = createIncidentManager({ storage, eventLog });
  const calls = { apply: 0, restore: 0, gate: 0 };
  const executor = {
    async apply() { calls.apply += 1; throw new Error('executor must not be called'); },
    async restore() { calls.restore += 1; throw new Error('restore must not be called'); },
  };
  let offered = false;
  const exorcist = {
    async diagnose(input) {
      return { outcome: 'ok', source: 'ai', diagnosis: {
        incidentId: input.incidentId, component: 'button', suspectedFile: 'public/button.js', location: 'line 1', rootCause: 'broken handler',
        confidence: 0.9, evidenceUsed: ['health:button'], status: 'ok',
      } };
    },
    async plan(d, input) {
      if (offered) return { outcome: 'no_source', reason: 'no_different_plan' };
      offered = true;
      return { outcome: 'ok', source: 'ai', plan: mutate(basePlan(input.incidentId)) };
    },
  };
  const decisions = [];
  const safetyGate = { evaluate(plan, config) { calls.gate += 1; const d = evaluate(plan, config); decisions.push(d); return d; } };
  const controller = createCycleController({
    incidents, eventLog, exorcist, safetyGate, executor, gateConfig: GATE_CONFIG,
    verification: { async verify() { throw new Error('verify must not be called'); } },
    monitor: { async confirmRecovery() { return { confirmed: false, healthyChecks: 0 }; } },
    poltergeist: { async startRun() { return { runId: 'r', scenarioId: 's' }; } },
    buildInput: async (i) => ({ incidentId: i.incidentId, component: i.component, evidence: [], sources: [], priorAttempts: [] }),
    loadEvidence: async () => ({ healthCheckResults: [] }),
    diagnosisTimeoutMs: 1000,
  });
  const inc = await incidents.create({ component: 'button', evidenceRefs: ['ev-1'] });
  if (priorAttempts > 0) await incidents.recordProgress(inc.incidentId, { attemptCount: priorAttempts });
  const result = await controller.runCycle(inc.incidentId);
  const stored = await incidents.get(inc.incidentId);
  const events = (await storage.list('events')).filter((e) => e.incidentId === inc.incidentId);
  return { calls, decisions, result, stored, events };
}

describe('Property 15: Rejection does not execute', () => {
  it('a Safety_Gate rejection never invokes the Repair_Executor, never enters repairing, and counts exactly one attempt', async () => {
    await fc.assert(
      fc.asyncProperty(arbRejected, fc.integer({ min: 0, max: RETRY_BUDGET - 1 }), async (mutate, prior) => {
        const { calls, decisions, stored, events, result } = await runRejected(mutate, prior);
        // the real gate evaluated the plan once and rejected it
        expect(calls.gate).toBe(1);
        expect(decisions[0].approved).toBe(false);
        expect(decisions[0].approval ?? null).toBeNull();
        expect(events.filter((e) => e.type === 'gate').every((e) => e.payload.decision === 'rejected')).toBe(true);
        // the executor was never invoked
        expect(calls.apply).toBe(0);
        expect(calls.restore).toBe(0);
        // attempt count rose by exactly one
        expect(stored.attemptCount).toBe(prior + 1);
        // no repairing / verifying transition, no repair Event
        const to = events.filter((e) => e.type === 'incident.state').map((e) => e.payload.to);
        expect(to).not.toContain('repairing');
        expect(to).not.toContain('verifying');
        expect(events.some((e) => e.type === 'repair')).toBe(false);
        expect(result.outcome).toBe('escalated');
      }),
      { numRuns: 30 },
    );
  });
});
