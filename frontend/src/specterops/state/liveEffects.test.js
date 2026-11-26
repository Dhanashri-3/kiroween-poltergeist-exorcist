import { describe, it, expect } from 'vitest';
import { ev, stateEv } from '../../components/testHelpers.js';
import { deriveLiveEffects } from './liveEffects.js';

const inject = (seq, targetComponent) => ev(seq, 'chaos.injection', { scenarioId: 's', targetComponent }, { incidentId: null, component: 'scenario-engine' });

describe('deriveLiveEffects', () => {
  it('produces nothing without a watermark or for history', () => {
    const events = [inject(1, 'button')];
    expect(deriveLiveEffects({ events, watermark: null })).toEqual({ strike: null, heal: null });
    expect(deriveLiveEffects({ events, watermark: 1 })).toEqual({ strike: null, heal: null });
  });

  it('targets the real payload.targetComponent of the newest live injection', () => {
    const events = [inject(2, 'button'), inject(3, 'layout')];
    expect(deriveLiveEffects({ events, watermark: 1 }).strike).toEqual({ targetKey: 'layout', token: 3 });
  });

  it('does not strike an unknown or missing target', () => {
    expect(deriveLiveEffects({ events: [inject(2, 'app')], watermark: 1 }).strike).toBeNull();
    expect(deriveLiveEffects({ events: [ev(2, 'chaos.injection', { target: 'x.jsx' })], watermark: 1 }).strike).toBeNull();
  });

  it('ends the strike on reset or on a terminal state for the targeted component', () => {
    const incidents = [{ incidentId: 'inc-1', component: 'button', outcome: 'escalated' }];
    expect(deriveLiveEffects({ events: [inject(2, 'button'), ev(3, 'reset', {}, { incidentId: null })], watermark: 1 }).strike).toBeNull();
    expect(deriveLiveEffects({ events: [inject(2, 'button'), stateEv(3, 'escalated')], watermark: 1, incidents }).strike).toBeNull();
    // rolled_back is transient: the strike stays
    expect(deriveLiveEffects({ events: [inject(2, 'button'), stateEv(3, 'rolled_back')], watermark: 1, incidents }).strike).not.toBeNull();
  });

  it('heals only a live, reducer-verified recovery on a mesh card', () => {
    const events = [inject(2, 'button'), stateEv(5, 'recovered')];
    const verified = [{ incidentId: 'inc-1', component: 'button', outcome: 'recovered' }];
    expect(deriveLiveEffects({ events, watermark: 1, incidents: verified }).heal).toEqual({ targetKey: 'button', token: 5 });
    const unverified = [{ incidentId: 'inc-1', component: 'button', outcome: 'unverified_recovery_claim' }];
    expect(deriveLiveEffects({ events, watermark: 1, incidents: unverified }).heal).toBeNull();
    const appLevel = [{ incidentId: 'inc-1', component: 'app', outcome: 'recovered' }];
    expect(deriveLiveEffects({ events, watermark: 1, incidents: appLevel }).heal).toBeNull();
    expect(deriveLiveEffects({ events, watermark: 5, incidents: verified }).heal).toBeNull(); // history
  });
});
