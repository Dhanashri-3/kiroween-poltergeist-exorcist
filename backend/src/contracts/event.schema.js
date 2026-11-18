import { EVENT_TYPES } from './common.js';

export const eventSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/event.json',
  title: 'Event',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'seq', 'ts', 'type', 'component', 'incidentId', 'runId', 'payload'],
  properties: {
    id: { $ref: 'common.json#/$defs/uuid' },
    seq: { type: 'integer', minimum: 0 },
    ts: { $ref: 'common.json#/$defs/isoTimestamp' },
    type: { type: 'string', enum: EVENT_TYPES },
    component: { $ref: 'common.json#/$defs/nonEmptyString' },
    incidentId: { type: ['string', 'null'], minLength: 1 },
    runId: { type: ['string', 'null'], minLength: 1 },
    // The 64 KB size limit (payload becomes {ref}) is enforced by the Event store (Property 27),
    // because JSON Schema cannot express serialized byte size.
    payload: { type: 'object' },
  },
};
