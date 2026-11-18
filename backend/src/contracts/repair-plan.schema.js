export const repairPlanSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/repair-plan.json',
  title: 'Repair_Plan',
  type: 'object',
  // additionalProperties is false so no command, shell or extra field can be carried (Requirement 8.1).
  additionalProperties: false,
  required: ['incidentId', 'actionType', 'targetFile', 'change', 'rationale'],
  properties: {
    incidentId: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Membership in the Action_Allowlist is decided by the Safety_Gate, not by this schema.
    actionType: { $ref: 'common.json#/$defs/nonEmptyString' },
    targetFile: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Structured change data, e.g. {find, replace} pairs or a bounded line range replacement.
    change: { type: 'object', minProperties: 1 },
    rationale: { $ref: 'common.json#/$defs/nonEmptyString' },
  },
};
