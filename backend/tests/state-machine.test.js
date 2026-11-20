import { describe, it, expect } from 'vitest';
import { TRANSITIONS, STATES, checkTransition, isTerminal } from '../src/incident/state-machine.js';

const ctx = { rollbackVerified: true, executorCompleted: true };

describe('incident state machine table', () => {
  it('has exactly the permitted transitions from the design diagram', () => {
    expect(TRANSITIONS).toEqual({
      detected: ['investigating', 'escalated'],
      investigating: ['planned', 'escalated'],
      planned: ['repairing', 'investigating', 'escalated', 'rolled_back'],
      repairing: ['verifying', 'rolled_back', 'escalated'],
      verifying: ['recovered', 'rolled_back', 'escalated'],
      rolled_back: ['investigating', 'escalated'],
      recovered: [],
      escalated: [],
    });
  });

  it('treats only recovered and escalated as terminal with no exits', () => {
    expect(STATES.filter(isTerminal)).toEqual(['recovered', 'escalated']);
    for (const to of STATES) {
      expect(checkTransition('recovered', to, ctx).ok).toBe(false);
      expect(checkTransition('escalated', to, ctx).ok).toBe(false);
    }
  });

  it('requires verified rollback for rolled_back', () => {
    expect(checkTransition('verifying', 'rolled_back', {}).ok).toBe(false);
    expect(checkTransition('verifying', 'rolled_back', { rollbackVerified: true }).ok).toBe(true);
  });

  it('allows verifying only from repairing with a completed executor record', () => {
    expect(checkTransition('repairing', 'verifying', {}).ok).toBe(false);
    expect(checkTransition('repairing', 'verifying', ctx).ok).toBe(true);
    for (const from of STATES.filter((s) => s !== 'repairing')) {
      expect(checkTransition(from, 'verifying', ctx).ok).toBe(false);
    }
  });

  it('rejects unknown states', () => {
    expect(checkTransition('bogus', 'detected').ok).toBe(false);
    expect(checkTransition('detected', 'bogus').ok).toBe(false);
  });
});
