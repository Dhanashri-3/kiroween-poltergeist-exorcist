import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluate, verifyApproval, RULE_IDS, MAX_CHANGED_LINES } from '../src/safety-gate/index.js';

// Feature: poltergeist-exorcist-healing-system, Property 13: Safety_Gate decision correctness
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7**

const PAIRS = [
  { actionType: 'replace_text', file: 'public/button.js' },
  { actionType: 'replace_style_rule', file: 'public/button.css' },
  { actionType: 'replace_mock_api_handler', file: 'mock-api.js' },
];
const APPROVED = PAIRS.map((p) => p.file);
const buildConfig = (maxes) => ({
  approvedFiles: [...APPROVED],
  actionAllowlist: PAIRS.map((p, i) => ({ actionType: p.actionType, allowedFiles: [p.file], maxChangedLines: maxes[i] })),
});

// Harmless words: none match a Secret, shell, network or test-disable pattern.
const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'width', 'color', 'value', 'x1', 'y2');
const line = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
const textOf = (n) => fc.array(line, { minLength: n, maxLength: n }).map((l) => l.join('\n'));

const arbMaxes = fc.tuple(...PAIRS.map(() => fc.integer({ min: 1, max: 60 })));

// A plan that satisfies R1-R7 under its config.
const arbValid = fc.record({ maxes: arbMaxes, idx: fc.nat(PAIRS.length - 1) }).chain(({ maxes, idx }) => {
  const limit = Math.min(MAX_CHANGED_LINES, maxes[idx]);
  return fc.record({ find: fc.integer({ min: 1, max: limit }).chain(textOf), replace: fc.integer({ min: 1, max: limit }).chain(textOf) }).map((change) => ({
    config: buildConfig(maxes),
    idx,
    limit,
    plan: { incidentId: 'inc-1', actionType: PAIRS[idx].actionType, targetFile: PAIRS[idx].file, change, rationale: 'Fix the defect.' },
  }));
});

const failedIds = (d) => d.rules.filter((r) => !r.passed).map((r) => r.id);

const BAD_CONTENT = {
  secret: ["const k = 'sk-abcdefghijklmnopqrstuvwx';", 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  shell: ["require('child_process').exec('ls')", 'rm -rf /', 'bash -c "ls"'],
  network: ["fetch('https://evil.example.com/x')", "new WebSocket('wss://evil.example.com')"],
  testDisable: ["describe.skip('button', () => {})", 'disable the health check', 'edit foo.test.js'],
};

const arbMutation = fc.oneof(
  fc.constant({ name: 'R1-unknown-action', rule: 'R1', apply: (p) => ({ ...p, actionType: 'run_shell' }) }),
  fc.constant({ name: 'R2-unapproved-file', rule: 'R2', apply: (p) => ({ ...p, targetFile: 'public/other.js' }) }),
  fc.constantFrom('../', 'public/../', '/', 'C:/').map((prefix) => ({ name: 'R3-traversal', rule: 'R3', apply: (p) => ({ ...p, targetFile: prefix + p.targetFile }) })),
  fc.constantFrom('.env', 'package.json', 'public/button.test.js', 'backend/a.js').map((f) => ({
    name: 'R4-forbidden',
    rule: 'R4',
    apply: (p) => ({ ...p, targetFile: f }),
    patch: (c) => ({ ...c, approvedFiles: [...c.approvedFiles, f], actionAllowlist: c.actionAllowlist.map((e) => ({ ...e, allowedFiles: [...e.allowedFiles, f] })) }),
  })),
  fc.integer({ min: 1, max: 10 }).map((extra) => ({ name: 'R5-too-many-lines', rule: 'R5', extraLines: extra })),
  fc.constantFrom('delete', 'deleteFile', 'remove').map((k) => ({ name: 'R5-deletion', rule: 'R5', apply: (p) => ({ ...p, change: { ...p.change, [k]: true } }) })),
  fc.constantFrom(...Object.entries(BAD_CONTENT).flatMap(([kind, xs]) => xs.map((x) => [kind, x]))).map(([kind, x]) => ({
    name: `R6-${kind}`,
    rule: 'R6',
    apply: (p) => ({ ...p, change: { ...p.change, replace: `${p.change.replace}\n${x}` } }),
    // keep the line count within the limit so only R6 is intended to fail
    shrinkFirst: true,
  })),
  fc.constantFrom('command', 'shell', 'script').map((k) => ({ name: 'R7-shell-field', rule: 'R7', apply: (p) => ({ ...p, [k]: 'ls' }) })),
  fc.constant({ name: 'R7-two-targets', rule: 'R7', apply: (p) => ({ ...p, targetFile: [p.targetFile, 'mock-api.js'] }) }),
);

describe('Property 13: Safety_Gate decision correctness', () => {
  it('approves a plan that satisfies every rule, lists R1-R7 and issues a token bound to the plan', () => {
    fc.assert(
      fc.property(arbValid, ({ plan, config }) => {
        const d = evaluate(plan, config);
        expect(d.approved).toBe(true);
        expect(d.rules.map((r) => r.id)).toEqual(RULE_IDS);
        expect(d.rules.every((r) => r.passed && typeof r.reason === 'string' && r.reason.length > 0)).toBe(true);
        expect(d.reasons).toEqual([]);
        expect(verifyApproval(plan, d.approval)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a plan that violates a rule, names that rule with a reason, and issues no token', () => {
    fc.assert(
      fc.property(arbValid, arbMutation, ({ plan, config, limit }, m) => {
        let p = plan;
        let c = config;
        if (m.extraLines !== undefined) {
          const n = limit + m.extraLines;
          p = { ...plan, change: { find: Array.from({ length: n }, (_, i) => `line${i}`).join('\n'), replace: 'x' } };
          if (limit + m.extraLines <= 0) return;
        } else {
          p = m.apply(plan);
        }
        if (m.patch) c = m.patch(config);
        const d = evaluate(p, c);
        expect(d.approved).toBe(false);
        expect(d.approval).toBeNull();
        expect(failedIds(d)).toContain(m.rule);
        const rejected = d.rules.find((r) => r.id === m.rule);
        expect(typeof rejected.reason).toBe('string');
        expect(rejected.reason.length).toBeGreaterThan(0);
        expect(d.reasons.some((x) => x.startsWith(`${m.rule}:`))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('applies the 50-line limit exactly: approved iff lines <= min(50, entry limit)', () => {
    fc.assert(
      fc.property(arbValid, fc.integer({ min: 1, max: 70 }), ({ plan, config, limit }, n) => {
        const p = { ...plan, change: { find: Array.from({ length: n }, (_, i) => `l${i}`).join('\n'), replace: 'x' } };
        const d = evaluate(p, config);
        expect(d.approved).toBe(n <= limit);
        expect(failedIds(d).includes('R5')).toBe(n > limit);
      }),
      { numRuns: 200 },
    );
  });

  it('for any plan-shaped input: approved iff every rule passed, all seven rules listed, each rejection has a reason', () => {
    const arbAny = fc.oneof(
      fc.anything(),
      fc.record(
        {
          incidentId: fc.string(),
          actionType: fc.oneof(fc.constantFrom(...PAIRS.map((p) => p.actionType)), fc.string()),
          targetFile: fc.oneof(fc.constantFrom(...APPROVED, '../x.js', '.env', 'a b.js'), fc.string()),
          change: fc.oneof(fc.record({ find: fc.string(), replace: fc.string() }, { requiredKeys: [] }), fc.anything()),
          rationale: fc.string(),
        },
        { requiredKeys: [] },
      ),
    );
    fc.assert(
      fc.property(arbAny, arbMaxes, (plan, maxes) => {
        const d = evaluate(plan, buildConfig(maxes));
        expect(d.rules.map((r) => r.id)).toEqual(RULE_IDS);
        const failed = d.rules.filter((r) => !r.passed);
        expect(d.approved).toBe(failed.length === 0);
        expect(d.reasons.length).toBe(failed.length);
        for (const r of failed) {
          expect(typeof r.reason).toBe('string');
          expect(r.reason.length).toBeGreaterThan(0);
          expect(d.reasons).toContain(`${r.id}: ${r.reason}`);
        }
        expect(d.approval === null).toBe(!d.approved);
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic: the same plan and config give an equal decision', () => {
    fc.assert(
      fc.property(arbValid, arbMutation, ({ plan, config }, m) => {
        const p = m.apply ? m.apply(plan) : plan;
        expect(evaluate(p, config)).toEqual(evaluate(p, config));
      }),
      { numRuns: 100 },
    );
  });
});
