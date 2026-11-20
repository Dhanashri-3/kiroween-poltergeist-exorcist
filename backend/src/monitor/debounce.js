// Pure debounce for Health_Check results (Requirements 5.3, 5.5, 5.6, 5.8, 5.9, 11.9).
// No I/O, no imports. The Monitor never reads chaos.* Events or poltergeist/exorcist modules.

/** Result statuses accepted by step(). */
export const RESULT_PASS = 'pass';
export const RESULT_FAIL = 'fail';
export const RESULT_UNREACHABLE = 'unreachable';

/** Emission types produced by step(). */
export const EMIT_DETECTION = 'detection';
export const EMIT_TRANSIENT = 'transient';
export const EMIT_CLEARED = 'cleared';
export const EMIT_RECOVERY_CONFIRMED = 'recovery_confirmed';

export const FAILURES_TO_DETECT = 2;
export const PASSES_TO_CLEAR = 2;
export const PASSES_TO_CONFIRM_RECOVERY = 3;

/** Returns a fresh per-check rolling window. */
export function createWindow() {
  return {
    consecutiveFailures: 0,
    consecutivePasses: 0,
    failureRecorded: false, // a failure occurred and `cleared` has not been emitted yet
    availabilityReported: false, // current failure streak included an availability failure
    awaitingRecovery: false // a failure occurred and the 3-pass confirmation has not been emitted yet
  };
}

function normalize(result) {
  const status = typeof result === 'string' ? result : result && result.status;
  if (status === RESULT_PASS || status === RESULT_FAIL || status === RESULT_UNREACHABLE) return status;
  throw new TypeError(`Invalid health check result: ${String(status)}`);
}

/**
 * Advance the window by one Health_Check result.
 * @param {object|undefined} window previous window (undefined starts a fresh one)
 * @param {'pass'|'fail'|'unreachable'|{status: string}} result
 * @param {boolean} incidentOpen true while a non-terminal Incident references this check
 * @returns {{window: object, emit: Array<{type: string, kind?: string}>}}
 */
export function step(window, result, incidentOpen) {
  const prev = window ?? createWindow();
  const status = normalize(result);
  const emit = [];
  const next = { ...prev };

  if (status === RESULT_PASS) {
    const hadSingleFailure = prev.consecutiveFailures === 1;
    next.consecutiveFailures = 0;
    next.consecutivePasses = prev.consecutivePasses + 1;
    next.availabilityReported = false;

    if (hadSingleFailure && !prev.availabilityReported) {
      emit.push({ type: EMIT_TRANSIENT });
    }
    if (next.failureRecorded && next.consecutivePasses >= PASSES_TO_CLEAR && !incidentOpen) {
      emit.push({ type: EMIT_CLEARED });
      next.failureRecorded = false;
    }
    if (next.awaitingRecovery && next.consecutivePasses >= PASSES_TO_CONFIRM_RECOVERY) {
      emit.push({ type: EMIT_RECOVERY_CONFIRMED });
      next.awaitingRecovery = false;
    }
  } else {
    next.consecutiveFailures = prev.consecutiveFailures + 1;
    next.consecutivePasses = 0;
    next.failureRecorded = true;
    next.awaitingRecovery = true;

    if (status === RESULT_UNREACHABLE) {
      next.availabilityReported = true;
      emit.push({ type: EMIT_DETECTION, kind: 'availability' });
    } else if (next.consecutiveFailures === FAILURES_TO_DETECT && !prev.availabilityReported) {
      emit.push({ type: EMIT_DETECTION, kind: 'failure' });
    }
  }

  return { window: next, emit };
}
