import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redact, REFUSED } from '../src/events/redactor.js';

// Feature: poltergeist-exorcist-healing-system, Property 23: Secret redaction
// **Validates: Requirements 13.6, 17.3**

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const UPPER_DIGIT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const chars = (set, min, max) => fc.array(fc.constantFrom(...set), { minLength: min, maxLength: max }).map((a) => a.join(''));

// Each arbitrary yields { text, secrets } where every string in `secrets` must be absent after redaction.
const arbSecret = fc.oneof(
  chars(ALNUM, 20, 40).map((s) => ({ text: `sk-${s}`, secrets: [`sk-${s}`] })),
  chars(ALNUM, 20, 40).map((s) => ({ text: `ghp_${s}`, secrets: [`ghp_${s}`] })),
  chars(UPPER_DIGIT, 16, 16).map((s) => ({ text: `AKIA${s}`, secrets: [`AKIA${s}`] })),
  chars(ALNUM, 16, 40).map((s) => ({ text: `Authorization: Bearer ${s}`, secrets: [s] })),
  fc
    .tuple(fc.constantFrom('API_KEY', 'DB_PASSWORD', 'AUTH_TOKEN', 'CLIENT_SECRET', 'apiKey'), chars(ALNUM, 12, 30))
    .map(([k, v]) => ({ text: `${k}=${v}`, secrets: [v] }))
);

const harmless = fc.constantFrom('hello', 'status', 'ok', 'width', 'color', 'retry');
const arbSecretString = fc
  .tuple(harmless, arbSecret, harmless)
  .map(([a, s, b]) => ({ text: `${a} ${s.text} ${b}`, secrets: s.secrets }));

// Nested payloads (objects/arrays) with secret strings at the leaves.
const arbPayload = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    arbSecretString.map((s) => ({ value: s.text, secrets: s.secrets })),
    fc.array(tie('node'), { maxLength: 3 }).map((xs) => ({ value: xs.map((x) => x.value), secrets: xs.flatMap((x) => x.secrets) })),
    fc
      .array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'detail', 'items'), tie('node')), { maxLength: 3 })
      .map((pairs) => ({
        value: Object.fromEntries(pairs.map(([k, n]) => [k, n.value])),
        // later duplicate keys overwrite earlier ones
        secrets: [...new Map(pairs.map(([k, n]) => [k, n])).values()].flatMap((n) => n.secrets)
      }))
  )
})).node;

const denyPaths = fc.constantFrom('.env', '.env.local', '.env.production', 'app/.env', '.git/config', 'repo/.git/HEAD', '.git', 'C:\\proj\\.git\\index', '.ENV');

describe('Property 23: Secret redaction', () => {
  it('removes every secret from nested payloads, never throws, and is idempotent', () => {
    fc.assert(
      fc.property(arbPayload, ({ value, secrets }) => {
        const out = redact(value);
        const serialized = JSON.stringify(out);
        for (const s of secrets) expect(serialized.includes(s)).toBe(false);
        expect(redact(out)).toEqual(out);
      }),
      { numRuns: 200 }
    );
  });

  it('refuses denylisted .env* and .git/ paths given as strings or path fields', () => {
    fc.assert(
      fc.property(denyPaths, fc.constantFrom('path', 'file', 'filename', 'filePath'), (p, key) => {
        expect(redact(p)).toBe(REFUSED);
        const out = redact({ [key]: p, content: 'API_KEY=supersecretvalue123' });
        expect(out).toBe(REFUSED);
        expect(JSON.stringify(redact([{ [key]: p, content: 'x' }]))).not.toContain(p.replace(/\\/g, '\\\\'));
      }),
      { numRuns: 100 }
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(arbPayload, ({ value }) => {
        const before = JSON.stringify(value);
        redact(value);
        expect(JSON.stringify(value)).toBe(before);
      }),
      { numRuns: 100 }
    );
  });
});
