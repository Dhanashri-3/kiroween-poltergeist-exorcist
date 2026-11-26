/**
 * Phase 4B.4B: cue selection against the real reducer and its authoritative outcome selector.
 * Every Event here is synthetic test input.
 */
import { describe, it, expect } from 'vitest';
import { cueForEvent, createCueTracker, CUES } from './soundCues.js';
import { selectIncidentOutcome } from '../state/dashboardReducer.js';
import { ev, stateEv, build } from '../components/testHelpers.js';

const pass = (seq, incidentId = 'inc-1') =>
  ev(seq, 'verification', { incidentId, verificationId: `v-${seq}`, overall: 'pass', checks: [{ outcome: 'pass' }] }, { incidentId });
const fail = (seq, incidentId = 'inc-1') =>
  ev(seq, 'verification', { incidentId, verificationId: `v-${seq}`, overall: 'fail', checks: [{ outcome: 'fail' }] }, { incidentId });
const inject = (seq) => ev(seq, 'chaos.injection', { scenarioId: 'button-failure', targetComponent: 'button' }, { incidentId: null, component: 'scenario-engine' });

/** Runs the tracker over the reducer state built from `events`, the way useSoundCues does. */
function step(tracker, events, { watermark = -1, canPlay = true } = {}) {
  const state = build(events);
  return tracker.next({
    events: state.events, watermark, canPlay, outcomeFor: (id) => selectIncidentOutcome(state, id),
  }).map((c) => c.cue);
}

describe('cueForEvent', () => {
  it('maps the approved Events to their cues', () => {
    expect(cueForEvent(inject(1))).toBe(CUES.POLTERGEIST);
    expect(cueForEvent(ev(1, 'diagnosis', { status: 'accepted', source: 'rule_based' }))).toBe(CUES.DIAGNOSE);
    expect(cueForEvent(stateEv(1, 'repairing'))).toBe(CUES.REPAIR_START);
    expect(cueForEvent(ev(1, 'repair', { target: 'mock-api.js', snapshotId: 's' }))).toBe(CUES.REPAIR_DONE);
    expect(cueForEvent(pass(1))).toBe(CUES.VERIFY_PASS);
    expect(cueForEvent(fail(1))).toBe(CUES.VERIFY_FAIL);
    expect(cueForEvent(ev(1, 'rollback', { status: 'verified' }))).toBe(CUES.ROLLBACK);
    expect(cueForEvent(stateEv(1, 'escalated'))).toBe(CUES.ESCALATE);
  });

  it('never returns the success cue and stays silent for the excluded Events', () => {
    expect(cueForEvent(stateEv(1, 'recovered'))).toBeNull();
    expect(cueForEvent(ev(1, 'recovery', { verificationId: 'v', healthyChecks: 3 }))).toBeNull();
    for (const type of ['battle_result', 'chaos.selection', 'chaos.rejected', 'reset', 'error', 'security', 'timeout', 'detection', 'plan', 'gate']) {
      expect(cueForEvent(ev(1, type, {})), type).toBeNull();
    }
    for (const to of ['detected', 'investigating', 'planned', 'verifying', 'rolled_back']) {
      expect(cueForEvent(stateEv(1, to)), to).toBeNull();
    }
    expect(cueForEvent(ev(1, 'verification', { overall: 'unknown' }))).toBeNull();
    expect(cueForEvent(null)).toBeNull();
  });
});

describe('createCueTracker: eligibility', () => {
  it('a null watermark makes nothing eligible', () => {
    const tracker = createCueTracker();
    expect(step(tracker, [inject(1), pass(2)], { watermark: null })).toEqual([]);
  });

  it('suppresses history at or below the watermark and plays only later Events', () => {
    const tracker = createCueTracker();
    const history = [inject(1), pass(2), stateEv(3, 'recovered')];
    expect(step(tracker, history, { watermark: 3 })).toEqual([]);
    expect(step(tracker, [...history, ev(4, 'diagnosis', { status: 'accepted' })], { watermark: 3 })).toEqual([CUES.DIAGNOSE]);
  });

  it('plays each seq at most once, also when the same Event is seen again', () => {
    const tracker = createCueTracker();
    expect(step(tracker, [inject(5)])).toEqual([CUES.POLTERGEIST]);
    expect(step(tracker, [inject(5)])).toEqual([]);
    expect(step(tracker, [inject(5), inject(5)])).toEqual([]);
  });
});

describe('createCueTracker: verification and recovery', () => {
  it('a passing verification alone gives only the neutral confirmation', () => {
    const tracker = createCueTracker();
    expect(step(tracker, [pass(10)])).toEqual([CUES.VERIFY_PASS]);
  });

  it('a failed verification gives its warning cue', () => {
    const tracker = createCueTracker();
    expect(step(tracker, [fail(10)])).toEqual([CUES.VERIFY_FAIL]);
  });

  it('in backend order (pass, then recovered) gives the confirmation and then one success cue', () => {
    const tracker = createCueTracker();
    expect(step(tracker, [pass(10)])).toEqual([CUES.VERIFY_PASS]);
    expect(step(tracker, [pass(10), stateEv(11, 'recovered')])).toEqual([CUES.RECOVERED]);
  });

  it('out of order: recovered first stays silent, the later passing verification gives one success cue', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered')];
    expect(step(tracker, events)).toEqual([]);
    expect(tracker.pendingCount()).toBe(1);
    events.push(pass(11));
    expect(step(tracker, events)).toEqual([CUES.VERIFY_PASS, CUES.RECOVERED]);
    expect(tracker.pendingCount()).toBe(0);
    expect(step(tracker, events)).toEqual([]);
  });

  it('an unverified recovery claim never gives success', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered')];
    expect(step(tracker, events)).toEqual([]);
    events.push(fail(11));
    expect(step(tracker, events)).toEqual([CUES.VERIFY_FAIL]);
    expect(step(tracker, [...events, ev(12, 'recovery', { verificationId: 'v', healthyChecks: 3 })])).toEqual([]);
  });

  it('a verification for another Incident does not confirm the claim', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered', 'inc-1'), pass(11, 'inc-2')];
    expect(step(tracker, events)).toEqual([CUES.VERIFY_PASS]);
    expect(tracker.pendingCount()).toBe(1);
  });

  it('plays the success cue once per Incident, even for a repeated recovered state', () => {
    const tracker = createCueTracker();
    const events = [pass(10), stateEv(11, 'recovered')];
    expect(step(tracker, events)).toEqual([CUES.VERIFY_PASS, CUES.RECOVERED]);
    expect(step(tracker, [...events, stateEv(12, 'recovered')])).toEqual([]);
  });

  it('a later non-recovered state withdraws the pending claim', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered'), stateEv(11, 'escalated')];
    expect(step(tracker, events)).toEqual([CUES.ESCALATE]);
    expect(tracker.pendingCount()).toBe(0);
    expect(step(tracker, [...events, pass(12)])).toEqual([CUES.VERIFY_PASS]);
  });
});

describe('createCueTracker: muted and hidden', () => {
  it('consumes Events while it cannot play and never replays them', () => {
    const tracker = createCueTracker();
    const events = [inject(1), pass(2), stateEv(3, 'recovered')];
    expect(step(tracker, events, { canPlay: false })).toEqual([]);
    expect(step(tracker, events, { canPlay: true })).toEqual([]);
  });

  it('muting or hiding while a recovery is pending discards it for good', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered')];
    expect(step(tracker, events)).toEqual([]);
    expect(tracker.pendingCount()).toBe(1);
    expect(step(tracker, events, { canPlay: false })).toEqual([]);
    expect(tracker.pendingCount()).toBe(0);
    events.push(pass(11));
    expect(step(tracker, events)).toEqual([CUES.VERIFY_PASS]); // no success cue after unmuting
  });

  it('discardPending() drops a pending recovery', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered')];
    step(tracker, events);
    tracker.discardPending();
    expect(step(tracker, [...events, pass(11)])).toEqual([CUES.VERIFY_PASS]);
  });

  it('a recovered claim seen while muted cannot sound after unmuting', () => {
    const tracker = createCueTracker();
    const events = [stateEv(10, 'recovered')];
    step(tracker, events, { canPlay: false });
    expect(step(tracker, [...events, pass(11)])).toEqual([CUES.VERIFY_PASS]);
  });
});
