/**
 * UI-CONTRACT tests against a FAKE API (e2e/support/fake-api.js). These are NOT the real-backend
 * acceptance run of Task 14.8 (blocked by Task 15.2: no backend entry point yet). Every failure,
 * Event and "Verification_Result" below is synthetic and written by the test. Nothing here shows
 * that a real recovery happened.
 *
 * Req 15.10 limitation: the real `repair` Event has checksums only, so the Dashboard shows a
 * "Repair record" plus a "Plan-derived preview (NOT the actual file change)". An actual before/after
 * diff is not possible and is never asserted.
 */
import { test, expect, openDashboard } from './support/fixtures.js';
import { pushInjectionAndDetection, pushRecoveredIncident } from './support/synthetic-incidents.js';

const SUITE = 'UI-contract vs FAKE API (not real-backend acceptance): ';

test.describe(`${SUITE}baseline, failure and recovery display`, () => {
  test('shows a loading state, then the baseline healthy state', async ({ page, fake }) => {
    fake.delays.snapshot = 800;
    await page.goto('/');
    await expect(page.getByTestId('loading')).toBeVisible();
    await expect(page.getByTestId('health-status')).toHaveText('ok');
    await expect(page.getByTestId('loading')).toHaveCount(0);
    await expect(page.getByTestId('health-reachable')).toHaveText('reachable');
    await expect(page.getByTestId('health-http')).toContainText('200');
    await expect(page.getByTestId('health-storage')).toHaveText('ok');
    await expect(page.getByTestId('health-component')).toHaveCount(4);
    await expect(page.getByTestId('idle')).toBeVisible();
    await expect(page.getByTestId('incidents-empty')).toBeVisible();
    await expect(page.getByTestId('timeline-empty')).toBeVisible();
    await expect(page.getByTestId('scenario-item')).toHaveCount(2);
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'connected');
  });

  test('displays one injected failure (synthetic Events) on the Dashboard', async ({ page, fake }) => {
    await openDashboard(page);
    pushInjectionAndDetection(fake, { incidentId: 'incident-1', runId: 'run-1' });

    const incident = page.getByTestId('incident-panel');
    await expect(incident).toHaveAttribute('data-outcome', 'active');
    await expect(page.getByTestId('incident-state')).toHaveText('detected');
    const types = page.getByTestId('timeline').getByTestId('event-type');
    await expect(types).toHaveText(['chaos.selection', 'chaos.injection', 'detection', 'incident.state']);
    await expect(page.getByTestId('incident-outcome-badge')).toHaveText('active');

    // Health is fetched on load; a fresh load shows what GET /health now says.
    fake.setHealth({
      status: 'degraded',
      testApp: { reachable: true, httpStatus: 500, components: { button: 'failing', layout: 'ok', dataPanel: 'ok', card: 'ok' } },
      storage: { ok: true },
    });
    await page.reload();
    await expect(page.getByTestId('health-status')).toHaveText('degraded');
    // The Incident record (component) is also read from the API at load time.
    await expect(page.getByTestId('incident-component')).toHaveText('button');
    await expect(page.getByTestId('health-component').filter({ hasText: 'button' })).toContainText('failing');
  });

  test('shows a recovered Incident with its Verification_Result (synthetic Events only)', async ({ page, fake }) => {
    await openDashboard(page);
    pushRecoveredIncident(fake, { incidentId: 'incident-1', runId: 'run-1' });

    const outcome = page.getByTestId('outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'recovered');
    await expect(outcome).toContainText('Recovered (verified)');
    const verification = page.getByTestId('recovery-verification');
    await expect(verification).toBeVisible();
    await expect(verification).toHaveAttribute('data-overall', 'pass');
    await expect(verification).toContainText('Verification_Result');
    await expect(verification).toContainText('verification-synthetic-1');
    await expect(page.getByTestId('recovery-verification-link')).toBeVisible();
    await expect(verification.getByTestId('verification-check')).toHaveCount(1);
    await expect(page.getByTestId('incident-outcome-badge')).toHaveText('recovered');
  });
});
