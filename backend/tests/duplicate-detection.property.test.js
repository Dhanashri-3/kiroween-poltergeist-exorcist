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

const PATH = ['investigating', 'planned', 'repairing'];
const component = fc.constantFrom('button', 'card', 'nav', 'form', 'header');
const refs = fc.array(fc.stringMatching(/^ev-[a-z0-9]{1,6}$/), { maxLength: 6 });

// Feature: poltergeist-exorcist-healing-system, Property 9: Duplicate detection attaches
describe('Property 9: Duplicate detection attaches', () => {
  it('a detection for a component with a non-terminal Incident attaches evidence and creates no duplicate', async () => {
    // **Validates: Requirements 6.7**
    await fc.assert(
      fc.asyncProperty(
        component,
        refs,
        fc.integer({ min: 0, max: PATH.length }),
        fc.array(refs, { minLength: 1, maxLength: 4 }),
        async (comp, initial, depth, detections) => {
          const storage = memoryStorage();
          const mgr = createIncidentManager({ storage, eventLog: createEventLog({ storage }) });
          const first = await mgr.create({ component: comp, evidenceRefs: initial });
          for (const to of PATH.slice(0, depth)) await mgr.transition(first.incidentId, to, 'orchestrator');

          const expected = [...initial];
          for (const d of detections) {
            const result = await mgr.create({ component: comp, evidenceRefs: d });
            expect(isRejected(result)).toBe(false);
            expect(result.incidentId).toBe(first.incidentId);
            for (const r of d) if (!expected.includes(r)) expected.push(r);
            expect(result.evidenceRefs).toEqual(expected);
          }
          const all = await mgr.list();
          expect(all).toHaveLength(1);
          expect(all[0].incidentId).toBe(first.incidentId);
          expect(all[0].evidenceRefs).toEqual(expected);
          expect(all[0].state).toBe(depth === 0 ? 'detected' : PATH[depth - 1]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
