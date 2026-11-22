// Task 10.1: Exorcist input builder (Requirements 3.8, 7.1, 7.4, 17.3).
import { describe, it, expect } from 'vitest';
import { buildExorcistInput, isDenylistedSourcePath } from '../src/exorcist/input-builder.js';
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
const SCENARIO_ID = 'scn-secret-button-removal';
const INJECTION = 'regex-delete-handler';
const FAKE_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';

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
  // Smuggled fields that must never reach the output.
  scenarioId: SCENARIO_ID,
  injectionMethod: INJECTION,
};

const evidence = {
  evidenceId: 'ev-1', incidentId: INCIDENT_ID, healthCheckResults: [{ healthCheckId: 'button', status: 'fail', error: `boom token=${FAKE_KEY}` }],
  consoleErrors: ['TypeError: x'], domSnapshotRef: 'dom-1.html', screenshotPath: 'shot-1.png', capturedAt: '2025-01-01T00:00:01.000Z',
  scenarioId: SCENARIO_ID,
};

async function makeLog() {
  const log = createEventLog({ storage: memoryStorage() });
  await log.append({ type: 'chaos.selection', component: 'poltergeist', incidentId: INCIDENT_ID, payload: { scenarioId: SCENARIO_ID, rationale: 'because' } });
  await log.append({ type: 'chaos.injection', component: 'scenario-engine', incidentId: INCIDENT_ID, payload: { scenarioId: SCENARIO_ID, injectionMethod: INJECTION } });
  await log.append({
    type: 'verification', component: 'verification', incidentId: INCIDENT_ID,
    payload: {
      verificationId: 'v1', incidentId: INCIDENT_ID, attemptNo: 1,
      checks: [{ checkId: 'c1', kind: 'health', coversComponent: 'button', outcome: 'fail', rawOutputRef: 'raw-1.txt', scenarioId: SCENARIO_ID }],
      originalFailingCheckRan: true, overall: 'fail', startedAt: '2025-01-01T00:00:02.000Z', durationMs: 5,
    },
  });
  await log.append({ type: 'verification', component: 'verification', incidentId: 'other', payload: { verificationId: 'vX', incidentId: 'other', attemptNo: 1, overall: 'fail' } });
  return log;
}

const deps = {
  redact,
  loadEvidence: () => [evidence],
  readApprovedSources: () => [
    { path: 'public/button.js', content: `const apiKey = "${FAKE_KEY}";\nexport const ok = 1;` },
    { path: '.env', content: 'SECRET=hunter2hunter2' },
    { path: '.env.local', content: 'TOKEN=abc' },
    { path: '.git/config', content: '[core]' },
    { path: 'sub\\.git\\HEAD', content: 'ref' },
  ],
};

describe('buildExorcistInput', () => {
  it('contains no scenario ID, injection method or chaos data', async () => {
    const out = await buildExorcistInput(incident, await makeLog(), deps);
    const text = JSON.stringify(out);
    expect(text).not.toContain(SCENARIO_ID);
    expect(text).not.toContain(INJECTION);
    expect(text).not.toContain('because');
    expect(text).not.toContain('chaos');
    expect(Object.keys(out).sort()).toEqual(['component', 'evidence', 'incidentId', 'priorAttempts', 'sources']);
  });

  it('redacts secrets in evidence and source content', async () => {
    const out = await buildExorcistInput(incident, await makeLog(), deps);
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.sources[0].content).toContain('[REDACTED]');
    expect(out.evidence[0].healthCheckResults[0].error).toContain('[REDACTED]');
  });

  it('excludes .env* and .git content', async () => {
    const out = await buildExorcistInput(incident, await makeLog(), deps);
    expect(out.sources.map((s) => s.path)).toEqual(['public/button.js']);
    const text = JSON.stringify(out);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('[core]');
  });

  it('returns only the incident own failed attempts with plan and verification', async () => {
    const out = await buildExorcistInput(incident, await makeLog(), deps);
    expect(out.priorAttempts).toHaveLength(1);
    const [a] = out.priorAttempts;
    expect(a.attemptNo).toBe(1);
    expect(a.plan.targetFile).toBe('public/button.js');
    expect(a.verification.verificationId).toBe('v1');
    expect(a.verification.checks[0]).not.toHaveProperty('scenarioId');
    expect(JSON.stringify(out)).not.toContain('vX');
  });

  it('is read-only and requires a redactor', async () => {
    const out = await buildExorcistInput(incident, await makeLog(), deps);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.sources[0])).toBe(true);
    await expect(buildExorcistInput(incident, await makeLog(), {})).rejects.toThrow(TypeError);
  });

  it('classifies denylisted paths', () => {
    expect(isDenylistedSourcePath('.env.production')).toBe(true);
    expect(isDenylistedSourcePath('a/.git/config')).toBe(true);
    expect(isDenylistedSourcePath('public/button.js')).toBe(false);
  });
});
