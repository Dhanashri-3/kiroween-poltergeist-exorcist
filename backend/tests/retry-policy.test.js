import { describe, it, expect } from 'vitest';
import { decideAfterFailure, RETRY_BUDGET, FAILURE_CAUSES } from '../src/orchestrator/retry-policy.js';

describe('decideAfterFailure', () => {
  it('has a Retry_Budget of 3', () => {
    expect(RETRY_BUDGET).toBe(3);
  });

  it.each(FAILURE_CAUSES)('retries on attempts 1 and 2 and escalates from 3 for %s', (cause) => {
    expect(decideAfterFailure(1, cause)).toBe('retry');
    expect(decideAfterFailure(2, cause)).toBe('retry');
    expect(decideAfterFailure(3, cause)).toBe('rollbackAndEscalate');
    expect(decideAfterFailure(4, cause)).toBe('rollbackAndEscalate');
  });

  it('throws on an unknown cause', () => {
    expect(() => decideAfterFailure(1, 'bogus')).toThrow(TypeError);
    expect(() => decideAfterFailure(1)).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, '2', null, undefined])('throws on invalid attemptCount %s', (n) => {
    expect(() => decideAfterFailure(n, 'failed_verification')).toThrow();
  });
});
