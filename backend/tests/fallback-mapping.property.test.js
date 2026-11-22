// Feature: poltergeist-exorcist-healing-system, Property 31: Fallback_Mapping determinism and isolation
// **Validates: Requirements 16.10**
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { matchFallbackMapping } from '../src/exorcist/fallback-mapping.js';

const { entries } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'fallback-mapping.json'), 'utf8'),
);

const ERRORS = {
  'fm-click-count-not-incremented': ['button', 'click handler produced "Clicked 0 times"'],
  'fm-layout-display-not-grid': ['layout', '.layout-section display is "inline"'],
  'fm-card-hidden-by-style': ['card', '.card is hidden'],
  'fm-items-endpoint-returns-error': ['dataPanel', 'mock API returned HTTP 500'],
  'fm-button-style-rule-missing': ['button', 'button style missing or hidden'],
  'fm-data-panel-wrong-endpoint': ['dataPanel', 'data panel did not render API data'],
};

const noise = fc.string({ maxLength: 20 });

// Evidence + sources that match a chosen entry, with random surrounding noise.
const inputArb = fc
  .record({
    entry: fc.constantFrom(...entries),
    pre: noise,
    post: noise,
    extraSources: fc.array(fc.record({ path: fc.string({ minLength: 1, maxLength: 10 }), content: noise }), { maxLength: 3 }),
    passChecks: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
    evidenceId: fc.string({ minLength: 1, maxLength: 10 }),
    incidentId: fc.string({ minLength: 1, maxLength: 10 }),
    matching: fc.boolean(),
  })
  .map((r) => {
    const [id, error] = ERRORS[r.entry.entryId];
    const content = r.matching ? `${r.pre}${r.entry.sourceCheck.contains}${r.post}` : r.pre;
    return {
      evidence: {
        evidenceId: r.evidenceId,
        incidentId: r.incidentId,
        healthCheckResults: [
          ...r.passChecks.map((c) => ({ healthCheckId: `p-${c}`, status: 'pass', error: null })),
          { healthCheckId: id, status: 'fail', error },
        ],
      },
      sources: [...r.extraSources, { path: r.entry.sourceCheck.file, content }],
    };
  });

describe('Property 31: Fallback_Mapping determinism and isolation', () => {
  it('(a) same Evidence and Approved_Files content yields identical output', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const first = matchFallbackMapping({ entries, ...input });
        const second = matchFallbackMapping({
          entries: structuredClone(entries),
          evidence: structuredClone(input.evidence),
          sources: structuredClone(input.sources),
        });
        expect(second).toEqual(first);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      }),
      { numRuns: 100 },
    );
  });

  it('(b) output is independent of scenario ID or chaos Event data', () => {
    fc.assert(
      fc.property(inputArb, fc.string(), fc.jsonValue(), (input, scenarioId, events) => {
        const baseline = matchFallbackMapping({ entries, ...input });
        const withExtras = matchFallbackMapping({
          entries,
          ...input,
          scenarioId,
          events,
          eventLog: events,
          evidence: { ...input.evidence, scenarioId, chaosEvents: events },
        });
        expect(withExtras).toEqual(baseline);
      }),
      { numRuns: 100 },
    );
  });

  it('(b) mapping entries contain no scenario IDs and the engine takes no such parameter', () => {
    const scenarioIds = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'scenario-catalog.json'), 'utf8'),
    ).scenarios.map((s) => s.scenarioId ?? s.id);
    const text = JSON.stringify(entries);
    for (const id of scenarioIds.filter(Boolean)) expect(text).not.toContain(`"${id}"`);
    for (const e of entries) {
      expect(Object.keys(e)).not.toContain('scenarioId');
      expect(text).not.toMatch(/"scenarioId"/);
    }
  });
});
