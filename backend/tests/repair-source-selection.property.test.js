// Feature: poltergeist-exorcist-healing-system, Property 30: Repair source selection
// **Validates: Requirements 16.5, 16.6, 16.8, 16.9**
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { createExorcist } from '../src/exorcist/exorcist.js';

const { entries } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'fallback-mapping.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'scenario-catalog.json'), 'utf8')).scenarios;

const sourcesFor = (scenario) => {
  const files = new Map();
  for (const s of scenario.injection.steps) files.set(s.file, `/* */ ${s.find} /* */`);
  for (const s of scenario.injection.steps) files.set(s.file, files.get(s.file).replace(s.find, s.replace));
  return [...files].map(([p, content]) => ({ path: p, content }));
};

const button = catalog.find((s) => s.scenarioId === 'button-failure');
const buttonSources = sourcesFor(button);

const evidence = (error) => ({
  evidenceId: 'ev-1',
  incidentId: 'inc-1',
  healthCheckResults: [{ healthCheckId: 'button', status: 'fail', error }],
  consoleErrors: [],
  domSnapshotRef: 'd.html',
  screenshotPath: 's.png',
  capturedAt: '2025-01-01T00:00:00.000Z',
});
const matchingInput = () => ({
  incidentId: 'inc-1', component: 'button', evidence: [evidence('click handler produced "Clicked 0 times"')],
  sources: buttonSources, priorAttempts: [],
});
const nonMatchingInput = (text) => ({
  incidentId: 'inc-1', component: 'button', evidence: [evidence(`zzz ${text}`)], sources: [], priorAttempts: [],
});

const aiDiagnosis = { incidentId: 'inc-1', component: 'button', suspectedFile: 'a.js', location: 'l', rootCause: 'r', confidence: 0.9, evidenceUsed: [], status: 'ok' };
const aiPlan = { incidentId: 'inc-1', actionType: 'replace_text', targetFile: 'a.js', change: { find: 'x', replace: 'y' }, rationale: 'r' };

const client = (available, how) => ({
  isAvailable: how === 'sync' ? () => available : async () => available,
  diagnose: async () => { if (!available) throw new Error('down'); return aiDiagnosis; },
  plan: async () => { if (!available) throw new Error('down'); return aiPlan; },
});

const availability = fc.constantFrom('sync', 'async');
const junk = fc.string({ maxLength: 20 }).filter((s) => !/click|button|clicked/i.test(s));

describe('Property 30: Repair source selection', () => {
  it('uses the AI service whenever it is available, even if the mapping would match (16.9)', async () => {
    await fc.assert(fc.asyncProperty(availability, fc.boolean(), async (how, matches) => {
      const ex = createExorcist({ aiClient: client(true, how), fallbackEntries: entries });
      const input = matches ? matchingInput() : nonMatchingInput('x');
      const d = await ex.diagnose(input);
      expect(d).toMatchObject({ outcome: 'ok', source: 'ai', diagnosis: aiDiagnosis });
      const p = await ex.plan(d.diagnosis, input);
      expect(p).toMatchObject({ outcome: 'ok', source: 'ai' });
    }), { numRuns: 50 });
  });

  it('uses a matching mapping entry and marks the Diagnosis rule_based when the AI is unavailable (16.6, 16.8)', async () => {
    await fc.assert(fc.asyncProperty(availability, async (how) => {
      const ex = createExorcist({ aiClient: client(false, how), fallbackEntries: entries });
      const d = await ex.diagnose(matchingInput());
      expect(d.outcome).toBe('ok');
      expect(d.source).toBe('rule_based');
      expect(d.diagnosis.status).toBe('rule_based');
      const p = await ex.plan(d.diagnosis, matchingInput());
      expect(p).toMatchObject({ outcome: 'ok', source: 'rule_based' });
    }), { numRuns: 20 });
  });

  it('returns no_source when the AI is unavailable and nothing matches (16.5)', async () => {
    await fc.assert(fc.asyncProperty(availability, junk, async (how, text) => {
      const ex = createExorcist({ aiClient: client(false, how), fallbackEntries: entries });
      const input = nonMatchingInput(text);
      expect(await ex.diagnose(input)).toEqual({ outcome: 'no_source', reason: 'ai_unavailable_no_mapping_match' });
      expect((await ex.plan({ status: 'ok' }, input)).outcome).toBe('no_source');
    }), { numRuns: 50 });
  });
});
