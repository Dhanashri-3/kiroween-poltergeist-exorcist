// Task 2.2: the pinned Health_Check script must fail closed.
// Hermetic: the script text is evaluated in a node:vm context with fetch, process and console
// stubbed, so no server or port 4100 is needed. One extra case spawns real `node -e` (no shell)
// to prove the component argument arrives as process.argv[1]; it needs no network.
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HEALTH_CHECK_SCRIPT,
  HEALTH_CHECK_SCRIPT_SHA256,
  DEFAULT_CONFIG_DIR,
} from '../src/orchestrator/config-loader.js';

const URL_UNDER_TEST = 'http://127.0.0.1:4100/health';
const healthy = () => ({
  status: 'ok',
  components: { button: { status: 'ok' }, layout: { status: 'ok' }, dataPanel: { status: 'ok' }, card: { status: 'ok' } },
});
const respond = (status, body) => () => Promise.resolve({
  status,
  ok: status >= 200 && status < 300,
  json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
});

async function run(argv, fetchImpl) {
  let exitCode = null;
  const stderr = [];
  const stdout = [];
  const urls = [];
  const sandbox = {
    process: { argv: ['node', ...argv], exit: (c) => { if (exitCode === null) exitCode = c; } },
    console: { error: (m) => stderr.push(String(m)), log: (m) => stdout.push(String(m)) },
    fetch: (url, opts) => { urls.push(url); return fetchImpl(url, opts); },
    AbortSignal,
  };
  await vm.runInNewContext(HEALTH_CHECK_SCRIPT, sandbox);
  return { exitCode: exitCode ?? 0, stderr: stderr.join('\n'), stdout: stdout.join('\n'), urls };
}

describe('Health_Check script (pinned) fails closed', () => {
  it('is pinned by SHA-256 and matches command-templates.json', () => {
    expect(crypto.createHash('sha256').update(HEALTH_CHECK_SCRIPT, 'utf8').digest('hex')).toBe(HEALTH_CHECK_SCRIPT_SHA256);
    const doc = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONFIG_DIR, 'command-templates.json'), 'utf8'));
    const hc = doc.templates.find((t) => t.templateId === 'Health_Check');
    expect(hc.args).toEqual(['-e', HEALTH_CHECK_SCRIPT]);
  });

  it('passes for a healthy system, with and without a component', async () => {
    const all = await run([], respond(200, healthy()));
    expect(all).toMatchObject({ exitCode: 0, stdout: 'ok', urls: [URL_UNDER_TEST] });
    const one = await run(['card'], respond(200, healthy()));
    expect(one.exitCode).toBe(0);
  });

  it('fails on HTTP 500', async () => {
    const r = await run([], respond(500, healthy()));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/500/);
  });

  it.each([
    ['no components key', { status: 'ok' }],
    ['null components', { status: 'ok', components: null }],
    ['array components', { status: 'ok', components: [] }],
    ['body is null', null],
    ['body is an array', []],
    ['one known component missing', { status: 'ok', components: { button: { status: 'ok' }, layout: { status: 'ok' }, card: { status: 'ok' } } }],
  ])('fails when the response is incomplete: %s', async (_name, body) => {
    const r = await run([], respond(200, body));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('fails when a component argument is missing from the response', async () => {
    const body = healthy();
    delete body.components.card;
    const r = await run(['card'], respond(200, body));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/card/);
  });

  it('fails for an unknown component argument without calling the network', async () => {
    const r = await run(['database'], respond(200, healthy()));
    expect(r.exitCode).not.toBe(0);
    expect(r.urls).toEqual([]);
    expect(r.stderr).toMatch(/unknown component/);
    expect((await run(['__proto__'], respond(200, healthy()))).exitCode).not.toBe(0);
  });

  it('fails when a checked component is unhealthy', async () => {
    const body = healthy();
    body.components.button = { status: 'fail', error: 'x' };
    delete body.status;
    expect((await run([], respond(200, body))).exitCode).not.toBe(0);
    expect((await run(['button'], respond(200, body))).exitCode).not.toBe(0);
    // Only the requested component is judged when the overall status is absent.
    expect((await run(['card'], respond(200, body))).exitCode).toBe(0);
  });

  it.each([
    ['status in a different case', { status: 'OK' }],
    ['status missing', {}],
    ['status not a string', { status: true }],
    ['component is not an object', 'ok'],
  ])('requires component status to be exactly "ok": %s', async (_name, value) => {
    const body = healthy();
    body.components.layout = value;
    expect((await run([], respond(200, body))).exitCode).not.toBe(0);
  });

  it('fails when the overall status is present and not ok', async () => {
    const body = healthy();
    body.status = 'degraded';
    expect((await run([], respond(200, body))).exitCode).not.toBe(0);
  });

  it('fails on invalid JSON and on network errors', async () => {
    const bad = await run([], respond(200, new SyntaxError('Unexpected token')));
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/Unexpected token/);
    const down = await run([], () => Promise.reject(new Error('connect ECONNREFUSED')));
    expect(down.exitCode).not.toBe(0);
    expect(down.stderr).toMatch(/ECONNREFUSED/);
  });

  it('real node -e: the component argument is process.argv[1] and an unknown one exits non-zero', () => {
    const res = spawnSync(process.execPath, ['-e', HEALTH_CHECK_SCRIPT, 'database'], { encoding: 'utf8', timeout: 20000 });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown component: database/);
    // Sanity: the script is accepted by the real parser (a syntax error would also exit non-zero).
    expect(() => new vm.Script(HEALTH_CHECK_SCRIPT)).not.toThrow();
  });
});
