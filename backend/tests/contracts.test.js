import { describe, it, expect } from 'vitest';
import { validate, SCHEMA_NAMES } from '../src/contracts/index.js';

const ts = '2025-01-01T00:00:00.000Z';
const sha = 'a'.repeat(64);

const diagnosis = {
  incidentId: 'inc-1', component: 'button', suspectedFile: 'public/button.js', location: 'line 3',
  rootCause: 'handler removed', confidence: 0.9, evidenceUsed: ['ev-1'], status: 'ok',
};
const repairPlan = {
  incidentId: 'inc-1', actionType: 'text-replace', targetFile: 'public/button.js',
  change: { find: 'a', replace: 'b' }, rationale: 'restore handler',
};

const step = { file: 'public/button.js', find: 'a', replace: 'b' };
const scenarioEntry = {
  scenarioId: 'button-failure', label: 'Button', targetComponent: 'button', severity: 'high', targetFiles: ['public/button.js'],
  injection: { type: 'replace_text', steps: [step] },
  reversal: { type: 'replace_text', steps: [{ file: step.file, find: 'b', replace: 'a' }] },
  expectedRepairAction: { actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'b', replace: 'a' } },
};
const fallbackEntry = {
  entryId: 'f1',
  evidencePattern: { healthCheckId: 'button', status: 'fail', errorPattern: '^click' },
  sourceCheck: { file: 'public/button.js', contains: 'x' },
  diagnosisTemplate: { component: 'button', suspectedFile: 'public/button.js', location: 'handler', rootCause: 'x', confidence: 0.5 },
  planTemplate: { actionType: 'replace_text', targetFile: 'public/button.js', change: { find: 'b', replace: 'a' }, rationale: 'r' },
};
const commandTemplate = { templateId: 't1', executable: 'npx', args: ['vitest', 'run'], allowedParams: ['button', 'card'], timeoutMs: 120000 };

const samples = {
  Event: {
    valid: { id: '123e4567-e89b-42d3-a456-426614174000', seq: 1, ts, type: 'detection', component: 'monitor', incidentId: null, runId: null, payload: {} },
    invalid: { id: 'not-a-uuid', seq: 1, ts, type: 'bogus', component: 'monitor', incidentId: null, runId: null, payload: {} },
  },
  Incident: {
    valid: {
      incidentId: 'inc-1', state: 'detected', detectedAt: ts, component: 'button', evidenceRefs: ['ev-1'],
      diagnosis, plans: [repairPlan], gateDecisions: [],
      attempts: [{ attemptNo: 1, planHash: 'h', snapshotId: 's', outcome: 'failed' }],
      attemptCount: 1, needsRollbackVerification: false, updatedAt: ts,
    },
    invalid: { incidentId: 'inc-1', state: 'unknown' },
  },
  Evidence: {
    valid: { evidenceId: 'ev-1', incidentId: 'inc-1', healthCheckResults: [{ id: 'button', ok: false }], consoleErrors: ['x'], domSnapshotRef: 'ref', screenshotPath: 'p.png', capturedAt: ts },
    invalid: { evidenceId: 'ev-1', incidentId: 'inc-1', consoleErrors: 'x' },
  },
  Diagnosis: { valid: diagnosis, invalid: { ...diagnosis, confidence: 1.5 } },
  RepairPlan: { valid: repairPlan, invalid: { ...repairPlan, command: 'rm -rf /' } },
  ScenarioCatalogEntry: {
    valid: scenarioEntry,
    invalid: { scenarioId: 'x', targetFiles: [] },
  },
  Snapshot: {
    valid: { snapshotId: 's1', createdAt: ts, reason: 'baseline', files: [{ path: 'public/button.js', checksum: sha, contentRef: 'c1' }] },
    invalid: { snapshotId: 's1', createdAt: ts, reason: 'baseline', files: [{ path: 'p', checksum: 'short', contentRef: 'c1' }] },
  },
  VerificationResult: {
    valid: { verificationId: 'v1', incidentId: 'inc-1', attemptNo: 1, checks: [{ checkId: 'c', kind: 'health', coversComponent: 'button', outcome: 'pass', rawOutputRef: 'r' }], originalFailingCheckRan: true, overall: 'pass', startedAt: ts, durationMs: 10 },
    invalid: { verificationId: 'v1', incidentId: 'inc-1', attemptNo: 1, checks: [{ checkId: 'c', kind: 'other', coversComponent: 'button', outcome: 'pass', rawOutputRef: 'r' }], originalFailingCheckRan: true, overall: 'maybe', startedAt: ts, durationMs: -1 },
  },
  ActionAllowlist: {
    valid: [{ actionType: 'text-replace', allowedFiles: ['public/button.js'], maxChangedLines: 50 }],
    invalid: [{ actionType: 'text-replace', allowedFiles: [], maxChangedLines: 0 }],
  },
  ActionAllowlistEntry: {
    valid: { actionType: 'text-replace', allowedFiles: ['public/button.js'], maxChangedLines: 50 },
    invalid: { actionType: 'text-replace' },
  },
  FallbackMappingEntry: {
    valid: fallbackEntry,
    invalid: { entryId: 'f1', evidencePattern: {} },
  },
  CommandTemplate: {
    valid: commandTemplate,
    invalid: { templateId: 't1', executable: 'npx', args: [1], allowedParams: 'button', timeoutMs: 0 },
  },
  ApprovedFilesDocument: {
    valid: { version: '1', files: ['public/button.js'] },
    invalid: { version: '1', files: [] },
  },
  ScenarioCatalogDocument: {
    valid: { version: '1', scenarios: Array.from({ length: 6 }, () => scenarioEntry) },
    invalid: { version: '1', scenarios: [scenarioEntry] },
  },
  ChaosRunRequest: {
    valid: { scenarioId: 'button-failure' },
    invalid: { scenarioId: '' },
  },
  ResetRequest: {
    valid: {},
    invalid: { force: true },
  },
  CommandTemplatesDocument: {
    valid: { version: '1', templates: [commandTemplate] },
    invalid: { templates: [commandTemplate] },
  },
  FallbackMappingDocument: {
    valid: { version: '1', entries: [fallbackEntry] },
    invalid: { version: '1', entries: [] },
  },
};

describe('contract schemas', () => {
  it('has a sample for every registered schema', () => {
    expect(Object.keys(samples).sort()).toEqual([...SCHEMA_NAMES].sort());
  });

  for (const [name, { valid, invalid }] of Object.entries(samples)) {
    it(`${name}: accepts a valid sample`, () => {
      const result = validate(name, valid);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
    it(`${name}: rejects an invalid sample with structured errors`, () => {
      const result = validate(name, invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      for (const e of result.errors) {
        expect(e).toEqual({
          path: expect.any(String), keyword: expect.any(String), message: expect.any(String), params: expect.any(Object),
        });
      }
    });
  }
});

describe('validate helper', () => {
  it('reports unknown schema names without throwing', () => {
    const r = validate('Nope', {});
    expect(r.valid).toBe(false);
    expect(r.errors[0].keyword).toBe('unknownSchema');
    expect(r.errors[0].params.knownSchemas).toContain('Event');
  });
  it('treats inherited property names as unknown', () => {
    expect(validate('toString', {}).errors[0].keyword).toBe('unknownSchema');
    expect(validate(undefined, {}).valid).toBe(false);
  });
  it('reports every missing required field with its path', () => {
    const r = validate('Diagnosis', {});
    expect(r.errors.filter((e) => e.keyword === 'required').length).toBe(8);
  });
  it('reports a nested path for a bad nested value', () => {
    const r = validate('Snapshot', samples.Snapshot.invalid);
    expect(r.errors[0].path).toBe('/files/0/checksum');
  });
  it('rejects a Repair_Plan carrying a command field', () => {
    const r = validate('RepairPlan', samples.RepairPlan.invalid);
    expect(r.errors[0].keyword).toBe('additionalProperties');
  });
  it('rejects non-object input', () => {
    expect(validate('Event', null).valid).toBe(false);
  });
});
