/**
 * Phase 4B.4B: useSoundCues with a fake engine (no audio) and real reducer state built from synthetic Events.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useSoundCues } from './useSoundCues.js';
import { selectIncidentOutcome } from '../../state/dashboardReducer.js';
import { ev, stateEv, build } from '../../components/testHelpers.js';

const pass = (seq) => ev(seq, 'verification', { incidentId: 'inc-1', verificationId: `v-${seq}`, overall: 'pass', checks: [{ outcome: 'pass' }] });
const inject = (seq) => ev(seq, 'chaos.injection', { scenarioId: 's', targetComponent: 'button' }, { incidentId: null, component: 'scenario-engine' });

const fakeEngine = () => ({ play: vi.fn(() => true) });
const propsFor = (events, extra = {}) => {
  const state = build(events);
  return { events: state.events, watermark: -1, outcomeFor: (id) => selectIncidentOutcome(state, id), enabled: true, ...extra };
};
const played = (engine) => engine.play.mock.calls.map(([cue]) => cue);

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  delete document.visibilityState; // back to jsdom's own getter
});

describe('useSoundCues', () => {
  it('plays nothing while disabled, and does not replay those Events once enabled', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), { initialProps: { ...propsFor([inject(1)]), engine, enabled: false } });
    expect(engine.play).not.toHaveBeenCalled();
    rerender({ ...propsFor([inject(1)]), engine, enabled: true });
    expect(engine.play).not.toHaveBeenCalled();
    rerender({ ...propsFor([inject(1), inject(2)]), engine, enabled: true });
    expect(played(engine)).toEqual(['poltergeist']);
  });

  it('plays nothing while the watermark is null', () => {
    const engine = fakeEngine();
    renderHook(() => useSoundCues({ ...propsFor([inject(1)]), engine, watermark: null }));
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('plays each live Event once under StrictMode', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), {
      initialProps: { ...propsFor([inject(1)]), engine }, wrapper: React.StrictMode,
    });
    rerender({ ...propsFor([inject(1)]), engine });
    expect(played(engine)).toEqual(['poltergeist']);
  });

  it('plays the success cue once, after the passing verification arrives out of order', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), { initialProps: { ...propsFor([stateEv(5, 'recovered')]), engine } });
    expect(engine.play).not.toHaveBeenCalled();
    rerender({ ...propsFor([stateEv(5, 'recovered'), pass(6)]), engine });
    expect(played(engine)).toEqual(['verify-pass', 'recovered']);
    rerender({ ...propsFor([stateEv(5, 'recovered'), pass(6)]), engine });
    expect(played(engine)).toEqual(['verify-pass', 'recovered']);
  });

  it('muting while a recovery is pending discards it', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), { initialProps: { ...propsFor([stateEv(5, 'recovered')]), engine } });
    rerender({ ...propsFor([stateEv(5, 'recovered')]), engine, enabled: false });
    rerender({ ...propsFor([stateEv(5, 'recovered'), pass(6)]), engine, enabled: true });
    expect(played(engine)).toEqual(['verify-pass']);
  });

  it('drops Events while the tab is hidden and never plays them later', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), { initialProps: { ...propsFor([]), engine } });
    act(() => setVisibility('hidden'));
    rerender({ ...propsFor([inject(1)]), engine });
    act(() => setVisibility('visible'));
    rerender({ ...propsFor([inject(1)]), engine });
    expect(engine.play).not.toHaveBeenCalled();
    rerender({ ...propsFor([inject(1), inject(2)]), engine });
    expect(played(engine)).toEqual(['poltergeist']);
  });

  it('hiding the tab while a recovery is pending discards it', () => {
    const engine = fakeEngine();
    const { rerender } = renderHook((p) => useSoundCues(p), { initialProps: { ...propsFor([stateEv(5, 'recovered')]), engine } });
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    rerender({ ...propsFor([stateEv(5, 'recovered'), pass(6)]), engine });
    expect(played(engine)).toEqual(['verify-pass']);
  });

  it('removes its visibility listener on unmount', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useSoundCues({ ...propsFor([]), engine: fakeEngine() }));
    unmount();
    expect(remove.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);
    remove.mockRestore();
  });
});
