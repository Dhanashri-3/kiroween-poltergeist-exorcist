// Pure retry decision for the Orchestrator (Requirements 7.8, 8.6, 9.8, 12.1, 12.2, 12.5).
// No I/O, no imports. attemptCount is the number of attempts that have failed so far,
// including the failure being decided on. Rejections count as attempts like any other failure.

export const RETRY_BUDGET = 3;

export const FAILURE_CAUSES = Object.freeze([
  'failed_verification',
  'rejected_plan',
  'rejected_diagnosis',
  'apply_error',
]);

export const DECISIONS = Object.freeze({
  RETRY: 'retry',
  ROLLBACK_AND_ESCALATE: 'rollbackAndEscalate',
});

/**
 * @param {number} attemptCount integer >= 1: failed attempts so far, including this one
 * @param {string} cause one of FAILURE_CAUSES
 * @returns {'retry'|'rollbackAndEscalate'}
 * @throws {TypeError|RangeError} on an unknown cause or invalid attemptCount
 */
export function decideAfterFailure(attemptCount, cause) {
  if (!FAILURE_CAUSES.includes(cause)) {
    throw new TypeError(`Unknown failure cause: ${String(cause)}`);
  }
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount)) {
    throw new TypeError('attemptCount must be an integer');
  }
  if (attemptCount < 1) {
    throw new RangeError('attemptCount must be >= 1');
  }
  return attemptCount >= RETRY_BUDGET ? DECISIONS.ROLLBACK_AND_ESCALATE : DECISIONS.RETRY;
}
