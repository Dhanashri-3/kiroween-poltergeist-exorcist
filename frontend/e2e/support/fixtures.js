import { test as base, expect } from '@playwright/test';
import { FakeApi } from './fake-api.js';
import { DASHBOARD_ORIGIN, FAKE_API_PORT } from './ports.js';

/** Playwright `test` with a `fake` fixture: a fresh FAKE API (see fake-api.js) per test. */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  fake: async ({}, use) => {
    const fake = new FakeApi({ port: FAKE_API_PORT, dashboardOrigin: DASHBOARD_ORIGIN });
    await fake.start();
    await use(fake);
    await fake.stop();
  },
});

export { expect };

/** Opens the Dashboard and waits until the event stream reports connected. */
export async function openDashboard(page) {
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'connected');
}
