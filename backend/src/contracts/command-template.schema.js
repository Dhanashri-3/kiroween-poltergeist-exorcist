export const commandTemplateSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/command-template.json',
  title: 'Command template',
  type: 'object',
  additionalProperties: false,
  required: ['templateId', 'executable', 'args', 'allowedParams', 'timeoutMs'],
  properties: {
    templateId: { $ref: 'common.json#/$defs/nonEmptyString' },
    executable: { $ref: 'common.json#/$defs/nonEmptyString' },
    // Fixed argument list; never built from agent text.
    args: { type: 'array', items: { type: 'string' } },
    // Enumeration of permitted component IDs (the only substitutable parameter).
    allowedParams: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    timeoutMs: { type: 'integer', minimum: 1 },
  },
};
