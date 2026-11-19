import { startServer } from './helpers.js';

describe('/health endpoint', () => {
  let app;
  beforeAll(async () => { app = await startServer(); });
  afterAll(async () => { await app.close(); });

  it('is bound to loopback only', () => {
    expect(app.server.address().address).toBe('127.0.0.1');
  });

  it('returns HTTP 200 JSON with status ok and every component ok', async () => {
    const res = await fetch(`${app.base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.components).toBeTypeOf('object');
    expect(Object.keys(body.components).sort()).toEqual(['button', 'card', 'dataPanel', 'layout']);
    for (const [name, result] of Object.entries(body.components)) {
      expect(result, `component ${name}`).toEqual({ status: 'ok' });
    }
    expect(body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  it('serves the page and its assets', async () => {
    const page = await fetch(`${app.base}/`);
    expect(page.status).toBe(200);
    for (const asset of ['button.js', 'card.js', 'data-panel.js', 'layout.css', 'button.css', 'card.css', 'data-panel.css']) {
      const res = await fetch(`${app.base}/${asset}`);
      expect(res.status, asset).toBe(200);
    }
    expect((await fetch(`${app.base}/missing.js`)).status).toBe(404);
  });
});
