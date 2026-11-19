// Task 2.3: baseline Verification_Result rule (Requirements 1.7, 1.8).
import { describe, it, expect } from 'vitest';
import { aggregateBaseline, buildBaselineVerificationResult } from '../src/verification/baseline.js';
import { validate } from '../src/contracts/index.js';

const COMPONENTS = ['button', 'layout', 'dataPanel', 'card'];
const check = (kind, coversComponent, outcome = 'pass') => ({
  checkId: `${kind}-${coversComponent}`,
  kind,
  coversComponent,
  outcome,
  rawOutputRef: `raw/${kind}-${coversComponent}.txt`,
});
const allPassing = () => [
  ...COMPONENTS.map((c) => check('health', c)),
  ...COMPONENTS.map((c) => check('vitest', c)),
  ...COMPONENTS.map((c) => check('playwright', c)),
];
const build = (checks) => buildBaselineVerificationResult({
  verificationId: 'baseline-1',
  startedAt: '2025-01-01T00:00:00.000Z',
  durationMs: 1234,
  checks,
});

describe('aggregateBaseline', () => {
  it('passes when every Health_Check and test passes', () => {
    expect(aggregateBaseline(allPassing())).toBe('pass');
  });

  it('fails when tests pass but one Health_Check fails', () => {
    const checks = allPassing();
    checks[0] = check('health', 'button', 'fail');
    expect(checks.filter((c) => c.kind !== 'health').every((c) => c.outcome === 'pass')).toBe(true);
    expect(aggregateBaseline(checks)).toBe('fail');
  });

  it('fails when several Health_Checks run and at least one fails', () => {
    const checks = allPassing();
    checks[2] = check('health', 'dataPanel', 'fail');
    expect(aggregateBaseline(checks)).toBe('fail');
  });

  it.each(['error', 'timeout'])('fails on a Health_Check outcome of %s even when tests pass', (outcome) => {
    const checks = allPassing();
    checks[3] = check('health', 'card', outcome);
    expect(aggregateBaseline(checks)).toBe('fail');
  });

  it.each(['fail', 'error', 'timeout'])('fails when a Vitest or Playwright check has outcome %s', (outcome) => {
    for (const kind of ['vitest', 'playwright']) {
      const checks = allPassing().map((c) => (c.kind === kind && c.coversComponent === 'layout' ? { ...c, outcome } : c));
      expect(aggregateBaseline(checks)).toBe('fail');
    }
  });

  it('fails closed on empty, missing, malformed or health-less input', () => {
    expect(aggregateBaseline([])).toBe('fail');
    expect(aggregateBaseline(undefined)).toBe('fail');
    expect(aggregateBaseline(null)).toBe('fail');
    expect(aggregateBaseline('pass')).toBe('fail');
    expect(aggregateBaseline([null])).toBe('fail');
    expect(aggregateBaseline([{ kind: 'health', outcome: 'PASS' }])).toBe('fail');
    expect(aggregateBaseline([{ kind: 'lint', outcome: 'pass' }])).toBe('fail');
    expect(aggregateBaseline(allPassing().filter((c) => c.kind !== 'health'))).toBe('fail');
  });
});

describe('buildBaselineVerificationResult', () => {
  it('builds a pass result that satisfies the VerificationResult contract', () => {
    const result = build(allPassing());
    expect(validate('VerificationResult', result)).toEqual({ valid: true, errors: [] });
    expect(result.overall).toBe('pass');
  });

  it('builds a contract-valid fail result when a Health_Check fails but all tests pass', () => {
    const checks = allPassing();
    checks[1] = check('health', 'layout', 'fail');
    const result = build(checks);
    expect(validate('VerificationResult', result).valid).toBe(true);
    expect(result.overall).toBe('fail');
  });

  it('builds a contract-valid fail result for empty checks', () => {
    const result = build([]);
    expect(validate('VerificationResult', result).valid).toBe(true);
    expect(result.overall).toBe('fail');
  });
});

describe('Playwright JSON report parsing and detection rule', () => {
  const report = (stats, suites = []) => JSON.stringify({ stats, suites });
  const failing = {
    suites: [{ title: 'testapp.spec.js', specs: [], suites: [
      { title: 'button', specs: [
        { title: 'is visible', tests: [{ status: 'expected' }] },
        { title: 'clicks', tests: [{ status: 'unexpected' }] },
      ] },
    ] }],
  };

  it('reads stats and names failed tests', async () => {
    const { parsePlaywrightJson } = await import('../src/verification/baseline.js');
    const c = parsePlaywrightJson(report({ expected: 1, unexpected: 1, flaky: 0, skipped: 0 }, failing.suites));
    expect(c).toMatchObject({ passed: 1, failed: 1, flaky: 0, skipped: 0 });
    expect(c.failedTests).toEqual(['testapp.spec.js › button › clicks']);
  });

  it('returns null for missing, malformed or stat-less reports', async () => {
    const { parsePlaywrightJson } = await import('../src/verification/baseline.js');
    for (const bad of [undefined, '', 'not json', '{}', '{"stats":{"expected":"1"}}']) {
      expect(parsePlaywrightJson(bad)).toBeNull();
    }
  });

  it('counts a detection only for a non-zero exit with at least one reporter-counted failure', async () => {
    const { isBrowserDetection } = await import('../src/verification/baseline.js');
    const counts = (failed) => ({ passed: 0, failed, flaky: 0, skipped: 0, failedTests: [] });
    expect(isBrowserDetection({ exitOk: false, counts: counts(1) })).toBe(true);
    expect(isBrowserDetection({ exitOk: false, counts: null })).toBe(false);
    expect(isBrowserDetection({ exitOk: false, counts: counts(0) })).toBe(false);
    expect(isBrowserDetection({ exitOk: true, counts: counts(1) })).toBe(false);
  });
});
