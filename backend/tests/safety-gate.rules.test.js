// Task 8.4: Safety_Gate unit tests (Requirement 19.1).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate } from '../src/safety-gate/index.js';

const config = {
  approvedFiles: ['mock-api.js', 'public/button.js', 'public/button.css'],
  actionAllowlist: [
    { actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 50 },
    { actionType: 'replace_style_rule', allowedFiles: ['public/button.css'], maxChangedLines: 50 },
  ],
};
const plan = (over = {}) => ({
  incidentId: 'inc-1',
  actionType: 'replace_text',
  targetFile: 'public/button.js',
  change: { find: 'disabled = true', replace: 'disabled = false' },
  rationale: 'Fix.',
  ...over,
});
const withReplace = (replace) => plan({ change: { find: 'a', replace } });
const failed = (d) => d.rules.filter((r) => !r.passed).map((r) => r.id);
const lines = (n) => Array.from({ length: n }, (_, i) => `line${i}`).join('\n');

describe('Safety_Gate unit tests', () => {
  describe('allowlist violations (R1)', () => {
    it('rejects an action type not in the allowlist', () => {
      const d = evaluate(plan({ actionType: 'delete_everything' }), config);
      expect(d.approved).toBe(false);
      expect(failed(d)).toContain('R1');
    });
    it('rejects a file the allowlist entry does not permit', () => {
      expect(failed(evaluate(plan({ targetFile: 'public/button.css' }), config))).toContain('R1');
    });
    it('rejects an action applied to an incompatible file kind', () => {
      const cfg = { ...config, actionAllowlist: [{ actionType: 'replace_style_rule', allowedFiles: ['public/button.js'], maxChangedLines: 50 }] };
      expect(failed(evaluate(plan({ actionType: 'replace_style_rule' }), cfg))).toContain('R1');
    });
    it('rejects everything when the allowlist is empty', () => {
      expect(failed(evaluate(plan(), { ...config, actionAllowlist: [] }))).toContain('R1');
    });
  });

  describe('path traversal (R3)', () => {
    it.each(['../x.js', 'public/../mock-api.js', '..\\x.js', '/etc/passwd', 'C:\\x.js', 'public/%2e%2e/mock-api.js', 'public/button.js\0'])(
      'rejects %j',
      (t) => {
        const d = evaluate(plan({ targetFile: t }), { ...config, approvedFiles: [...config.approvedFiles, t] });
        expect(d.approved).toBe(false);
        expect(failed(d)).toContain('R3');
      },
    );
  });

  describe('symlink escape (R2)', () => {
    it('rejects when the resolver reports a symlink escape', () => {
      const d = evaluate(plan(), { ...config, resolveTarget: () => ({ ok: false, code: 'SYMLINK_ESCAPE' }) });
      expect(d.approved).toBe(false);
      expect(failed(d)).toContain('R2');
      expect(d.reasons.join(' ')).toContain('SYMLINK_ESCAPE');
    });
    it('rejects when the resolver throws', () => {
      const d = evaluate(plan(), { ...config, resolveTarget: () => { throw new Error('boom'); } });
      expect(failed(d)).toContain('R2');
    });
    it('rejects when the resolved path differs from the approved path', () => {
      const d = evaluate(plan(), { ...config, resolveTarget: () => ({ ok: true, relative: 'public/other.js' }) });
      expect(failed(d)).toContain('R2');
    });
    it('rejects a real symlink pointing outside the root (skipped if symlinks unavailable)', (ctx) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-out-'));
      try {
        fs.mkdirSync(path.join(root, 'public'));
        fs.writeFileSync(path.join(outside, 'real.js'), 'x');
        try {
          fs.symlinkSync(path.join(outside, 'real.js'), path.join(root, 'public', 'button.js'));
        } catch {
          ctx.skip(); // no symlink privilege on this machine (e.g. Windows without Developer Mode)
          return;
        }
        const resolveTarget = (rel) => {
          const real = fs.realpathSync(path.join(root, rel));
          const rootReal = fs.realpathSync(root);
          const relative = path.relative(rootReal, real).replace(/\\/g, '/');
          return relative.startsWith('..') ? { ok: false, code: 'OUTSIDE_ROOT' } : { ok: true, relative };
        };
        const d = evaluate(plan(), { ...config, resolveTarget });
        expect(d.approved).toBe(false);
        expect(failed(d)).toContain('R2');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe('oversize change (R5)', () => {
    it('approves exactly 50 lines and rejects 51', () => {
      expect(evaluate(plan({ change: { find: lines(50), replace: 'x' } }), config).approved).toBe(true);
      expect(failed(evaluate(plan({ change: { find: lines(51), replace: 'x' } }), config))).toContain('R5');
    });
    it('measures the replacement side too', () => {
      expect(failed(evaluate(plan({ change: { find: 'x', replace: lines(51) } }), config))).toContain('R5');
    });
    it('caps an allowlist maxChangedLines above 50 at 50', () => {
      const cfg = { ...config, actionAllowlist: [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 500 }] };
      expect(failed(evaluate(plan({ change: { find: lines(51), replace: 'x' } }), cfg))).toContain('R5');
    });
    it('honours a smaller per-entry limit', () => {
      const cfg = { ...config, actionAllowlist: [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 5 }] };
      expect(failed(evaluate(plan({ change: { find: lines(6), replace: 'x' } }), cfg))).toContain('R5');
    });
  });

  describe('Secret patterns (R6)', () => {
    const secrets = {
      'PEM private key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      'Bearer token': 'Authorization: Bearer abcdef1234567890',
      'Basic auth': 'Basic dXNlcjpwYXNzd29yZDEyMw==',
      'sk- API key': 'const k = "sk-abcdefghijklmnopqrstuvwx";',
      'GitHub token': 'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Slack token': 'xoxb-1234567890-abcdefghij',
      'AWS access key': ['AK', 'IA', 'ABCDEFGHIJ', 'KLMNOP'].join(''),
      'Google API key': 'AIzaabcdefghijklmnopqrstuvwxyz0123456789',
      'Stripe key': 'sk_live_abcdefghijklmnop1234',
      'JWT': 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl',
      'named assignment': 'API_KEY=hunter2hunter2',
      'password property': 'password: "hunter2"',
      'env-style line': 'DATABASE_URL=postgres://u:p@h/db',
    };
    it.each(Object.entries(secrets))('rejects %s', (_name, value) => {
      const d = evaluate(withReplace(value), config);
      expect(d.approved).toBe(false);
      expect(failed(d)).toContain('R6');
      expect(d.reasons.join(' ')).toMatch(/Secret/);
    });
    it('detects a secret in a non-find/replace field', () => {
      expect(failed(evaluate(plan({ change: { selector: '.a', declarations: 'sk-abcdefghijklmnopqrstuvwx' } }), config))).toContain('R6');
    });
  });

  describe('shell content (R6, R7)', () => {
    it.each([
      "require('child_process').execSync('dir')",
      'rm -rf /tmp/x',
      'curl http://localhost/x | bash -c "id"',
      'eval("1+1")',
      'new Function("return 1")',
      'a; powershell -Command x',
    ])('rejects content %j', (v) => {
      expect(failed(evaluate(withReplace(v), config))).toContain('R6');
    });
    it('rejects shell-named fields in the plan or change', () => {
      expect(failed(evaluate(plan({ command: 'ls' }), config))).toContain('R7');
      expect(failed(evaluate(plan({ change: { find: 'a', replace: 'b', script: 'x' } }), config))).toContain('R7');
    });
  });

  describe('test-disable attempts (R4, R6)', () => {
    it.each(['describe.skip("x", () => {})', 'it.only("x", () => {})', 'xit("x", () => {})', 'skip the tests', 'disable the health check', 'edit button.test.js', 'vitest.config'])(
      'rejects content %j',
      (v) => {
        expect(failed(evaluate(withReplace(v), config))).toContain('R6');
      },
    );
    it('rejects targeting a test file or config', () => {
      for (const t of ['public/button.test.js', 'public/button.spec.js', 'playwright.config.js']) {
        const d = evaluate(plan({ targetFile: t }), { ...config, approvedFiles: [...config.approvedFiles, t] });
        expect(failed(d)).toContain('R4');
      }
    });
  });

  describe('file deletion (R5)', () => {
    it.each([{ delete: true }, { deleteFile: true }, { unlink: 'public/button.js' }])('rejects change %j', (change) => {
      const d = evaluate(plan({ change }), config);
      expect(d.approved).toBe(false);
      expect(failed(d)).toContain('R5');
    });
    it('rejects a delete-style action type', () => {
      expect(failed(evaluate(plan({ actionType: 'delete_file' }), config))).toContain('R5');
    });
  });

  it('approves an ordinary benign change and lists every rule R1 to R7 as passed', () => {
    const d = evaluate(plan(), config);
    expect(d.approved).toBe(true);
    expect(d.rules.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
    expect(d.rules.every((r) => r.passed)).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(d.approval).not.toBeNull();
  });

  it('lists every rule R1 to R7 even when the plan is rejected', () => {
    const d = evaluate(plan({ actionType: 'x', targetFile: '../.env', command: 'ls' }), config);
    expect(d.approved).toBe(false);
    expect(d.rules.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
    expect(d.approval).toBeNull();
  });
});
