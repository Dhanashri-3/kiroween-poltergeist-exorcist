// Task 10.2 - Property 7: Information barrier.
// **Validates: Requirements 3.8, 5.2, 7.4**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildExorcistInput } from '../src/exorcist/input-builder.js';
import { createEventLog } from '../src/events/event-log.js';
import { redact } from '../src/events/redactor.js';

function memoryStorage() {
  const data = new Map();
  return {
    async append(col, item) { (data.get(col) ?? data.set(col, []).get(col)).push(structuredClone(item)); },
    async list(col) { return structuredClone(data.get(col) ?? []); },
    async get() { return undefined; },
    async put() {},
  };
}

const INCIDENT_ID = 'inc-1';

// Distinctive, redaction-neutral marker strings so a substring hit is a real leak.
const marker = (prefix) => fc.stringMatching(/^[a-z]{10,16}$/).map((s) => `${prefix}${s}`);

const chaosEventArb = fc.record({
  type: fc.constantFrom('chaos.selection', 'chaos.injection', 'chaos.rejected'),
  scenarioId: marker('scnzq'),
  injectionMethod: marker('injzq'),
  rationale: marker('ratzq'),
  incidentId: fc.constantFrom(INCIDENT_ID, null),
});

const incident = {
  incidentId: INCIDENT_ID,
  state: 'investigating',
  detectedAt: '2025-01-01T00:00:00.000Z',
  component: 'button',
  evidenceRefs: ['ev-1'],
  plans: [{ incidentId: INCIDENT_ID, actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'a', replace: 'b' }, rationale: 'try' }],
  gateDecisions: [],
  attempts: [{ attemptNo: 1, planHash: 'h1', snapshotId: 's1', verificationId: 'v1', outcome: 'failed' }],
  attemptCount: 1,
  needsRollbackVerification: false,
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const evidence = {
  evidenceId: 'ev-1', incidentId: INCIDENT_ID,
  healthCheckResults: [{ healthCheckId: 'button', status: 'fail' }],
  consoleErrors: ['TypeError: x'], domSnapshotRef: 'dom-1.html', screenshotPath: 'shot-1.png',
  capturedAt: '2025-01-01T00:00:01.000Z',
};

const verificationPayload = {
  verificationId: 'v1', incidentId: INCIDENT_ID, attemptNo: 1,
  checks: [{ checkId: 'c1', kind: 'health', coversComponent: 'button', outcome: 'fail', rawOutputRef: 'raw-1.txt' }],
  originalFailingCheckRan: true, overall: 'fail', startedAt: '2025-01-01T00:00:02.000Z', durationMs: 5,
};

async function buildLog(chaosEvents) {
  const log = createEventLog({ storage: memoryStorage() });
  for (const c of chaosEvents) {
    await log.append({
      type: c.type,
      component: 'poltergeist',
      incidentId: c.incidentId,
      payload: { scenarioId: c.scenarioId, injectionMethod: c.injectionMethod, rationale: c.rationale },
    });
  }
  await log.append({ type: 'verification', component: 'verification', incidentId: INCIDENT_ID, payload: verificationPayload });
  return log;
}

describe('Property 7: Information barrier', () => {
  it('Property 7: Information barrier - Exorcist input contains no chaos values', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chaosEventArb, { minLength: 1, maxLength: 8 }), async (chaosEvents) => {
        const log = await buildLog(chaosEvents);
        const input = await buildExorcistInput(incident, log, {
          redact,
          loadEvidence: () => [evidence],
          readApprovedSources: () => [{ path: 'public/button.js', content: 'export const ok = 1;' }],
        });
        const text = JSON.stringify(input);
        for (const c of chaosEvents) {
          expect(text).not.toContain(c.scenarioId);
          expect(text).not.toContain(c.injectionMethod);
          expect(text).not.toContain(c.rationale);
        }
        expect(text).not.toMatch(/chaos\./);
        // Evidence the Exorcist sees is the Incident's own Evidence.
        expect(input.evidence).toHaveLength(1);
        expect(input.priorAttempts).toHaveLength(1);
      }),
      { numRuns: 50 }
    );
  });

  it('Property 7: Information barrier - Monitor reads no chaos.* events', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(chaosEventArb, { minLength: 1, maxLength: 8 }), async (chaosEvents) => {
        const log = createEventLog({ storage: memoryStorage() });
        const monitor = log.monitorView();
        const nonChaos = log.nonChaosView();
        const monitorSeen = [];
        const nonChaosSeen = [];
        monitor.subscribe((e) => monitorSeen.push(e));
        nonChaos.subscribe((e) => nonChaosSeen.push(e));

        for (const c of chaosEvents) {
          await log.append({
            type: c.type, component: 'poltergeist', incidentId: c.incidentId,
            payload: { scenarioId: c.scenarioId, injectionMethod: c.injectionMethod, rationale: c.rationale },
          });
        }
        await log.append({ type: 'verification', component: 'verification', incidentId: INCIDENT_ID, payload: verificationPayload });

        expect(monitorSeen).toEqual([]);
        expect(await monitor.readAfter(0)).toEqual([]);
        expect(nonChaosSeen.some((e) => e.type.startsWith('chaos.'))).toBe(false);
        expect((await nonChaos.readAfter(0)).some((e) => e.type.startsWith('chaos.'))).toBe(false);
        // The log does hold the chaos events (the barrier is a view, not deletion).
        expect((await log.dashboardView().readAfter(0)).filter((e) => e.type.startsWith('chaos.')).length).toBe(chaosEvents.length);
      }),
      { numRuns: 50 }
    );
  });
});
