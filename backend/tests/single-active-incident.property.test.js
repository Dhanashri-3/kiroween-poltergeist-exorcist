import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog } from '../src/events/event-log.js';
import { createIncidentManager, isRejected } from '../src/incident/incident-manager.js';
import { isTerminal } from '../src/incident/state-machine.js';
import { createScenarioEngine } from '../src/scenario-engine/scenario-engine.js';

function memoryStorage() {
  const data = { events: [], incidents: new Map(), verifications: new Map(), snapshots: [] };
  return {
    async get(c, key) { const t = data[c]; return t instanceof Map ? structuredClone(t.get(key) ?? null) : null; },
    async put(c, key, rec) { data[c].set(key, structuredClone(rec)); return rec; },
    async append(c, rec) { data[c].push(structuredClone(rec)); return rec; },
    async list(c) { const t = data[c]; return structuredClone(t instanceof Map ? [...t.values()] : t); },
  };
}

// Non-terminal states reachable through the real Incident_Manager, with the context each step needs.
const PATHS = {
  detected: [],
  investigating: [['investigating', {}]],
  planned: [['investigating', {}], ['planned', {}]],
  repairing: [['investigating', {}], ['planned', {}], ['repairing', {}]],
  rolled_back: [['investigating', {}], ['planned', {}], ['rolled_back', { rollbackVerified: true }]],
};
const NON_TERMINAL = Object.keys(PATHS);
const component = fc.constantFrom('button', 'card', 'nav', 'form', 'header');
const refs = fc.array(fc.stringMatching(/^ev-[a-z0-9]{1,6}$/), { maxLength: 4 });

function setup() {
  const storage = memoryStorage();
  const eventLog = createEventLog({ storage });
  const mgr = createIncidentManager({ storage, eventLog });
  return { storage, eventLog, mgr };
}

async function driveTo(mgr, incidentId, state) {
  for (const [to, ctx] of PATHS[state]) {
    const r = await mgr.transition(incidentId, to, 'orchestrator', ctx);
    expect(isRejected(r)).toBe(false);
  }
}

// Scenario_Engine whose snapshot/guard collaborators fail loudly if a rejected injection touches them.
function engineFor(storage, eventLog) {
  const touched = [];
  const boom = (name) => () => { touched.push(name); throw new Error(`${name} must not be called on rejection`); };
  const catalog = { get: () => ({ scenarioId: 's1', targetComponent: 'button', targetFiles: ['index.html'] }) };
  const engine = createScenarioEngine({
    catalog,
    testappDir: '.',
    snapshotService: { create: boom('create'), restore: boom('restore'), list: boom('list'), currentChecksums: boom('currentChecksums') },
    fileGuard: { assertWritable: boom('assertWritable') },
    eventLog,
    storage,
  });
  return { engine, touched };
}

// Feature: poltergeist-exorcist-healing-system, Property 4: Single active Incident
describe('Property 4: Single active Incident', () => {
  it('injection is rejected with a rejection Event for any non-terminal Incident state', async () => {
    // **Validates: Requirements 3.4, 6.8, 13.4**
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NON_TERMINAL), component, refs, async (state, comp, evidenceRefs) => {
        const { storage, eventLog, mgr } = setup();
        const inc = await mgr.create({ component: comp, evidenceRefs });
        await driveTo(mgr, inc.incidentId, state);
        expect(isTerminal((await mgr.get(inc.incidentId)).state)).toBe(false);
        expect(await mgr.injectionBlocked()).toBe(true);

        const { engine, touched } = engineFor(storage, eventLog);
        await expect(engine.inject('s1', 'run-1')).rejects.toMatchObject({ code: 'incident_active' });
        expect(touched).toEqual([]);

        const rejections = (await eventLog.readAfter(0)).filter((e) => e.type === 'chaos.rejected');
        expect(rejections).toHaveLength(1);
        expect(rejections[0].payload.reason).toBe('incident_non_terminal');
      }),
      { numRuns: 100 },
    );
  });

  it('for any sequence of detections at most one non-terminal Incident exists at a time', async () => {
    // **Validates: Requirements 3.4, 6.8, 13.4**
    const step = fc.oneof(
      fc.record({ kind: fc.constant('detect'), comp: component, refs }),
      fc.record({ kind: fc.constant('escalate') }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 15 }), async (steps) => {
        const { mgr } = setup();
        for (const s of steps) {
          if (s.kind === 'detect') {
            const before = await mgr.getActive();
            const result = await mgr.create({ component: s.comp, evidenceRefs: s.refs });
            if (before && before.component !== s.comp) expect(isRejected(result)).toBe(true);
            else expect(isRejected(result)).toBe(false);
          } else {
            const active = await mgr.getActive();
            if (active) expect(isRejected(await mgr.transition(active.incidentId, 'escalated', 'orchestrator'))).toBe(false);
          }
          const nonTerminal = (await mgr.list()).filter((i) => !isTerminal(i.state));
          expect(nonTerminal.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
