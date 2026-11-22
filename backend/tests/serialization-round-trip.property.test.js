// Feature: poltergeist-exorcist-healing-system, Property 10: Serialization round trip
// **Validates: Requirements 6.10, 8.7, 14.9, 18.5**
//
// Incident, Repair_Plan and Event values survive JSON serialization and parsing unchanged, and
// records survive put then get through the local JSON store. Storage runs use temporary directories.
import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/contracts/index.js';
import { INCIDENT_STATES, EVENT_TYPES, COMPONENT_IDS } from '../src/contracts/common.js';
import { createJsonStore, COLLECTIONS } from '../src/storage/index.js';

const NUM_RUNS = 100;

// ----- generators ---------------------------------------------------------------------------

const text = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 30 });
const isoTs = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString());
const hex = (n) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
const uuid = fc.tuple(hex(8), hex(4), hex(4), hex(4), hex(12)).map((p) => p.join('-'));
// JSON values without -0 (JSON turns -0 into 0) and with safe keys.
const jsonKey = fc.string({ minLength: 1, maxLength: 10 }).filter((k) => k !== '__proto__');
const jsonLeaf = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
  fc.boolean(),
  fc.constant(null),
);
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof({ depthSize: 'small' }, jsonLeaf, tie('array'), tie('object')),
  array: fc.array(tie('value'), { maxLength: 4 }),
  object: fc.dictionary(jsonKey, tie('value'), { maxKeys: 4 }),
})).value;
const jsonObject = fc.dictionary(jsonKey, jsonValue, { maxKeys: 5 });
const nonEmptyJsonObject = fc.dictionary(jsonKey, jsonValue, { minKeys: 1, maxKeys: 5 });

const repairPlanArb = fc.record({
  incidentId: text,
  actionType: text,
  targetFile: text,
  change: nonEmptyJsonObject,
  rationale: text,
});

const attemptArb = fc.record(
  {
    attemptNo: fc.integer({ min: 1, max: 1000 }),
    planHash: text,
    snapshotId: text,
    verificationId: text,
    outcome: text,
  },
  { requiredKeys: ['attemptNo', 'planHash', 'snapshotId', 'outcome'] },
);

const incidentArb = fc.record(
  {
    incidentId: text,
    state: fc.constantFrom(...INCIDENT_STATES),
    detectedAt: isoTs,
    component: fc.constantFrom(...COMPONENT_IDS),
    evidenceRefs: fc.array(text, { maxLength: 4 }),
    plans: fc.array(repairPlanArb, { maxLength: 3 }),
    gateDecisions: fc.array(jsonObject, { maxLength: 3 }),
    attempts: fc.array(attemptArb, { maxLength: 3 }),
    attemptCount: fc.nat({ max: 1000 }),
    needsRollbackVerification: fc.boolean(),
    updatedAt: isoTs,
    terminalReason: text,
  },
  {
    requiredKeys: [
      'incidentId', 'state', 'detectedAt', 'component', 'evidenceRefs', 'plans',
      'gateDecisions', 'attempts', 'attemptCount', 'needsRollbackVerification', 'updatedAt',
    ],
  },
);

const eventArb = fc.record({
  id: uuid,
  seq: fc.nat({ max: 1_000_000 }),
  ts: isoTs,
  type: fc.constantFrom(...EVENT_TYPES),
  component: text,
  incidentId: fc.option(text, { nil: null }),
  runId: fc.option(text, { nil: null }),
  payload: jsonObject,
});

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

// ----- tests --------------------------------------------------------------------------------

const temps = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Property 10: Serialization round trip', () => {
  it('Incident records parse back equal after serialization (Req 6.10)', () => {
    fc.assert(
      fc.property(incidentArb, (incident) => {
        expect(validate('Incident', incident).valid).toBe(true);
        const back = roundTrip(incident);
        expect(back).toEqual(incident);
        expect(validate('Incident', back).valid).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Repair_Plan values parse back equal after serialization (Req 8.7)', () => {
    fc.assert(
      fc.property(repairPlanArb, (plan) => {
        expect(validate('RepairPlan', plan).valid).toBe(true);
        const back = roundTrip(plan);
        expect(back).toEqual(plan);
        expect(validate('RepairPlan', back).valid).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Event values parse back equal after serialization (Req 14.9)', () => {
    fc.assert(
      fc.property(eventArb, (event) => {
        expect(validate('Event', event).valid).toBe(true);
        const back = roundTrip(event);
        expect(back).toEqual(event);
        expect(validate('Event', back).valid).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('stored records come back equal after put then get, in a fresh store instance (Req 18.5)', async () => {
    const recordArb = fc.oneof(
      fc.tuple(fc.constant('incidents'), incidentArb),
      fc.tuple(fc.constant('events'), eventArb),
      fc.tuple(fc.constantFrom(...COLLECTIONS), jsonObject),
    );
    await fc.assert(
      fc.asyncProperty(recordArb, text, async ([collection, record], key) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serialization-rt-'));
        temps.push(dir);
        try {
          const store = createJsonStore({ directory: dir });
          const returned = await store.put(collection, key, record);
          expect(returned).toEqual(record);
          expect(await store.get(collection, key)).toEqual(record);
          // Re-read from disk with a new instance.
          const reopened = createJsonStore({ directory: dir });
          expect(await reopened.get(collection, key)).toEqual(record);
          expect(await reopened.list(collection)).toEqual([record]);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
