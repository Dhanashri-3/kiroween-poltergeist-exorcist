// Every sub-object is closed (additionalProperties: false), so a command, shell or script key,
// or a scenario reference, cannot be carried by a mapping entry.
export const fallbackMappingEntrySchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/fallback-mapping-entry.json',
  title: 'Fallback_Mapping entry',
  type: 'object',
  additionalProperties: false,
  required: ['entryId', 'evidencePattern', 'sourceCheck', 'diagnosisTemplate', 'planTemplate'],
  properties: {
    entryId: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Matcher over a Health_Check result: component identifier, failing status, error text pattern.
    evidencePattern: {
      type: 'object',
      additionalProperties: false,
      required: ['healthCheckId', 'status', 'errorPattern'],
      properties: {
        healthCheckId: { $ref: 'common.json#/$defs/componentId' },
        status: { type: 'string', const: 'fail' },
        errorPattern: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    // Deterministic check over Approved_Files content.
    sourceCheck: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'contains'],
      properties: {
        file: { $ref: 'common.json#/$defs/nonEmptyString' },
        contains: { $ref: 'common.json#/$defs/nonEmptyString' },
      },
    },
    diagnosisTemplate: {
      type: 'object',
      additionalProperties: false,
      required: ['component', 'suspectedFile', 'location', 'rootCause', 'confidence'],
      properties: {
        component: { $ref: 'common.json#/$defs/componentId' },
        suspectedFile: { $ref: 'common.json#/$defs/nonEmptyString' },
        location: { $ref: 'common.json#/$defs/nonEmptyString' },
        rootCause: { $ref: 'common.json#/$defs/nonEmptyString' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    planTemplate: {
      type: 'object',
      additionalProperties: false,
      required: ['actionType', 'targetFile', 'change', 'rationale'],
      properties: {
        actionType: { $ref: 'common.json#/$defs/nonEmptyString' },
        targetFile: { $ref: 'common.json#/$defs/nonEmptyString' },
        change: { $ref: 'common.json#/$defs/changePair' },
        rationale: { $ref: 'common.json#/$defs/nonEmptyString' },
      },
    },
  },
};
