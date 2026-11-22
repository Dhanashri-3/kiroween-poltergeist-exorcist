import { describe, it, expect } from 'vitest';
import { validateDiagnosis, validateRepairPlan, isIdenticalToFailedPlan } from '../src/exorcist/validators.js';

const diagnosis = (over = {}) => ({
  incidentId: 'i1',
  component: 'button',
  suspectedFile: 'public/button.js',
  location: 'line 4',
  rootCause: 'label replaced',
  confidence: 0.9,
  evidenceUsed: ['e1'],
  status: 'ok',
  ...over,
});

const allowlist = [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 }];
const plan = (over = {}) => ({
  incidentId: 'i1',
  actionType: 'replace_text',
  targetFile: 'public/button.js',
  change: { find: 'a', replace: 'b' },
  rationale: 'restore label',
  ...over,
});

describe('validateDiagnosis', () => {
  it('accepts a valid confident diagnosis', () => {
    const r = validateDiagnosis(diagnosis());
    expect(r.outcome).toBe('accepted');
    expect(r.countsAsAttempt).toBe(false);
  });
  it.each([undefined, null])('treats a missing diagnosis (%s) as inconclusive', (v) => {
    const r = validateDiagnosis(v);
    expect(r.outcome).toBe('inconclusive');
    expect(r.valid).toBe(false);
  });
  it('treats confidence below 0.5 as inconclusive and 0.5 as accepted', () => {
    expect(validateDiagnosis(diagnosis({ confidence: 0.49 })).outcome).toBe('inconclusive');
    expect(validateDiagnosis(diagnosis({ confidence: 0.5 })).outcome).toBe('accepted');
  });
  it('treats status inconclusive as inconclusive', () => {
    expect(validateDiagnosis(diagnosis({ status: 'inconclusive' })).outcome).toBe('inconclusive');
  });
  it.each([{ confidence: 1.1 }, { confidence: -0.1 }, { evidenceUsed: 'e1' }, { status: 'maybe' }])(
    'rejects schema-invalid diagnosis %j and counts an attempt',
    (over) => {
      const r = validateDiagnosis(diagnosis(over));
      expect(r.outcome).toBe('rejected');
      expect(r.countsAsAttempt).toBe(true);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  );
});

describe('validateRepairPlan', () => {
  it('accepts a well-formed allowlisted plan', () => {
    const r = validateRepairPlan(plan(), { allowlist });
    expect(r).toMatchObject({ valid: true, identicalToFailed: false, countsAsAttempt: false });
  });
  it('rejects an action outside the allowlist', () => {
    const r = validateRepairPlan(plan({ actionType: 'run_shell' }), { allowlist });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'notAllowlisted')).toBe(true);
  });
  it('rejects a top-level command field', () => {
    const r = validateRepairPlan({ ...plan(), command: 'rm -rf /' }, { allowlist });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === 'noCommand')).toBe(true);
  });
  it('rejects a command field nested in change', () => {
    const r = validateRepairPlan(plan({ change: { find: 'a', replace: 'b', shell: 'ls' } }), { allowlist });
    expect(r.errors.some((e) => e.keyword === 'noCommand')).toBe(true);
  });
  it('rejects a non-structured change and multiple targets', () => {
    expect(validateRepairPlan(plan({ change: 'sed -i s/a/b/' }), { allowlist }).valid).toBe(false);
    expect(validateRepairPlan(plan({ targetFile: ['a.js', 'b.js'] }), { allowlist }).valid).toBe(false);
    expect(validateRepairPlan(plan({ targetFile: 'a.js,b.js' }), { allowlist }).valid).toBe(false);
  });
  it('rejects non-object plans', () => {
    expect(validateRepairPlan(undefined, { allowlist }).valid).toBe(false);
  });
  it('detects a plan identical to a failed one, ignoring key order and rationale', () => {
    const failed = [plan({ change: { replace: 'b', find: 'a' }, rationale: 'earlier' })];
    const r = validateRepairPlan(plan(), { allowlist, failedPlans: failed });
    expect(r.identicalToFailed).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.countsAsAttempt).toBe(true);
  });
  it('accepts a plan that differs from the failed ones', () => {
    const failed = [plan({ change: { find: 'a', replace: 'c' } })];
    expect(validateRepairPlan(plan(), { allowlist, failedPlans: failed }).valid).toBe(true);
    expect(isIdenticalToFailedPlan(plan({ targetFile: 'public/card.js' }), [plan()])).toBe(false);
  });
});
