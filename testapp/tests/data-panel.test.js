import { loadSource, fakeDocument, startServer } from './helpers.js';

describe('data panel component', () => {
  const panel = loadSource('public/data-panel.js');
  let app;

  beforeAll(async () => { app = await startServer(); });
  afterAll(async () => { await app.close(); });

  const fetchFromApp = (url) => fetch(app.base + url);

  it('requests the items endpoint', () => {
    expect(panel.ENDPOINT).toBe('/api/items');
  });

  it('renders items, escapes names and handles empty data', () => {
    const html = panel.render([{ id: 1, name: '<i>Ghost</i>' }]);
    expect(html).toContain('&lt;i&gt;Ghost&lt;/i&gt;');
    expect(panel.render([])).toBe('<p>No data</p>');
  });

  it('loads items from the real mock API', async () => {
    const doc = fakeDocument(['data-panel-content']);
    await panel.load(fetchFromApp, doc);
    const out = doc.els['data-panel-content'].innerHTML;
    expect(out).toContain('Ghost Lantern');
    expect(out).toContain('Haunted Mirror');
    expect(out).not.toContain('Failed to load');
  });

  it('shows an error message when the request fails', async () => {
    const doc = fakeDocument(['data-panel-content']);
    await panel.load(() => Promise.resolve({ ok: false, status: 500 }), doc);
    expect(doc.els['data-panel-content'].textContent).toBe('Failed to load data: HTTP 500');
  });
});

describe('mock API', () => {
  let app;
  beforeAll(async () => { app = await startServer(); });
  afterAll(async () => { await app.close(); });

  it('GET /api/items returns HTTP 200 with a non-empty items array', async () => {
    const res = await fetch(`${app.base}/api/items`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toEqual({ id: 1, name: 'Ghost Lantern' });
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await fetch(`${app.base}/api/items`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
