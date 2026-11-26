// Playwright config for the REAL-STACK suite (Task 17). Separate from playwright.config.js, which runs
// the fake-API UI-contract tests in e2e/. Specs here run against the real Test_App, backend and
// frontend started by e2e-real/global-setup.mjs. They must never import e2e/support/fake-api.js,
// synthetic-incidents.js or mock responses.
// Run: node node_modules/@playwright/test/cli.js test --config playwright.real.config.js
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { DASHBOARD_ORIGIN, RUN_DIR } from './e2e-real/support/stack.js';

export default defineConfig({
  testDir: './e2e-real',
  testMatch: '**/*.real.spec.js',
  globalSetup: './e2e-real/global-setup.mjs',
  // One real stack, one Incident at a time (the backend allows one active Incident).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: path.join(RUN_DIR, 'playwright-report'), open: 'never' }]],
  outputDir: path.join(RUN_DIR, 'pw-output'),
  use: {
    baseURL: DASHBOARD_ORIGIN,
    headless: true,
    trace: 'retain-on-failure',
  },
  // The smoke test expects fresh storage (no Incidents), so it runs before any spec that creates one.
  projects: [
    { name: 'smoke', testMatch: '**/stack-smoke.real.spec.js' },
    { name: 'incidents', testIgnore: '**/stack-smoke.real.spec.js', dependencies: ['smoke'] },
  ],
});
