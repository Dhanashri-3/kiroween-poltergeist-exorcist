export const evidenceSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/evidence.json',
  title: 'Evidence',
  type: 'object',
  additionalProperties: false,
  required: [
    'evidenceId',
    'incidentId',
    'healthCheckResults',
    'consoleErrors',
    'domSnapshotRef',
    'screenshotPath',
    'capturedAt',
  ],
  properties: {
    evidenceId: { $ref: 'common.json#/$defs/nonEmptyString' },
    incidentId: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Item shape is not fixed by the design; each result must at least be an object.
    healthCheckResults: { type: 'array', items: { type: 'object' } },
    consoleErrors: { type: 'array', items: { type: 'string' } },
    domSnapshotRef: { $ref: 'common.json#/$defs/nonEmptyString' },
    screenshotPath: { $ref: 'common.json#/$defs/nonEmptyString' },
    capturedAt: { $ref: 'common.json#/$defs/isoTimestamp' },
  },
};
