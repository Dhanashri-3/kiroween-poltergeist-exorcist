import { describe, it, expect, beforeEach } from 'vitest';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager, isRejected } from '../src/incident/incident-manager.js';

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: [] };
  const table = (c) => (c === 'events' || c === 'snapshots' ? data[c] : data[c]);
  return {
    async get(c, key) { const t = table(c); return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { table(c).set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { table(c).push(structuredClone(rec)); return rec; },
    async list(c) { const t = table(c); return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

let storage; let log; let mgr;
const setup = () => {
  storage = memoryStorage();
  log = createEventLog({ storage });
  mgr = createIncidentManager({ storage, eventLog: log });
};
const eventsOf = async (type) => (await storage.list('events')).filter((e) => e.type === type);
const verification = (incidentId, overall = 'pass') => ({
  verificationId: `v-${incidentId}-${overall}`, incidentId, attemptNo: 1, checks: [], originalFailingCheckRan: true,
  overall, startedAt: new Date().toISOString(), durationMs: 5,
});
const repairEvent = (incidentId) => log.append({ type: 'repair', component: 'repair_executor', incidentId, payload: { status: 'applied' } });

async function toVerifying(inc) {
  for (const to of ['investigating', 'planned', 'repairing']) await mgr.transition(inc.incidentId, to, 'orchestrator');
  await repairEvent(inc.incidentId);
  return mgr.transition(inc.incidentId, 'verifying', 'orchestrator');
}

describe('IncidentManager', () => {
  beforeEach(setup);

  it('creates a detected incident and records an incident.state event', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: ['e1'] });
    expect(inc.state).toBe('detected');
    expect(await mgr.get(inc.incidentId)).toEqual(inc);
    const evs = await eventsOf('incident.state');
    expect(evs).toHaveLength(1);
    expect(evs[0].incidentId).toBe(inc.incidentId);
  });

  it('attaches evidence for the same component instead of creating a duplicate', async () => {
    const a = await mgr.create({ component: 'button', evidenceRefs: ['e1'] });
    const b = await mgr.create({ component: 'button', evidenceRefs: ['e2', 'e1'] });
    expect(b.incidentId).toBe(a.incidentId);
    expect(b.evidenceRefs).toEqual(['e1', 'e2']);
    expect(await mgr.list()).toHaveLength(1);
    const c = await mgr.attach(a.incidentId, { evidenceRefs: ['e3'] });
    expect(c.evidenceRefs).toEqual(['e1', 'e2', 'e3']);
  });

  it('allows at most one non-terminal incident', async () => {
    await mgr.create({ component: 'button', evidenceRefs: [] });
    const r = await mgr.create({ component: 'card', evidenceRefs: [] });
    expect(isRejected(r)).toBe(true);
    expect(await mgr.list()).toHaveLength(1);
    expect(await eventsOf('error')).toHaveLength(1);
  });

  it('rejects illegal transitions, leaving the incident unchanged and recording an error event', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    const r = await mgr.transition(inc.incidentId, 'recovered', 'orchestrator');
    expect(isRejected(r)).toBe(true);
    expect((await mgr.get(inc.incidentId)).state).toBe('detected');
    expect(await eventsOf('error')).toHaveLength(1);
  });

  it('persists a legal transition and records the state event', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    const r = await mgr.transition(inc.incidentId, 'investigating', 'orchestrator');
    expect(r.state).toBe('investigating');
    expect((await mgr.get(inc.incidentId)).state).toBe('investigating');
    expect((await eventsOf('incident.state')).at(-1).payload).toMatchObject({ from: 'detected', to: 'investigating' });
  });

  it('rejects verifying without a completed executor record', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    for (const to of ['investigating', 'planned', 'repairing']) await mgr.transition(inc.incidentId, to, 'o');
    expect(isRejected(await mgr.transition(inc.incidentId, 'verifying', 'o'))).toBe(true);
    await repairEvent(inc.incidentId);
    expect((await mgr.transition(inc.incidentId, 'verifying', 'o')).state).toBe('verifying');
  });

  it('guards recovered: needs a stored passing verification and 3 healthy checks', async () => {
    const inc = await toVerifying(await mgr.create({ component: 'button', evidenceRefs: [] }));
    const id = inc.incidentId;
    expect(isRejected(await mgr.transition(id, 'recovered', 'o', { healthyChecks: 3 }))).toBe(true);
    await storage.put('verifications', 'v-fail', verification(id, 'fail'));
    expect(isRejected(await mgr.transition(id, 'recovered', 'o', { healthyChecks: 3 }))).toBe(true);
    await storage.put('verifications', 'v-other', verification('other', 'pass'));
    expect(isRejected(await mgr.transition(id, 'recovered', 'o', { healthyChecks: 3 }))).toBe(true);
    await storage.put('verifications', 'v-pass', verification(id, 'pass'));
    expect(isRejected(await mgr.transition(id, 'recovered', 'o', { healthyChecks: 2 }))).toBe(true);
    expect((await mgr.transition(id, 'recovered', 'o', { healthyChecks: 3 })).state).toBe('recovered');
    expect(await mgr.getActive()).toBeNull();
  });

  it('reload flags repairing and verifying incidents, blocks injection and blocks resume to verifying', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    for (const to of ['investigating', 'planned', 'repairing']) await mgr.transition(inc.incidentId, to, 'o');
    await repairEvent(inc.incidentId);

    const restarted = createIncidentManager({ storage, eventLog: createEventLog({ storage }) });
    const flagged = await restarted.reload();
    expect(flagged.map((i) => i.incidentId)).toEqual([inc.incidentId]);
    expect((await restarted.get(inc.incidentId)).needsRollbackVerification).toBe(true);
    expect(await restarted.injectionBlocked()).toBe(true);
    expect(isRejected(await restarted.transition(inc.incidentId, 'verifying', 'o'))).toBe(true);

    await restarted.markRollbackVerified(inc.incidentId);
    expect((await restarted.get(inc.incidentId)).needsRollbackVerification).toBe(false);
  });

  it('reload does not flag detected or terminal incidents', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    await mgr.transition(inc.incidentId, 'escalated', 'o', { terminalReason: 'test' });
    expect(await mgr.reload()).toEqual([]);
    expect(await mgr.injectionBlocked()).toBe(false);
  });

  it('never reads chaos events (information barrier)', async () => {
    const inc = await mgr.create({ component: 'button', evidenceRefs: [] });
    for (const to of ['investigating', 'planned', 'repairing']) await mgr.transition(inc.incidentId, to, 'o');
    // A chaos event must not satisfy the executor-record requirement.
    await log.append({ type: 'chaos.injection', component: 'scenario_engine', incidentId: inc.incidentId, payload: {} });
    expect(isRejected(await mgr.transition(inc.incidentId, 'verifying', 'o'))).toBe(true);

    const seen = [];
    const spyLog = { append: log.append.bind(log), nonChaosView: () => ({ readAfter: async (s, f) => { seen.push(f); return log.nonChaosView().readAfter(s, f); } }) };
    const spied = createIncidentManager({ storage, eventLog: spyLog });
    await spied.transition(inc.incidentId, 'verifying', 'o');
    expect(seen.length).toBeGreaterThan(0);
  });
});
