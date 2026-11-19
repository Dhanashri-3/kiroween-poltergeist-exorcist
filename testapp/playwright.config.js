// Playwright configuration for the Test_App baseline browser tests (Task 2.3).
// Pinned template: node testapp/node_modules/@playwright/test/cli.js test --config testapp/playwright.config.js
//
// The Test_App is started on 127.0.0.1 only, never on the live port 4100. Only Chromium is used.
// Tests make no external requests: the specs abort every request outside the base URL, and
// Chromium's host resolver fails every host name except loopback.
//
// Optional environment variables (used by backend/tests/baseline-detection.test.js so the same
// pinned command can test a temporary copy of the Test_App without touching the real files):
//   TESTAPP_E2E_PORT     port for the Test_App server under test (default 4101)
//   TESTAPP_E2E_APP_DIR  absolute path of the Test_App directory to serve (default: this directory)
// Test results are written inside the served directory, so a run against a copy leaves the real
// testapp/ unchanged.
const { defineConfig } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.TESTAPP_E2E_PORT) || 4101;
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === 4100) {
  throw new Error('TESTAPP_E2E_PORT must be an integer in 1024-65535 and not 4100');
}
const APP_DIR = process.env.TESTAPP_E2E_APP_DIR ? path.resolve(process.env.TESTAPP_E2E_APP_DIR) : __dirname;
if (!fs.existsSync(path.join(APP_DIR, 'server.js'))) {
  throw new Error('TESTAPP_E2E_APP_DIR does not contain server.js: ' + APP_DIR);
}
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15000,
  expect: { timeout: 5000 },
  // When PLAYWRIGHT_JSON_OUTPUT_NAME is set (backend detection tests), also write a JSON report
  // so failures are counted from structured data rather than parsed from list-reporter text.
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['list'], ['json']] : 'list',
  outputDir: path.join(APP_DIR, 'test-results'),
  use: {
    baseURL: BASE_URL,
    headless: true,
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] },
      },
    },
  ],
  webServer: {
    command: 'node server.js',
    cwd: APP_DIR,
    env: { TESTAPP_PORT: String(PORT) },
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
