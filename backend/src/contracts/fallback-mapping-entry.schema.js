export const fallbackMappingEntrySchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/fallback-mapping-entry.json',
  title: 'Fallback_Mapping entry',
  type: 'object',
  additionalProperties: false,
  required: ['entryId', 'evidencePattern', 'sourceCheck', 'diagnosisTemplate', 'planTemplate'],
  properties: {
    entryId: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Matchers over Health_Check identifiers, console error text and DOM snapshot features.
    evidencePattern: { type: 'object', minProperties: 1 },
    // Deterministic check over Approved_Files content.
    sourceCheck: { type: 'object', minProperties: 1 },
    diagnosisTemplate: { type: 'object', minProperties: 1 },
    planTemplate: { type: 'object', minProperties: 1 },
  },
};
