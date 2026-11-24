/**
 * UI-CONTRACT tests against a FAKE API (e2e/support/fake-api.js). NOT the real-backend acceptance
 * of Task 14.8 (blocked by Task 15.2). The fake never creates Events on its own: POST /chaos-runs
 * and POST /reset only answer, so any displayed change must come from Events the test pushes.
 */
import { test, expect, openDashboard } from './support/fixtures.js';

const SUITE = 'UI-contract vs FAKE API (not real-backend acceptance): ';
const startButton = (page) => page.getByRole('button', { name: 'Start chaos', exact: true });
const resetButton = (page) => page.getByRole('button', { name: 'Reset', exact: true });

async function expectBaselineUnchanged(page) {
  await expect(page.getByTestId('health-status')).toHaveText('ok');
  await expect(page.getByTestId('idle')).toBeVisible();
  await expect(page.getByTestId('incident-panel')).toHaveCount(0);
  await expect(page.getByTestId('incidents-empty')).toBeVisible();
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
}

test.describe(`${SUITE}chaos controls`, () => {
  test('Start chaos with a chosen scenario sends that scenarioId', async ({ page, fake }) => {
    await openDashboard(page);
    await page.getByTestId('scenario-select').selectOption({ label: 'Card layout broken' });
    await startButton(page).click();
    await expect(page.getByTestId('control-notice')).toContainText('Chaos run request accepted');
    const posts = fake.requestsTo('POST', '/chaos-runs');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ scenarioId: 'card-layout-broken' });
  });

  test('Start chaos with "Random scenario" sends no scenarioId', async ({ page, fake }) => {
    await openDashboard(page);
    await startButton(page).click();
    await expect(page.getByTestId('control-notice')).toContainText('runId run-fake-1');
    const posts = fake.requestsTo('POST', '/chaos-runs');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({});
  });

  test('Start chaos alone changes no displayed health or Incident state (Req 15.8)', async ({ page, fake }) => {
    fake.delays.chaos = 800;
    await openDashboard(page);
    await expectBaselineUnchanged(page);

    await startButton(page).click();
    await expect(page.getByTestId('control-pending')).toBeVisible();
    await expectBaselineUnchanged(page); // while the request is in flight

    await expect(page.getByTestId('control-notice')).toContainText('Chaos run request accepted');
    await expectBaselineUnchanged(page); // after the 202

    // A rejected request (409) changes nothing either.
    fake.forceError('chaos', 409, 'incident_active', 'An Incident is not terminal.', { incidentId: null });
    await startButton(page).click();
    await expect(page.getByTestId('control-error')).toContainText('incident_active');
    await expectBaselineUnchanged(page);

    // Only pushed Events change the display.
    fake.pushEvent({ type: 'chaos.selection', component: 'poltergeist', runId: 'run-x', payload: { scenarioId: 'card-layout-broken' } });
    await expect(page.getByTestId('timeline').getByTestId('event-row')).toHaveCount(1);
    await expect(page.getByTestId('timeline-empty')).toHaveCount(0);
  });

  test('Reset success shows a notice that does not claim a restored or healthy Test_App', async ({ page, fake }) => {
    await openDashboard(page);
    await resetButton(page).click();
    const notice = page.getByTestId('control-notice');
    await expect(notice).toContainText('Reset request accepted');
    await expect(notice).toContainText('does not confirm the Test_App is restored or healthy');
    expect(fake.requestsTo('POST', '/reset')).toHaveLength(1);
    await expectBaselineUnchanged(page);
  });

  test('Reset 409 shows the conflict and changes nothing', async ({ page, fake }) => {
    fake.forceError('reset', 409, 'incident_active', 'An Incident is not terminal.', { incidentId: 'incident-1' });
    await openDashboard(page);
    await resetButton(page).click();
    const error = page.getByTestId('control-error');
    await expect(error).toContainText('still active');
    await expect(error).toContainText('incident_active');
    await expect(page.getByTestId('control-notice')).toHaveCount(0);
    await expectBaselineUnchanged(page);
  });

  test('Reset 500 shows the error and changes nothing', async ({ page, fake }) => {
    fake.forceError('reset', 500, 'internal_error', 'Unexpected failure.');
    await openDashboard(page);
    await resetButton(page).click();
    await expect(page.getByTestId('control-error')).toContainText('internal_error');
    await expect(page.getByTestId('control-notice')).toHaveCount(0);
    await expectBaselineUnchanged(page);
  });

  test('a double click on Reset sends one request', async ({ page, fake }) => {
    fake.delays.reset = 600;
    await openDashboard(page);
    await resetButton(page).dblclick();
    await expect(page.getByTestId('control-notice')).toContainText('Reset request accepted');
    expect(fake.requestsTo('POST', '/reset')).toHaveLength(1);
  });

  test('a double click on Start chaos sends one request', async ({ page, fake }) => {
    fake.delays.chaos = 600;
    await openDashboard(page);
    await startButton(page).dblclick();
    await expect(page.getByTestId('control-notice')).toContainText('Chaos run request accepted');
    expect(fake.requestsTo('POST', '/chaos-runs')).toHaveLength(1);
  });
});
