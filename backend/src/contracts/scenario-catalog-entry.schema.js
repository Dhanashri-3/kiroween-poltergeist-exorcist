export const scenarioCatalogEntrySchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/scenario-catalog-entry.json',
  title: 'Scenario_Catalog entry',
  type: 'object',
  additionalProperties: false,
  required: [
    'scenarioId',
    'label',
    'targetComponent',
    'severity',
    'targetFiles',
    'injection',
    'reversal',
    'expectedRepairAction',
  ],
  properties: {
    scenarioId: { $ref: 'common.json#/$defs/nonEmptyString' },
    label: { $ref: 'common.json#/$defs/nonEmptyString' },
    targetComponent: { $ref: 'common.json#/$defs/nonEmptyString' },
    severity: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Membership in Approved_Files and catalog-wide uniqueness / the six-entry count
    // are enforced by the Scenario_Engine (Property 2).
    targetFiles: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    // Deterministic transform description; the design does not fix its shape (object or text).
    injection: { type: ['object', 'string'] },
    reversal: { type: ['object', 'string'] },
    expectedRepairAction: { type: ['object', 'string'] },
  },
};
