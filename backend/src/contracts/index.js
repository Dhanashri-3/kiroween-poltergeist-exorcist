import Ajv from 'ajv';
import { commonSchema } from './common.js';
import { eventSchema } from './event.schema.js';
import { incidentSchema } from './incident.schema.js';
import { evidenceSchema } from './evidence.schema.js';
import { diagnosisSchema } from './diagnosis.schema.js';
import { repairPlanSchema } from './repair-plan.schema.js';
import { scenarioCatalogEntrySchema } from './scenario-catalog-entry.schema.js';
import { snapshotSchema } from './snapshot.schema.js';
import { verificationResultSchema } from './verification-result.schema.js';
import { actionAllowlistEntrySchema, actionAllowlistSchema } from './action-allowlist.schema.js';
import { fallbackMappingEntrySchema } from './fallback-mapping-entry.schema.js';
import { commandTemplateSchema } from './command-template.schema.js';
import {
  approvedFilesDocumentSchema,
  scenarioCatalogDocumentSchema,
  commandTemplatesDocumentSchema,
  fallbackMappingDocumentSchema,
} from './config-documents.schema.js';

/** Public schema names accepted by validate(). */
export const SCHEMAS = {
  Event: eventSchema,
  Incident: incidentSchema,
  Evidence: evidenceSchema,
  Diagnosis: diagnosisSchema,
  RepairPlan: repairPlanSchema,
  ScenarioCatalogEntry: scenarioCatalogEntrySchema,
  Snapshot: snapshotSchema,
  VerificationResult: verificationResultSchema,
  ActionAllowlist: actionAllowlistSchema, // array of entries
  ActionAllowlistEntry: actionAllowlistEntrySchema, // single entry
  FallbackMappingEntry: fallbackMappingEntrySchema,
  CommandTemplate: commandTemplateSchema,
  // Complete configuration documents.
  ApprovedFilesDocument: approvedFilesDocumentSchema,
  ScenarioCatalogDocument: scenarioCatalogDocumentSchema,
  CommandTemplatesDocument: commandTemplatesDocumentSchema,
  FallbackMappingDocument: fallbackMappingDocumentSchema,
};

export const SCHEMA_NAMES = Object.freeze(Object.keys(SCHEMAS));

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addSchema(commonSchema);
// Referenced schemas must be registered before the schemas that use them are compiled.
ajv.addSchema(actionAllowlistEntrySchema);
ajv.addSchema(diagnosisSchema);
ajv.addSchema(repairPlanSchema);
ajv.addSchema(scenarioCatalogEntrySchema);
ajv.addSchema(fallbackMappingEntrySchema);
ajv.addSchema(commandTemplateSchema);

const validators = new Map();
for (const [name, schema] of Object.entries(SCHEMAS)) {
  validators.set(name, ajv.getSchema(schema.$id) ?? ajv.compile(schema));
}

function toStructuredError(err) {
  return {
    path: err.instancePath === '' ? '/' : err.instancePath,
    keyword: err.keyword,
    message: err.message ?? 'invalid value',
    params: { ...err.params },
  };
}

/**
 * Validate `value` against a named contract schema.
 * @param {string} schemaName one of SCHEMA_NAMES
 * @param {unknown} value
 * @returns {{valid: boolean, errors: Array<{path: string, keyword: string, message: string, params: object}>}}
 */
export function validate(schemaName, value) {
  const check = typeof schemaName === 'string' && Object.hasOwn(SCHEMAS, schemaName)
    ? validators.get(schemaName)
    : undefined;

  if (!check) {
    return {
      valid: false,
      errors: [
        {
          path: '/',
          keyword: 'unknownSchema',
          message: `Unknown schema name: ${String(schemaName)}`,
          params: { schemaName: String(schemaName), knownSchemas: [...SCHEMA_NAMES] },
        },
      ],
    };
  }

  const valid = check(value) === true;
  return { valid, errors: valid ? [] : (check.errors ?? []).map(toStructuredError) };
}
