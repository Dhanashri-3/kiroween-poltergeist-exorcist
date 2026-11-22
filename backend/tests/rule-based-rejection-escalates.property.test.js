import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager } from '../src/incident/incident-manager.js';
import { evaluate } from '../src/safety-gate/safety-gate.js';
import { createCycleController, ESCALATION_REASONS } from '../src/orchestrator/cycle-controller.js';
import { RETRY_BUDGET } from '../src/orchestrator/retry-policy.js';

// Feature: poltergeist-exorcist-healing-system, Property 32: Rule-based plan rejection escalates
// **Validates: Requirements 16.11**
//
// Real Event_Log, Incident_Manager, Safety_Gate and cycle controller. The Repair_Executor is a spy.
// The Exorcist would happily offer more plans if asked, so a substitute plan is detectable by counting plan() calls.

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

const basePlan = (incidentId, n) => ({
  incidentId, actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'BROKEN', replace: `FIXED${n}` }, rationale: 'repair the button',
});

// Each mutation yields a plan the real Safety_Gate must reject.
const arbRejected = fc.oneof(
  fc.constantFrom('public/card.js', 'public/other.js', 'mock-api.js', '.env', 'package.json').map((f) => (p) => ({ ...p, targetFile: f })),
  fc.constantFrom("const k = 'sk-abcdefghijklmnopqrstuvwx';", "require('child_process').exec('ls')", "fetch('https://evil.example.com/x')")
    .map((x) => (p) => ({ ...p, change: { ...p.change, replace: `FIXED\n${x}` } })),
  fc.integer({ min: 21, max: 40 }).map((n) => (p) => ({ ...p, change: { ...p.change, replace: Array.from({ length: n }, (_, i) => `line${i}`).join('\n') } })),
);

async function run(mutate, prior) {
  const storage = memoryStorage();
  const eventLog = createEventLog({ storage });
  const incidents = createIncidentManager({ storage, eventLog });
  const calls = { apply: 0, restore: 0, gate: 0, plan: 0, diagnose: 0 };
  const executor = {
    async apply() { calls.apply += 1; throw new Error('executor must not be called'); },
    async restore() { calls.restore += 1; throw new Error('restore must not be called'); },
  };
  const exorcist = {
    async diagnose(input) {
      calls.diagnose += 1;
      return { outcome: 'ok', source: 'rule_based', diagnosis: {
        incidentId: input.incidentId, component: 'button', suspectedFile: 'public/button.js', location: 'line 1', rootCause: 'broken handler',
        confidence: 0.9, evidenceUsed: ['health:button'], status: 'ok',
      } };
    },
    async plan(d, input) {
      calls.plan += 1;
      // The first call yields the rule-based plan that gets rejected; any later call would be a substitute.
      const plan = calls.plan === 1 ? mutate(basePlan(input.incidentId, 0)) : basePlan(input.incidentId, calls.plan);
      return { outcome: 'ok', source: 'rule_based', plan };
    },
  };
  const safetyGate = { evaluate(plan, config) { calls.gate += 1; return evaluate(plan, config); } };
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
  if (prior > 0) await incidents.recordProgress(inc.incidentId, { attemptCount: prior });
  const result = await controller.runCycle(inc.incidentId);
  const stored = await incidents.get(inc.incidentId);
  const events = (await storage.list('events')).filter((e) => e.incidentId === inc.incidentId);
  return { calls, result, stored, events };
}

describe('Property 32: Rule-based plan rejection escalates', () => {
  it('a Safety_Gate rejection of a rule_based plan escalates with no substitute plan and no Repair_Executor call', async () => {
    await fc.assert(
      fc.asyncProperty(arbRejected, fc.integer({ min: 0, max: RETRY_BUDGET - 1 }), async (mutate, prior) => {
        const { calls, result, stored, events } = await run(mutate, prior);
        expect(calls.gate).toBe(1);
        // escalated, with the rule-based rejection reason
        expect(result.outcome).toBe('escalated');
        expect(result.reason).toBe(ESCALATION_REASONS.RULE_BASED_PLAN_REJECTED);
        expect(stored.state).toBe('escalated');
        // no substitute plan: one diagnosis, one plan request, one plan stored/recorded
        expect(calls.diagnose).toBe(1);
        expect(calls.plan).toBe(1);
        expect(events.filter((e) => e.type === 'plan').length).toBe(1);
        // the executor was never invoked, nothing to roll back
        expect(calls.apply).toBe(0);
        expect(calls.restore).toBe(0);
        const to = events.filter((e) => e.type === 'incident.state').map((e) => e.payload.to);
        expect(to).not.toContain('repairing');
        expect(to).not.toContain('verifying');
        expect(events.some((e) => e.type === 'repair')).toBe(false);
        expect(events.some((e) => e.type === 'escalation')).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});
