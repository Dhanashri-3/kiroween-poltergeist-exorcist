// Shared JSON Schema definitions reused by every contract schema.
// Referenced from other schemas as { "$ref": "common.json#/$defs/<name>" }.

export const COMMON_ID = 'https://poltergeist-exorcist.local/contracts/common.json';

export const INCIDENT_STATES = [
  'detected',
  'investigating',
  'planned',
  'repairing',
  'verifying',
  'recovered',
  'rolled_back',
  'escalated',
];

export const EVENT_TYPES = [
  'chaos.selection',
  'chaos.injection',
  'chaos.rejected',
  'detection',
  'transient',
  'cleared',
  'incident.state',
  'diagnosis',
  'plan',
  'gate',
  'repair',
  'verification',
  'rollback',
  'escalation',
  'recovery',
  'battle_result',
  'reset',
  'security',
  'error',
  'timeout',
];

export const commonSchema = {
  $id: COMMON_ID,
  $defs: {
    nonEmptyString: { type: 'string', minLength: 1 },
    uuid: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
    // ISO-8601 date-time with a timezone designator (no ajv-formats dependency).
    isoTimestamp: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$',
    },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    nonNegativeInteger: { type: 'integer', minimum: 0 },
    incidentState: { type: 'string', enum: INCIDENT_STATES },
    stringArray: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};
