import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../../state/dashboardReducer.js';
import { ev } from '../../components/testHelpers.js';
import { ACTORS, EVENT_ACTORS, actorForEvent, buildLogLines, describeEvent, describeSource } from './agentLog.js';

const POLTERGEIST_TYPES = ['chaos.selection', 'chaos.injection'];
const EXORCIST_TYPES = ['diagnosis', 'plan', 'repair', 'rollback', 'escalation', 'recovery'];

describe('actorForEvent', () => {
  it('maps every documented Event type to the approved actor', () => {
    for (const type of EVENT_TYPES) {
      const expected = POLTERGEIST_TYPES.includes(type) ? ACTORS.POLTERGEIST
        : EXORCIST_TYPES.includes(type) ? ACTORS.EXORCIST : ACTORS.SYSTEM;
      expect(actorForEvent(ev(1, type)), type).toBe(expected);
      expect(EVENT_ACTORS[type], `${type} is listed explicitly`).toBe(expected);
    }
  });

  it('labels detection, verification, chaos.rejected and battle_result as SYSTEM', () => {
    for (const type of ['detection', 'verification', 'chaos.rejected', 'battle_result']) {
      expect(actorForEvent(ev(1, type))).toBe(ACTORS.SYSTEM);
    }
  });

  it('ignores event.component entirely', () => {
    // Real backend emitters and fake-fixture names must not change the label.
    expect(actorForEvent(ev(1, 'detection', {}, { component: 'exorcist' }))).toBe(ACTORS.SYSTEM);
    expect(actorForEvent(ev(2, 'chaos.injection', {}, { component: 'scenario-engine' }))).toBe(ACTORS.POLTERGEIST);
    expect(actorForEvent(ev(3, 'diagnosis', {}, { component: 'orchestrator' }))).toBe(ACTORS.EXORCIST);
    expect(actorForEvent(ev(4, 'battle_result', {}, { component: 'poltergeist' }))).toBe(ACTORS.SYSTEM);
  });

  it('falls back to SYSTEM for unknown or malformed input', () => {
    expect(actorForEvent({ type: 'something-new' })).toBe(ACTORS.SYSTEM);
    expect(actorForEvent(null)).toBe(ACTORS.SYSTEM);
    expect(actorForEvent({ type: 'toString' })).toBe(ACTORS.SYSTEM);
  });
});

describe('describeEvent', () => {
  it('uses only payload facts for the injection target', () => {
    expect(describeEvent(ev(1, 'chaos.injection', { scenarioId: 's-1', targetComponent: 'button' })))
      .toBe('Injected scenario s-1 into component button.');
    // The fake fixture shape (`target`, no `targetComponent`) does not invent a component.
    expect(describeEvent(ev(2, 'chaos.injection', { scenarioId: 's-1', target: 'testapp/src/Button.jsx' })))
      .toBe('Injected scenario s-1.');
  });

  it('never repeats a battle_result winner claim', () => {
    const text = describeEvent(ev(1, 'battle_result', { winner: 'poltergeist', result: 'victory' }));
    expect(text).not.toMatch(/poltergeist|victory|win/i);
    expect(text).toContain('verified Incident state');
  });

  it('describes a rule-based diagnosis without claiming AI reasoning', () => {
    const text = describeEvent(ev(1, 'diagnosis', { status: 'accepted', source: 'rule_based', diagnosis: { rootCause: 'handler removed' } }));
    expect(text).toBe('Diagnosis accepted (rule-based fallback). Root cause: handler removed');
    expect(text).not.toMatch(/\bAI\b/);
    expect(describeSource('rule_based')).toBe('rule-based fallback');
    expect(describeSource(undefined)).toBeNull();
  });

  it('marks a recovered state that the reducer has not verified', () => {
    const e = ev(1, 'incident.state', { to: 'recovered' });
    expect(describeEvent(e, { outcomeFor: () => 'unverified_recovery_claim' })).toBe('Incident inc-1 state: recovered. Not verified.');
    expect(describeEvent(e, { outcomeFor: () => 'recovered' })).toBe('Incident inc-1 state: recovered.');
  });

  it('reports verification counts from the checks that exist', () => {
    const payload = { overall: 'fail', checks: [{ outcome: 'pass' }, { outcome: 'fail' }, { outcome: 'pass' }] };
    expect(describeEvent(ev(1, 'verification', payload))).toBe('Verification fail. 2 of 3 checks passed.');
    expect(describeEvent(ev(2, 'verification', { overall: 'pass' }))).toBe('Verification pass.');
  });

  it('describes recovery, plan and omitted payloads honestly', () => {
    expect(describeEvent(ev(1, 'recovery', { verificationId: 'v-1', healthyChecks: 3 })))
      .toBe('Recovery confirmed: verification v-1, 3 healthy checks.');
    expect(describeEvent(ev(2, 'recovery', {}))).toBe('Recovery confirmed.');
    expect(describeEvent(ev(3, 'plan', { plan: { actionType: 'replace_text', targetFile: 'a.jsx' }, source: 'rule_based', rejected: false })))
      .toBe('Repair plan proposed: replace_text on a.jsx (rule-based fallback).');
    expect(describeEvent(ev(4, 'plan', { rejected: true }))).toBe('Repair plan rejected by validation.');
    expect(describeEvent(ev(5, 'verification', { ref: 'blob-1', bytes: 9000 }))).toBe('verification event recorded (payload omitted).');
  });

  it('never produces the Dashboard-reserved phrases', () => {
    for (const type of EVENT_TYPES) {
      const text = describeEvent(ev(1, type, { to: 'recovered', overall: 'pass', status: 'restored' }), { outcomeFor: () => 'recovered' });
      expect(text, type).not.toMatch(/recovered \(verified\)|applied diff/i);
    }
  });
});

describe('buildLogLines', () => {
  const events = [ev(1, 'chaos.selection', { scenarioId: 's' }), ev(2, 'detection', {}, { incidentId: null, component: 'button' }), ev(5, 'diagnosis', { status: 'accepted' })];

  it('keeps Event order and actor identity', () => {
    const lines = buildLogLines({ events });
    expect(lines.map((l) => [l.seq, l.actor])).toEqual([[1, 'POLTERGEIST'], [2, 'SYSTEM'], [5, 'EXORCIST']]);
    expect(lines.every((l) => l.source === 'event')).toBe(true);
  });

  it('flags only Events above the watermark as live', () => {
    expect(buildLogLines({ events }).some((l) => l.live)).toBe(false); // no watermark: nothing is live
    expect(buildLogLines({ events, watermark: 2 }).map((l) => l.live)).toEqual([false, false, true]);
  });

  it('places client notes after their seq and strips a duplicated [SYSTEM] prefix', () => {
    const notes = [{ id: 'a', text: '[SYSTEM] Live refresh of health failed after 4 attempts: down', afterSeq: 2 }];
    const lines = buildLogLines({ events, notes, watermark: 0 });
    expect(lines.map((l) => l.key)).toEqual(['e-1', 'e-2', 'n-a', 'e-5']);
    expect(lines[2]).toMatchObject({ actor: 'SYSTEM', source: 'client', text: 'Live refresh of health failed after 4 attempts: down' });
  });

  it('keeps the newest lines within the limit and skips malformed input', () => {
    const many = Array.from({ length: 60 }, (_, i) => ev(i + 1, 'cleared', { check: 'button' }));
    const lines = buildLogLines({ events: [...many, null, { seq: 'x' }], limit: 50 });
    expect(lines).toHaveLength(50);
    expect(lines[0].seq).toBe(11);
    expect(lines[49].seq).toBe(60);
  });
});
