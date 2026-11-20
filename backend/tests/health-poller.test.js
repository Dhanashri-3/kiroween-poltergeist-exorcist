import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMonitor, interpretHealth, createGuardedEvidenceWriter, DEFAULT_INTERVAL_MS } from '../src/monitor/health-poller.js';
import { createPlaywrightCapturer } from '../src/monitor/playwright-capturer.js';
import { createFileGuard } from '../src/file-guard/file-guard.js';

const healthy = () => ({
  httpStatus: 200,
  body: { status: 'ok', components: { button: { status: 'ok' }, layout: { status: 'ok' }, dataPanel: { status: 'ok' }, card: { status: 'ok' } } }
});
const cardFailing = () => ({
  httpStatus: 200,
  body: {
    status: 'degraded',
    components: { button: { status: 'ok' }, layout: { status: 'ok' }, dataPanel: { status: 'ok' }, card: { status: 'fail', error: 'card broken' } }
  }
});

function setup({ responses, capturer, writeFile, incidentOpen = false } = {}) {
  const queue = [...responses];
  const events = [];
  const reports = [];
  const files = {};
  let ids = 0;
  const monitor = createMonitor({
    fetchHealth: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    eventLog: { append: async (e) => { events.push(e); return e; } },
    incidentManager: { report: async (d) => { reports.push(d); }, hasOpenIncident: async () => incidentOpen },
    capturer: capturer === undefined
      ? { capture: async ({ component }) => ({ consoleErrors: ['boom token=abc'], domSnapshot: `<div data-c="${component}"></div>`, screenshot: Buffer.from('png') }) }
      : capturer,
    writeFile: writeFile ?? (async (name, data) => { files[name] = data; return `/evidence/${name}`; }),
    idFactory: () => `ev-${++ids}`,
    now: () => new Date('2025-01-01T00:00:00Z')
  });
  return { monitor, events, reports, files };
}

describe('Monitor health polling', () => {
  it('defaults to a 2 second interval and does nothing while healthy', async () => {
    const { monitor, events, reports } = setup({ responses: [healthy(), healthy(), healthy()] });
    expect(monitor.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_INTERVAL_MS).toBe(2000);
    for (let i = 0; i < 3; i++) await monitor.tick();
    expect(events).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('detects after two consecutive failures, captures evidence, records the Event and reports', async () => {
    const { monitor, events, reports, files } = setup({ responses: [cardFailing(), cardFailing()] });
    await monitor.tick();
    expect(events).toEqual([]);
    await monitor.tick();

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe('detection');
    expect(ev.component).toBe('card');
    const evidence = ev.payload.evidence;
    expect(evidence.healthCheckResults.find((r) => r.healthCheckId === 'card')).toMatchObject({ status: 'fail', error: 'card broken' });
    expect(evidence.consoleErrors[0]).not.toContain('abc'); // redacted
    expect(evidence.domSnapshotRef).toBe('/evidence/ev-1.dom.html');
    expect(evidence.screenshotPath).toBe('/evidence/ev-1.png');
    expect(Object.keys(files).sort()).toEqual(['ev-1.dom.html', 'ev-1.png']);
    expect(files['ev-1.dom.html']).toContain('data-c="card"');
    expect(JSON.stringify(ev)).not.toMatch(/chaos|scenario/i);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ component: 'card', kind: 'failure' });
  });

  it('records transient for one failure followed by a pass, with no report', async () => {
    const { monitor, events, reports } = setup({ responses: [cardFailing(), healthy()] });
    await monitor.tick();
    await monitor.tick();
    expect(events.map((e) => `${e.type}:${e.component}`)).toEqual(['transient:card']);
    expect(reports).toEqual([]);
  });

  it('records cleared after two passes following a detection when no Incident is open', async () => {
    const { monitor, events } = setup({ responses: [cardFailing(), cardFailing(), healthy(), healthy()] });
    for (let i = 0; i < 4; i++) await monitor.tick();
    expect(events.filter((e) => e.component === 'card').map((e) => e.type)).toEqual(['detection', 'cleared']);
  });

  it('withholds cleared while an Incident references the check', async () => {
    const { monitor, events } = setup({ responses: [cardFailing(), cardFailing(), healthy(), healthy()], incidentOpen: true });
    for (let i = 0; i < 4; i++) await monitor.tick();
    expect(events.some((e) => e.type === 'cleared')).toBe(false);
  });

  it('reports an availability failure immediately when the app is unreachable', async () => {
    const { monitor, events, reports } = setup({ responses: [new Error('ECONNREFUSED')] });
    await monitor.tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'detection', component: 'app' });
    expect(events[0].payload.kind).toBe('availability');
    expect(events[0].payload.evidence.healthCheckResults[0]).toMatchObject({ status: 'unreachable' });
    expect(reports[0].kind).toBe('availability');
  });

  it('still reports the detection with placeholders when capture or storage fails', async () => {
    const { monitor, events, reports } = setup({
      responses: [cardFailing(), cardFailing()],
      capturer: { capture: async () => { throw new Error('no browser'); } }
    });
    await monitor.tick();
    await monitor.tick();
    const evidence = events[0].payload.evidence;
    expect(evidence.domSnapshotRef).toBe('unavailable');
    expect(evidence.screenshotPath).toBe('unavailable');
    expect(evidence.captureProblems[0]).toContain('no browser');
    expect(reports).toHaveLength(1);
  });

  it('never throws from tick and forwards errors to onError', async () => {
    const errors = [];
    const m = createMonitor({
      fetchHealth: async () => cardFailing(),
      eventLog: { append: async () => { throw new Error('disk full'); } },
      incidentManager: { report: async () => {} },
      writeFile: async () => 'x',
      onError: (e) => errors.push(e.message)
    });
    await m.tick();
    await m.tick();
    expect(errors).toContain('disk full');
  });

  it('schedules ticks with the injected timer and stops cleanly', async () => {
    const timers = [];
    let fetches = 0;
    const m = createMonitor({
      fetchHealth: async () => { fetches++; return healthy(); },
      eventLog: { append: async () => {} },
      incidentManager: { report: async () => {} },
      writeFile: async () => 'x',
      intervalMs: 500,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {}
    });
    m.start();
    expect(timers.map((t) => t.ms)).toEqual([500]);
    await timers[0].fn();
    expect(fetches).toBe(1);
    expect(timers).toHaveLength(2);
    await m.stop();
    expect(m.running).toBe(false);
  });

  it('interpretHealth treats a non-200 or malformed response as an app failure', () => {
    expect(interpretHealth({ httpStatus: 500, body: null }).results.get('app')).toBe('fail');
    expect(interpretHealth(healthy()).results.get('dataPanel')).toBe('pass');
  });
});

describe('Playwright capturer (injected fake)', () => {
  it('collects console errors, component DOM and screenshot, and closes the context', async () => {
    let closed = false;
    const page = {
      on(evt, cb) { if (evt === 'console') cb({ type: () => 'error', text: () => 'bad thing' }); },
      goto: async () => {},
      waitForTimeout: async () => {},
      $: async (sel) => (sel === '#test-card' ? { evaluate: async (fn) => fn({ outerHTML: '<div id="test-card"></div>' }) } : null),
      screenshot: async () => Buffer.from('img')
    };
    const fake = { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => { closed = true; } }), close: async () => {} }) } };
    const cap = createPlaywrightCapturer({ baseUrl: 'http://127.0.0.1:1', loadPlaywright: async () => fake, settleMs: 0 });
    const out = await cap.capture({ component: 'card' });
    expect(out.consoleErrors).toEqual(['bad thing']);
    expect(out.domSnapshot).toBe('<div id="test-card"></div>');
    expect(out.screenshot.toString()).toBe('img');
    expect(closed).toBe(true);
    await cap.close();
  });
});

describe('guarded evidence writer', () => {
  it('writes inside the storage directory and denies other callers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    try {
      const testapp = path.join(root, 'testapp');
      fs.mkdirSync(testapp);
      const dir = path.join(root, 'storage-data', 'evidence');
      const guard = createFileGuard({ testappDir: testapp, approvedFiles: [], storageDirs: [path.join(root, 'storage-data')] });
      const write = createGuardedEvidenceWriter({ directory: dir, fileGuard: guard });
      const p = await write('a.png', Buffer.from('x'));
      expect(fs.readFileSync(p, 'utf8')).toBe('x');
      await expect(write('../escape.png', 'x')).rejects.toThrow();
      const denied = createGuardedEvidenceWriter({ directory: dir, fileGuard: guard, caller: 'poltergeist' });
      await expect(denied('b.png', 'x')).rejects.toThrow(/File_Guard denied/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
