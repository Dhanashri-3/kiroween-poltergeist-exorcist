// Complete configuration documents (the on-disk shape of four of the five config files; the
// Action_Allowlist file is itself an array and uses ActionAllowlist). All are closed objects.
const BASE = 'https://poltergeist-exorcist.local/contracts/';

export const approvedFilesDocumentSchema = {
  $id: `${BASE}approved-files-document.json`,
  title: 'Approved_Files document',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'files'],
  properties: {
    version: { $ref: 'common.json#/$defs/nonEmptyString' },
    files: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
};

export const scenarioCatalogDocumentSchema = {
  $id: `${BASE}scenario-catalog-document.json`,
  title: 'Scenario_Catalog document',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'scenarios'],
  properties: {
    version: { $ref: 'common.json#/$defs/nonEmptyString' },
    scenarios: { type: 'array', minItems: 6, maxItems: 6, items: { $ref: 'scenario-catalog-entry.json' } },
  },
};

export const commandTemplatesDocumentSchema = {
  $id: `${BASE}command-templates-document.json`,
  title: 'Command templates document',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'templates'],
  properties: {
    version: { $ref: 'common.json#/$defs/nonEmptyString' },
    templates: { type: 'array', items: { $ref: 'command-template.json' } },
  },
};

export const fallbackMappingDocumentSchema = {
  $id: `${BASE}fallback-mapping-document.json`,
  title: 'Fallback_Mapping document',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'entries'],
  properties: {
    version: { $ref: 'common.json#/$defs/nonEmptyString' },
    entries: { type: 'array', minItems: 1, items: { $ref: 'fallback-mapping-entry.json' } },
  },
};
