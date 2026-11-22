// Feature: poltergeist-exorcist-healing-system, Property 12: Repair_Plan structural validity
// **Validates: Requirements 8.1, 8.2, 8.3, 8.6**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateRepairPlan } from '../src/exorcist/validators.js';

const str = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const fileName = fc.stringMatching(/^[a-z][a-z0-9_./-]{0,19}$/);
const actionType = fc.stringMatching(/^[a-z][a-z_]{0,14}$/);
const change = fc.record({ find: str, replace: str });
const COMMAND_KEYS = ['command', 'cmd', 'shell', 'script', 'exec', 'execute', 'run', 'args', 'argv'];

const plan = fc.record({
  incidentId: str,
  actionType,
  targetFile: fileName,
  change,
  rationale: str,
});

const withAllowlist = plan.map((p) => ({ p, allowlist: [{ actionType: p.actionType }, { actionType: 'zz_other' }] }));

describe('Property 12: Repair_Plan structural validity', () => {
  it('accepts a complete plan with an allowlisted action and no command field', () => {
    fc.assert(
      fc.property(withAllowlist, ({ p, allowlist }) => {
        const r = validateRepairPlan(p, { allowlist, failedPlans: [] });
        expect(r.valid).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.identicalToFailed).toBe(false);
        expect(r.countsAsAttempt).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a plan missing any required field', () => {
    fc.assert(
      fc.property(withAllowlist, fc.constantFrom('incidentId', 'actionType', 'targetFile', 'change', 'rationale'), ({ p, allowlist }, key) => {
        const broken = { ...p };
        delete broken[key];
        const r = validateRepairPlan(broken, { allowlist });
        expect(r.valid).toBe(false);
        expect(r.countsAsAttempt).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects an action type outside the allowlist', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const r = validateRepairPlan(p, { allowlist: [{ actionType: `${p.actionType}_x` }] });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => e.keyword === 'notAllowlisted')).toBe(true);
        expect(r.countsAsAttempt).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects multiple target files', () => {
    fc.assert(
      fc.property(withAllowlist, fileName, fc.constantFrom(',', ';', '|', '\n'), ({ p, allowlist }, other, sep) => {
        const r = validateRepairPlan({ ...p, targetFile: `${p.targetFile}${sep}${other}` }, { allowlist });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => e.keyword === 'singleTarget')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects unstructured change data', () => {
    fc.assert(
      fc.property(withAllowlist, fc.oneof(str, fc.integer(), fc.array(str), fc.constant({})), ({ p, allowlist }, bad) => {
        expect(validateRepairPlan({ ...p, change: bad }, { allowlist }).valid).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects any command or shell field, top level or nested', () => {
    fc.assert(
      fc.property(withAllowlist, fc.constantFrom(...COMMAND_KEYS), str, fc.boolean(), ({ p, allowlist }, key, value, nested) => {
        const bad = nested ? { ...p, change: { ...p.change, [key]: value } } : { ...p, [key]: value };
        const r = validateRepairPlan(bad, { allowlist });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => e.keyword === 'noCommand')).toBe(true);
        expect(r.countsAsAttempt).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a plan identical to a previously failed plan and counts one attempt', () => {
    fc.assert(
      fc.property(withAllowlist, str, ({ p, allowlist }, otherRationale) => {
        const failed = { ...p, rationale: otherRationale };
        const r = validateRepairPlan(p, { allowlist, failedPlans: [failed] });
        expect(r.valid).toBe(false);
        expect(r.identicalToFailed).toBe(true);
        expect(r.countsAsAttempt).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('does not flag a plan that differs from failed plans in incident or change', () => {
    fc.assert(
      fc.property(withAllowlist, ({ p, allowlist }) => {
        const failed = [
          { ...p, incidentId: `${p.incidentId}-other` },
          { ...p, change: { ...p.change, find: `${p.change.find}!` } },
        ];
        const r = validateRepairPlan(p, { allowlist, failedPlans: failed });
        expect(r.valid).toBe(true);
        expect(r.identicalToFailed).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
