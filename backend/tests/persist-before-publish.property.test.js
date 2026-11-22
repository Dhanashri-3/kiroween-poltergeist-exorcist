// Feature: poltergeist-exorcist-healing-system, Property 25: Persist before publish
// **Validates: Requirements 14.2**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog, EventLogStorageError } from '../src/events/event-log.js';
import { EVENT_TYPES } from '../src/contracts/common.js';

const inputArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  component: fc.constantFrom('monitor', 'poltergeist', 'exorcist', 'incident-manager'),
  incidentId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  runId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  payload: fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.integer()),
});

// failAt[i] === true means the i-th append call to storage fails.
function makeStorage(failAt, trace) {
  const rows = [];
  let calls = 0;
  return {
    rows,
    async append(_c, record) {
      const failing = failAt[calls++ % failAt.length];
      await new Promise((r) => setImmediate(r));
      if (failing) throw new Error('disk full');
      rows.push(structuredClone(record));
      trace.push(`persist:${record.id}`);
      return record;
    },
    async list() { return structuredClone(rows); },
  };
}

describe('Property 25: Persist before publish', () => {
  it('publishes only events already persisted; a persist failure publishes nothing and signals a storage error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(inputArb, { minLength: 1, maxLength: 10 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        async (inputs, failAt) => {
          const trace = [];
          const storage = makeStorage(failAt, trace);
          const log = createEventLog({ storage });
          const published = [];
          log.subscribe((e) => {
            // at publish time the event must already be in storage
            expect(storage.rows.some((r) => r.id === e.id)).toBe(true);
            trace.push(`publish:${e.id}`);
            published.push(e);
          });

          let successes = 0;
          for (const input of inputs) {
            const before = published.length;
            const persistedBefore = storage.rows.length;
            let error = null;
            let result = null;
            try { result = await log.append(input); } catch (e) { error = e; }

            if (error) {
              expect(error).toBeInstanceOf(EventLogStorageError);
              expect(error.code).toBe('storage_error');
              expect(published.length).toBe(before);
              expect(storage.rows.length).toBe(persistedBefore);
              expect(log.storageStatus.ok).toBe(false);
            } else {
              successes++;
              expect(published.length).toBe(before + 1);
              expect(published[published.length - 1].id).toBe(result.id);
              expect(storage.rows.length).toBe(persistedBefore + 1);
            }
          }

          expect(published).toHaveLength(successes);
          expect(storage.rows).toHaveLength(successes);
          for (const p of published) {
            expect(trace.indexOf(`persist:${p.id}`)).toBeGreaterThanOrEqual(0);
            expect(trace.indexOf(`persist:${p.id}`)).toBeLessThan(trace.indexOf(`publish:${p.id}`));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
