// Feature: poltergeist-exorcist-healing-system, Property 19: Recovery requires proof
// **Validates: Requirements 11.7, 11.8, 11.9**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager, isRejected } from '../src/incident/incident-manager.js';

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: [] };
  return {
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { data[c].push(structuredClone(rec)); return rec; },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

const verification = (incidentId, overall, n) => ({
  verificationId: `v-${n}`, incidentId, attemptNo: 1, checks: [], originalFailingCheckRan: true,
  overall, startedAt: new Date().toISOString(), durationMs: 5,
});

const PATH = ['investigating', 'planned', 'repairing', 'verifying'];
const advance = async (mgr, log, id, upTo) => {
  for (const to of PATH.slice(0, upTo)) {
    if (to === 'verifying') {
      await log.append({ type: 'repair', component: 'repair_executor', incidentId: id, payload: { status: 'applied' } });
    }
    const r = await mgr.transition(id, to, 'orchestrator');
    if (isRejected(r)) throw new Error(`setup failed at ${to}`);
  }
};

const proofKind = fc.constantFrom('pass', 'fail', 'none', 'other-incident-pass');

describe('Property 19: Recovery requires proof', () => {
  it('recovered only from verifying with a stored pass for this incident and >=3 healthy checks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }), // number of path steps taken (4 = verifying)
        proofKind,
        fc.oneof(fc.integer({ min: -1, max: 6 }), fc.constantFrom(undefined, null, 3.5, '3')),
        async (steps, proof, healthyChecks) => {
          const storage = memoryStorage();
          const log = createEventLog({ storage });
          const mgr = createIncidentManager({ storage, eventLog: log });
          const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
          const id = inc.incidentId;
          await advance(mgr, log, id, steps);

          if (proof === 'pass' || proof === 'fail') {
            await storage.put('verifications', 'v1', verification(id, proof, 1));
          } else if (proof === 'other-incident-pass') {
            await storage.put('verifications', 'v1', verification('some-other-incident', 'pass', 1));
          }

          const before = await mgr.get(id);
          const errorsBefore = (await storage.list('events')).filter((e) => e.type === 'error').length;
          const result = await mgr.transition(id, 'recovered', 'orchestrator', { healthyChecks });

          const shouldSucceed = steps === 4 && proof === 'pass' && Number.isInteger(healthyChecks) && healthyChecks >= 3;
          if (shouldSucceed) {
            expect(isRejected(result)).toBe(false);
            expect((await mgr.get(id)).state).toBe('recovered');
          } else {
            expect(isRejected(result)).toBe(true);
            const after = await mgr.get(id);
            expect(after).toEqual(before);
            expect(after.state).not.toBe('recovered');
            const errors = (await storage.list('events')).filter((e) => e.type === 'error');
            expect(errors.length).toBe(errorsBefore + 1);
            expect(errors.at(-1).incidentId).toBe(id);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
