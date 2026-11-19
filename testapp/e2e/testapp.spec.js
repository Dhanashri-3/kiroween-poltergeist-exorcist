// Browser tests for the four Test_App components and /health (Task 2.3).
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page, baseURL }) => {
  // No external requests: abort anything that is not the local Test_App.
  const allowed = new URL(baseURL).origin;
  await page.route('**/*', (route) => {
    let origin = null;
    try { origin = new URL(route.request().url()).origin; } catch { /* non-URL requests are blocked */ }
    return origin === allowed ? route.continue() : route.abort();
  });
});

test.describe('button', () => {
  test('is visible, styled and counts clicks', async ({ page }) => {
    await page.goto('/');
    const button = page.locator('#test-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS('cursor', 'pointer');
    await expect(button).toHaveCSS('background-color', 'rgb(75, 59, 143)');
    await button.click();
    await button.click();
    await expect(page.locator('#button-output')).toHaveText('Clicked 2 times');
  });
});

test.describe('layout', () => {
  test('lays the section out as a two-column grid', async ({ page }) => {
    await page.goto('/');
    const layout = page.locator('.layout-section');
    await expect(layout).toBeVisible();
    await expect(layout).toHaveCSS('display', 'grid');
    const columns = await layout.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
  });
});

test.describe('data panel', () => {
  test('shows items loaded from the local mock API', async ({ page }) => {
    await page.goto('/');
    const items = page.locator('#data-panel-content li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toHaveText('Ghost Lantern');
    await expect(page.locator('#data-panel-content')).not.toContainText('Failed to load');
  });
});

test.describe('card', () => {
  test('is visible with its styling', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('#test-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.card-title')).toHaveText('Haunted Card');
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(card).toHaveCSS('border-top-width', '1px');
  });
});

test.describe('/health', () => {
  test('reports ok for the status and each of the four components', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    for (const name of ['button', 'layout', 'dataPanel', 'card']) {
      expect(body.components[name].status, name).toBe('ok');
    }
  });
});
