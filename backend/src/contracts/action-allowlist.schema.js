export const actionAllowlistEntrySchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/action-allowlist-entry.json',
  title: 'Action_Allowlist entry',
  type: 'object',
  additionalProperties: false,
  required: ['actionType', 'allowedFiles', 'maxChangedLines'],
  properties: {
    actionType: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Each file must also be an Approved_File; that cross-check is done at configuration load.
    allowedFiles: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    maxChangedLines: { type: 'integer', minimum: 1 },
  },
};

// The Action_Allowlist configuration is an array of entries.
export const actionAllowlistSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/action-allowlist.json',
  title: 'Action_Allowlist',
  type: 'array',
  items: { $ref: 'action-allowlist-entry.json' },
};
