// Baseline Verification_Result aggregation (Task 2.3, Requirements 1.7 and 1.8).
//
// Scope: only the baseline rule. The full Verification_Engine (command execution, verify(incident),
// timeouts, and the Requirement 11.6 "original failing check" rule) belongs to later tasks.
//
// Rule: the baseline overall is `pass` only when there is at least one Health_Check result and
// EVERY check (kind health, vitest or playwright) has outcome `pass`. A failing, errored or
// timed-out Health_Check therefore makes the result `fail` even when all tests pass. The function
// fails closed: missing input, an empty list, no Health_Check, an unknown kind or an unknown
// outcome all give `fail`. Pure and deterministic; imports nothing.

const KINDS = new Set(['health', 'vitest', 'playwright']);

/**
 * @param {Array<{kind: string, outcome: string}>} checkResults
 * @returns {'pass'|'fail'}
 */
export function aggregateBaseline(checkResults) {
  if (!Array.isArray(checkResults) || checkResults.length === 0) return 'fail';
  let sawHealth = false;
  for (const check of checkResults) {
    if (typeof check !== 'object' || check === null) return 'fail';
    if (!KINDS.has(check.kind)) return 'fail';
    if (check.outcome !== 'pass') return 'fail';
    if (check.kind === 'health') sawHealth = true;
  }
  return sawHealth ? 'pass' : 'fail';
}

/**
 * Read counts from Playwright's JSON reporter output (text of the report file).
 * Returns null when the report is missing, unparsable or lacks stats, so callers can treat a
 * run with no usable report (server/config error) as NOT a detection.
 * @param {string|undefined} jsonText
 * @returns {{passed:number, failed:number, flaky:number, skipped:number, failedTests:string[]}|null}
 */
export function parsePlaywrightJson(jsonText) {
  let report;
  try { report = JSON.parse(jsonText); } catch { return null; }
  const s = report && report.stats;
  if (!s || ![s.expected, s.unexpected, s.flaky, s.skipped].every(Number.isInteger)) return null;
  const failedTests = [];
  const walk = (suite, titles) => {
    const here = suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      const bad = (spec.tests || []).some((t) => t.status === 'unexpected');
      if (bad) failedTests.push([...here, spec.title].join(' › '));
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const suite of report.suites || []) walk(suite, []);
  return { passed: s.expected, failed: s.unexpected, flaky: s.flaky, skipped: s.skipped, failedTests };
}

/**
 * A run counts as a detection only when the reporter counted at least one failed test that
 * actually executed and the process exited non-zero. A missing report never detects.
 */
export function isBrowserDetection({ exitOk, counts }) {
  return !exitOk && counts !== null && counts.failed >= 1;
}

/**
 * Build a baseline Verification_Result (shape of the Verification_Result contract). The baseline
 * has no incident, so incidentId is the fixed marker 'baseline' and attemptNo is 1.
 * @param {{verificationId: string, startedAt: string, durationMs: number,
 *          checks: Array<{checkId: string, kind: string, coversComponent: string,
 *                         outcome: string, rawOutputRef: string}>}} input
 */
export function buildBaselineVerificationResult({ verificationId, startedAt, durationMs, checks }) {
  return {
    verificationId,
    incidentId: 'baseline',
    attemptNo: 1,
    checks,
    originalFailingCheckRan: false,
    overall: aggregateBaseline(checks),
    startedAt,
    durationMs,
  };
}
