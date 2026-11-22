// Task 6.3: every from-state x to-state pair against the transition table and Incident_Manager.
// Validates: Requirements 19.2
import { describe, it, expect } from 'vitest';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager, isRejected } from '../src/incident/incident-manager.js';
import { STATES, TRANSITIONS } from '../src/incident/state-machine.js';

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: [] };
  return {
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { data[c].push(structuredClone(rec)); return rec; },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

// Paths from `detected` to each state. rolled_back is reached from planned, recovered from verifying.
const PATHS = {
  detected: [],
  investigating: ['investigating'],
  planned: ['investigating', 'planned'],
  repairing: ['investigating', 'planned', 'repairing'],
  verifying: ['investigating', 'planned', 'repairing', 'verifying'],
  rolled_back: ['investigating', 'planned', 'rolled_back'],
  recovered: ['investigating', 'planned', 'repairing', 'verifying', 'recovered'],
  escalated: ['escalated'],
};

// Satisfies every context precondition so a rejection can only come from the transition table.
const FULL_CONTEXT = { rollbackVerified: true, executorCompleted: true, healthyChecks: 3 };

async function incidentIn(state) {
  const storage = memoryStorage();
  const log = createEventLog({ storage });
  const mgr = createIncidentManager({ storage, eventLog: log });
  const inc = await mgr.create({ component: 'button', evidenceRefs: ['e1'] });
  const id = inc.incidentId;
  for (const step of PATHS[state]) {
    if (step === 'verifying') {
      await log.append({ type: 'repair', component: 'repair_executor', incidentId: id, payload: { status: 'applied' } });
    }
    if (step === 'recovered') {
      await storage.put('verifications', 'v1', {
        verificationId: 'v1', incidentId: id, attemptNo: 1, checks: [], originalFailingCheckRan: true,
        overall: 'pass', startedAt: new Date().toISOString(), durationMs: 5,
      });
    }
    const r = await mgr.transition(id, step, 'orchestrator', FULL_CONTEXT);
    if (isRejected(r)) throw new Error(`setup failed at ${step}: ${r.reason}`);
  }
  expect((await mgr.get(id)).state).toBe(state);
  return { storage, log, mgr, id };
}

// Adds a completed executor record and a passing Verification_Result so only the table can reject.
async function satisfyPreconditions({ storage, log, id }) {
  await log.append({ type: 'repair', component: 'repair_executor', incidentId: id, payload: { status: 'applied' } });
  await storage.put('verifications', 'v-pre', {
    verificationId: 'v-pre', incidentId: id, attemptNo: 1, checks: [], originalFailingCheckRan: true,
    overall: 'pass', startedAt: new Date().toISOString(), durationMs: 5,
  });
}

const pairs = STATES.flatMap((from) => STATES.map((to) => ({ from, to, permitted: TRANSITIONS[from].includes(to) })));

describe('incident transition matrix (8 x 8)', () => {
  it('covers 64 pairs, 16 of them permitted', () => {
    expect(pairs).toHaveLength(64);
    expect(pairs.filter((p) => p.permitted)).toHaveLength(16);
  });

  describe.each(pairs.filter((p) => p.permitted))('permitted $from -> $to', ({ from, to }) => {
    it('succeeds, persists the new state and records an incident.state event', async () => {
      const { storage, log, mgr, id } = await incidentIn(from);
      await satisfyPreconditions({ storage, log, id });
      const before = (await storage.list('events')).length;
      const result = await mgr.transition(id, to, 'orchestrator', FULL_CONTEXT);
      expect(isRejected(result)).toBe(false);
      expect(result.state).toBe(to);
      expect((await mgr.get(id)).state).toBe(to);
      const added = (await storage.list('events')).slice(before);
      expect(added.filter((e) => e.type === 'error')).toHaveLength(0);
      expect(added.find((e) => e.type === 'incident.state').payload).toMatchObject({ from, to });
    });
  });

  describe.each(pairs.filter((p) => !p.permitted))('rejected $from -> $to', ({ from, to }) => {
    it('leaves the incident unchanged and records an error event', async () => {
      const { storage, log, mgr, id } = await incidentIn(from);
      await satisfyPreconditions({ storage, log, id });
      const incidentBefore = await mgr.get(id);
      const before = (await storage.list('events')).length;
      const result = await mgr.transition(id, to, 'orchestrator', FULL_CONTEXT);
      expect(isRejected(result)).toBe(true);
      expect(await mgr.get(id)).toEqual(incidentBefore);
      const added = (await storage.list('events')).slice(before);
      expect(added.map((e) => e.type)).toEqual(['error']);
      expect(added[0].incidentId).toBe(id);
    });
  });

  describe('preconditions on otherwise permitted transitions', () => {
    const rejectsWith = async (from, to, context, mutate) => {
      const { storage, log, mgr, id } = await incidentIn(from);
      if (mutate) await mutate({ storage, log, id });
      const incidentBefore = await mgr.get(id);
      const before = (await storage.list('events')).length;
      const result = await mgr.transition(id, to, 'orchestrator', context);
      expect(isRejected(result)).toBe(true);
      expect(await mgr.get(id)).toEqual(incidentBefore);
      expect((await storage.list('events')).slice(before).map((e) => e.type)).toEqual(['error']);
    };

    it('rejects rolled_back without a verified rollback', () => rejectsWith('planned', 'rolled_back', {}));

    // An incident in `repairing` has no repair event yet, so no completed executor record exists.
    it('rejects verifying without a completed executor record', () => rejectsWith('repairing', 'verifying', FULL_CONTEXT));

    it('rejects recovered without a stored passing Verification_Result', async () => {
      const { storage, mgr, id } = await incidentIn('verifying');
      const before = await mgr.get(id);
      const result = await mgr.transition(id, 'recovered', 'orchestrator', FULL_CONTEXT);
      expect(isRejected(result)).toBe(true);
      expect(await mgr.get(id)).toEqual(before);
      expect((await storage.list('events')).at(-1).type).toBe('error');
    });
  });
});
