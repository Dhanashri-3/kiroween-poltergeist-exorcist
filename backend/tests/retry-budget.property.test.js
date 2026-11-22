import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  decideAfterFailure,
  FAILURE_CAUSES,
  RETRY_BUDGET,
} from '../src/orchestrator/retry-policy.js';

// Feature: poltergeist-exorcist-healing-system, Property 20: Retry budget bound
// **Validates: Requirements 12.1, 12.2, 12.5, 12.7**

const cause = fc.constantFrom(...FAILURE_CAUSES);

describe('Property 20: Retry budget bound', () => {
  it('uses a Retry_Budget of 3', () => {
    expect(RETRY_BUDGET).toBe(3);
  });

  it('retries while attempts < 3 and rollbackAndEscalate once attempts >= 3', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), cause, (attempts, c) => {
        const decision = decideAfterFailure(attempts, c);
        expect(decision).toBe(attempts < 3 ? 'retry' : 'rollbackAndEscalate');
      }),
      { numRuns: 200 },
    );
  });

  it('never performs more than 3 attempts in any simulated failure sequence', () => {
    fc.assert(
      fc.property(fc.array(cause, { minLength: 1, maxLength: 20 }), (causes) => {
        let attempts = 0;
        let escalated = false;
        for (const c of causes) {
          if (escalated) break; // no automated repair after escalation
          attempts += 1;
          if (decideAfterFailure(attempts, c) === 'rollbackAndEscalate') escalated = true;
        }
        expect(attempts).toBeLessThanOrEqual(3);
        expect(escalated).toBe(causes.length >= 3);
        if (causes.length >= 3) expect(attempts).toBe(3);
      }),
      { numRuns: 200 },
    );
  });
});
