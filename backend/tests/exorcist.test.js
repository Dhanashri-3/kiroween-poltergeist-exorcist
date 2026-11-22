import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExorcist, createStubAiClient, readAiCredential, AI_CREDENTIAL_ENV_VAR,
} from '../src/exorcist/exorcist.js';

const { entries } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'fallback-mapping.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'scenario-catalog.json'), 'utf8')).scenarios;

const button = catalog.find((s) => s.scenarioId === 'button-failure');
const sources = (() => {
  const files = new Map();
  for (const s of button.injection.steps) files.set(s.file, `/* */ ${s.find} /* */`);
  for (const s of button.injection.steps) files.set(s.file, files.get(s.file).replace(s.find, s.replace));
  return [...files].map(([p, content]) => ({ path: p, content }));
})();

const evidence = (error = 'click handler produced "Clicked 0 times"') => ({
  evidenceId: 'ev-1',
  incidentId: 'inc-1',
  healthCheckResults: [{ healthCheckId: 'button', status: 'fail', error }],
  consoleErrors: [],
  domSnapshotRef: 'd.html',
  screenshotPath: 's.png',
  capturedAt: '2025-01-01T00:00:00.000Z',
});

const input = (extra = {}) => ({ incidentId: 'inc-1', component: 'button', evidence: [evidence()], sources, priorAttempts: [], ...extra });

const aiDiagnosis = { incidentId: 'inc-1', component: 'button', suspectedFile: 'a.js', location: 'l', rootCause: 'r', confidence: 0.9, evidenceUsed: [], status: 'ok' };
const aiPlan = (n) => ({ incidentId: 'inc-1', actionType: 'replace_text', targetFile: 'a.js', change: { find: 'x', replace: `y${n}` }, rationale: 'r' });

const fakeClient = (over = {}) => {
  const calls = { diagnose: 0, plan: [] };
  return {
    calls,
    isAvailable: () => true,
    diagnose: async () => { calls.diagnose += 1; return aiDiagnosis; },
    plan: async (args) => { calls.plan.push(args); return aiPlan(1); },
    ...over,
  };
};

describe('Exorcist source selection', () => {
  it('uses the AI service while it is available, not the mapping (16.9)', async () => {
    const client = fakeClient();
    const ex = createExorcist({ aiClient: client, fallbackEntries: entries });
    const d = await ex.diagnose(input());
    expect(d).toMatchObject({ outcome: 'ok', source: 'ai', diagnosis: aiDiagnosis });
    const p = await ex.plan(d.diagnosis, input());
    expect(p).toMatchObject({ outcome: 'ok', source: 'ai', identicalToFailed: false });
  });

  it('uses the mapping and marks rule_based when the stub AI is unavailable (16.6, 16.8)', async () => {
    const ex = createExorcist({ aiClient: createStubAiClient(), fallbackEntries: entries });
    const d = await ex.diagnose(input());
    expect(d.outcome).toBe('ok');
    expect(d.source).toBe('rule_based');
    expect(d.diagnosis.status).toBe('rule_based');
    const p = await ex.plan(d.diagnosis, input());
    expect(p).toMatchObject({ outcome: 'ok', source: 'rule_based' });
    expect(p.plan.targetFile).toBe(button.expectedRepairAction.targetFile);
  });

  it('falls back to the mapping when the AI call throws', async () => {
    const ex = createExorcist({ aiClient: fakeClient({ diagnose: async () => { throw new Error('503'); } }), fallbackEntries: entries });
    expect((await ex.diagnose(input())).source).toBe('rule_based');
  });

  it('returns no_source when the AI is unavailable and nothing matches (16.5)', async () => {
    const ex = createExorcist({ fallbackEntries: entries });
    const unmatched = input({ evidence: [evidence('something unknown')] });
    expect(await ex.diagnose(unmatched)).toEqual({ outcome: 'no_source', reason: 'ai_unavailable_no_mapping_match' });
    expect((await ex.plan({ status: 'ok' }, unmatched)).outcome).toBe('no_source');
  });

  it('defaults to the stub client and an empty mapping', async () => {
    expect((await createExorcist().diagnose(input())).outcome).toBe('no_source');
  });
});

describe('Exorcist retries (8.5)', () => {
  it('passes the failed plan and its Verification_Result to the AI client', async () => {
    const client = fakeClient();
    const prior = [{ attemptNo: 1, plan: aiPlan(0), verification: { overall: 'fail', checks: [] } }];
    await createExorcist({ aiClient: client }).plan(aiDiagnosis, input({ priorAttempts: prior }));
    expect(client.calls.plan[0].priorAttempts).toEqual(prior);
  });

  it('flags an AI plan identical to a failed plan', async () => {
    const prior = [{ attemptNo: 1, plan: aiPlan(1) }];
    const out = await createExorcist({ aiClient: fakeClient() }).plan(aiDiagnosis, input({ priorAttempts: prior }));
    expect(out.identicalToFailed).toBe(true);
  });

  it('does not offer the same mapping plan again after it failed', async () => {
    const ex = createExorcist({ fallbackEntries: entries });
    const d = await ex.diagnose(input());
    const first = await ex.plan(d.diagnosis, input());
    const retry = await ex.plan(d.diagnosis, input({ priorAttempts: [{ attemptNo: 1, plan: first.plan }] }));
    expect(retry).toEqual({ outcome: 'no_source', reason: 'no_different_plan' });
  });
});

describe('AI credential (13.9)', () => {
  it('reads the credential only from the environment', () => {
    expect(readAiCredential({ [AI_CREDENTIAL_ENV_VAR]: 'k' })).toBe('k');
    expect(readAiCredential({})).toBeUndefined();
    expect(readAiCredential({ [AI_CREDENTIAL_ENV_VAR]: '  ' })).toBeUndefined();
  });

  it('module has no file-write, shell or network imports (7.3)', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'exorcist', 'exorcist.js'), 'utf8');
    expect(src).not.toMatch(/from\s+'node:(fs|child_process|http|https|net)'|require\(/);
  });
});
