// Feature: poltergeist-exorcist-healing-system, Property 28: Dashboard timeline ordering
// **Validates: Requirements 15.2, 15.7**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { initialState, reduce, selectTimeline, EVENT_TYPES } from './dashboardReducer.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const makeEvent = (seq, type) => ({
  id: uuid(seq), seq, ts: '2025-01-01T12:00:00.000Z', type,
  component: 'orchestrator', incidentId: null, runId: null, payload: {},
});

// A pool of valid Events with distinct seq numbers.
const poolArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 40 })
  .chain((seqs) =>
    fc.tuple(...seqs.map(() => fc.constantFrom(...EVENT_TYPES))).map((types) =>
      seqs.map((seq, i) => makeEvent(seq, types[i]))));

// Delivery: any order, with duplicates; each step is a single event, a batch from
// GET /events, or a reconnect replay of an earlier slice. `pick` indexes into the pool.
const deliveryArb = poolArb.chain((pool) => {
  const idx = fc.nat({ max: pool.length - 1 });
  const step = fc.oneof(
    idx.map((i) => ({ kind: 'event', event: pool[i] })),
    fc.array(idx, { maxLength: 15 }).map((is) => ({
      kind: 'api', endpoint: 'events', response: { events: is.map((i) => pool[i]) },
    })),
    fc.tuple(idx, idx).map(([a, b]) => ({
      kind: 'api', endpoint: 'events',
      response: { events: pool.slice(Math.min(a, b), Math.max(a, b) + 1) },
    })),
  );
  return fc.array(step, { minLength: 1, maxLength: 60 }).map((steps) => ({ pool, steps }));
});

const deliveredSeqs = (steps) => {
  const out = new Set();
  for (const s of steps) {
    if (s.kind === 'event') out.add(s.event.seq);
    else s.response.events.forEach((e) => out.add(e.seq));
  }
  return out;
};

describe('Property 28: Dashboard timeline ordering', () => {
  it('timeline is strictly increasing by seq with no duplicates after any delivery', () => {
    fc.assert(
      fc.property(deliveryArb, ({ steps }) => {
        let state = initialState;
        for (const s of steps) {
          state = reduce(state, s);
          const seqs = selectTimeline(state).map((e) => e.seq);
          for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
        }
        const finalSeqs = selectTimeline(state).map((e) => e.seq);
        // Nothing lost and nothing invented.
        expect(new Set(finalSeqs)).toEqual(deliveredSeqs(steps));
        expect(new Set(finalSeqs).size).toBe(finalSeqs.length);
      }),
      { numRuns: 200 },
    );
  });

  it('replaying the whole delivery after a reconnect leaves the timeline unchanged', () => {
    fc.assert(
      fc.property(deliveryArb, ({ steps }) => {
        const once = steps.reduce(reduce, initialState);
        const twice = [...steps, ...steps].reduce(reduce, initialState);
        expect(selectTimeline(twice)).toEqual(selectTimeline(once));
      }),
      { numRuns: 100 },
    );
  });

  it('final timeline does not depend on delivery order', () => {
    fc.assert(
      fc.property(
        poolArb.chain((pool) => fc.tuple(fc.constant(pool), fc.shuffledSubarray(pool, { minLength: pool.length }))),
        ([pool, shuffled]) => {
          const a = pool.map((event) => ({ kind: 'event', event })).reduce(reduce, initialState);
          const b = shuffled.map((event) => ({ kind: 'event', event })).reduce(reduce, initialState);
          expect(selectTimeline(b)).toEqual(selectTimeline(a));
          expect(selectTimeline(a).map((e) => e.seq)).toEqual(pool.map((e) => e.seq).sort((x, y) => x - y));
        },
      ),
      { numRuns: 100 },
    );
  });
});
