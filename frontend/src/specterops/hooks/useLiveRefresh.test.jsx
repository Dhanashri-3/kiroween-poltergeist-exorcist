import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLiveRefresh, isFullVerificationPayload } from './useLiveRefresh.js';
import { ApiError } from '../../api/client.js';
import { build, ev, stateEv, healthOk, passVerification, INC } from '../../components/testHelpers.js';

const T0 = '2024-01-01T00:00:00.000Z';
const rec = (incidentId, state = 'detected', updatedAt = T0) => ({
  incidentId, state, component: 'button', detectedAt: T0, updatedAt, evidenceRefs: [], plans: [],
  gateDecisions: [], attempts: [], attemptCount: 0, needsRollbackVerification: false,
});
const known = (...ids) => [['incidents', { incidents: ids.map((id) => rec(id)) }]];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const notFound = (code) => new ApiError({ status: 404, code, message: 'Not found.' });

function makeClient(overrides = {}) {
  return {
    getHealth: vi.fn(async () => healthOk),
    getIncident: vi.fn(async (id) => rec(id)),
    getVerification: vi.fn(async (id) => ({ ...passVerification, incidentId: id })),
    ...overrides,
  };
}

/** Mounts the hook with a fixed client/dispatch/onError. `push(state)` re-renders with new reducer state. */
function mount({ state = build([], known(INC)), client = makeClient(), ready = true, wrapper, ...rest } = {}) {
  const dispatch = vi.fn();
  const onError = vi.fn();
  const base = { dispatch, client, onError, ...rest };
  const view = renderHook((p) => useLiveRefresh(p), { initialProps: { ...base, state, ready }, wrapper });
  const push = (next, nextReady = ready) => act(() => { view.rerender({ ...base, state: next, ready: nextReady }); });
  return { ...view, client, dispatch, onError, push };
}

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const dispatched = (dispatch, endpoint) => dispatch.mock.calls.map((c) => c[0]).filter((a) => a.endpoint === endpoint);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useLiveRefresh: health refresh', () => {
  it.each(['chaos.injection', 'detection', 'cleared', 'repair', 'rollback', 'recovery', 'reset'])(
    'a live %s Event refreshes health with the existing action shape', async (type) => {
      const { client, dispatch, push } = mount();
      push(build([ev(1, type, {}, { incidentId: null })], known(INC)));
      expect(client.getHealth).not.toHaveBeenCalled(); // debounced
      await tick(300);
      expect(client.getHealth).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({ kind: 'api', endpoint: 'health', response: healthOk });
    },
  );

  it('coalesces a burst of Events into one request', async () => {
    const { client, push } = mount();
    push(build([ev(1, 'repair', {}, { incidentId: null }), ev(2, 'rollback', {}, { incidentId: null }), ev(3, 'reset', {}, { incidentId: null })], known(INC)));
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for Events that were already present (history) or for unrelated types', async () => {
    const history = build([ev(1, 'chaos.injection', {}, { incidentId: null })], known(INC));
    const { client, push } = mount({ state: history });
    await tick(1000);
    expect(client.getHealth).not.toHaveBeenCalled();
    push(build([ev(1, 'chaos.injection', {}, { incidentId: null }), ev(2, 'chaos.selection', {}, { incidentId: null })], known(INC)));
    await tick(1000);
    expect(client.getHealth).not.toHaveBeenCalled();
  });

  it('treats Events present when it becomes ready as history (ready=false first)', async () => {
    const withHistory = build([ev(1, 'detection', {}, { incidentId: null })], known(INC));
    const { client, push } = mount({ state: withHistory, ready: false });
    push(withHistory, true);
    await tick(1000);
    expect(client.getHealth).not.toHaveBeenCalled();
    push(build([ev(1, 'detection', {}, { incidentId: null }), ev(2, 'cleared', {}, { incidentId: null })], known(INC)), true);
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
  });
});

describe('useLiveRefresh: incident ids', () => {
  it('a detection with incidentId null never requests an invented incident', async () => {
    const { client, push } = mount({ state: build([]) });
    push(build([ev(1, 'detection', { check: 'button' }, { incidentId: null, component: 'button' })]));
    await tick(10_000);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(client.getIncident).not.toHaveBeenCalled();
    expect(client.getVerification).not.toHaveBeenCalled();
  });

  it('an unknown incident in live Events triggers one detail fetch and dispatches it', async () => {
    const { client, dispatch, push } = mount({ state: build([]) });
    push(build([stateEv(1, 'detected', 'inc-new')]));
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(client.getIncident.mock.calls[0][0]).toBe('inc-new');
    expect(dispatched(dispatch, 'incident')).toEqual([{ kind: 'api', endpoint: 'incident', response: rec('inc-new') }]);
  });

  it('an unknown incident already in history is looked up once, not on every render', async () => {
    const state = build([ev(1, 'diagnosis', {}, { incidentId: 'inc-old' })]);
    const { client, push } = mount({ state });
    push(state);
    push(build([ev(1, 'diagnosis', {}, { incidentId: 'inc-old' })]));
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(client.getIncident.mock.calls[0][0]).toBe('inc-old');
  });

  it.each(['incident.state', 'diagnosis', 'plan', 'gate', 'repair', 'verification', 'rollback', 'escalation', 'recovery'])(
    'a %s Event for a known incident refreshes its details', async (type) => {
      const { client, push } = mount();
      const payload = type === 'incident.state' ? { to: 'investigating' } : type === 'verification' ? passVerification : {};
      push(build([ev(1, type, payload)], known(INC)));
      await tick(300);
      expect(client.getIncident).toHaveBeenCalledTimes(1);
      expect(client.getIncident.mock.calls[0][0]).toBe(INC);
    },
  );

  it('a 404 incident_not_found does not crash, reports nothing and pauses lookups', async () => {
    const client = makeClient({ getIncident: vi.fn(async () => { throw notFound('incident_not_found'); }) });
    const { dispatch, onError, push } = mount({ state: build([]), client, cooldownMs: 5000 });
    push(build([stateEv(1, 'detected', 'inc-x')]));
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(dispatched(dispatch, 'incident')).toEqual([]);

    push(build([stateEv(1, 'detected', 'inc-x'), stateEv(2, 'investigating', 'inc-x')]));
    await tick(1000);
    expect(client.getIncident).toHaveBeenCalledTimes(1); // inside the cooldown

    await tick(5000);
    push(build([stateEv(1, 'detected', 'inc-x'), stateEv(2, 'investigating', 'inc-x'), stateEv(3, 'planned', 'inc-x')]));
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(2); // after the cooldown
  });
});

describe('useLiveRefresh: verification', () => {
  it('a full Verification_Result in the Event causes no verification fetch', async () => {
    const { client, push } = mount();
    push(build([ev(1, 'verification', passVerification)], known(INC)));
    await tick(5000);
    expect(client.getVerification).not.toHaveBeenCalled();
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an omitted {ref, bytes} payload', { ref: 'x.payload.json', bytes: 70000 }],
    ['a payload without verificationId', { incidentId: INC, overall: 'pass' }],
  ])('%s triggers one verification fetch', async (_label, payload) => {
    const { client, dispatch, push } = mount();
    push(build([ev(1, 'verification', payload)], known(INC)));
    await tick(300);
    expect(client.getVerification).toHaveBeenCalledTimes(1);
    expect(client.getVerification.mock.calls[0][0]).toBe(INC);
    expect(dispatched(dispatch, 'verification')).toHaveLength(1);
  });

  it('a 404 verification_not_found is a normal state: no crash, no error report', async () => {
    const client = makeClient({ getVerification: vi.fn(async () => { throw notFound('verification_not_found'); }) });
    const { onError, dispatch, push } = mount({ client });
    push(build([ev(1, 'verification', { ref: 'x.payload.json', bytes: 70000 })], known(INC)));
    await tick(10_000);
    expect(client.getVerification).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(dispatched(dispatch, 'verification')).toEqual([]);
  });

  it('isFullVerificationPayload accepts only complete results', () => {
    expect(isFullVerificationPayload(passVerification)).toBe(true);
    expect(isFullVerificationPayload({ ref: 'r', bytes: 1 })).toBe(false);
    expect(isFullVerificationPayload({ ...passVerification, overall: 'maybe' })).toBe(false);
    expect(isFullVerificationPayload(null)).toBe(false);
  });
});

describe('useLiveRefresh: terminal states', () => {
  it.each(['recovered', 'escalated'])('%s refreshes health and incident at once, then settles once ~2 s later', async (to) => {
    const { client, push } = mount();
    push(build([stateEv(1, to)], known(INC)));
    await tick(0);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    await tick(1999);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(client.getHealth).toHaveBeenCalledTimes(2);
    expect(client.getIncident).toHaveBeenCalledTimes(2);
    await tick(20_000);
    expect(client.getHealth).toHaveBeenCalledTimes(2); // no polling afterwards
    expect(client.getIncident).toHaveBeenCalledTimes(2);
  });

  it('rolled_back is not terminal: one incident refresh, no health refresh, no settling refresh', async () => {
    const { client, push } = mount();
    push(build([stateEv(1, 'rolled_back')], known(INC)));
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    await tick(20_000);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(client.getHealth).not.toHaveBeenCalled();
  });
});

describe('useLiveRefresh: races, aborts and stale data', () => {
  it('a superseded response never overwrites the newer one', async () => {
    const first = deferred();
    const second = deferred();
    const getIncident = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { dispatch, push } = mount({ client: makeClient({ getIncident }) });
    push(build([stateEv(1, 'recovered')], known(INC)));
    await tick(0); // request 1 in flight
    await tick(2000); // settling request 2 supersedes it
    expect(getIncident).toHaveBeenCalledTimes(2);
    expect(getIncident.mock.calls[0][1].signal.aborted).toBe(true);

    second.resolve(rec(INC, 'recovered', '2024-01-01T00:00:20.000Z'));
    await tick(0);
    first.resolve(rec(INC, 'verifying', '2024-01-01T00:00:10.000Z')); // late, superseded
    await tick(0);
    expect(dispatched(dispatch, 'incident').map((a) => a.response.state)).toEqual(['recovered']);
  });

  it('a response with an older updatedAt than the last dispatched one is dropped', async () => {
    const getIncident = vi.fn()
      .mockResolvedValueOnce(rec(INC, 'planned', '2024-01-01T00:00:10.000Z'))
      .mockResolvedValueOnce(rec(INC, 'investigating', '2024-01-01T00:00:05.000Z'));
    const { dispatch, push } = mount({ client: makeClient({ getIncident }) });
    push(build([stateEv(1, 'planned')], known(INC)));
    await tick(300);
    push(build([stateEv(1, 'planned'), ev(2, 'gate', {})], known(INC)));
    await tick(300);
    expect(getIncident).toHaveBeenCalledTimes(2);
    expect(dispatched(dispatch, 'incident').map((a) => a.response.state)).toEqual(['planned']);
  });

  it('an aborted request is ignored: no dispatch, no error report', async () => {
    const getHealth = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const { dispatch, onError, push, unmount } = mount({ client: makeClient({ getHealth }) });
    push(build([ev(1, 'reset', {}, { incidentId: null })], known(INC)));
    await tick(300);
    expect(getHealth).toHaveBeenCalledTimes(1);
    unmount();
    await tick(0);
    expect(getHealth.mock.calls[0][0].signal.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('useLiveRefresh: errors and retries', () => {
  it('retries an ApiError after 1, 2 and 4 s (3 retries), then reports one [SYSTEM] failure', async () => {
    const getHealth = vi.fn(async () => { throw new ApiError({ status: 500, code: 'internal_error', message: 'Boom.' }); });
    const { onError, dispatch, push } = mount({ client: makeClient({ getHealth }) });
    push(build([ev(1, 'repair', {}, { incidentId: null })], known(INC)));
    await tick(300);
    expect(getHealth).toHaveBeenCalledTimes(1);
    await tick(999);
    expect(getHealth).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(getHealth).toHaveBeenCalledTimes(2);
    await tick(2000);
    expect(getHealth).toHaveBeenCalledTimes(3);
    await tick(4000);
    expect(getHealth).toHaveBeenCalledTimes(4);
    await tick(30_000);
    expect(getHealth).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
    const report = onError.mock.calls[0][0];
    expect(report.tag).toBe('SYSTEM');
    expect(report.text).toMatch(/^\[SYSTEM\] Live refresh of health failed after 4 attempts: Boom\. \(internal_error\)$/);
    expect(report).toMatchObject({ key: 'health', code: 'internal_error', status: 500, attempts: 4 });
    expect(dispatched(dispatch, 'health')).toEqual([]);
  });

  it('a successful retry dispatches and reports nothing', async () => {
    const getHealth = vi.fn()
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'network_error', message: 'offline' }))
      .mockResolvedValueOnce(healthOk);
    const { onError, dispatch, push } = mount({ client: makeClient({ getHealth }) });
    push(build([ev(1, 'cleared', {}, { incidentId: null })], known(INC)));
    await tick(300);
    await tick(1000);
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(dispatched(dispatch, 'health')).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a non-ApiError is reported at once without retries', async () => {
    const getHealth = vi.fn(async () => { throw new TypeError('bad'); });
    const { onError, push } = mount({ client: makeClient({ getHealth }) });
    push(build([ev(1, 'cleared', {}, { incidentId: null })], known(INC)));
    await tick(300);
    await tick(10_000);
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].attempts).toBe(1);
  });

  it('a throwing onError callback does not break the hook', async () => {
    const getHealth = vi.fn(async () => { throw new TypeError('bad'); });
    const { push } = mount({ client: makeClient({ getHealth }), onError: () => { throw new Error('callback'); } });
    push(build([ev(1, 'cleared', {}, { incidentId: null })], known(INC)));
    await tick(300); // must not throw; never hand act()'s thenable to expect(...).resolves
    expect(getHealth).toHaveBeenCalledTimes(1);
  });
});

describe('useLiveRefresh: cleanup and lifecycle', () => {
  it('unmount before the debounce fires sends nothing and leaves no timers', async () => {
    const { client, push, unmount } = mount();
    push(build([ev(1, 'reset', {}, { incidentId: null })], known(INC)));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(client.getHealth).not.toHaveBeenCalled();
  });

  it('unmount clears a pending settling refresh and pending retries', async () => {
    const getIncident = vi.fn(async () => { throw new ApiError({ status: 500, code: 'internal_error', message: 'x' }); });
    const { client, push, unmount } = mount({ client: makeClient({ getIncident }) });
    push(build([stateEv(1, 'escalated')], known(INC)));
    await tick(0);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(getIncident).toHaveBeenCalledTimes(1);
  });

  it('works under StrictMode without duplicate requests', async () => {
    const { client, push } = mount({ wrapper: StrictMode });
    push(build([ev(1, 'reset', {}, { incidentId: null })], known(INC)));
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
  });

  it('uses the latest dispatch and onError after a re-render without resubscribing', async () => {
    const client = makeClient();
    const first = vi.fn();
    const second = vi.fn();
    const props = { client, dispatch: first, state: build([], known(INC)), ready: true };
    const view = renderHook((p) => useLiveRefresh(p), { initialProps: props });
    act(() => { view.rerender({ ...props, dispatch: second, state: build([ev(1, 'reset', {}, { incidentId: null })], known(INC)) }); });
    await tick(300);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ kind: 'api', endpoint: 'health', response: healthOk });
  });
});

// ---- Phase 4B.2.1 regressions -------------------------------------------------------------------------------

const failing = () => new ApiError({ status: 500, code: 'internal_error', message: 'Boom.' });
/** Reducer state with `n` live reset Events (health-only trigger, incidentId null). */
const resets = (n) => build(Array.from({ length: n }, (_, i) => ev(i + 1, 'reset', {}, { incidentId: null })), known(INC));

describe('useLiveRefresh: retry budget per resource and episode', () => {
  it('bursts of Events during every backoff never reset the budget: 4 attempts, one report, then silence', async () => {
    const getHealth = vi.fn(async () => { throw failing(); });
    const { onError, push } = mount({ client: makeClient({ getHealth }) });
    let n = 1;
    push(resets(n));
    await tick(300); // attempt 1 fails -> retry in 1 s
    expect(getHealth).toHaveBeenCalledTimes(1);

    // A burst inside each backoff window. Before the fix every burst restarted the chain at attempt 0.
    for (const backoff of [1000, 2000, 4000]) {
      for (let i = 0; i < 3; i += 1) {
        n += 1;
        push(resets(n));
        await tick(100);
      }
      await tick(backoff - 300);
    }
    expect(getHealth).toHaveBeenCalledTimes(4);

    for (let i = 0; i < 5; i += 1) { // the episode is over; nothing is pending, nothing retries by itself
      await tick(10_000);
    }
    expect(getHealth).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ key: 'health', attempts: 4 });
  });

  it('a request superseded while in flight (aborted) consumes no retry attempt', async () => {
    const getHealth = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(failing()), 500);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const { onError, push } = mount({ client: makeClient({ getHealth }) });
    push(resets(1));
    await tick(300); // request 1 in flight
    push(resets(2)); // a new trigger while it is in flight
    await tick(300); // request 2 supersedes request 1
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(getHealth.mock.calls[0][0].signal.aborted).toBe(true);

    await tick(60_000);
    expect(getHealth).toHaveBeenCalledTimes(5); // 1 aborted + 4 real attempts
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].attempts).toBe(4); // the aborted request was not counted
  });

  it('a success ends the episode, so a later failure starts with a fresh budget', async () => {
    const getHealth = vi.fn()
      .mockRejectedValueOnce(failing())
      .mockResolvedValueOnce(healthOk)
      .mockRejectedValue(failing());
    const { onError, dispatch, push } = mount({ client: makeClient({ getHealth }) });
    push(resets(1));
    await tick(300);
    await tick(1000); // retry succeeds
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(dispatched(dispatch, 'health')).toHaveLength(1);

    push(resets(2)); // a genuinely new episode
    await tick(300);
    await tick(1000 + 2000 + 4000);
    expect(getHealth).toHaveBeenCalledTimes(6); // 2 + 1 + 3 retries
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].attempts).toBe(4); // the first failure was not carried over
  });

  it('after the budget is spent, only a new trigger starts another bounded episode', async () => {
    const getHealth = vi.fn(async () => { throw failing(); });
    const { onError, push } = mount({ client: makeClient({ getHealth }) });
    push(resets(1));
    await tick(300 + 1000 + 2000 + 4000);
    expect(getHealth).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);

    push(resets(2));
    await tick(300 + 1000 + 2000 + 4000);
    await tick(30_000);
    expect(getHealth).toHaveBeenCalledTimes(8);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a failing incident refresh does not consume or delay the health budget', async () => {
    const getIncident = vi.fn(async () => { throw failing(); });
    const { client, dispatch, onError, push } = mount({ client: makeClient({ getIncident }) });
    push(build([ev(1, 'repair', {})], known(INC))); // health + incident
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(getIncident).toHaveBeenCalledTimes(1);

    push(build([ev(1, 'repair', {}), ev(2, 'reset', {}, { incidentId: null })], known(INC))); // incident is in backoff
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(2); // health runs at once, unaffected
    expect(getIncident).toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(getIncident).toHaveBeenCalledTimes(4);
    expect(client.getHealth).toHaveBeenCalledTimes(2);
    expect(dispatched(dispatch, 'health')).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ key: `incident:${INC}`, attempts: 4 });
  });

  it('a terminal refresh during backoff keeps the budget bounded', async () => {
    const getIncident = vi.fn(async () => { throw failing(); });
    const { onError, push } = mount({ client: makeClient({ getIncident }) });
    push(build([stateEv(1, 'verifying')], known(INC)));
    await tick(300); // incident attempt 1 fails -> backoff
    push(build([stateEv(1, 'verifying'), stateEv(2, 'escalated')], known(INC))); // immediate + settling refresh
    await tick(60_000);
    expect(getIncident.mock.calls.length).toBeLessThanOrEqual(5); // 1 episode of 4, plus at most the settling call
    expect(onError.mock.calls.every(([r]) => r.attempts <= 4)).toBe(true);
  });

  it('unmount during backoff leaves no timers and makes no further attempts', async () => {
    const getHealth = vi.fn(async () => { throw failing(); });
    const { onError, push, unmount } = mount({ client: makeClient({ getHealth }) });
    push(resets(1));
    await tick(300);
    expect(getHealth).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('useLiveRefresh: subscription review', () => {
  it('ready=false initiates no requests at all, even for new Events and unknown incidents', async () => {
    const { client, push } = mount({ state: build([ev(1, 'diagnosis', {}, { incidentId: 'inc-u' })]), ready: false });
    push(build([ev(1, 'diagnosis', {}, { incidentId: 'inc-u' }), ev(2, 'reset', {}, { incidentId: null })]), false);
    await tick(30_000);
    expect(client.getHealth).not.toHaveBeenCalled();
    expect(client.getIncident).not.toHaveBeenCalled();
    expect(client.getVerification).not.toHaveBeenCalled();
  });

  it('StrictMode: an unknown incident in history is fetched exactly once (regression)', async () => {
    const { client } = mount({ state: build([ev(1, 'diagnosis', {}, { incidentId: 'inc-old' })]), wrapper: StrictMode });
    await tick(300);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
    expect(client.getIncident.mock.calls[0][0]).toBe('inc-old');
    await tick(30_000);
    expect(client.getIncident).toHaveBeenCalledTimes(1);
  });

  it('StrictMode: a terminal state produces exactly one immediate and one settling refresh', async () => {
    const { client, push } = mount({ wrapper: StrictMode });
    push(build([stateEv(1, 'recovered')], known(INC)));
    await tick(30_000);
    expect(client.getHealth).toHaveBeenCalledTimes(2);
    expect(client.getIncident).toHaveBeenCalledTimes(2);
  });

  it('never constructs an EventSource', async () => {
    const EventSourceSpy = vi.fn();
    vi.stubGlobal('EventSource', EventSourceSpy);
    try {
      const { push } = mount();
      push(build([ev(1, 'chaos.injection', {}, { incidentId: null }), stateEv(2, 'escalated')], known(INC)));
      await tick(30_000);
      expect(EventSourceSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the latest client after a re-render without restarting the engine', async () => {
    const a = makeClient();
    const b = makeClient();
    const dispatch = vi.fn();
    const props = { client: a, dispatch, state: build([], known(INC)), ready: true };
    const view = renderHook((p) => useLiveRefresh(p), { initialProps: props });
    act(() => { view.rerender({ ...props, client: b }); });
    act(() => { view.rerender({ ...props, client: b, state: resets(1) }); });
    await tick(300);
    expect(a.getHealth).not.toHaveBeenCalled();
    expect(b.getHealth).toHaveBeenCalledTimes(1);
  });

  it('history stays history: only Events after the first ready render trigger refreshes', async () => {
    const history = resets(3);
    const { client, push } = mount({ state: history });
    push(resets(3)); // same Events, new state object
    await tick(1000);
    expect(client.getHealth).not.toHaveBeenCalled();
    push(resets(4));
    await tick(300);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
  });
});
