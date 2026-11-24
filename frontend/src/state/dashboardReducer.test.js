import { describe, it, expect } from 'vitest';
import {
  initialState, reduce, selectTimeline, selectIncidentOutcome, selectIncidentView,
  selectCurrentIncidentId, OUTCOMES,
} from './dashboardReducer.js';

// Fixtures follow docs/event-schema.md and docs/api.md (Event shape, Incident, Verification_Result).
const INC = 'inc-1';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function ev(seq, type, payload = {}, incidentId = INC) {
  return {
    id: uuid(seq), seq, ts: '2025-01-01T12:00:00.000Z', type,
    component: 'orchestrator', incidentId, runId: null, payload,
  };
}
const state = (seq, to, from = null) => ev(seq, 'incident.state', { from, to, actor: 'orchestrator' });
const verification = (seq, overall) => ev(seq, 'verification', {
  verificationId: `v-${seq}`, incidentId: INC, attemptNo: 1,
  checks: [{ checkId: 'c1', kind: 'health', coversComponent: 'nav', outcome: overall === 'pass' ? 'pass' : 'fail', rawOutputRef: 'r' }],
  originalFailingCheckRan: true, overall, startedAt: '2025-01-01T12:00:00.000Z', durationMs: 5,
});
const apply = (s, ...actions) => actions.reduce(reduce, s);
const asEvents = (...events) => events.map((event) => ({ kind: 'event', event }));
const outcome = (s) => selectIncidentOutcome(s, INC);

const recoveredRun = [
  state(1, 'detected'), state(2, 'investigating', 'detected'), state(3, 'planned', 'investigating'),
  state(4, 'repairing', 'planned'), state(5, 'verifying', 'repairing'), verification(6, 'pass'),
  state(7, 'recovered', 'verifying'),
];

describe('timeline', () => {
  it('is sorted ascending by seq regardless of arrival order', () => {
    const s = apply(initialState, ...asEvents(ev(3, 'detection', {}, null), ev(1, 'chaos.injection', {}, null), ev(2, 'detection', {}, null)));
    expect(selectTimeline(s).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('ignores duplicates, including a replayed event inside a batch', () => {
    const a = ev(1, 'detection', {}, null);
    const b = ev(2, 'detection', {}, null);
    let s = apply(initialState, ...asEvents(a, b, a));
    s = reduce(s, { kind: 'api', endpoint: 'events', response: { events: [a, b, ev(3, 'cleared', {}, null), b] } });
    expect(selectTimeline(s).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the first-seen event when a seq is replayed', () => {
    const first = ev(1, 'detection', { n: 1 }, null);
    const s = apply(initialState, ...asEvents(first, { ...first, payload: { n: 2 } }));
    expect(selectTimeline(s)).toHaveLength(1);
    expect(selectTimeline(s)[0].payload.n).toBe(1);
  });

  it('converges to the same state for out-of-order, replayed and batched arrival', () => {
    const forward = apply(initialState, ...asEvents(...recoveredRun));
    const shuffled = [recoveredRun[6], recoveredRun[2], recoveredRun[0], recoveredRun[5], recoveredRun[1], recoveredRun[4], recoveredRun[3]];
    const replayed = apply(initialState, ...asEvents(...shuffled, ...shuffled));
    const batched = reduce(initialState, { kind: 'api', endpoint: 'events', response: { events: [...shuffled].reverse() } });
    expect(replayed).toEqual(forward);
    expect(batched).toEqual(forward);
    expect(outcome(replayed)).toBe(OUTCOMES.RECOVERED);
  });

  it('does not regress incident state when an older state event arrives last', () => {
    const s = apply(initialState, ...asEvents(state(4, 'repairing', 'planned'), state(2, 'investigating', 'detected')));
    expect(selectIncidentView(s, INC).state).toBe('repairing');
  });
});

describe('recovery requires a passing verification Event', () => {
  it('shows recovered with state recovered and verification pass', () => {
    expect(outcome(apply(initialState, ...asEvents(...recoveredRun)))).toBe(OUTCOMES.RECOVERED);
  });

  it('does not show recovery after a verification fail', () => {
    const s = apply(initialState, ...asEvents(state(1, 'verifying'), verification(2, 'fail'), state(3, 'recovered', 'verifying')));
    expect(outcome(s)).toBe(OUTCOMES.UNVERIFIED_RECOVERY_CLAIM);
  });

  it('does not show recovery when state claims recovered with no verification Event', () => {
    const s = apply(initialState, ...asEvents(state(1, 'detected'), state(2, 'recovered', 'verifying')));
    expect(outcome(s)).toBe(OUTCOMES.UNVERIFIED_RECOVERY_CLAIM);
  });

  it('does not show recovery from a recovery Event alone', () => {
    const s = apply(initialState, ...asEvents(state(1, 'recovered'), ev(2, 'recovery', { verificationId: 'v' })));
    expect(outcome(s)).not.toBe(OUTCOMES.RECOVERED);
  });

  it('does not show recovery from a pass verification Event of another incident', () => {
    const other = ev(2, 'verification', { overall: 'pass', incidentId: 'inc-2' }, 'inc-2');
    expect(outcome(apply(initialState, ...asEvents(state(1, 'recovered'), other)))).toBe(OUTCOMES.UNVERIFIED_RECOVERY_CLAIM);
  });

  it('does not show recovery from health or API verification alone', () => {
    const apiIncident = {
      incidentId: INC, state: 'recovered', detectedAt: '2025-01-01T12:00:00.000Z', component: 'nav', evidenceRefs: [],
      plans: [], gateDecisions: [], attempts: [], attemptCount: 1, needsRollbackVerification: false, updatedAt: '2025-01-01T12:00:00.000Z',
    };
    let s = reduce(initialState, { kind: 'api', endpoint: 'health', response: { status: 'ok', testApp: { reachable: true, httpStatus: 200, components: {} }, storage: { ok: true } } });
    expect(outcome(s)).toBe(OUTCOMES.NONE);
    s = reduce(s, { kind: 'api', endpoint: 'incident', response: apiIncident });
    s = reduce(s, { kind: 'api', endpoint: 'verification', response: JSON.parse(JSON.stringify({ ...verification(1, 'pass').payload })) });
    expect(outcome(s)).toBe(OUTCOMES.UNVERIFIED_RECOVERY_CLAIM);
  });
});

describe('distinct outcomes', () => {
  it('keeps escalated, rolled_back and recovered distinct', () => {
    const escalated = apply(initialState, ...asEvents(state(1, 'detected'), state(2, 'escalated', 'detected'),
      ev(3, 'escalation', { reason: 'diagnosis_timeout', plans: [], verificationResults: [], attemptCount: 0 })));
    const rolledBack = apply(initialState, ...asEvents(state(1, 'repairing'), ev(2, 'rollback', { status: 'verified' }), state(3, 'rolled_back', 'repairing')));
    const recovered = apply(initialState, ...asEvents(...recoveredRun));
    const values = [outcome(escalated), outcome(rolledBack), outcome(recovered)];
    expect(values).toEqual([OUTCOMES.ESCALATED, OUTCOMES.ROLLED_BACK, OUTCOMES.RECOVERED]);
    expect(new Set(values).size).toBe(3);
    expect(selectIncidentView(escalated, INC).terminalReason).toBe('diagnosis_timeout');
    expect(selectIncidentView(rolledBack, INC).rollbacks).toEqual([{ status: 'verified' }]);
  });

  it('reports escalated after rolled_back once the later state arrives', () => {
    const s = apply(initialState, ...asEvents(state(2, 'escalated', 'rolled_back'), state(1, 'rolled_back', 'planned')));
    expect(outcome(s)).toBe(OUTCOMES.ESCALATED);
  });
});

describe('local actions and API responses', () => {
  it('leaves state deeply equal after chaos-start and reset requests', () => {
    const before = apply(initialState, ...asEvents(...recoveredRun.slice(0, 3)),
      { kind: 'api', endpoint: 'health', response: { status: 'degraded', testApp: { reachable: false, httpStatus: null, components: null }, storage: { ok: true } } });
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = apply(before, { kind: 'chaos-start-requested' }, { kind: 'reset-requested' });
    expect(after).toEqual(snapshot);
    expect(outcome(after)).toBe(outcome(before));
  });

  it('populates health, scenarios and incidents without inventing outcomes', () => {
    const incident = {
      incidentId: INC, state: 'investigating', detectedAt: '2025-01-01T12:00:00.000Z', component: 'nav', evidenceRefs: ['e'],
      plans: [], gateDecisions: [], attempts: [], attemptCount: 0, needsRollbackVerification: false, updatedAt: '2025-01-01T12:00:00.000Z',
    };
    const s = apply(initialState,
      { kind: 'api', endpoint: 'health', response: { status: 'ok', testApp: { reachable: true, httpStatus: 200, components: { nav: 'ok' } }, storage: { ok: true } } },
      { kind: 'api', endpoint: 'scenarios', response: { scenarios: [{ id: 's1', label: 'Broken nav', severity: 'high' }] } },
      { kind: 'api', endpoint: 'incidents', response: { incidents: [incident] } });
    expect(s.health.status).toBe('ok');
    expect(s.scenarios).toEqual([{ id: 's1', label: 'Broken nav', severity: 'high' }]);
    expect(selectCurrentIncidentId(s)).toBe(INC);
    expect(outcome(s)).toBe(OUTCOMES.ACTIVE);
    expect(selectTimeline(s)).toEqual([]);
  });

  it('shows no incident while idle', () => {
    expect(selectCurrentIncidentId(initialState)).toBeNull();
    expect(selectIncidentView(initialState, INC)).toBeNull();
  });
});

describe('malformed input and purity', () => {
  it('ignores malformed input without throwing or changing state', () => {
    const base = apply(initialState, ...asEvents(ev(1, 'detection', {}, null)));
    const bad = [
      undefined, null, 'x', 42, [], {}, { kind: 'nope' },
      { kind: 'event' }, { kind: 'event', event: null },
      { kind: 'event', event: { ...ev(2, 'detection'), seq: '2' } },
      { kind: 'event', event: { ...ev(2, 'detection'), seq: 2.5 } },
      { kind: 'event', event: { ...ev(2, 'detection'), seq: undefined } },
      { kind: 'event', event: { ...ev(2, 'detection'), seq: -1 } },
      { kind: 'event', event: ev(2, 'not-a-real-type') },
      { kind: 'event', event: { ...ev(2, 'detection'), extra: 1 } },
      { kind: 'event', event: { ...ev(2, 'detection'), payload: null } },
      { kind: 'api' }, { kind: 'api', endpoint: 'bogus', response: {} },
      { kind: 'api', endpoint: 'events', response: { events: 'x' } },
      { kind: 'api', endpoint: 'events', response: { events: [{ seq: 'a' }, null, 3] } },
      { kind: 'api', endpoint: 'health', response: { error: { code: 'internal_error' } } },
      { kind: 'api', endpoint: 'incident', response: { incidentId: 'x', state: 'bogus' } },
      { kind: 'api', endpoint: 'verification', response: { incidentId: 'x', verificationId: 'v', overall: 'maybe' } },
    ];
    for (const input of bad) {
      expect(() => reduce(base, input)).not.toThrow();
      expect(reduce(base, input)).toBe(base);
    }
  });

  it('adds only the valid events from a mixed batch', () => {
    const s = reduce(initialState, { kind: 'api', endpoint: 'events', response: { events: [ev(2, 'detection', {}, null), { seq: 1 }, ev(1, 'cleared', {}, null)] } });
    expect(selectTimeline(s).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('does not mutate the previous state or the input event', () => {
    const base = apply(initialState, ...asEvents(ev(2, 'detection', {}, null)));
    const frozenBefore = JSON.stringify(base);
    const incoming = ev(1, 'detection', {}, null);
    const incomingBefore = JSON.stringify(incoming);
    const next = reduce(base, { kind: 'event', event: incoming });
    expect(JSON.stringify(base)).toBe(frozenBefore);
    expect(JSON.stringify(incoming)).toBe(incomingBefore);
    expect(next).not.toBe(base);
    expect(next.events).not.toBe(base.events);
    expect(initialState.events).toEqual([]);
  });
});
