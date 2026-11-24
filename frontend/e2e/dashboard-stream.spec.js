/**
 * UI-CONTRACT tests against a FAKE API (e2e/support/fake-api.js). NOT the real-backend acceptance
 * of Task 14.8 (blocked by Task 15.2). The fake implements the documented SSE framing (retry, id,
 * named events) and resume rule (max of afterSeq and Last-Event-ID); it is not the real server.
 */
import { test, expect, openDashboard } from './support/fixtures.js';

const SUITE = 'UI-contract vs FAKE API (not real-backend acceptance): ';
const rows = (page) => page.getByTestId('timeline').getByTestId('event-row');
const seqs = async (page) => (await rows(page).evaluateAll((els) => els.map((e) => Number(e.dataset.seq))));

test.describe(`${SUITE}event stream`, () => {
  test('delivers history and live Events in seq order without duplicates', async ({ page, fake }) => {
    fake.pushEvent({ type: 'chaos.selection', component: 'poltergeist', runId: 'run-1', payload: {} });
    fake.pushEvent({ type: 'chaos.injection', component: 'poltergeist', runId: 'run-1', payload: {} });
    await openDashboard(page);
    await expect(rows(page)).toHaveCount(2);

    fake.pushEvent({ type: 'detection', component: 'monitor', incidentId: 'incident-1', runId: 'run-1', payload: {} });
    fake.pushEvent({ type: 'incident.state', component: 'incident-manager', incidentId: 'incident-1', runId: 'run-1', payload: { to: 'detected' } });
    await expect(rows(page)).toHaveCount(4);
    expect(await seqs(page)).toEqual([1, 2, 3, 4]);
    await expect(page.getByTestId('connection-status')).toContainText('last seq 4');
  });

  test('connection loss shows the disconnected indicator, then resumes from the last seq', async ({ page, fake }) => {
    await openDashboard(page);
    fake.pushEvent({ type: 'chaos.selection', component: 'poltergeist', runId: 'run-1', payload: {} });
    fake.pushEvent({ type: 'chaos.injection', component: 'poltergeist', runId: 'run-1', payload: {} });
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId('connection-status')).toContainText('last seq 2');

    // Lose the connection and keep refusing the stream so the indicator state is observable.
    fake.refuseStream = true;
    fake.dropStreams();
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'disconnected');
    await expect(page.getByTestId('connection-status')).toContainText('Disconnected');

    // An Event arrives while the Dashboard is disconnected; it must show up after the reconnect.
    fake.pushEvent({ type: 'detection', component: 'monitor', incidentId: 'incident-1', runId: 'run-1', payload: {} });
    fake.refuseStream = false;
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    await expect(rows(page)).toHaveCount(3);
    expect(await seqs(page)).toEqual([1, 2, 3]); // no duplicate rows

    // The reconnect asked the server to resume after the last seq it had seen (2).
    const accepted = fake.streamConnections.filter((c) => c.accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    const resumed = accepted.at(-1);
    expect(resumed.resume).toBe(2);
    expect(resumed.afterSeq === 2 || resumed.lastEventId === 2).toBe(true);
  });
});
