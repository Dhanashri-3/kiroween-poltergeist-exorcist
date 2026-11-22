// Feature: poltergeist-exorcist-healing-system, Property 24: Event sequence invariant
// **Validates: Requirements 14.1, 14.10**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { EVENT_TYPES } from '../src/contracts/common.js';

function memoryStorage() {
  const rows = [];
  return {
    rows,
    async append(_c, record) {
      // yield so concurrent appends can interleave
      await new Promise((r) => setImmediate(r));
      rows.push(structuredClone(record));
      return record;
    },
    async list() { return structuredClone(rows); },
  };
}

const inputArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  component: fc.constantFrom('monitor', 'poltergeist', 'exorcist', 'incident-manager'),
  incidentId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  runId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  payload: fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.integer()),
});

const REQUIRED = ['id', 'seq', 'ts', 'type', 'component', 'incidentId', 'runId', 'payload'];

describe('Property 24: Event sequence invariant', () => {
  it('seq is strictly increasing without duplicates and every persisted Event has all required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(inputArb, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 }),
        async (batches) => {
          const storage = memoryStorage();
          const log = createEventLog({ storage });
          const returned = [];
          // each batch is appended concurrently; batches run sequentially
          for (const batch of batches) {
            returned.push(...(await Promise.all(batch.map((i) => log.append(i)))));
          }
          const total = batches.reduce((n, b) => n + b.length, 0);
          const persisted = storage.rows;
          expect(persisted).toHaveLength(total);

          const seqs = persisted.map((e) => e.seq);
          for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
          expect(new Set(seqs).size).toBe(seqs.length);
          expect(new Set(persisted.map((e) => e.id)).size).toBe(total);
          expect(returned.map((e) => e.seq).sort((a, b) => a - b)).toEqual(seqs);

          for (const e of persisted) {
            for (const f of REQUIRED) expect(e).toHaveProperty(f);
            expect(Number.isInteger(e.seq)).toBe(true);
            expect(typeof e.id).toBe('string');
            expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a new EventLog over existing storage continues strictly after the highest seq', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 10 }), inputArb, async (n, m, i) => {
        const storage = memoryStorage();
        const first = createEventLog({ storage });
        await Promise.all(Array.from({ length: n }, () => first.append(i)));
        const restarted = createEventLog({ storage });
        await Promise.all(Array.from({ length: m }, () => restarted.append(i)));
        const seqs = storage.rows.map((e) => e.seq);
        expect(seqs).toHaveLength(n + m);
        expect(new Set(seqs).size).toBe(seqs.length);
        for (let k = 1; k < seqs.length; k++) expect(seqs[k]).toBeGreaterThan(seqs[k - 1]);
      }),
      { numRuns: 50 },
    );
  });
});
