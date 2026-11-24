/**
 * UI-CONTRACT tests against a FAKE API (e2e/support/fake-api.js). NOT the real-backend acceptance
 * of Task 14.8 (blocked by Task 15.2). All Incidents, repairs, rollbacks and Verification_Results
 * are synthetic Events written by the tests.
 *
 * Req 15.10: the `repair` Event carries checksums only. The Dashboard shows a "Repair record" and a
 * "Plan-derived preview (NOT the actual file change)". These tests never expect an actual diff and
 * check that the text "applied diff" is absent.
 */
import { test, expect, openDashboard } from './support/fixtures.js';
import {
  CHECKSUM_AFTER, CHECKSUM_BEFORE,
  pushEscalatedIncident, pushRecoveredIncident, pushRolledBackIncident, pushUnverifiedRecoveryClaim,
} from './support/synthetic-incidents.js';

const SUITE = 'UI-contract vs FAKE API (not real-backend acceptance): ';

test.describe(`${SUITE}Incident outcome views`, () => {
  test('escalated Incident shows the reason and the rollback evidence', async ({ page, fake }) => {
    await openDashboard(page);
    pushEscalatedIncident(fake, { incidentId: 'incident-esc', runId: 'run-1', reason: 'verification failed twice (synthetic)' });
    await expect(page.getByTestId('outcome')).toHaveAttribute('data-outcome', 'escalated');
    await expect(page.getByTestId('escalation-reason')).toContainText('verification failed twice (synthetic)');
    const rollback = page.getByTestId('rollback-item');
    await expect(rollback).toHaveCount(1);
    await expect(rollback).toHaveAttribute('data-status', 'restored');
    await expect(rollback).toContainText('snapshot-synthetic-1');
    await expect(page.getByText('Recovered (verified)')).toHaveCount(0);
  });

  test('rolled_back Incident is shown as rolled back, not recovered', async ({ page, fake }) => {
    await openDashboard(page);
    pushRolledBackIncident(fake, { incidentId: 'incident-rb', runId: 'run-1' });
    await expect(page.getByTestId('outcome')).toHaveAttribute('data-outcome', 'rolled_back');
    await expect(page.getByTestId('outcome')).toContainText('Rolled back');
    await expect(page.getByTestId('rollback-item')).toHaveCount(1);
    await expect(page.getByText('Recovered (verified)')).toHaveCount(0);
  });

  test('a recovery claim without a passing verification is NOT VERIFIED and shows no recovered banner', async ({ page, fake }) => {
    await openDashboard(page);
    pushUnverifiedRecoveryClaim(fake, { incidentId: 'incident-claim', runId: 'run-1' });
    const outcome = page.getByTestId('outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'unverified_recovery_claim');
    await expect(outcome).toContainText('NOT VERIFIED');
    await expect(page.getByText('Recovered (verified)')).toHaveCount(0);
    await expect(page.getByTestId('recovery-verification')).toHaveCount(0);
    await expect(page.getByTestId('incident-outcome-badge')).toHaveText('unverified recovery claim');
  });

  test('repair record shows checksums and a plan-derived preview labelled as not the actual change', async ({ page, fake }) => {
    await openDashboard(page);
    pushRecoveredIncident(fake, { incidentId: 'incident-1', runId: 'run-1' });
    await expect(page.getByTestId('repair')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Repair record (from repair Event)' })).toBeVisible();
    await expect(page.getByTestId('repair-target')).toHaveText('testapp/src/Button.jsx');
    await expect(page.getByTestId('repair-snapshot')).toHaveText('snapshot-synthetic-1');
    await expect(page.getByTestId('repair-pre')).toHaveText(CHECKSUM_BEFORE);
    await expect(page.getByTestId('repair-post')).toHaveText(CHECKSUM_AFTER);
    await expect(page.getByTestId('repair-compare')).toHaveText('different');
    await expect(page.getByTestId('repair-snapshot-checksums')).toContainText(CHECKSUM_BEFORE);

    const preview = page.getByTestId('plan-preview');
    await expect(preview.getByRole('heading')).toHaveText('Plan-derived preview (NOT the actual file change)');
    await expect(preview.getByTestId('preview-removed-line')).toContainText('<button>');
    await expect(preview.getByTestId('preview-added-line')).toContainText('<button onClick={handle}>');
    await expect(page.getByText(/applied diff/i)).toHaveCount(0);
  });

  test('selecting a past Incident shows its details; Back returns to the current one', async ({ page, fake }) => {
    await openDashboard(page);
    pushRecoveredIncident(fake, { incidentId: 'incident-a', runId: 'run-a' });
    pushEscalatedIncident(fake, { incidentId: 'incident-b', runId: 'run-b' });

    await expect(page.getByTestId('incident-item')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: /Current incident/ })).toContainText('incident-b');
    await expect(page.getByTestId('outcome')).toHaveAttribute('data-outcome', 'escalated');

    await page.getByTestId('incident-list').getByRole('button', { name: 'incident-a' }).click();
    await expect(page.getByRole('heading', { name: /Past incident/ })).toContainText('incident-a');
    await expect(page.getByTestId('outcome')).toHaveAttribute('data-outcome', 'recovered');
    await expect(page.getByTestId('incident-panel').getByTestId('incident-events').getByTestId('event-row').first())
      .toBeVisible();

    await page.getByRole('button', { name: 'Back to current incident' }).click();
    await expect(page.getByRole('heading', { name: /Current incident/ })).toContainText('incident-b');
  });
});
