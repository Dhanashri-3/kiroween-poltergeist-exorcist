import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aggregate } from '../src/verification/verification-engine.js';

// Feature: poltergeist-exorcist-healing-system, Property 18: Verification aggregation
// **Validates: Requirements 11.3, 11.4, 11.5, 11.6**

const COMPONENTS = ['c1', 'c2', 'c3', 'c4'];
const outcome = fc.constantFrom('pass', 'fail', 'error', 'timeout');
const allPass = fc.constant('pass');

const check = (outcomeArb) =>
  fc.record({
    checkId: fc.string({ minLength: 1 }),
    kind: fc.constantFrom('health', 'vitest', 'playwright'),
    coversComponent: fc.constantFrom(...COMPONENTS),
    outcome: outcomeArb,
    rawOutputRef: fc.string({ minLength: 1 }),
  });

const arbEvidence = fc
  .array(
    fc.record({ healthCheckId: fc.constantFrom(...COMPONENTS), status: fc.constantFrom('pass', 'fail') }),
    { maxLength: 6 },
  )
  .map((healthCheckResults) => ({ healthCheckResults }));

const failedIds = (evidence) =>
  new Set(evidence.healthCheckResults.filter((h) => h.status === 'fail').map((h) => h.healthCheckId));

// Independent oracle for the property statement.
const expected = (checks, evidence) => {
  const failed = failedIds(evidence);
  const everyPassed = checks.length > 0 && checks.every((c) => c.outcome === 'pass');
  const noErrOrTimeout = checks.every((c) => c.outcome !== 'error' && c.outcome !== 'timeout');
  const failingRan = checks.some((c) => failed.has(c.coversComponent));
  return everyPassed && noErrOrTimeout && failingRan ? 'pass' : 'fail';
};

describe('Property 18: Verification aggregation', () => {
  it('is pass iff all checks pass, none error or time out, and an originally failing check ran', () => {
    fc.assert(
      fc.property(fc.array(check(outcome), { maxLength: 6 }), arbEvidence, (checks, evidence) => {
        expect(aggregate(checks, evidence)).toBe(expected(checks, evidence));
      }),
      { numRuns: 200 },
    );
  });

  it('is pass when every check passes and one covers a component that failed originally', () => {
    fc.assert(
      fc.property(
        fc.array(check(allPass), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...COMPONENTS),
        (checks, comp) => {
          const withCover = [...checks, { ...checks[0], coversComponent: comp }];
          const evidence = { healthCheckResults: [{ healthCheckId: comp, status: 'fail' }] };
          expect(aggregate(withCover, evidence)).toBe('pass');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is fail when any check fails, errors or times out, even if the original failing check ran', () => {
    fc.assert(
      fc.property(
        fc.array(check(allPass), { maxLength: 4 }),
        fc.constantFrom('fail', 'error', 'timeout'),
        fc.constantFrom(...COMPONENTS),
        (checks, bad, comp) => {
          const all = [...checks, { checkId: 'x', kind: 'health', coversComponent: comp, outcome: bad, rawOutputRef: 'r' }];
          const evidence = { healthCheckResults: [{ healthCheckId: comp, status: 'fail' }] };
          expect(aggregate(all, evidence)).toBe('fail');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is fail when all checks pass but none covers a component that failed in the Evidence', () => {
    fc.assert(
      fc.property(fc.array(check(allPass), { minLength: 1, maxLength: 5 }), (checks) => {
        const evidence = { healthCheckResults: [{ healthCheckId: 'other-component', status: 'fail' }] };
        expect(aggregate(checks, evidence)).toBe('fail');
        expect(aggregate(checks, { healthCheckResults: [] })).toBe('fail');
      }),
      { numRuns: 100 },
    );
  });
});
