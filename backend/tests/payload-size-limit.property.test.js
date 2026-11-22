// Feature: poltergeist-exorcist-healing-system, Property 27: Payload size limit
// **Validates: Requirements 14.7**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventLog, MAX_EVENT_BYTES } from '../src/events/event-log.js';

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// Payload text length spans well below and well above the 64 KB limit.
const sizeArb = fc.oneof(
  fc.integer({ min: 0, max: 2000 }),
  fc.integer({ min: MAX_EVENT_BYTES - 600, max: MAX_EVENT_BYTES + 600 }),
  fc.integer({ min: MAX_EVENT_BYTES, max: 3 * MAX_EVENT_BYTES }),
);

function makeLog() {
  const rows = [];
  const blobs = new Map();
  const storage = {
    async append(_c, record) { rows.push(structuredClone(record)); return record; },
    async list() { return structuredClone(rows); },
  };
  const writeBlob = async (name, text) => { blobs.set(name, text); return name; };
  return { rows, blobs, log: createEventLog({ storage, writeBlob }) };
}

describe('Property 27: Payload size limit', () => {
  it('persisted events never exceed 64 KB; oversized payloads become a {ref} to a file holding the full content', async () => {
    await fc.assert(
      fc.asyncProperty(sizeArb, async (size) => {
        const { rows, blobs, log } = makeLog();
        const payload = { text: 'a'.repeat(size) };
        const event = await log.append({ type: 'detection', component: 'monitor', payload });

        expect(bytes(event)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
        expect(rows).toHaveLength(1);
        expect(bytes(rows[0])).toBeLessThanOrEqual(MAX_EVENT_BYTES);

        const inlineEvent = { ...event, payload };
        if (bytes(inlineEvent) > MAX_EVENT_BYTES) {
          expect(typeof event.payload.ref).toBe('string');
          expect(blobs.has(event.payload.ref)).toBe(true);
          expect(JSON.parse(blobs.get(event.payload.ref))).toEqual(payload);
        } else {
          expect(event.payload).toEqual(payload);
          expect(blobs.size).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
