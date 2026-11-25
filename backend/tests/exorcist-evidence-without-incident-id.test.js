// Regression: Evidence captured before the Incident exists has no incidentId. The real path
// (input builder -> Exorcist -> Fallback_Mapping -> schema validation) must still produce a
// valid rule-based Diagnosis and Repair_Plan bound to the Incident.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildExorcistInput } from '../src/exorcist/input-builder.js';
import { createExorcist } from '../src/exorcist/exorcist.js';
import { createEventLog } from '../src/events/event-log.js';
import { redact } from '../src/events/redactor.js';
import { validate } from '../src/contracts/index.js';

const entries = JSON.parse(fs.readFileSync(new URL('../config/fallback-mapping.json', import.meta.url), 'utf8')).entries;

function memoryStorage() {
  const data = new Map();
  return {
    async append(col, item) { (data.get(col) ?? data.set(col, []).get(col)).push(structuredClone(item)); },
    async list(col) { return structuredClone(data.get(col) ?? []); },
    async get() { return undefined; },
    async put() {},
  };
}

describe('Evidence without incidentId', () => {
  it('yields a valid rule-based diagnosis and plan carrying the Incident id', async () => {
    const incident = {
      incidentId: 'inc-9', state: 'investigating', detectedAt: '2025-01-01T00:00:00.000Z', component: 'button',
      evidenceRefs: ['ev-9'], plans: [], gateDecisions: [], attempts: [], attemptCount: 0,
      needsRollbackVerification: false, updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const evidence = { // no incidentId, as stored in the detection Event
      evidenceId: 'ev-9',
      healthCheckResults: [{ healthCheckId: 'button', status: 'fail', error: 'click handler produced no count change' }],
      consoleErrors: [], capturedAt: '2025-01-01T00:00:01.000Z',
    };
    expect('incidentId' in evidence).toBe(false);

    const input = await buildExorcistInput(incident, createEventLog({ storage: memoryStorage() }), {
      redact,
      loadEvidence: () => [evidence],
      readApprovedSources: () => [{ path: 'public/button.js', content: 'function f(){ count = count; }' }],
    });
    expect(input.evidence[0].incidentId).toBe('inc-9');

    const exorcist = createExorcist({ fallbackEntries: entries });
    const result = await exorcist.diagnose(input);
    expect(result).toMatchObject({ outcome: 'ok', source: 'rule_based', entryId: 'fm-click-count-not-incremented' });
    expect(result.diagnosis.incidentId).toBe('inc-9');
    expect(validate('Diagnosis', result.diagnosis).valid).toBe(true);

    const planned = await exorcist.plan(result.diagnosis, input);
    expect(planned).toMatchObject({ outcome: 'ok', source: 'rule_based', entryId: 'fm-click-count-not-incremented' });
    expect(planned.plan.incidentId).toBe('inc-9');
    expect(planned.plan.targetFile).toBe('public/button.js');
    expect(validate('RepairPlan', planned.plan).valid).toBe(true);
  });
});
