// Starts the REAL Test_App, backend and frontend for the real-stack suite, and stops them afterwards.
// Commands are the ones documented in README.md ("Running locally"), run from the same directories:
//   testapp:  node server.js                (TESTAPP_PORT)
//   backend:  node src/main.js  (= npm start; BACKEND_PORT, DASHBOARD_ORIGIN, TESTAPP_URL,
//                                BACKEND_STORAGE_DIR, MONITOR_INTERVAL_MS)
//   frontend: vite dev server   (= npm run dev; VITE_API_BASE_URL)
// `node <script>` is used instead of npm/npx because npx is unreliable on this machine; the child
// processes are identical to what `npm start` / `npm run dev` run.
// Any unhealthy process stops the whole run with a message naming it. No mocks, no synthetic data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  HOST, TESTAPP_PORT, BACKEND_PORT, DASHBOARD_PORT, TESTAPP_URL, BACKEND_ORIGIN, API_BASE_URL, DASHBOARD_ORIGIN,
  TESTAPP_DIR, BACKEND_DIR, FRONTEND_DIR, STORAGE_DIR, LOG_DIR, RUN_DIR, STATE_FILE, MONITOR_INTERVAL_MS,
} from './support/stack.js';

const STARTUP_TIMEOUT_MS = 60_000;
const COMPONENTS = ['button', 'layout', 'dataPanel', 'card'];

class StackError extends Error {
  constructor(message) {
    super(`REAL-STACK SETUP FAILED: ${message}`);
    this.name = 'StackError';
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProcess(name, args, { cwd, env }) {
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const proc = { name, child, logFile, exited: null };
  child.once('exit', (code, signal) => { proc.exited = { code, signal }; });
  child.once('error', (error) => { proc.exited = { code: null, signal: null, error: String(error.message ?? error) }; });
  return proc;
}

function tail(file, lines = 15) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return '(no log)'; }
}

async function waitHealthy(proc, label, check) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    if (proc.exited) {
      throw new StackError(`${label} exited during startup (${JSON.stringify(proc.exited)}). Last log lines (${proc.logFile}):\n${tail(proc.logFile)}`);
    }
    try {
      const problem = await check();
      if (!problem) return;
      last = problem;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(300);
  }
  throw new StackError(`${label} was not healthy within ${STARTUP_TIMEOUT_MS} ms: ${last}. Last log lines (${proc.logFile}):\n${tail(proc.logFile)}`);
}

async function stopProcess(proc) {
  if (!proc || proc.exited) return;
  proc.child.kill();
  const deadline = Date.now() + 8000;
  while (!proc.exited && Date.now() < deadline) await sleep(100);
  if (!proc.exited) proc.child.kill('SIGKILL');
}

export default async function globalSetup() {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Pre-flight: never reuse or collide with something already listening.
  for (const [label, port] of [['Test_App', TESTAPP_PORT], ['backend', BACKEND_PORT], ['dashboard', DASHBOARD_PORT]]) {
    if (await portInUse(port)) {
      throw new StackError(`port ${port} (${label}) is already in use on ${HOST}. Stop whatever is listening there; the real-stack run only starts its own processes.`);
    }
  }

  // Throwaway backend state: fresh storage means a fresh Event_Log, no Incidents, and a new baseline Snapshot.
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });

  const started = [];
  const stopAll = async () => {
    for (const proc of [...started].reverse()) await stopProcess(proc);
  };

  try {
    // 1. Test_App (README step 2)
    const testapp = startProcess('testapp', ['server.js'], { cwd: TESTAPP_DIR, env: { TESTAPP_PORT: String(TESTAPP_PORT) } });
    started.push(testapp);
    await waitHealthy(testapp, 'Test_App', async () => {
      const { status, body } = await getJson(`${TESTAPP_URL}/health`);
      if (status !== 200) return `/health answered HTTP ${status}`;
      const bad = COMPONENTS.filter((c) => body?.components?.[c]?.status !== 'ok');
      if (body?.status !== 'ok' || bad.length > 0) {
        return `Test_App is not in a healthy baseline state (status=${body?.status}, unhealthy components: ${bad.join(', ') || 'none'}). Restore testapp/ before running; the backend would otherwise record a broken baseline Snapshot.`;
      }
      return null;
    });

    // 2. Backend (README step 3). CORS origin = the dashboard origin of this run, via DASHBOARD_ORIGIN.
    const backend = startProcess('backend', ['src/main.js'], {
      cwd: BACKEND_DIR,
      env: {
        BACKEND_PORT: String(BACKEND_PORT),
        DASHBOARD_ORIGIN,
        TESTAPP_URL,
        BACKEND_STORAGE_DIR: STORAGE_DIR,
        MONITOR_INTERVAL_MS: String(MONITOR_INTERVAL_MS),
      },
    });
    started.push(backend);
    await waitHealthy(backend, 'backend', async () => {
      const { status, body } = await getJson(`${API_BASE_URL}/health`);
      if (status !== 200) return `/api/v1/health answered HTTP ${status}`;
      if (body?.status !== 'ok') return `backend health status is "${body?.status}" (testApp.reachable=${body?.testApp?.reachable}, storage.ok=${body?.storage?.ok})`;
      return null;
    });

    // 3. Frontend (README step 4): Vite dev server pointed at the real backend.
    const frontend = startProcess(
      'frontend',
      [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--host', HOST, '--port', String(DASHBOARD_PORT), '--strictPort'],
      { cwd: FRONTEND_DIR, env: { VITE_API_BASE_URL: API_BASE_URL } },
    );
    started.push(frontend);
    await waitHealthy(frontend, 'frontend', async () => {
      const res = await fetch(`${DASHBOARD_ORIGIN}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status !== 200) return `dashboard answered HTTP ${res.status}`;
      return null;
    });
  } catch (error) {
    await stopAll();
    throw error;
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    startedAt: new Date().toISOString(),
    testapp: TESTAPP_URL, backend: BACKEND_ORIGIN, dashboard: DASHBOARD_ORIGIN, apiBaseUrl: API_BASE_URL,
    storageDir: STORAGE_DIR, logs: started.map((p) => p.logFile),
  }, null, 2));

  // Teardown: reset the Test_App to the baseline Snapshot through the real API, then stop everything.
  return async () => {
    let resetNote = 'not attempted';
    try {
      const res = await fetch(`${API_BASE_URL}/reset`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000),
      });
      resetNote = `POST /reset answered HTTP ${res.status}`;
    } catch (e) {
      resetNote = `POST /reset failed: ${String(e?.message ?? e)}`;
    }
    await stopAll();
    fs.writeFileSync(path.join(RUN_DIR, 'teardown.txt'), `${new Date().toISOString()} ${resetNote}\nprocesses stopped: ${started.map((p) => p.name).join(', ')}\n`);
    console.log(`[real-stack] teardown: ${resetNote}; processes stopped.`);
  };
}
