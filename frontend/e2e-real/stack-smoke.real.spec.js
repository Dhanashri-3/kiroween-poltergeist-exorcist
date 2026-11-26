/**
 * REAL-STACK smoke test (Task 17.1). No fake API, no mocked responses, no synthetic data.
 * Proves the three real processes are up and the real frontend reaches the real backend.
 * It injects no failure and makes no recovery claim.
 */
import { test, expect } from '@playwright/test';
import { TESTAPP_URL, API_BASE_URL, DASHBOARD_ORIGIN } from './support/stack.js';

test.describe('REAL-STACK smoke', () => {
  test('Test_App, backend and frontend are up and the Dashboard reaches the real backend', async ({ page, request }) => {
    // Process 1: the real Test_App, checked directly.
    const testApp = await request.get(`${TESTAPP_URL}/health`);
    expect(testApp.status()).toBe(200);
    const testAppBody = await testApp.json();
    expect(testAppBody.status).toBe('ok');

    // Process 2: the real backend, which reports on the Test_App itself.
    const backend = await request.get(`${API_BASE_URL}/health`);
    expect(backend.status()).toBe(200);
    const backendBody = await backend.json();
    expect(backendBody.status).toBe('ok');
    expect(backendBody.testApp.reachable).toBe(true);

    const scenarios = await (await request.get(`${API_BASE_URL}/scenarios`)).json();
    expect(scenarios.scenarios.length).toBeGreaterThan(0);
    const incidents = await (await request.get(`${API_BASE_URL}/incidents`)).json();
    expect(incidents.incidents).toEqual([]); // fresh throwaway storage

    // Process 3: the real frontend. Record every API request the page makes: all must go to the real backend.
    const apiRequests = [];
    page.on('request', (r) => { if (['fetch', 'xhr', 'eventsource'].includes(r.resourceType())) apiRequests.push(r.url()); });
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto('/');
    expect(page.url()).toBe(`${DASHBOARD_ORIGIN}/`);
    await expect(page.getByTestId('health-status')).toHaveText('ok');
    await expect(page.getByTestId('health-reachable')).toHaveText('reachable');
    await expect(page.getByTestId('health-component')).toHaveCount(4);
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'connected');
    // The scenario list on the page comes from GET /scenarios of the real backend.
    await expect(page.getByTestId('scenario-item')).toHaveCount(scenarios.scenarios.length);

    expect(apiRequests.length).toBeGreaterThan(0);
    for (const url of apiRequests) expect(url.startsWith(API_BASE_URL)).toBe(true);
    expect(consoleErrors.filter((t) => /CORS|blocked|Failed to load resource/i.test(t))).toEqual([]);
  });
});
