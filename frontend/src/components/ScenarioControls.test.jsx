import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import ScenarioControls from './ScenarioControls.jsx';

afterEach(cleanup);

const scenarios = [{ id: 's1', label: 'Break cart' }, { id: 's2', label: 'Break header' }];
const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });
const show = (props = {}) => render(
  <ScenarioControls scenarios={scenarios} onStartChaos={() => Promise.resolve({ runId: 'run-9' })}
    onReset={() => Promise.resolve({})} {...props} />,
);
const startBtn = () => screen.getByRole('button', { name: 'Start chaos' });
const resetBtn = () => screen.getByRole('button', { name: 'Reset' });

describe('start chaos', () => {
  it('sends the chosen scenarioId, and undefined for random', async () => {
    const onStartChaos = vi.fn(() => Promise.resolve({ runId: 'run-9' }));
    show({ onStartChaos });
    fireEvent.change(screen.getByTestId('scenario-select'), { target: { value: 's2' } });
    fireEvent.click(startBtn());
    await waitFor(() => expect(screen.getByTestId('control-notice').textContent).toContain('run-9'));
    expect(onStartChaos).toHaveBeenLastCalledWith('s2');
    fireEvent.change(screen.getByTestId('scenario-select'), { target: { value: '' } });
    fireEvent.click(startBtn());
    await waitFor(() => expect(onStartChaos).toHaveBeenCalledTimes(2));
    expect(onStartChaos).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to random when the selected scenario leaves the list', async () => {
    const onStartChaos = vi.fn(() => Promise.resolve({ runId: 'r' }));
    const { rerender } = show({ onStartChaos });
    fireEvent.change(screen.getByTestId('scenario-select'), { target: { value: 's2' } });
    rerender(<ScenarioControls scenarios={[scenarios[0]]} onStartChaos={onStartChaos} onReset={() => Promise.resolve({})} />);
    expect(screen.getByTestId('scenario-select').value).toBe('');
    fireEvent.click(startBtn());
    await waitFor(() => expect(onStartChaos).toHaveBeenCalledTimes(1));
    expect(onStartChaos).toHaveBeenLastCalledWith(undefined);
  });

  it('accepted notice does not claim a state change', async () => {
    show();
    fireEvent.click(startBtn());
    const notice = await screen.findByTestId('control-notice');
    expect(notice.textContent).toMatch(/accepted/i);
    expect(notice.textContent).toMatch(/Waiting for Events/);
    expect(notice.textContent).not.toMatch(/started|running|recovered|healthy/i);
  });

  it('409 incident_active shows a conflict message with the code', async () => {
    show({ onStartChaos: () => Promise.reject(apiError(409, 'incident_active', 'busy')) });
    fireEvent.click(startBtn());
    const alert = await screen.findByTestId('control-error');
    expect(alert.textContent).toContain('An Incident is still active; try again when it is terminal');
    expect(alert.textContent).toContain('incident_active');
    expect(screen.queryByTestId('control-notice')).toBeNull();
  });

  it('shows message and code for other errors and network errors', async () => {
    const onStartChaos = vi.fn()
      .mockRejectedValueOnce(apiError(503, 'storage_unavailable', 'Storage down'))
      .mockRejectedValueOnce(apiError(0, 'network_error', 'Failed to fetch'))
      .mockRejectedValueOnce(apiError(200, 'invalid_response', 'Bad body'));
    show({ onStartChaos });
    for (const [msg, code] of [['Storage down', 'storage_unavailable'], ['Failed to fetch', 'network_error'], ['Bad body', 'invalid_response']]) {
      fireEvent.click(startBtn());
      await waitFor(() => expect(screen.getByTestId('control-error').textContent).toContain(`${msg} (${code})`));
      await waitFor(() => expect(startBtn().disabled).toBe(false));
    }
  });

  it('survives a synchronous throw and a non-Error rejection', async () => {
    show({ onStartChaos: () => { throw new Error('sync boom'); } });
    fireEvent.click(startBtn());
    expect((await screen.findByTestId('control-error')).textContent).toContain('sync boom');
    cleanup();
    show({ onStartChaos: () => Promise.reject(undefined) });
    fireEvent.click(startBtn());
    expect((await screen.findByTestId('control-error')).textContent).toContain('Request failed.');
  });
});

describe('reset', () => {
  it('calls reset and shows an accepted notice that does not claim restoration', async () => {
    const onReset = vi.fn(() => Promise.resolve({}));
    show({ onReset });
    fireEvent.click(resetBtn());
    const notice = await screen.findByTestId('control-notice');
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(notice.textContent).toMatch(/accepted/i);
    expect(notice.textContent).toContain('does not confirm the Test_App is restored or healthy');
  });

  it('409 incident_active and other errors are shown with codes', async () => {
    const onReset = vi.fn()
      .mockRejectedValueOnce(apiError(409, 'incident_active', 'Incident active'))
      .mockRejectedValueOnce(apiError(500, 'internal_error', 'Server failed'));
    show({ onReset });
    fireEvent.click(resetBtn());
    await waitFor(() => expect(screen.getByTestId('control-error').textContent).toContain('still active'));
    await waitFor(() => expect(resetBtn().disabled).toBe(false));
    fireEvent.click(resetBtn());
    await waitFor(() => expect(screen.getByTestId('control-error').textContent).toContain('Server failed (internal_error)'));
  });
});

describe('pending state and guards', () => {
  it('shows aria-busy and progress text while pending, then clears them', async () => {
    let resolve;
    show({ onReset: () => new Promise((r) => { resolve = r; }) });
    fireEvent.click(resetBtn());
    await waitFor(() => expect(screen.getByTestId('control-pending').textContent).toBe('Request in progress...'));
    expect(screen.getByTestId('scenario-controls').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('control-feedback').getAttribute('aria-live')).toBe('polite');
    await act(async () => { resolve({}); });
    await waitFor(() => expect(screen.queryByTestId('control-pending')).toBeNull());
    expect(screen.getByTestId('scenario-controls').getAttribute('aria-busy')).toBe('false');
  });

  it('a second synchronous activation never calls the API twice', async () => {
    let resolve;
    const onStartChaos = vi.fn(() => new Promise((r) => { resolve = r; }));
    const onReset = vi.fn(() => Promise.resolve({}));
    show({ onStartChaos, onReset });
    fireEvent.click(startBtn());
    fireEvent.click(startBtn());
    fireEvent.click(resetBtn());
    expect(onStartChaos).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
    await act(async () => { resolve({ runId: 'x' }); });
    await waitFor(() => expect(startBtn().disabled).toBe(false));
    fireEvent.click(startBtn());
    expect(onStartChaos).toHaveBeenCalledTimes(2);
  });

  it('clears previous feedback when a new request starts', async () => {
    let resolve;
    const onReset = vi.fn()
      .mockRejectedValueOnce(apiError(500, 'internal_error', 'Server failed'))
      .mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    show({ onReset });
    fireEvent.click(resetBtn());
    await screen.findByTestId('control-error');
    await waitFor(() => expect(resetBtn().disabled).toBe(false));
    fireEvent.click(resetBtn());
    expect(screen.queryByTestId('control-error')).toBeNull();
    expect(screen.queryByTestId('control-notice')).toBeNull();
    await act(async () => { resolve({}); });
    await screen.findByTestId('control-notice');
  });

  it('ignores a result that arrives after unmount', async () => {
    let resolve;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = show({ onReset: () => new Promise((r) => { resolve = r; }) });
    fireEvent.click(resetBtn());
    unmount();
    await act(async () => { resolve({}); });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
