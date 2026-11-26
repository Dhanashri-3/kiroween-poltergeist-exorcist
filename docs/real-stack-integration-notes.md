# Real-stack integration notes

Status: working notes, NOT part of the official specification. The official specification
(`.kiro/specs/poltergeist-exorcist-healing-system/tasks.md`) contains exactly Tasks 1-16.
These notes preserve a "Task 17" draft that was found uncommitted in the working tree, plus
the execution notes for the real-stack test harness that lives in `frontend/e2e-real/`.
Treat everything below as integration-test artifacts and planning notes, not as a task list.

## 1. Origin of the draft

- The draft was uncommitted edits to `tasks.md` (31 added lines plus 3 graph entries, and one
  comma added to the `14.8` graph line) and `tasks.meta.json` (48 added lines of execution records).
- Tasks 1-16 text and completion statuses were not changed by the draft.
- The execution records reference chat sessions `sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6` and
  `sess_e7dffed5-9557-4000-8759-dacf662e85ec` (17.1 and 17.2 had runs recorded; 17.3 and 17.4 only
  an initial record).

## 2. Draft status at the time of preservation

| Item | State in the draft | State of the files in the repository |
|---|---|---|
| 17.1 real-stack environment | marked done | `frontend/playwright.real.config.js`, `frontend/e2e-real/global-setup.mjs`, `frontend/e2e-real/support/stack.js`, `frontend/e2e-real/stack-smoke.real.spec.js` exist (untracked) |
| 17.2 genuine recovery test | not marked done | `frontend/e2e-real/genuine-recovery.real.spec.js` exists (untracked); no recorded passing run |
| 17.3 failed recovery test | not marked done | no spec exists |
| 17.4 evidence and documentation | not marked done | no evidence directory, no README section |

No run of these tests was performed or verified while writing these notes.

## 3. Real-stack harness facts (from the files)

Run command (from `frontend/`, per the header of `playwright.real.config.js`):

    node node_modules/@playwright/test/cli.js test --config playwright.real.config.js

`global-setup.mjs` starts three real processes with `node <script>` (npx is described as unreliable
on this machine), using the same commands as the README:

| Process | Directory | Command | Network port |
|---|---|---|---|
| Test_App | `testapp/` | `node server.js` (env `TESTAPP_PORT`) | 4100 |
| Backend | `backend/` | `node src/main.js` | 4290 |
| Frontend | `frontend/` | `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5190 --strictPort` | 5190 |

- Backend environment: `BACKEND_PORT=4290`, `DASHBOARD_ORIGIN=http://127.0.0.1:5190`,
  `TESTAPP_URL=http://127.0.0.1:4100`,
  `BACKEND_STORAGE_DIR=<os tmpdir>/poltergeist-exorcist-real-stack-storage`,
  `MONITOR_INTERVAL_MS=1000`.
- Frontend environment: `VITE_API_BASE_URL=http://127.0.0.1:4290/api/v1`.
- Port 4100 cannot be isolated: the pinned `Health_Check` command template in
  `backend/config/command-templates.json` hard-codes `http://127.0.0.1:4100/health`.
- The setup refuses to start if any of the three ports is already in use, and requires the
  Test_App to be healthy first (otherwise the backend would record a broken baseline Snapshot).
- Backend storage is deleted before each run, so the smoke test (which expects no Incidents)
  runs first through a Playwright project dependency.
- Teardown calls `POST /api/v1/reset`, then stops the three processes, and writes
  `frontend/test-results/real-stack/teardown.txt`. Process logs go to
  `frontend/test-results/real-stack/logs/`.
- Config: 1 worker, no retries, 120 s test timeout; the genuine-recovery test allows 360 s for recovery.

## 4. What the specs assert

`stack-smoke.real.spec.js`
- Test_App `/health` is `ok`; backend `/api/v1/health` is `ok` with `testApp.reachable`.
- `/scenarios` is non-empty and `/incidents` is empty (fresh storage).
- The dashboard loads from the dashboard origin and shows health `ok`, `reachable`, 4 components,
  a connected event stream, and one `scenario-item` per catalog scenario.
- Every fetch, XHR and EventSource request made by the page goes to the backend origin, with no
  CORS errors.

`genuine-recovery.real.spec.js` (scenario `button-failure`)
- Starts the run from the dashboard controls and waits for a terminal outcome; fails fast on
  `escalated`, `rolled_back` or `unverified_recovery_claim`.
- Observes the DOM with a MutationObserver and checks that the first-seen time of the injection
  row, incident area, `recovered` state and outcome is not earlier than the backend event timestamps.
- Compares the diagnosis, plan, gate, repair (target, snapshot, checksums) and verification
  rendered by the dashboard with the backend event payloads.
- Reads `/incidents/:id/verification` and requires `overall: pass`, `originalFailingCheckRan`,
  every check `pass`, and a `health` check present.
- Requires the event order: repair, then passing verification, then `incident.state` to `recovered`.
- Reads the Test_App `/health` directly and requires `ok` for all four components.
- `afterAll` calls `POST /reset` and logs the Test_App health.

## 5. Planned but not implemented (draft 17.3 and 17.4)

- A failed-recovery test: the dashboard shows the failed verification, the rollback and
  `escalated`, never `recovered`; the Test_App is restored from the snapshot; evidence is preserved.
- Evidence capture (commands, logs, Playwright report, event-log excerpt, no secrets) and a README
  section for the real-stack run.

## 6. Related backend fix

`backend/src/exorcist/input-builder.js` binds Evidence to the Incident when it is loaded, because
Evidence captured by the Monitor has no `incidentId`. Without it, the Fallback_Mapping path
produces a Diagnosis and Repair_Plan without an `incidentId`, which fail schema validation.
Regression test: `backend/tests/exorcist-evidence-without-incident-id.test.js`.

## 7. Open points recorded during the audit (not verified by running anything)

- The dashboard loads `/health` and `/incidents` only once at start-up, so the Incident
  `component` field and the health panel may not refresh after a new Incident.
- The `api-failure` scenario edits `mock-api.js`, which `testapp/server.js` loads once via
  `require`; the running Test_App may never see the injected change.
- No approved scenario produces a failed recovery on its own. Candidate isolated mechanisms
  (a temporary config copy and a launcher outside the repository) were proposed but not approved or run.

## 8. Verbatim copy of the draft "Task 17" text

Copied unchanged from the working-tree `tasks.md` (lines 427-457) before it was restored:

```markdown
- [ ] 17. Real-stack frontend end-to-end testing (follow-up to 14.8 and 16)
  - Objective: prove the actual React frontend talks to the real backend and Test_App, and displays a genuine Poltergeist injection, Exorcist repair and independently verified recovery
  - Keep the existing 18 fake-API Playwright tests in `frontend/e2e/` unchanged as UI contract tests; do not change the recorded results of Task 16
  - Do not use `fake-api.js`, synthetic Incidents, canned Events or mocked backend responses in any real-stack test, and do not claim real-stack coverage for tests that use synthetic data
  - Do not weaken the Safety_Gate or verification requirements to make a test pass; do not commit or push until the user has reviewed the changes

  - [x] 17.1 Set up the real-stack test environment
    - Add a separate Playwright config and spec directory for real-stack tests (for example `frontend/e2e-real/`), clearly named so they are never confused with the fake-API tests
    - Start the real Test_App, backend and frontend with the documented commands from the README, on isolated test ports and a throwaway copy or reset state of the Test_App, and stop them after the run
    - Configure the real API base URL in the frontend and the allowed origin (CORS) in the backend through the documented configuration, without editing `.env` files, secrets or unrelated project configuration
    - Fail fast with a clear message if any of the three processes is not healthy
    - _Requirements: 13.1, 13.7, 15.8, 19.4_

  - [ ] 17.2 Write real-stack test for a genuine recovery
    - Trigger a real chaos scenario from the Dashboard control, and assert the Dashboard shows the injected failure only after the backend publishes its real Events through SSE
    - Verify incident selection, diagnosis, proposed repair and verification information are displayed from real backend data
    - Confirm a real Verification_Result exists by reading it from the backend API and Event_Log, and that the Dashboard shows `recovered` only after a passing Verification_Result for that same Incident
    - Confirm the Test_App is actually healthy afterwards through an independent Health_Check
    - _Requirements: 13.2, 13.3, 14.8, 15.8, 19.4_

  - [ ] 17.3 Write real-stack test for a failed recovery that escalates
    - Use an approved real mechanism to make recovery fail (for example the repair client configuration or a scenario the Fallback_Mapping cannot fix), without bypassing the Safety_Gate or verification
    - Assert the Dashboard shows the failed verification, the rollback and the `escalated` state, and never shows `recovered` for that Incident
    - Confirm the Test_App is restored from the snapshot and the evidence is preserved
    - _Requirements: 16.4, 19.5, 19.6, 19.7_

  - [ ] 17.4 Capture evidence and document
    - Save the exact commands used, process logs, the Playwright report and the Event_Log excerpt for each run under an evidence directory (for example `docs/evidence/real-stack-e2e/`), excluding any Secrets
    - Add a README section with the commands to run the real-stack tests and a note that they differ from the fake-API contract tests
    - Report every modified file and every unresolved limitation, and report complete only after the test output is available
    - _Requirements: 13.9, 20.5_
```

Dependency-graph entries the draft added (after the existing `14.8` entry):

```json
    { "id": 14, "tasks": ["17.1"] },
    { "id": 15, "tasks": ["17.2", "17.3"] },
    { "id": 16, "tasks": ["17.4"] }
```

## 9. Appendix: execution records the draft added to `tasks.meta.json`

Verbatim copy of the 48 added lines (they were inserted after the Task 16 records). They are tool bookkeeping, kept here only so nothing is lost when the file is restored.

```json
    ],
    "17.1 Set up the real-stack test environment": [
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795541829061
      },
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795541833812
      },
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795542181001
      }
    ],
    "17.2 Write real-stack test for a genuine recovery": [
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795541829256
      },
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795542185688
      },
      {
        "executionId": "c1a2e5eb-932b-4515-beb7-5a0b8b219f2a",
        "chatSessionId": "sess_e7dffed5-9557-4000-8759-dacf662e85ec",
        "timestamp": 1795607388511
      }
    ],
    "17.3 Write real-stack test for a failed recovery that escalates": [
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795541829394
      }
    ],
    "17.4 Capture evidence and document": [
      {
        "executionId": "cecad945-ac93-4c84-99db-22ffc60ed12a",
        "chatSessionId": "sess_1b22efd9-2b26-4fd5-b742-1319e7a90db6",
        "timestamp": 1795541829516
      }
```
