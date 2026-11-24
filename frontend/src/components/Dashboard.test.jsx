import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import Dashboard from './Dashboard.jsx';
import { build, ev, stateEv, healthOk, passVerification, INC } from './testHelpers.js';

afterEach(cleanup);

const conn = (status = 'connected', error = null) => ({ status, error, lastSeq: 0 });
const noop = () => Promise.resolve({});
const show = (state, { connection = conn(), onStartChaos = noop, onReset = noop } = {}) =>
  render(<Dashboard state={state} connection={connection} onStartChaos={onStartChaos} onReset={onReset} />);

const scenarios = { scenarios: [{ id: 's1', label: 'Break cart', severity: 'low' }, { id: 's2', label: 'Break header', severity: 'high' }] };
const outcomeOf = () => screen.getByTestId('outcome').getAttribute('data-outcome');

describe('health panel', () => {
  it('shows each component and overall status', () => {
    show(build([], [['health', healthOk]]));
    expect(screen.getAllByTestId('health-component').map((n) => n.getAttribute('data-component'))).toEqual(['header', 'cart']);
    expect(screen.getByTestId('health-status').textContent).toBe('ok');
    expect(screen.getByTestId('health-http').textContent).toContain('200');
  });

  it('handles null components', () => {
    show(build([], [['health', { status: 'degraded', testApp: { reachable: false, httpStatus: null, components: null, error: 'down' }, storage: { ok: true } }]]));
    expect(screen.getByTestId('health-components-null')).toBeTruthy();
    expect(screen.getByTestId('health-reachable').textContent).toBe('unreachable');
  });

  it('shows degraded status and storage errors', () => {
    show(build([], [['health', { status: 'degraded', testApp: { reachable: true, httpStatus: 500, components: { cart: 'down' } }, storage: { ok: false, error: 'disk' } }]]));
    expect(screen.getByTestId('health-status').textContent).toBe('degraded');
    expect(screen.getByTestId('health-storage').textContent).toContain('disk');
  });
});

describe('scenario controls', () => {
  it('lists scenarios and starts a chosen scenario, then random, then reset', async () => {
    const onStartChaos = vi.fn(() => Promise.resolve({ runId: 'r' }));
    const onReset = vi.fn(() => Promise.resolve({}));
    show(build([], [['scenarios', scenarios]]), { onStartChaos, onReset });
    expect(screen.getAllByTestId('scenario-item')).toHaveLength(2);
    fireEvent.change(screen.getByTestId('scenario-select'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start chaos' }));
    await waitFor(() => expect(screen.getByTestId('control-notice')).toBeTruthy());
    expect(onStartChaos).toHaveBeenLastCalledWith('s2');
    fireEvent.change(screen.getByTestId('scenario-select'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start chaos' }));
    await waitFor(() => expect(onStartChaos).toHaveBeenCalledTimes(2));
    expect(onStartChaos).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });

  it('shows the 409 incident_active error and leaves health and incident display unchanged', async () => {
    const err = Object.assign(new Error('An incident is active'), { code: 'incident_active', status: 409 });
    const onStartChaos = vi.fn(() => Promise.reject(err));
    show(build([], [['health', healthOk], ['scenarios', scenarios]]), { onStartChaos });
    fireEvent.click(screen.getByRole('button', { name: 'Start chaos' }));
    const alert = await screen.findByTestId('control-error');
    expect(alert.textContent).toContain('An incident is active');
    expect(alert.textContent).toContain('incident_active');
    expect(screen.getByTestId('health-status').textContent).toBe('ok');
    expect(screen.getByTestId('idle')).toBeTruthy();
  });

  it('disables buttons only while the request is in flight', async () => {
    let resolve;
    const onReset = vi.fn(() => new Promise((r) => { resolve = r; }));
    show(build(), { onReset });
    const resetBtn = screen.getByRole('button', { name: 'Reset' });
    expect(resetBtn.disabled).toBe(false);
    fireEvent.click(resetBtn);
    await waitFor(() => expect(resetBtn.disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Start chaos' }).disabled).toBe(true);
    resolve({});
    await waitFor(() => expect(resetBtn.disabled).toBe(false));
  });

  it('shows an empty scenario state', () => {
    show(build());
    expect(screen.getByTestId('scenarios-empty')).toBeTruthy();
  });
});

describe('timeline', () => {
  it('orders rows by seq and renders omitted payloads', () => {
    const events = [
      ev(3, 'detection', { a: 1 }, { incidentId: null }),
      ev(1, 'chaos.injection', {}, { incidentId: null, component: 'poltergeist' }),
      ev(2, 'diagnosis', { ref: 'x.payload.json', bytes: 70000 }, { incidentId: INC }),
    ];
    show(build(events));
    const rows = within(screen.getByTestId('timeline')).getAllByTestId('event-row');
    expect(rows.map((r) => r.getAttribute('data-seq'))).toEqual(['1', '2', '3']);
    expect(within(rows[0]).getByTestId('event-component').textContent).toBe('poltergeist');
    expect(within(rows[1]).getByTestId('event-incident').textContent).toBe(INC);
    expect(within(rows[1]).getByTestId('payload-omitted').textContent).toBe('payload omitted (70000 bytes)');
    expect(screen.getByTestId('timeline').getAttribute('aria-live')).toBe('polite');
  });

  it('shows an empty state with no events', () => {
    show(build());
    expect(screen.getByTestId('timeline-empty')).toBeTruthy();
    expect(screen.getByTestId('incidents-empty')).toBeTruthy();
  });
});

describe('incident outcomes', () => {
  it('idle: no incident, shows latest known health', () => {
    show(build([], [['health', healthOk]]));
    expect(screen.getByTestId('idle')).toBeTruthy();
    expect(screen.getAllByTestId('health-component')).toHaveLength(2);
    expect(screen.queryByTestId('incident-panel')).toBeNull();
  });

  it('active incident shows state, component, attempts', () => {
    const state = build(
      [stateEv(1, 'detected'), stateEv(2, 'investigating')],
      [['incidents', { incidents: [{ incidentId: INC, state: 'detected', detectedAt: '2024-01-01T00:00:00.000Z', component: 'cart', evidenceRefs: ['ev-1'], plans: [], gateDecisions: [], attempts: [], attemptCount: 2, needsRollbackVerification: false, updatedAt: '2024-01-01T00:00:00.000Z' }] }]],
    );
    show(state);
    expect(outcomeOf()).toBe('active');
    expect(screen.getByTestId('incident-state').textContent).toBe('investigating');
    expect(screen.getByTestId('incident-component').textContent).toBe('cart');
    expect(screen.getByTestId('incident-attempts').textContent).toBe('2');
    expect(screen.getByTestId('evidence-item').textContent).toBe('ev-1');
  });

  it('recovered is shown with its supporting verification panel', () => {
    const state = build([
      ev(1, 'diagnosis', { status: 'accepted', diagnosis: { rootCause: 'bad prop' } }),
      ev(2, 'plan', { plan: { incidentId: INC, actionType: 'text_replace', targetFile: 'src/Cart.jsx', change: { find: 'oops', replace: 'ok' }, rationale: 'fix' }, source: 'llm', rejected: false }),
      ev(3, 'gate', { decision: 'approve' }),
      ev(4, 'repair', { incidentId: INC, target: 'src/Cart.jsx', snapshotId: 'snap1', preChecksum: 'a'.repeat(64), postChecksum: 'b'.repeat(64), snapshotChecksums: {} }),
      ev(5, 'verification', passVerification),
      stateEv(6, 'recovered'),
    ]);
    show(state);
    expect(outcomeOf()).toBe('recovered');
    const panel = screen.getByTestId('recovery-verification');
    expect(panel.getAttribute('data-overall')).toBe('pass');
    expect(screen.getByTestId('plan-preview-lines').textContent).toContain('- oops');
    expect(screen.getByTestId('plan-preview-lines').textContent).toContain('+ ok');
    expect(screen.getByTestId('repair-pre').textContent).toBe('a'.repeat(64));
    expect(screen.getByTestId('plan-item').textContent).toContain('text_replace');
    expect(screen.getAllByTestId('gate-item')).toHaveLength(1);
  });

  it('unverified recovery claim is clearly not a recovery', () => {
    show(build([stateEv(1, 'recovered')]));
    expect(outcomeOf()).toBe('unverified_recovery_claim');
    expect(screen.getByTestId('outcome').textContent).toContain('NOT VERIFIED');
    expect(screen.queryByTestId('recovery-verification')).toBeNull();
    expect(screen.queryByText(/Recovered \(verified\)/)).toBeNull();
  });

  it('escalated shows reason and rollback evidence, distinct from recovery', () => {
    const state = build([
      ev(1, 'rollback', { status: 'verified', reason: 'verification_failed', snapshotId: 'snap1', mismatches: [] }),
      ev(2, 'escalation', { incidentId: INC, reason: 'attempts_exhausted', plans: [], verificationResults: [], attemptCount: 3 }),
      stateEv(3, 'escalated'),
    ]);
    show(state);
    expect(outcomeOf()).toBe('escalated');
    expect(screen.getByTestId('escalation-reason').textContent).toContain('attempts_exhausted');
    expect(screen.getByTestId('rollback-item').getAttribute('data-status')).toBe('verified');
    expect(screen.queryByTestId('recovery-verification')).toBeNull();
    expect(screen.getByTestId('outcome').className).toContain('outcome--escalated');
  });

  it('rolled_back shows rollback evidence', () => {
    show(build([ev(1, 'rollback', { status: 'verified', reason: 'x', snapshotId: 's' }), stateEv(2, 'rolled_back')]));
    expect(outcomeOf()).toBe('rolled_back');
    expect(screen.getByTestId('rollback-list')).toBeTruthy();
  });

  it('says the plan preview is not available when the plan has no find/replace', () => {
    show(build([
      ev(1, 'plan', { plan: { incidentId: INC, actionType: 'x', targetFile: 'f', change: { lines: [1, 2] }, rationale: 'r' }, rejected: false }),
      ev(2, 'repair', { incidentId: INC, target: 'f', snapshotId: 's', preChecksum: 'a', postChecksum: 'b', snapshotChecksums: {} }),
      stateEv(3, 'verifying'),
    ]));
    expect(screen.getByTestId('plan-preview-unavailable')).toBeTruthy();
    expect(screen.getByTestId('repair-post').textContent).toBe('b');
  });
});

describe('past incident selection', () => {
  const two = () => build([
    ev(1, 'detection', { n: 1 }, { incidentId: 'inc-a' }),
    stateEv(2, 'escalated', 'inc-a'),
    ev(3, 'detection', { n: 2 }, { incidentId: 'inc-b' }),
    stateEv(4, 'detected', 'inc-b'),
  ], [['incidents', { incidents: [{ incidentId: 'inc-a', state: 'escalated', detectedAt: '2024-01-01T00:00:00.000Z', component: 'cart', evidenceRefs: ['evidence-a'], plans: [], gateDecisions: [], attempts: [], attemptCount: 3, needsRollbackVerification: false, updatedAt: '2024-01-01T00:00:00.000Z' }] }]]);

  it('defaults to the current incident and lets the user view a past one with its events and evidence', () => {
    show(two());
    expect(screen.getByTestId('incident-panel').textContent).toContain('inc-b');
    const badges = screen.getAllByTestId('incident-item').map((n) => [n.textContent, n.getAttribute('data-outcome')]);
    expect(badges.find(([t]) => t.includes('inc-a'))[1]).toBe('escalated');
    fireEvent.click(screen.getByRole('button', { name: 'inc-a' }));
    expect(screen.getByTestId('incident-panel').textContent).toContain('Past incident');
    const rows = within(screen.getByTestId('incident-events')).getAllByTestId('event-row');
    expect(rows.map((r) => r.getAttribute('data-seq'))).toEqual(['1', '2']);
    expect(screen.getByTestId('evidence-item').textContent).toBe('evidence-a');
    fireEvent.click(screen.getByRole('button', { name: 'Back to current incident' }));
    expect(screen.getByTestId('incident-panel').textContent).toContain('inc-b');
  });
});

describe('connection and loading states', () => {
  it.each([['connected', 'Connected'], ['disconnected', 'Disconnected'], ['connecting', 'Connecting'], ['closed', 'Closed']])(
    'shows %s', (status, text) => {
      show(build([], [['health', healthOk]]), { connection: conn(status) });
      const node = screen.getByTestId('connection-status');
      expect(node.getAttribute('data-status')).toBe(status);
      expect(node.textContent).toContain(text);
      expect(node.getAttribute('aria-live')).toBe('polite');
    },
  );

  it('shows the hook error text', () => {
    show(build(), { connection: conn('disconnected', 'The event stream was interrupted') });
    expect(screen.getByTestId('connection-error').textContent).toContain('interrupted');
  });

  it('shows loading before the first data and hides it afterwards', () => {
    const { unmount } = show(build(), { connection: conn('connecting') });
    expect(screen.getByTestId('loading')).toBeTruthy();
    unmount();
    show(build([], [['health', healthOk]]), { connection: conn('connecting') });
    expect(screen.queryByTestId('loading')).toBeNull();
  });

  it('shows health unavailable when there is no health data', () => {
    show(build(), { connection: conn('connected') });
    expect(screen.getByTestId('health-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('loading')).toBeNull();
  });
});
