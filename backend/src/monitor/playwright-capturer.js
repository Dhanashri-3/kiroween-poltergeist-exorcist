// Playwright-backed evidence capturer for the Monitor (Task 5.4; Requirement 5.4).
// The Monitor owns its own browser context. Playwright is loaded lazily so unit tests (and a
// backend without the package installed) never need a browser. Pass `loadPlaywright` to inject.
//
// capture({ component }) opens the Test_App page, collects console errors and page errors, then
// returns the DOM snapshot of the affected component (whole <body> for the `app` check) and a
// full-page screenshot buffer. It never writes files; the Monitor stores the returned data.

export const COMPONENT_SELECTORS = Object.freeze({
  button: '#test-button',
  layout: '#layout-section',
  dataPanel: '#data-panel',
  card: '#test-card',
  app: 'body'
});

async function defaultLoadPlaywright() {
  // Resolved at runtime; Playwright is on the approved dependency list but installed separately.
  const name = 'playwright';
  return import(name);
}

export function createPlaywrightCapturer({
  baseUrl,
  selectors = COMPONENT_SELECTORS,
  loadPlaywright = defaultLoadPlaywright,
  navigationTimeoutMs = 3000,
  settleMs = 300
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new TypeError('baseUrl is required.');
  let browser = null;

  async function getBrowser() {
    if (!browser) {
      const pw = await loadPlaywright();
      browser = await (pw.chromium ?? pw.default?.chromium).launch();
    }
    return browser;
  }

  return {
    async capture({ component }) {
      const b = await getBrowser();
      const context = await b.newContext();
      try {
        const page = await context.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(String(err?.message ?? err)));
        await page.goto(baseUrl, { timeout: navigationTimeoutMs, waitUntil: 'load' });
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        const selector = selectors[component] ?? selectors.app;
        const handle = await page.$(selector);
        const domSnapshot = handle ? await handle.evaluate((el) => el.outerHTML) : `<!-- ${component}: element not found -->`;
        const screenshot = await page.screenshot({ fullPage: true });
        return { consoleErrors, domSnapshot, screenshot };
      } finally {
        await context.close();
      }
    },
    async close() {
      if (browser) await browser.close();
      browser = null;
    }
  };
}
