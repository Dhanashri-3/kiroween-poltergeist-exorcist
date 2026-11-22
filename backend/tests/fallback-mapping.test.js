import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { matchFallbackMapping } from '../src/exorcist/fallback-mapping.js';
import { validate } from '../src/contracts/index.js';

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', name), 'utf8'));
const { entries } = readJson('fallback-mapping.json');
const catalog = readJson('scenario-catalog.json').scenarios;

// Health check error text per component/scenario, as produced by testapp/health.js.
const ERRORS = {
  'button-failure': { id: 'button', error: 'click handler produced "Clicked 0 times"' },
  'layout-corruption': { id: 'layout', error: '.layout-section display is "inline"' },
  'component-disappearance': { id: 'card', error: '.card is hidden' },
  'api-failure': { id: 'dataPanel', error: 'mock API returned HTTP 500' },
  'styling-failure': { id: 'button', error: 'button style missing or hidden' },
  'loading-failure': { id: 'dataPanel', error: 'data panel did not render API data' },
};

// Minimal healthy file content: contains each step's `find` text so the injection applies.
const injectedSources = (scenario) => {
  const files = new Map();
  for (const step of scenario.injection.steps) {
    files.set(step.file, `/* start */ ${step.find} /* end */`);
  }
  for (const step of scenario.injection.steps) {
    files.set(step.file, files.get(step.file).replace(step.find, step.replace));
  }
  return [...files].map(([p, content]) => ({ path: p, content }));
};

const evidenceFor = (id, error, extra = {}) => ({
  evidenceId: 'ev-1',
  incidentId: 'inc-1',
  healthCheckResults: [
    { healthCheckId: 'app', status: 'pass', error: null },
    { healthCheckId: id, status: 'fail', error },
  ],
  consoleErrors: [],
  domSnapshotRef: 'dom.html',
  screenshotPath: 'shot.png',
  capturedAt: '2025-01-01T00:00:00.000Z',
  ...extra,
});

describe('Fallback_Mapping engine', () => {
  it.each(catalog.map((s) => [s.scenarioId, s]))('maps %s evidence to its rule_based Diagnosis and Repair_Plan', (scenarioId, scenario) => {
    const { id, error } = ERRORS[scenarioId];
    const out = matchFallbackMapping({ entries, evidence: evidenceFor(id, error), sources: injectedSources(scenario) });

    expect(out.matched).toBe(true);
    expect(out.diagnosis.status).toBe('rule_based');
    expect(out.diagnosis.component).toBe(scenario.targetComponent);
    expect(out.diagnosis.suspectedFile).toBe(scenario.targetFiles[0]);
    expect(out.diagnosis.evidenceUsed).toEqual(['ev-1']);
    expect(out.plan).toEqual({
      incidentId: 'inc-1',
      ...scenario.expectedRepairAction,
      rationale: expect.any(String),
    });
    expect(validate('Diagnosis', out.diagnosis).valid).toBe(true);
    expect(validate('RepairPlan', out.plan).valid).toBe(true);
  });

  it('selects the style entry, not the click entry, for the second button scenario', () => {
    const styling = catalog.find((s) => s.scenarioId === 'styling-failure');
    const out = matchFallbackMapping({
      entries,
      evidence: evidenceFor('button', ERRORS['styling-failure'].error),
      sources: injectedSources(styling),
    });
    expect(out.entryId).toBe('fm-button-style-rule-missing');
  });

  describe('no match', () => {
    const button = catalog[0];
    const good = () => ({ entries, evidence: evidenceFor('button', ERRORS['button-failure'].error), sources: injectedSources(button) });

    it('returns no_match for an unknown error text', () => {
      const input = good();
      input.evidence = evidenceFor('button', 'something unexpected');
      expect(matchFallbackMapping(input)).toEqual({ matched: false, reason: 'no_match' });
    });

    it('returns no_match when the source check text is absent from the Approved_Files', () => {
      const input = good();
      input.sources = [{ path: 'public/button.js', content: 'count = nextCount(count);' }];
      expect(matchFallbackMapping(input)).toEqual({ matched: false, reason: 'no_match' });
    });

    it('returns no_match when the file is not among the sources', () => {
      const input = good();
      input.sources = [];
      expect(matchFallbackMapping(input).matched).toBe(false);
    });

    it('returns no_match when the matching health check is passing', () => {
      const input = good();
      input.evidence.healthCheckResults = [{ healthCheckId: 'button', status: 'pass', error: null }];
      expect(matchFallbackMapping(input).matched).toBe(false);
    });

    it('reports missing evidence and missing entries', () => {
      expect(matchFallbackMapping({ entries, sources: [] }).reason).toBe('no_evidence');
      expect(matchFallbackMapping({ ...good(), entries: [] }).reason).toBe('no_entries');
    });
  });

  describe('determinism and isolation', () => {
    it('returns identical output on repeated evaluation', () => {
      const s = catalog[3];
      const input = { entries, evidence: evidenceFor('dataPanel', ERRORS['api-failure'].error), sources: injectedSources(s) };
      const first = matchFallbackMapping(input);
      for (let i = 0; i < 5; i += 1) expect(matchFallbackMapping(input)).toEqual(first);
    });

    it('does not mutate its inputs', () => {
      const s = catalog[0];
      const input = { entries, evidence: evidenceFor('button', ERRORS['button-failure'].error), sources: injectedSources(s) };
      const before = structuredClone(input);
      const out = matchFallbackMapping(input);
      out.plan.change.find = 'changed';
      expect(input).toEqual(before);
    });

    it('ignores extra scenario or chaos data carried on the inputs', () => {
      const s = catalog[1];
      const base = { entries, evidence: evidenceFor('layout', ERRORS['layout-corruption'].error), sources: injectedSources(s) };
      const noisy = {
        ...base,
        scenarioId: 'button-failure',
        events: [{ type: 'chaos.selection', payload: { scenarioId: 'api-failure' } }],
        evidence: { ...base.evidence, scenarioId: 'api-failure' },
      };
      expect(matchFallbackMapping(noisy)).toEqual(matchFallbackMapping(base));
    });

    it('contains no scenario ID in the mapping entries', () => {
      const text = JSON.stringify(entries).toLowerCase();
      for (const s of catalog) expect(text).not.toContain(s.scenarioId);
    });
  });
});
