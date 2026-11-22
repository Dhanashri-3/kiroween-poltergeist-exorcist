// Feature: poltergeist-exorcist-healing-system, Property 11: Diagnosis validation and confidence gate
// **Validates: Requirements 7.2, 7.5, 7.8, 7.9**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateDiagnosis } from '../src/exorcist/validators.js';

const str = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const validDiagnosis = (confidence, status) =>
  fc.record({
    incidentId: str,
    component: str,
    suspectedFile: str,
    location: str,
    rootCause: str,
    confidence,
    evidenceUsed: fc.array(str, { maxLength: 5 }),
    status,
  });

const REQUIRED = ['incidentId', 'component', 'suspectedFile', 'location', 'rootCause', 'confidence', 'evidenceUsed', 'status'];

describe('Property 11: Diagnosis validation and confidence gate', () => {
  it('accepts a schema-valid, confident, non-inconclusive Diagnosis', () => {
    fc.assert(
      fc.property(validDiagnosis(fc.double({ min: 0.5, max: 1, noNaN: true }), fc.constantFrom('ok', 'rule_based')), (d) => {
        const r = validateDiagnosis(d);
        expect(r.outcome).toBe('accepted');
        expect(r.valid).toBe(true);
        expect(r.countsAsAttempt).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('yields inconclusive (no attempt consumed) for confidence below 0.5', () => {
    fc.assert(
      fc.property(
        validDiagnosis(fc.double({ min: 0, max: 0.5, noNaN: true }).filter((c) => c < 0.5), fc.constantFrom('ok', 'inconclusive', 'rule_based')),
        (d) => {
          const r = validateDiagnosis(d);
          expect(r.outcome).toBe('inconclusive');
          expect(r.countsAsAttempt).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('yields inconclusive for status inconclusive at any confidence', () => {
    fc.assert(
      fc.property(validDiagnosis(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant('inconclusive')), (d) => {
        expect(validateDiagnosis(d).outcome).toBe('inconclusive');
      }),
      { numRuns: 100 },
    );
  });

  it('yields inconclusive for a missing Diagnosis', () => {
    for (const v of [undefined, null]) {
      const r = validateDiagnosis(v);
      expect(r.outcome).toBe('inconclusive');
      expect(r.valid).toBe(false);
    }
  });

  it('rejects schema-invalid Diagnoses and counts one attempt', () => {
    const corrupt = fc.tuple(
      validDiagnosis(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant('ok')),
      fc.constantFrom(...REQUIRED),
      fc.constantFrom('remove', 'wrongType', 'badConfidenceHigh', 'badConfidenceLow', 'extra', 'badStatus'),
    );
    fc.assert(
      fc.property(corrupt, ([d, key, kind]) => {
        const bad = { ...d };
        if (kind === 'remove') delete bad[key];
        else if (kind === 'wrongType') bad[key] = key === 'evidenceUsed' ? 'x' : 42;
        else if (kind === 'badConfidenceHigh') bad.confidence = 1.0001;
        else if (kind === 'badConfidenceLow') bad.confidence = -0.0001;
        else if (kind === 'extra') bad.unexpected = 1;
        else bad.status = 'bogus';
        const r = validateDiagnosis(bad);
        expect(r.outcome).toBe('rejected');
        expect(r.valid).toBe(false);
        expect(r.countsAsAttempt).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
