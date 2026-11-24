// Test-only ports for the Dashboard UI-contract e2e suite (Task 14.8 harness).
// Neither is the real backend port. Both bind to 127.0.0.1 only.
export const DASHBOARD_PORT = 5199;
export const FAKE_API_PORT = 5198;
export const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_PORT}`;
export const FAKE_API_BASE_URL = `http://127.0.0.1:${FAKE_API_PORT}/api/v1`;
