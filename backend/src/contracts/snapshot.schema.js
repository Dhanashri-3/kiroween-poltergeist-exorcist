export const snapshotSchema = {
  $id: 'https://poltergeist-exorcist.local/contracts/snapshot.json',
  title: 'Snapshot',
  type: 'object',
  additionalProperties: false,
  required: ['snapshotId', 'createdAt', 'reason', 'files'],
  properties: {
    snapshotId: { $ref: 'common.json#/$defs/nonEmptyString' },
    createdAt: { $ref: 'common.json#/$defs/isoTimestamp' },
    reason: { type: 'string', enum: ['injection', 'repair', 'baseline'] },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'checksum', 'contentRef'],
        properties: {
          path: { $ref: 'common.json#/$defs/nonEmptyString' },
          checksum: { $ref: 'common.json#/$defs/sha256' },
          contentRef: { $ref: 'common.json#/$defs/nonEmptyString' },
        },
      },
    },
  },
};
