import { describe, it, expect } from 'vitest';
import { redact, isDenylistedPath, REDACTED, REFUSED } from '../src/events/redactor.js';

describe('redactor', () => {
  it('redacts API-key shapes', () => {
    const keys = [
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'AKIAABCDEFGHIJKLMNOP',
      'AIza' + 'a'.repeat(35),
      'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl'
    ];
    for (const k of keys) {
      const out = redact(`key is ${k} ok`);
      expect(out).not.toContain(k);
      expect(out).toContain(REDACTED);
    }
  });

  it('redacts bearer tokens', () => {
    for (const text of ['Authorization: Bearer abc123.def456-ghi789', 'sent Bearer abc123.def456-ghi789 now']) {
      const out = redact(text);
      expect(out).not.toContain('abc123');
      expect(out).toContain(REDACTED);
    }
    expect(redact('sent Bearer abc123.def456-ghi789 now')).toBe('sent Bearer ' + REDACTED + ' now');
  });

  it('redacts .env-style assignments', () => {
    const out = redact('PORT=3000\nDB_PASSWORD=hunter2hunter2\nAPI_KEY: "zzz-secret-value"\nname=ok');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('zzz-secret-value');
    expect(out).toContain('name=ok');
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redact(`x ${pem} y`)).toBe(`x ${REDACTED} y`);
  });

  it('leaves benign text alone', () => {
    expect(redact('Sidebar overlaps content at src/app.js:12')).toBe('Sidebar overlaps content at src/app.js:12');
  });

  it('recurses into nested objects and arrays without mutating input', () => {
    const input = { a: ['Bearer abcdefghijkl', { b: 'TOKEN=abcdef123' }], n: 5, ok: true, z: null };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = redact(input);
    expect(input).toEqual(snapshot);
    expect(JSON.stringify(out)).not.toMatch(/abcdefghijkl|abcdef123/);
    expect(out.n).toBe(5);
    expect(out.ok).toBe(true);
    expect(out.z).toBeNull();
  });

  it('identifies denylisted paths', () => {
    for (const p of ['.env', '.env.local', 'app/.env.production', '.git/config', 'x/.git/HEAD', '.GIT\\config']) {
      expect(isDenylistedPath(p)).toBe(true);
    }
    for (const p of ['src/app.js', 'environment.js', 'gitignore.txt', '.gitignore']) {
      expect(isDenylistedPath(p)).toBe(false);
    }
  });

  it('refuses content from denylisted files', () => {
    expect(redact({ path: '.env', content: 'FOO=bar' })).toBe(REFUSED);
    expect(redact([{ file: '.git/config', content: 'x' }, { file: 'a.js', content: 'y' }]))
      .toEqual([REFUSED, { file: 'a.js', content: 'y' }]);
    expect(redact('.env.local')).toBe(REFUSED);
    expect(redact({ '.env': 'FOO=bar' })).not.toHaveProperty('.env');
  });

  it('handles circular references and primitives', () => {
    const a = { name: 'x' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(redact(42)).toBe(42);
    expect(redact(undefined)).toBeUndefined();
  });
});
