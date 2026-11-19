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
    targetComponent: { $ref: 'common.json#/$defs/componentId' },
    severity: { $ref: 'common.json#/$defs/severity' },
    // Membership in Approved_Files and catalog-wide uniqueness / the six-entry count
    // are enforced by the configuration loader and the Scenario_Engine (Property 2).
    targetFiles: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    // Deterministic transform objects: {type: 'replace_text', steps: [{file, find, replace}]}.
    injection: { $ref: 'common.json#/$defs/replaceTextTransform' },
    reversal: { $ref: 'common.json#/$defs/replaceTextTransform' },
    // Used by tests only; never sent to the Monitor, Exorcist or Fallback_Mapping.
    expectedRepairAction: {
      type: 'object',
      additionalProperties: false,
      required: ['actionType', 'targetFile', 'change'],
      properties: {
        actionType: { $ref: 'common.json#/$defs/nonEmptyString' },
        targetFile: { $ref: 'common.json#/$defs/nonEmptyString' },
        change: { $ref: 'common.json#/$defs/changePair' },
      },
    },
  },
};
