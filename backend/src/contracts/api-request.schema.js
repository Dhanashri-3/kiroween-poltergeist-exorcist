// Request body schemas for the HTTP API (Task 12.1, Requirement 13.3).

/** POST /api/v1/chaos-runs body: optional scenario choice; omitted means the Poltergeist picks. */
export const chaosRunRequestSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/chaos-run-request.json',
  title: 'ChaosRunRequest',
  type: 'object',
  additionalProperties: false,
  properties: {
    scenarioId: { $ref: 'common.json#/$defs/nonEmptyString' },
  },
};

/** POST /api/v1/reset body: no fields are accepted. */
export const resetRequestSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/reset-request.json',
  title: 'ResetRequest',
  type: 'object',
  additionalProperties: false,
  properties: {},
};
