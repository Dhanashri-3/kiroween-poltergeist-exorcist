import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, verifyApproval, hashPlan, canonicalize } from '../src/safety-gate/index.js';
import { recordGateDecision } from '../src/orchestrator/gate-recorder.js';

const config = {
  approvedFiles: ['mock-api.js', 'public/button.js', 'public/button.css'],
  actionAllowlist: [
    { actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 20 },
    { actionType: 'replace_style_rule', allowedFiles: ['public/button.css'], maxChangedLines: 20 },
    { actionType: 'replace_mock_api_handler', allowedFiles: ['mock-api.js'], maxChangedLines: 30 },
  ],
};
const plan = (over = {}) => ({
  incidentId: 'inc-1',
  actionType: 'replace_text',
  targetFile: 'public/button.js',
  change: { find: 'disabled = true', replace: 'disabled = false' },
  rationale: 'Button is disabled by mistake.',
  ...over,
});
const failed = (d) => d.rules.filter((r) => !r.passed).map((r) => r.id);

describe('Safety_Gate', () => {
  it('approves a valid plan, lists all seven rules and issues a token bound to the plan', () => {
    const p = plan();
    const d = evaluate(p, config);
    expect(d.approved).toBe(true);
    expect(d.rules.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
    expect(d.approval.planHash).toBe(hashPlan(p));
    expect(verifyApproval(p, d.approval)).toBe(true);
    expect(verifyApproval(plan({ change: { find: 'a', replace: 'b' } }), d.approval)).toBe(false);
    expect(verifyApproval(p, { ...d.approval, token: '00'.repeat(32) })).toBe(false);
  });

  it('is deterministic and ignores key order in the hash', () => {
    expect(evaluate(plan(), config).approval.planHash).toBe(hashPlan({ ...plan(), change: { replace: 'disabled = false', find: 'disabled = true' } }));
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(evaluate(plan(), config)).toEqual(evaluate(plan(), config));
  });

  it('R1 rejects unknown action and file outside the entry', () => {
    expect(failed(evaluate(plan({ actionType: 'run_shell' }), config))).toContain('R1');
    expect(failed(evaluate(plan({ targetFile: 'mock-api.js' }), config))).toContain('R1');
  });

  it('R2 rejects non-approved files and unresolved targets', () => {
    expect(failed(evaluate(plan({ targetFile: 'public/other.js' }), config))).toContain('R2');
    const resolveTarget = () => ({ ok: true, relative: 'public/button.css' });
    expect(failed(evaluate(plan(), { ...config, resolveTarget }))).toContain('R2');
    expect(failed(evaluate(plan(), { ...config, resolveTarget: () => ({ ok: false, code: 'symlink' }) }))).toContain('R2');
    expect(evaluate(plan(), { ...config, resolveTarget: (t) => ({ ok: true, relative: t }) }).approved).toBe(true);
  });

  it('R3 rejects traversal and absolute paths', () => {
    for (const t of ['../backend/x.js', 'public/../mock-api.js', '/etc/passwd', 'C:/x.js', 'public\\button.js']) {
      expect(failed(evaluate(plan({ targetFile: t }), config))).toContain('R3');
    }
  });

  it('R4 rejects forbidden categories', () => {
    for (const t of ['.env', 'package.json', 'public/button.test.js', 'frontend/a.js', 'backend/a.js', '.kiro/a.js', 'vitest.config.js']) {
      const d = evaluate(plan({ targetFile: t }), { ...config, approvedFiles: [...config.approvedFiles, t] });
      expect(failed(d)).toContain('R4');
    }
  });

  it('R5 rejects more than 50 lines and deletions', () => {
    const many = Array.from({ length: 51 }, (_, i) => `l${i}`).join('\n');
    const cfg = { ...config, actionAllowlist: [{ actionType: 'replace_text', allowedFiles: ['public/button.js'], maxChangedLines: 50 }] };
    expect(failed(evaluate(plan({ change: { find: many, replace: 'x' } }), cfg))).toContain('R5');
    expect(evaluate(plan({ change: { find: many.split('\n').slice(0, 50).join('\n'), replace: 'x' } }), cfg).approved).toBe(true);
    expect(failed(evaluate(plan({ change: { delete: true } }), config))).toContain('R5');
  });

  it('R6 rejects secret, shell, external network and test-disable content', () => {
    const bad = [
      "const k = 'sk-abcdefghijklmnopqrstuvwx';",
      "require('child_process').exec('ls')",
      'rm -rf /',
      "fetch('https://evil.example.com/x')",
      "describe.skip('button', () => {})",
      'disable the health check',
    ];
    for (const replace of bad) expect(failed(evaluate(plan({ change: { find: 'a', replace } }), config))).toContain('R6');
    expect(evaluate(plan({ change: { find: 'a', replace: "if (a && b || c) fetch('/api/data');" } }), config).approved).toBe(true);
  });

  it('R7 rejects extra fields, shell fields and multiple targets', () => {
    expect(failed(evaluate(plan({ command: 'ls' }), config))).toContain('R7');
    expect(failed(evaluate(plan({ change: { find: 'a', replace: 'b', shell: 'ls' } }), config))).toContain('R7');
    expect(failed(evaluate(plan({ targetFile: ['public/button.js', 'mock-api.js'] }), config))).toContain('R7');
  });

  it('fails closed on malformed input and never approves', () => {
    for (const p of [null, undefined, 5, 'x', [], {}]) {
      const d = evaluate(p, config);
      expect(d.approved).toBe(false);
      expect(d.approval).toBeNull();
    }
  });

  it('lists every failing rule instead of stopping at the first', () => {
    const d = evaluate(plan({ actionType: 'x', targetFile: '../.env' }), config);
    expect(failed(d)).toEqual(expect.arrayContaining(['R1', 'R2', 'R3', 'R4']));
    expect(d.reasons.length).toBe(failed(d).length);
  });

  it('does no I/O and does not import poltergeist, exorcist or AI modules', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/safety-gate/safety-gate.js'), 'utf8');
    const specs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(specs.some((s) => /poltergeist|exorcist/.test(s))).toBe(false);
    expect(specs).not.toContain('node:fs');
  });

  it('records a gate Event without the token', async () => {
    const appended = [];
    const log = { append: async (e) => { appended.push(e); return e; } };
    const p = plan();
    await recordGateDecision(log, p, evaluate(p, config));
    expect(appended[0]).toMatchObject({ type: 'gate', incidentId: 'inc-1' });
    expect(appended[0].payload.decision).toBe('approved');
    expect(JSON.stringify(appended[0])).not.toContain(evaluate(p, config).approval.token);
  });
});
