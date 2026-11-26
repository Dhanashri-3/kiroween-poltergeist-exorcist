// Real-stack test environment constants (Task 17.1). NOT the fake-API harness.
//
// Ports:
//  - Test_App 4100 is NOT isolated. The pinned `Health_Check` command template in
//    backend/config/command-templates.json hard-codes http://127.0.0.1:4100/health, so the backend's
//    independent verification can only see a Test_App on 4100. The run refuses to start if 4100 is
//    already in use, so it never touches a Test_App someone else is running.
//  - Backend 4290 and dashboard 5190 are isolated test ports (defaults are 4200 and 5173).
// Everything binds to 127.0.0.1.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_DIR = path.resolve(HERE, '..', '..');
export const REPO_ROOT = path.resolve(FRONTEND_DIR, '..');
export const TESTAPP_DIR = path.join(REPO_ROOT, 'testapp');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

export const HOST = '127.0.0.1';
export const TESTAPP_PORT = 4100;
export const BACKEND_PORT = 4290;
export const DASHBOARD_PORT = 5190;

export const TESTAPP_URL = `http://${HOST}:${TESTAPP_PORT}`;
export const BACKEND_ORIGIN = `http://${HOST}:${BACKEND_PORT}`;
export const API_BASE_URL = `${BACKEND_ORIGIN}/api/v1`;
export const DASHBOARD_ORIGIN = `http://${HOST}:${DASHBOARD_PORT}`;

// Throwaway backend storage (Event_Log, Incidents, Snapshots). Fresh for every run, outside the repo.
export const STORAGE_DIR = path.join(os.tmpdir(), 'poltergeist-exorcist-real-stack-storage');
// Process logs and the Playwright output stay under frontend/test-results/ (already git-ignored).
export const RUN_DIR = path.join(FRONTEND_DIR, 'test-results', 'real-stack');
export const LOG_DIR = path.join(RUN_DIR, 'logs');
export const STATE_FILE = path.join(RUN_DIR, 'run-state.json');

// Backend monitor poll interval for the real run (documented env var MONITOR_INTERVAL_MS).
export const MONITOR_INTERVAL_MS = 1000;
