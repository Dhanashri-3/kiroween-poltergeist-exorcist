import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluate, verifyApproval, RULE_IDS } from '../src/safety-gate/index.js';

// Feature: poltergeist-exorcist-healing-system, Property 14: Safety_Gate determinism
// **Validates: Requirements 9.10**

const PAIRS = [
  { actionType: 'replace_text', file: 'public/button.js' },
  { actionType: 'replace_style_rule', file: 'public/button.css' },
  { actionType: 'replace_mock_api_handler', file: 'mock-api.js' },
];
const buildConfig = (maxes) => ({
  approvedFiles: PAIRS.map((p) => p.file),
  actionAllowlist: PAIRS.map((p, i) => ({ actionType: p.actionType, allowedFiles: [p.file], maxChangedLines: maxes[i] })),
});

const text = fc.array(fc.constantFrom('alpha', 'beta', 'width', 'x1', 'rm -rf /', "fetch('https://e.com')"), { minLength: 1, maxLength: 60 }).map((w) => w.join('\n'));
const arbMaxes = fc.tuple(...PAIRS.map(() => fc.integer({ min: 1, max: 60 })));

// Mix of plans likely to be approved, plans likely to be rejected, and arbitrary values.
const arbPlan = fc.oneof(
  fc.anything(),
  fc.record(
    {
      incidentId: fc.string(),
      actionType: fc.oneof(fc.constantFrom(...PAIRS.map((p) => p.actionType)), fc.string()),
      targetFile: fc.oneof(fc.constantFrom(...PAIRS.map((p) => p.file), '../x.js', '.env'), fc.string()),
      change: fc.oneof(fc.record({ find: text, replace: text }), fc.anything()),
      rationale: fc.string(),
    },
    { requiredKeys: [] },
  ),
  fc.nat(PAIRS.length - 1).chain((i) =>
    fc.record({ find: fc.constantFrom('a', 'a\nb'), replace: fc.constantFrom('c', 'c\nd') }).map((change) => ({
      incidentId: 'inc-1', actionType: PAIRS[i].actionType, targetFile: PAIRS[i].file, change, rationale: 'Fix.',
    })),
  ),
);

describe('Property 14: Safety_Gate determinism', () => {
  it('returns the same decision (rules, reasons, outcome, approval token/plan hash) for the same plan and config', () => {
    fc.assert(
      fc.property(arbPlan, arbMaxes, fc.integer({ min: 2, max: 5 }), (plan, maxes, repeats) => {
        const config = buildConfig(maxes);
        const first = evaluate(plan, config);
        expect(first.rules.map((r) => r.id)).toEqual(RULE_IDS);
        for (let i = 1; i < repeats; i++) {
          const next = evaluate(plan, config);
          expect(next.approved).toBe(first.approved);
          expect(next.rules).toEqual(first.rules);
          expect(next.reasons).toEqual(first.reasons);
          expect(next.approval).toEqual(first.approval);
          expect(next).toEqual(first);
        }
        if (first.approved) {
          expect(first.approval).not.toBeNull();
          expect(verifyApproval(plan, first.approval)).toBe(true);
        } else {
          expect(first.approval).toBeNull();
        }
      }),
      { numRuns: 300 },
    );
  });
});
