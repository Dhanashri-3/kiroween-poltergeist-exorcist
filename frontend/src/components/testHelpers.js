// Test-only helpers: build real reducer state from valid Events (UUID id, ISO ts, all 8 fields).
import { reduce, initialState } from '../state/dashboardReducer.js';

export const INC = 'inc-1';

export function ev(seq, type, payload = {}, { incidentId = INC, component = 'orchestrator', runId = null } = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    ts: `2024-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    type,
    component,
    incidentId,
    runId,
    payload,
  };
}

export const stateEv = (seq, to, incidentId = INC) => ev(seq, 'incident.state', { to }, { incidentId });

export function build(events = [], apis = []) {
  let s = initialState;
  for (const [endpoint, response] of apis) s = reduce(s, { kind: 'api', endpoint, response });
  for (const e of events) s = reduce(s, { kind: 'event', event: e });
  return s;
}

export const healthOk = {
  status: 'ok',
  testApp: { reachable: true, httpStatus: 200, components: { header: 'ok', cart: 'ok' } },
  storage: { ok: true },
};

export const passVerification = {
  verificationId: 'v-1', incidentId: INC, attemptNo: 1, originalFailingCheckRan: true, overall: 'pass',
  startedAt: '2024-01-01T00:00:00.000Z', durationMs: 120,
  checks: [{ checkId: 'c1', kind: 'health', coversComponent: 'cart', outcome: 'pass', rawOutputRef: 'r1' }],
};
