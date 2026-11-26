import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSharedChaosGuard } from './useSharedChaosGuard.js';

afterEach(cleanup);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const IN_PROGRESS = { code: 'request_in_progress', message: 'Another request is already in progress.' };

/**
 * Runs fn inside one awaited async act() and returns { value } or { error }. Never pass act()'s thenable to
 * expect(...).resolves: that leaves React's act scope open and later renders stop flushing effects.
 */
async function settle(fn) {
  let out;
  await act(async () => {
    try {
      out = { value: await fn() };
    } catch (error) {
      out = { error };
    }
  });
  return out;
}

function setup(overrides = {}) {
  const startChaos = vi.fn(() => Promise.resolve({ runId: 'run-1' }));
  const reset = vi.fn(() => Promise.resolve({ reset: true }));
  const props = { startChaos, reset, ...overrides };
  const view = renderHook((p) => useSharedChaosGuard(p), { initialProps: props });
  return { ...view, startChaos: props.startChaos, reset: props.reset };
}

describe('useSharedChaosGuard: pass-through', () => {
  it('passes a chaos request and its argument through unchanged', async () => {
    const { result, startChaos } = setup();
    expect(await settle(() => result.current.startChaos('button-failure'))).toEqual({ value: { runId: 'run-1' } });
    expect(startChaos).toHaveBeenCalledTimes(1);
    expect(startChaos).toHaveBeenLastCalledWith('button-failure');
    await settle(() => result.current.startChaos(undefined));
    expect(startChaos).toHaveBeenLastCalledWith(undefined);
  });

  it('passes a reset request through unchanged', async () => {
    const { result, reset } = setup();
    expect(await settle(() => result.current.reset())).toEqual({ value: { reset: true } });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('returns the original result, not a fabricated one', async () => {
    const { result } = setup({ startChaos: vi.fn(() => Promise.resolve('exactly-this')) });
    expect(await settle(() => result.current.startChaos())).toEqual({ value: 'exactly-this' });
  });

  it('wraps a non-promise return value', async () => {
    const { result } = setup({ reset: vi.fn(() => 42) });
    expect(await settle(() => result.current.reset())).toEqual({ value: 42 });
  });
});

describe('useSharedChaosGuard: one shared guard', () => {
  it('rejects a second chaos request while one is in flight and does not call the function', async () => {
    const gate = deferred();
    const { result, startChaos } = setup({ startChaos: vi.fn(() => gate.promise) });
    let first;
    act(() => { first = result.current.startChaos('a'); });
    await expect(result.current.startChaos('b')).rejects.toMatchObject(IN_PROGRESS);
    expect(startChaos).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve({ runId: 'r' }); await first; });
  });

  it('rejects reset while chaos is in flight, and chaos while reset is in flight', async () => {
    const chaosGate = deferred();
    const resetGate = deferred();
    const { result, startChaos, reset } = setup({
      startChaos: vi.fn(() => chaosGate.promise),
      reset: vi.fn(() => resetGate.promise),
    });

    let chaos;
    act(() => { chaos = result.current.startChaos(); });
    await expect(result.current.reset()).rejects.toMatchObject(IN_PROGRESS);
    expect(reset).not.toHaveBeenCalled();
    await act(async () => { chaosGate.resolve({}); await chaos; });

    let resetting;
    act(() => { resetting = result.current.reset(); });
    await expect(result.current.startChaos()).rejects.toMatchObject(IN_PROGRESS);
    expect(startChaos).toHaveBeenCalledTimes(1);
    await act(async () => { resetGate.resolve({}); await resetting; });
  });

  it('rejects with an Error that carries the code', async () => {
    const gate = deferred();
    const { result } = setup({ startChaos: vi.fn(() => gate.promise) });
    act(() => { result.current.startChaos(); });
    const error = await result.current.reset().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('request_in_progress');
    gate.resolve({});
  });

  it('blocks synchronously, before React re-renders', () => {
    const gate = deferred();
    const { result, startChaos } = setup({ startChaos: vi.fn(() => gate.promise) });
    act(() => {
      result.current.startChaos();
      result.current.startChaos().catch(() => {});
    });
    expect(startChaos).toHaveBeenCalledTimes(1);
    gate.resolve({});
  });
});

describe('useSharedChaosGuard: release', () => {
  it('releases after success, before the caller sees the result', async () => {
    const { result, startChaos } = setup();
    await settle(() => result.current.startChaos('a'));
    expect(await settle(() => result.current.startChaos('b'))).toEqual({ value: { runId: 'run-1' } });
    expect(startChaos).toHaveBeenCalledTimes(2);
  });

  it('releases after failure and passes the original error through', async () => {
    const apiError = Object.assign(new Error('busy'), { code: 'incident_active', status: 409 });
    const startChaos = vi.fn().mockRejectedValueOnce(apiError).mockResolvedValueOnce({ runId: 'r2' });
    const { result } = setup({ startChaos });
    expect((await settle(() => result.current.startChaos())).error).toBe(apiError);
    expect(await settle(() => result.current.startChaos())).toEqual({ value: { runId: 'r2' } });
    expect(startChaos).toHaveBeenCalledTimes(2);
  });

  it('releases after a synchronous throw and rethrows it unchanged', async () => {
    const boom = new Error('sync boom');
    const reset = vi.fn().mockImplementationOnce(() => { throw boom; }).mockResolvedValueOnce({});
    const { result } = setup({ reset });
    let thrown = null;
    act(() => {
      try { result.current.reset(); } catch (error) { thrown = error; }
    });
    expect(thrown).toBe(boom);
    expect(await settle(() => result.current.reset())).toEqual({ value: {} });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('reports busy while a request is pending and clears it afterwards', async () => {
    const gate = deferred();
    const { result } = setup({ reset: vi.fn(() => gate.promise) });
    expect(result.current.busy).toBe(false);
    let pending;
    act(() => { pending = result.current.reset(); });
    expect(result.current.busy).toBe(true);
    await act(async () => { gate.resolve({}); await pending; });
    expect(result.current.busy).toBe(false);
  });

  it('does not set state after unmount', async () => {
    const gate = deferred();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = setup({ reset: vi.fn(() => gate.promise) });
    let pending;
    act(() => { pending = result.current.reset(); });
    unmount();
    gate.resolve({});
    await pending;
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('useSharedChaosGuard: stable wrappers', () => {
  it('keeps function identity across renders and calls the latest function', async () => {
    const first = vi.fn(() => Promise.resolve('first'));
    const second = vi.fn(() => Promise.resolve('second'));
    const { result, rerender } = setup({ startChaos: first });
    const before = result.current.startChaos;
    rerender({ startChaos: second, reset: vi.fn() });
    expect(result.current.startChaos).toBe(before);
    expect(await settle(() => result.current.startChaos())).toEqual({ value: 'second' });
    expect(first).not.toHaveBeenCalled();
  });

  it('rejects clearly when a wrapped function is missing', async () => {
    const { result } = setup({ reset: undefined });
    await expect(result.current.reset()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('useSharedChaosGuard: Phase 4B.2.1 review', () => {
  it('under StrictMode both functions still share one guard and release it', async () => {
    const gate = deferred();
    const startChaos = vi.fn(() => gate.promise);
    const reset = vi.fn(() => Promise.resolve({ reset: true }));
    const { result } = renderHook((p) => useSharedChaosGuard(p), {
      initialProps: { startChaos, reset },
      wrapper: StrictMode,
    });
    let pending;
    act(() => { pending = result.current.startChaos('s'); });
    const blocked = await result.current.reset().catch((e) => e);
    expect(blocked).toMatchObject(IN_PROGRESS);
    expect(reset).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    await act(async () => { gate.resolve({ runId: 'r' }); await pending; });
    expect(result.current.busy).toBe(false);
    expect(await settle(() => result.current.reset())).toEqual({ value: { reset: true } });
  });

  it('passes every argument through unchanged', async () => {
    const { result, startChaos } = setup();
    const arg = { nested: true };
    await settle(() => result.current.startChaos('a', arg, 3));
    expect(startChaos).toHaveBeenLastCalledWith('a', arg, 3);
    expect(startChaos.mock.calls[0][1]).toBe(arg);
  });
});
