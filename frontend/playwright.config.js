// Playwright config for the Dashboard UI-contract tests (Task 14.8).
// These tests run against a FAKE API harness (e2e/support/fake-api.js), not the real backend.
// See e2e/README.md. No browser is downloaded: the Chromium already in the Playwright cache
// (revision 1255, matching @playwright/test 1.65.1) is reused.
import { defineConfig } from '@playwright/test';
import { DASHBOARD_ORIGIN } from './e2e/support/ports.js';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  // One worker: the fake API listens on a fixed port, and each test starts and stops its own instance.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: DASHBOARD_ORIGIN,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/support/serve-dashboard.mjs',
    url: DASHBOARD_ORIGIN,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
