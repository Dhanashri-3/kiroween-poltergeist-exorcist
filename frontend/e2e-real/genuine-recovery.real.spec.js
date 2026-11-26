/**
 * REAL-STACK test: a genuine recovery (Task 17.2). No fake API, no mocks, no route interception,
 * no synthetic data. The real Test_App, backend (Poltergeist + Exorcist + real Vitest/Playwright
 * verification) and frontend run as started by e2e-real/global-setup.mjs.
 *
 * What it proves, using only real data:
 *  - The scenario is started from the Dashboard control (real POST /chaos-runs).
 *  - The Dashboard shows the injection / Incident only AFTER the backend published the matching
 *    Event (page-side first-seen time >= Event `ts` read from the backend Event_Log).
 *  - Diagnosis, Repair_Plan, repair record and Verification_Result shown on the Dashboard equal the
 *    real backend Event payloads.
 *  - `recovered` is shown only after a passing Verification_Result Event for the SAME Incident, and
 *    that Verification_Result also exists in the backend API.
 *  - The Test_App Health_Check, queried directly and independently of the Dashboard, is healthy.
 */
import { test, expect } from '@playwright/test';
import { TESTAPP_URL, API_BASE_URL } from './support/stack.js';

const SCENARIO_ID = 'button-failure';
const COMPONENTS = ['button', 'layout', 'dataPanel', 'card'];
const RECOVERY_TIMEOUT_MS = 360_000;

// Records, in the page, the wall-clock time at which each element first appeared in the DOM.
// It only observes the DOM; it never touches network traffic or app code.
const FIRST_SEEN_PROBES = {
  injectionRow: '[data-testid="event-row"][data-type="chaos.injection"]',
  incidentArea: '[data-testid="incident-area"]',
  verificationPassPanel: '[data-testid="verification"][data-overall="pass"]',
  recoveredOutcome: '[data-testid="outcome"][data-outcome="recovered"]',
};
function installFirstSeenRecorder(probes) {
  window.__firstSeen = {};
  const check = () => {
    for (const [name, selector] of Object.entries(probes)) {
      if (window.__firstSeen[name] === undefined && document.querySelector(selector)) window.__firstSeen[name] = Date.now();
    }
    if (window.__firstSeen.recoveredState === undefined) {
      const el = document.querySelector('[data-testid="incident-state"]');
      if (el && el.textContent.trim() === 'recovered') window.__firstSeen.recoveredState = Date.now();
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}

async function getJson(request, url) {
  const res = await request.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  return res.json();
}

async function resetTestApp(request) {
  const res = await request.post(`${API_BASE_URL}/reset`, { data: {}, timeout: 60_000 });
  return res.status();
}

test.describe('REAL-STACK genuine recovery', () => {
  test.afterAll(async ({ request }) => {
    // Leave the Test_App at the baseline Snapshot. Only possible when no Incident is active.
    const status = await resetTestApp(request);
    console.log(`[real-stack] afterAll POST /reset -> HTTP ${status}`);
    const health = await (await request.get(`${TESTAPP_URL}/health`)).json();
    console.log(`[real-stack] afterAll Test_App health status=${health.status}`);
  });

  test(`Dashboard shows a real ${SCENARIO_ID} injection, diagnosis, repair and a verified recovery`, async ({ page, request }) => {
    test.setTimeout(RECOVERY_TIMEOUT_MS + 120_000);

    // ---- Preconditions: real, healthy, empty stack --------------------------------------
    const baseline = await getJson(request, `${TESTAPP_URL}/health`);
    expect(baseline.status).toBe('ok');
    expect((await getJson(request, `${API_BASE_URL}/incidents`)).incidents).toEqual([]);
    expect((await getJson(request, `${API_BASE_URL}/events`)).events.filter((e) => e.type === 'chaos.injection')).toEqual([]);

    await page.addInitScript(installFirstSeenRecorder, FIRST_SEEN_PROBES);
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.getByTestId('health-status')).toHaveText('ok');
    await expect(page.getByTestId('idle')).toBeVisible();
    await expect(page.getByTestId('incident-area')).toHaveCount(0);

    // ---- Trigger the real chaos scenario from the Dashboard control -----------------------
    await page.getByTestId('scenario-select').selectOption(SCENARIO_ID);
    await page.getByRole('button', { name: 'Start chaos' }).click();
    await expect(page.getByTestId('control-notice')).toContainText('Chaos run request accepted');

    // The Dashboard shows the injection, and then an Incident, only from Events.
    await expect(page.locator(FIRST_SEEN_PROBES.injectionRow)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('incident-area')).toBeVisible({ timeout: 60_000 });

    // ---- Wait for a terminal outcome; fail fast on anything but recovery ------------------
    await expect.poll(async () => {
      const outcome = await page.getByTestId('incident-panel').getAttribute('data-outcome');
      if (['escalated', 'rolled_back', 'unverified_recovery_claim'].includes(outcome)) {
        throw new Error(`Incident ended as "${outcome}" instead of "recovered" (this is a real failed recovery, not a test defect to paper over).`);
      }
      return outcome;
    }, { timeout: RECOVERY_TIMEOUT_MS, intervals: [1000, 2000, 3000] }).toBe('recovered');

    // ---- Read the real backend data ---------------------------------------------------------
    const { incidents } = await getJson(request, `${API_BASE_URL}/incidents`);
    expect(incidents).toHaveLength(1);
    const incidentId = incidents[0].incidentId;
    expect(typeof incidentId).toBe('string');

    const allEvents = (await getJson(request, `${API_BASE_URL}/events`)).events;
    const incidentEvents = (await getJson(request, `${API_BASE_URL}/events?incidentId=${encodeURIComponent(incidentId)}`)).events;
    const ofType = (list, type) => list.filter((e) => e.type === type);

    // Injection (chaos.injection may be recorded outside the Incident, so read it from the whole log).
    const injections = ofType(allEvents, 'chaos.injection');
    expect(injections).toHaveLength(1);
    const injection = injections[0];
    expect(JSON.stringify(injection.payload)).toContain(SCENARIO_ID);

    // Incident identification
    const apiIncident = await getJson(request, `${API_BASE_URL}/incidents/${encodeURIComponent(incidentId)}`);
    expect(apiIncident.incidentId).toBe(incidentId);
    expect(apiIncident.state).toBe('recovered');
    await expect(page.getByTestId('incident-panel')).toContainText(incidentId);
    await expect(page.getByTestId('incident-state')).toHaveText('recovered');
    await expect(page.getByTestId('incident-component')).toHaveText('button');
    await expect(page.getByTestId('incident-item')).toHaveCount(1);
    await expect(page.getByTestId('incident-item')).toHaveAttribute('data-outcome', 'recovered');

    // ---- Dashboard shows the injection only after the backend published it ----------------
    const firstSeen = await page.evaluate(() => window.__firstSeen);
    const ms = (iso) => Date.parse(iso);
    expect(firstSeen.injectionRow, 'injection row was seen in the DOM').toBeGreaterThan(0);
    expect(firstSeen.injectionRow).toBeGreaterThanOrEqual(ms(injection.ts));
    const firstIncidentEvent = incidentEvents[0];
    expect(firstIncidentEvent.incidentId).toBe(incidentId);
    expect(firstSeen.incidentArea, 'incident area was seen in the DOM').toBeGreaterThan(0);
    expect(firstSeen.incidentArea).toBeGreaterThanOrEqual(ms(firstIncidentEvent.ts));
    // The injection Event precedes the Incident's first Event in the Event_Log.
    expect(injection.seq).toBeLessThan(firstIncidentEvent.seq);

    // ---- Diagnosis, plan, repair shown from real backend data ------------------------------
    // Every JSON payload rendered in the incident panel is parsed and compared with the backend Events.
    const renderedPayloads = (await page.getByTestId('incident-panel').locator('pre').allTextContents())
      .map((t) => { try { return JSON.parse(t); } catch { return undefined; } })
      .filter((v) => v !== undefined);
    const renderedHas = (payload) => renderedPayloads.some((r) => JSON.stringify(r) === JSON.stringify(payload));

    const diagnoses = ofType(incidentEvents, 'diagnosis');
    expect(diagnoses.length).toBeGreaterThan(0);
    await expect(page.getByTestId('diagnosis-none')).toHaveCount(0);
    expect(renderedHas(diagnoses[diagnoses.length - 1].payload), 'Dashboard diagnosis equals backend diagnosis Event payload').toBe(true);

    const plans = ofType(incidentEvents, 'plan');
    expect(plans.length).toBeGreaterThan(0);
    await expect(page.getByTestId('plan-item')).toHaveCount(plans.length);
    for (const p of plans) expect(renderedHas(p.payload), `Dashboard shows plan Event seq ${p.seq}`).toBe(true);

    const gates = ofType(incidentEvents, 'gate');
    expect(gates.length).toBeGreaterThan(0);
    await expect(page.getByTestId('gate-item')).toHaveCount(gates.length);

    const repairs = ofType(incidentEvents, 'repair');
    expect(repairs.length).toBeGreaterThan(0);
    const repair = repairs[repairs.length - 1];
    await expect(page.getByTestId('repair-target')).toHaveText(repair.payload.target);
    await expect(page.getByTestId('repair-snapshot')).toHaveText(repair.payload.snapshotId);
    await expect(page.getByTestId('repair-pre')).toHaveText(repair.payload.preChecksum);
    await expect(page.getByTestId('repair-post')).toHaveText(repair.payload.postChecksum);
    await expect(page.getByTestId('repair-compare')).toHaveText('different');
    await expect(page.getByTestId('plan-preview')).toBeVisible();

    // ---- Real Verification_Result: backend API and Event_Log --------------------------------
    const apiVerification = await getJson(request, `${API_BASE_URL}/incidents/${encodeURIComponent(incidentId)}/verification`);
    expect(apiVerification.incidentId).toBe(incidentId);
    expect(apiVerification.overall).toBe('pass');
    expect(apiVerification.originalFailingCheckRan).toBe(true);
    expect(apiVerification.checks.length).toBeGreaterThan(0);
    for (const c of apiVerification.checks) expect(c.outcome, `check ${c.checkId} (${c.kind})`).toBe('pass');
    expect(new Set(apiVerification.checks.map((c) => c.kind))).toContain('health');

    const verificationEvents = ofType(incidentEvents, 'verification');
    expect(verificationEvents.length).toBeGreaterThan(0);
    const passEvent = verificationEvents.filter((e) => e.payload.overall === 'pass').pop();
    expect(passEvent, 'a passing verification Event exists for this Incident').toBeDefined();
    expect(passEvent.incidentId).toBe(incidentId);
    expect(passEvent.payload.incidentId).toBe(incidentId);
    expect(passEvent.payload.verificationId).toBe(apiVerification.verificationId);

    // Ordering in the Event_Log: passing verification < the incident.state -> recovered transition.
    const recoveredStates = ofType(incidentEvents, 'incident.state').filter((e) => e.payload.to === 'recovered');
    expect(recoveredStates).toHaveLength(1);
    const recoveredState = recoveredStates[0];
    expect(recoveredState.incidentId).toBe(incidentId);
    expect(passEvent.seq).toBeLessThan(recoveredState.seq);
    // The passing verification followed the repair.
    expect(repair.seq).toBeLessThan(passEvent.seq);
    // No other Incident has any recovered transition.
    expect(ofType(allEvents, 'incident.state').filter((e) => e.payload.to === 'recovered' && e.incidentId !== incidentId)).toEqual([]);

    // ---- Dashboard shows `recovered` only after that passing verification -------------------
    await expect(page.getByTestId('outcome')).toHaveAttribute('data-outcome', 'recovered');
    await expect(page.getByTestId('recovery-verification')).toHaveAttribute('data-overall', 'pass');
    await expect(page.getByTestId('recovery-verification')).toContainText(passEvent.payload.verificationId);
    await expect(page.getByTestId('recovery-verification-link')).toContainText(passEvent.payload.verificationId);
    await expect(page.getByTestId('recovery-verification').getByTestId('verification-check')).toHaveCount(apiVerification.checks.length);
    expect(firstSeen.recoveredState, '`recovered` state was seen in the DOM').toBeGreaterThan(0);
    expect(firstSeen.recoveredOutcome, 'recovered outcome was seen in the DOM').toBeGreaterThan(0);
    expect(firstSeen.recoveredState).toBeGreaterThanOrEqual(ms(passEvent.ts));
    expect(firstSeen.recoveredState).toBeGreaterThanOrEqual(ms(recoveredState.ts));
    expect(firstSeen.recoveredOutcome).toBeGreaterThanOrEqual(ms(passEvent.ts));
    expect(firstSeen.recoveredOutcome).toBeGreaterThanOrEqual(ms(recoveredState.ts));
    if (firstSeen.verificationPassPanel !== undefined) {
      expect(firstSeen.verificationPassPanel).toBeGreaterThanOrEqual(ms(passEvent.ts));
    }

    // ---- Independent Health_Check of the real Test_App (not via the Dashboard) --------------
    const health = await getJson(request, `${TESTAPP_URL}/health`);
    expect(health.status).toBe('ok');
    for (const c of COMPONENTS) expect(health.components?.[c]?.status, `Test_App component ${c}`).toBe('ok');
    const backendHealth = await getJson(request, `${API_BASE_URL}/health`);
    expect(backendHealth.status).toBe('ok');
  });
});
