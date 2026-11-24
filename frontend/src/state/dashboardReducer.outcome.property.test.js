// Feature: poltergeist-exorcist-healing-system, Property 29: Dashboard derives outcome from Events
// **Validates: Requirements 14.11, 15.5, 15.6, 15.8**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  initialState, reduce, selectIncidentOutcome, selectIncidentIds, OUTCOMES, INCIDENT_STATES,
} from './dashboardReducer.js';

const INC = 'inc-1';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const makeEvent = (seq, type, payload, incidentId = INC) => ({
  id: uuid(seq), seq, ts: '2025-01-01T12:00:00.000Z', type,
  component: 'orchestrator', incidentId, runId: null, payload,
});

// Payload-level descriptions of Events for one Incident; seq numbers are assigned afterwards.
const specArb = fc.oneof(
  fc.constantFrom(...INCIDENT_STATES).map((to) => ({ type: 'incident.state', payload: { to } })),
  fc.constantFrom('pass', 'fail').map((overall) => ({ type: 'verification', payload: { overall } })),
  fc.constantFrom('detection', 'diagnosis', 'plan', 'gate', 'repair', 'rollback', 'escalation', 'recovery')
    .map((type) => ({ type, payload: {} })),
);

// A set of Events with distinct seq numbers, delivered in any order.
const eventsArb = fc
  .array(specArb, { minLength: 0, maxLength: 25 })
  .chain((specs) => fc.shuffledSubarray(specs.map((s, i) => makeEvent(i + 1, s.type, s.payload)),
    { minLength: specs.length }));

const apiArb = fc.oneof(
  fc.constantFrom(...INCIDENT_STATES).map((state) => ({
    kind: 'api', endpoint: 'incident', response: { incidentId: INC, state },
  })),
  fc.constantFrom('pass', 'fail').map((overall) => ({
    kind: 'api', endpoint: 'verification', response: { incidentId: INC, verificationId: 'v-1', overall },
  })),
  fc.constantFrom('ok', 'degraded', 'storage_error').map((status) => ({
    kind: 'api', endpoint: 'health', response: { status, testApp: {} },
  })),
);

const localActionArb = fc.constantFrom({ kind: 'chaos-start-requested' }, { kind: 'reset-requested' });

const deliver = (events, api = []) =>
  [...events.map((event) => ({ kind: 'event', event })), ...api].reduce(reduce, initialState);

describe('Property 29: Dashboard derives outcome from Events', () => {
  it('shows recovery only when a verification Event with overall=pass exists for the Incident', () => {
    fc.assert(
      fc.property(eventsArb, fc.array(apiArb, { maxLength: 6 }), (events, api) => {
        const state = deliver(events, api);
        const hasPass = events.some((e) => e.type === 'verification' && e.payload.overall === 'pass');
        if (selectIncidentOutcome(state, INC) === OUTCOMES.RECOVERED) expect(hasPass).toBe(true);
        if (!hasPass) expect(selectIncidentOutcome(state, INC)).not.toBe(OUTCOMES.RECOVERED);
      }),
      { numRuns: 300 },
    );
  });

  it('a recovered state with a passing verification Event is shown as recovered', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (passFirst, withFail) => {
        const seqs = passFirst ? [1, 2] : [2, 1];
        const events = [
          makeEvent(seqs[0], 'verification', { overall: 'pass' }),
          makeEvent(seqs[1], 'incident.state', { to: 'recovered' }),
        ];
        if (withFail) events.push(makeEvent(0, 'verification', { overall: 'fail' }));
        expect(selectIncidentOutcome(deliver(events), INC)).toBe(OUTCOMES.RECOVERED);
      }),
      { numRuns: 20 },
    );
  });

  it('escalated and rolled_back are displayed distinctly from recovered and from each other', () => {
    fc.assert(
      fc.property(
        eventsArb,
        fc.constantFrom('recovered', 'escalated', 'rolled_back'),
        fc.constantFrom('pass', 'fail'),
        (events, finalState, overall) => {
          const base = events.length + 1;
          const all = [
            ...events,
            makeEvent(base, 'verification', { overall }),
            makeEvent(base + 1, 'incident.state', { to: finalState }),
          ];
          const outcome = selectIncidentOutcome(deliver(all), INC);
          if (finalState === 'escalated') expect(outcome).toBe(OUTCOMES.ESCALATED);
          if (finalState === 'rolled_back') expect(outcome).toBe(OUTCOMES.ROLLED_BACK);
          if (finalState === 'recovered') {
            const hasPass = all.some((e) => e.type === 'verification' && e.payload.overall === 'pass');
            expect(outcome).toBe(hasPass ? OUTCOMES.RECOVERED : OUTCOMES.UNVERIFIED_RECOVERY_CLAIM);
          }
        },
      ),
      { numRuns: 200 },
    );
    expect(new Set([OUTCOMES.RECOVERED, OUTCOMES.ESCALATED, OUTCOMES.ROLLED_BACK]).size).toBe(3);
  });

  it('a start-chaos or reset action alone changes no state and no outcome', () => {
    fc.assert(
      fc.property(
        eventsArb, fc.array(apiArb, { maxLength: 6 }), fc.array(localActionArb, { minLength: 1, maxLength: 5 }),
        (events, api, actions) => {
          const before = deliver(events, api);
          const after = actions.reduce(reduce, before);
          expect(after).toBe(before);
          expect(selectIncidentOutcome(after, INC)).toBe(selectIncidentOutcome(before, INC));
        },
      ),
      { numRuns: 200 },
    );
    expect(reduce(initialState, { kind: 'chaos-start-requested' })).toBe(initialState);
  });

  it('no outcome appears without Events (API responses alone never show recovery)', () => {
    expect(selectIncidentOutcome(initialState, INC)).toBe(OUTCOMES.NONE);
    expect(selectIncidentIds(initialState)).toEqual([]);
    fc.assert(
      fc.property(fc.array(fc.oneof(apiArb, localActionArb), { maxLength: 10 }), (actions) => {
        const state = actions.reduce(reduce, initialState);
        expect(state.events).toEqual([]);
        expect(selectIncidentOutcome(state, INC)).not.toBe(OUTCOMES.RECOVERED);
        expect(selectIncidentOutcome(state, 'other-incident')).toBe(OUTCOMES.NONE);
      }),
      { numRuns: 200 },
    );
  });
});
