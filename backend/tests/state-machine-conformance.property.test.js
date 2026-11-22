import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager, isRejected } from '../src/incident/incident-manager.js';
import { STATES, TRANSITIONS, TERMINAL_STATES } from '../src/incident/state-machine.js';

// Independent oracle: the permitted transition table from the design ("Incident Lifecycle").
const PERMITTED = {
  detected: ['investigating', 'escalated'],
  investigating: ['planned', 'escalated'],
  planned: ['repairing', 'investigating', 'escalated', 'rolled_back'],
  repairing: ['verifying', 'rolled_back', 'escalated'],
  verifying: ['recovered', 'rolled_back', 'escalated'],
  rolled_back: ['investigating', 'escalated'],
  recovered: [],
  escalated: [],
};

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: [] };
  return {
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { data[c].push(structuredClone(rec)); return rec; },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

const stateArb = fc.constantFrom(...STATES);

/** Build a manager with one incident forced into `from` (bypassing transitions). */
async function arrange(from, { hasExecutor, hasPassingVerification }) {
  const storage = memoryStorage();
  const log = createEventLog({ storage });
  const mgr = createIncidentManager({ storage, eventLog: log });
  const created = await mgr.create({ component: 'button', evidenceRefs: ['e1'] });
  await storage.put('incidents', created.incidentId, { ...created, state: from });
  if (hasExecutor) {
    await log.append({ type: 'repair', component: 'repair_executor', incidentId: created.incidentId, payload: { status: 'applied' } });
  }
  if (hasPassingVerification) {
    await storage.put('verifications', 'v1', {
      verificationId: 'v1', incidentId: created.incidentId, attemptNo: 1, checks: [],
      originalFailingCheckRan: true, overall: 'pass', startedAt: new Date().toISOString(), durationMs: 5,
    });
  }
  return { storage, mgr, id: created.incidentId };
}

const countType = async (storage, type) => (await storage.list('events')).filter((e) => e.type === type).length;

describe('Property 8: State machine conformance', () => {
  it('Property 8: State machine conformance - the transition table matches the design', () => {
    for (const s of STATES) expect([...TRANSITIONS[s]].sort()).toEqual([...PERMITTED[s]].sort());
    expect([...TERMINAL_STATES].sort()).toEqual(['escalated', 'recovered']);
    // rolled_back is never terminal: exits are only investigating and escalated.
    expect([...TRANSITIONS.rolled_back].sort()).toEqual(['escalated', 'investigating']);
  });

  it('Property 8: State machine conformance - accepted iff permitted; rejection leaves incident unchanged and records an error event', async () => {
    /**
     * **Validates: Requirements 6.2, 6.3, 6.4, 10.10, 10.11, 12.2, 12.5**
     */
    await fc.assert(
      fc.asyncProperty(
        stateArb,
        stateArb,
        fc.record({
          rollbackVerified: fc.boolean(),
          hasExecutor: fc.boolean(),
          hasPassingVerification: fc.boolean(),
          healthyChecks: fc.integer({ min: 0, max: 5 }),
        }),
        async (from, to, c) => {
          const { storage, mgr, id } = await arrange(from, c);
          const before = await mgr.get(id);
          const errorsBefore = await countType(storage, 'error');
          const statesBefore = await countType(storage, 'incident.state');

          const expected =
            PERMITTED[from].includes(to) &&
            (to !== 'rolled_back' || c.rollbackVerified) &&
            (to !== 'verifying' || c.hasExecutor) &&
            (to !== 'recovered' || (c.hasPassingVerification && c.healthyChecks >= 3));

          const result = await mgr.transition(id, to, 'orchestrator', {
            rollbackVerified: c.rollbackVerified,
            healthyChecks: c.healthyChecks,
          });
          const after = await mgr.get(id);

          if (expected) {
            expect(isRejected(result)).toBe(false);
            expect(after.state).toBe(to);
            expect(await countType(storage, 'incident.state')).toBe(statesBefore + 1);
            expect(await countType(storage, 'error')).toBe(errorsBefore);
          } else {
            expect(isRejected(result)).toBe(true);
            expect(after).toEqual(before);
            expect(await countType(storage, 'error')).toBe(errorsBefore + 1);
            expect(await countType(storage, 'incident.state')).toBe(statesBefore);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('Property 8: State machine conformance - terminal states accept nothing and rolled_back exits only to investigating or escalated', async () => {
    /**
     * **Validates: Requirements 6.3, 12.2, 12.5**
     */
    const fullCtx = { rollbackVerified: true, healthyChecks: 5 };
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('recovered', 'escalated', 'rolled_back'), stateArb, async (from, to) => {
        const { mgr, id } = await arrange(from, { hasExecutor: true, hasPassingVerification: true });
        const result = await mgr.transition(id, to, 'orchestrator', fullCtx);
        const allowed = from === 'rolled_back' && ['investigating', 'escalated'].includes(to);
        expect(isRejected(result)).toBe(!allowed);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 8: State machine conformance - verifying only from repairing, recovered only from verifying', async () => {
    /**
     * **Validates: Requirements 10.10, 10.11, 6.4**
     */
    await fc.assert(
      fc.asyncProperty(stateArb, fc.constantFrom('verifying', 'recovered'), async (from, to) => {
        const { mgr, id } = await arrange(from, { hasExecutor: true, hasPassingVerification: true });
        const result = await mgr.transition(id, to, 'orchestrator', { rollbackVerified: true, healthyChecks: 5 });
        const source = to === 'verifying' ? 'repairing' : 'verifying';
        expect(isRejected(result)).toBe(from !== source);
      }),
      { numRuns: 100 },
    );
  });
});
