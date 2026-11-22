# Implementation Plan: Poltergeist QA vs. The Exorcist

## Overview

The design specifies JavaScript on Node.js (ESM) for `backend/` and `testapp/`, and React + Vite for `frontend/`, so no language question is needed. The plan builds from governance and contracts, through the isolated Test_App and the deterministic core (storage, events, snapshots, gate, executor, state machine), then the agents, orchestrator and API, and finally the Dashboard. Pure logic is built before I/O so each step can be tested early. Every module is wired into the next step, and the plan ends with integration tests that prove a real failure is repaired and verified.

Steering constraints that apply to every task:

- Small, testable commits on a branch per owner (see Notes). No merge to main without review.
- No dependency is installed before it is listed in `docs/dependency-review.md` and approved by the team. fast-check and Ajv are already approved but are installed only in the task that first needs them (Ajv in 1.3, fast-check in 3.2).
- Never replace real execution with simulated success. A task that touches repair or recovery must show verification output (test run results) before it is reported complete.
- Poltergeist and Exorcist modules never import each other. `frontend/` never imports `backend/`.
- Do not modify `.env` files, secrets, `.kiro/` agent files, or project configuration outside what a task names.

## Tasks

- [x] 1. Governance, scaffolding and contracts
  - [x] 1.1 Create the dependency review document and docs skeleton
    - Create `docs/dependency-review.md` listing Node.js, Express, React, Vite, Vitest, Playwright, fast-check, Ajv and the open AI model SDK, each with purpose and status (fast-check and Ajv approved, install deferred)
    - Create empty placeholders `docs/api.md`, `docs/event-schema.md`, `docs/diagnosis-schema.md`, `docs/repair-plan-schema.md`, `docs/scenario-catalog-schema.md` with headings only
    - Do not install anything in this task
    - _Requirements: 20.3, 20.4_

  - [x] 1.2 Scaffold the backend directory structure
    - After the team approves Node.js, Express and Vitest in the dependency review, create `backend/package.json` and the `backend/src/` module directories from the design layout (contracts, orchestrator, api, poltergeist, exorcist, scenario-engine, monitor, incident, safety-gate, repair-executor, verification, events, storage, file-guard), plus `backend/config/` and `backend/tests/`
    - Add `backend/storage-data/` to `.gitignore`
    - Add a Vitest configuration limited to `backend/`
    - _Requirements: 13.8, 18.1, 20.1_

  - [x] 1.3 Define JSON Schema contracts and install Ajv
    - Install Ajv in `backend/` (already approved; record the install in the dependency review)
    - Create schemas in `backend/src/contracts/` for Event, Incident, Evidence, Diagnosis, Repair_Plan, Scenario_Catalog entry, Snapshot, Verification_Result, Action_Allowlist, Fallback_Mapping entry and Command template
    - Export a `validate(schemaName, value)` helper that returns structured errors
    - Mirror the field lists from the design Data Models section into `docs/event-schema.md`, `docs/diagnosis-schema.md`, `docs/repair-plan-schema.md`, `docs/scenario-catalog-schema.md`
    - _Requirements: 7.2, 8.1, 14.1, 20.3_

  - [x] 1.4 Add the module import-boundary check
    - Create a Vitest test that scans sources and fails if `backend/src/poltergeist/` imports `exorcist/`, if `backend/src/exorcist/` imports `poltergeist/`, if either imports anything other than `contracts/`, or if `frontend/` imports from `backend/`
    - Fail also if any agent module imports the local JSON storage implementation directly
    - _Requirements: 13.8, 15.11, 18.4, 20.2_

- [x] 2. Isolated Test_App and configuration
  - [x] 2.1 Build the Test_App in `testapp/`
    - Create a small web app bound only to 127.0.0.1 with four designated components: a button, a layout section, a data panel loading from a local mock API, and a styled card
    - Add a `/health` endpoint returning HTTP 200 and JSON with the status of each component, based on real checks of the component behavior
    - Make no requests to external hosts
    - Use only dependencies from the approved list
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.2 Create the approved configuration files
    - In `backend/config/`, create `approved-files.json` (paths relative to `testapp/`), `action-allowlist.json` (text replacement, style rule replacement, mock API handler replacement, each with allowed files and `maxChangedLines`), `scenario-catalog.json` (exactly the six scenarios with deterministic injection and reversal transforms), `command-templates.json` (Health_Check, Vitest and Playwright templates with fixed args and component enum), and `fallback-mapping.json` (entries for the six scenarios, evidence-pattern based, with no scenario IDs)
    - Add a config loader that validates each file against its contract schema and refuses to start when a file is missing or invalid
    - Confirm that all approved files resolve inside `testapp/`
    - _Requirements: 1.6, 2.1, 2.2, 2.3, 13.7, 16.10_

  - [x] 2.3 Add baseline tests for the Test_App
    - Create Vitest unit tests and Playwright tests in `testapp/` that cover each of the four components and the `/health` endpoint
    - Ensure each failure mode of the six scenarios makes at least one of these tests or a Health_Check fail
    - Make the baseline Verification_Result fail whenever any Health_Check fails, even if the tests pass
    - _Requirements: 1.7, 1.8, 3.7_

- [x] 3. Storage, file guard, redaction and Event_Log
  - [x] 3.1 Implement the Storage interface and local JSON store
    - Define `get`, `put`, `append`, `list` per collection (`events`, `incidents`, `verifications`, `snapshots`)
    - Implement the local JSON store with write-to-temp then rename, a short retry on Windows rename failures, and corrupt-file handling (rename to `<name>.corrupt-<timestamp>`, start empty, report an error for the Event_Log to record)
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [x] 3.2 Write property test for serialization round trip
    - Install fast-check in `backend/` in this task if it is not yet installed, after review, and record it in the dependency review
    - **Property 10: Serialization round trip**
    - **Validates: Requirements 6.10, 8.7, 14.9, 18.5**

  - [x] 3.3 Implement the File_Guard
    - Provide `assertWritable(path, caller)` that resolves real paths and allows only Approved_Files and the storage directories
    - Return a denial that carries the data for a `security` Event
    - _Requirements: 17.1, 17.4_

  - [x] 3.4 Implement the Redactor
    - Provide `redact(value)` that removes Secret patterns (API-key shapes, bearer tokens, `.env`-style assignments) and refuses content from `.env*` and `.git/`
    - _Requirements: 13.6, 17.3_

  - [x] 3.5 Write property test for secret redaction
    - **Property 23: Secret redaction**
    - **Validates: Requirements 13.6, 17.3**

  - [x] 3.6 Implement the Event_Log and publisher
    - Append-only, assigns strictly increasing sequence numbers under a mutex, redacts, enforces the 64 KB payload limit by storing larger content as a referenced file, persists through Storage, then publishes to subscribers
    - Provide `readAfter(seq, filter)` and typed filtered views (including a view that excludes `chaos.*` events for non-Dashboard consumers)
    - If persisting fails, publish nothing and signal a storage error
    - _Requirements: 14.1, 14.2, 14.6, 14.7, 14.8, 14.10_

  - [x] 3.7 Write property test for the Event sequence invariant
    - **Property 24: Event sequence invariant**
    - **Validates: Requirements 14.1, 14.10**

  - [x] 3.8 Write property test for persist-before-publish
    - **Property 25: Persist before publish**
    - **Validates: Requirements 14.2**

  - [x] 3.9 Write property test for the payload size limit
    - **Property 27: Payload size limit**
    - **Validates: Requirements 14.7**

- [x] 4. Scenario_Engine
  - [x] 4.1 Implement the shared Snapshot service
    - Create snapshots of all Approved_Files with SHA-256 checksums, restore from a snapshot, and return restored checksums for comparison
    - Place it in a shared module (for example `backend/src/file-guard/snapshots`) so Scenario_Engine and Repair_Executor do not import each other
    - All writes go through the File_Guard
    - _Requirements: 3.1, 10.2, 10.9, 17.7_

  - [x] 4.2 Implement the catalog loader
    - Load the versioned catalog at startup, validate schema, unique IDs, and that every target file is an Approved_File
    - On failure refuse to start and record an error Event naming the invalid entry
    - Reject unknown scenario IDs
    - Include unit tests that the shipped catalog has exactly the six required scenarios with all required fields
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 4.3 Implement injection, reversal and reset
    - `inject(scenarioId, runId)` snapshots first, applies the deterministic transform only to the scenario's files, and records the `chaos.injection` Event with checksums, files and timestamp
    - Restore the snapshot and record an error Event if injection fails midway
    - `reverse(scenarioId)` and `reset()` (baseline restore plus `reset` Event)
    - Never call the Monitor, Exorcist or Incident_Manager
    - Reject injection while an Incident is non-terminal, with a `chaos.rejected` Event
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 4.4 Write property test for scenario injection round trip
    - **Property 1: Scenario injection round trip**
    - **Validates: Requirements 2.6**

  - [x] 4.5 Write property test for catalog validation and unknown IDs
    - **Property 2: Catalog validation and unknown IDs**
    - **Validates: Requirements 2.4, 2.5**

  - [x] 4.6 Write property test for injection write scope
    - **Property 3: Write scope and snapshot-first** (injection and rollback operations; repair operations are covered in 8.8)
    - **Validates: Requirements 3.1, 3.2, 3.5, 17.1, 17.4, 17.7**

- [x] 5. Monitor
  - [x] 5.1 Implement the pure debounce function
    - `step(window, result, incidentOpen) -> {window, emit[]}` implementing: detection on two consecutive failures, `transient` for a single failure followed by a pass, availability-failure on unreachable app, `cleared` after two passes and withheld while an Incident references the check, and a 3-consecutive-pass confirmation signal for recovery
    - _Requirements: 5.3, 5.5, 5.6, 5.8, 5.9, 11.9_

  - [x] 5.2 Write property test for detection debounce
    - **Property 5: Detection debounce**
    - **Validates: Requirements 5.3, 5.5, 5.8**

  - [x] 5.3 Write property test for cleared event gating
    - **Property 6: Cleared event gating**
    - **Validates: Requirements 5.6, 5.9**

  - [x] 5.4 Implement health polling and evidence capture
    - Poll Health_Checks at a configurable interval (default 2 seconds), using only the Test_App and never reading `chaos.*` Events
    - On detection capture the Health_Check response, console errors, a DOM snapshot of the affected component and a screenshot path using Playwright, store large Evidence as files, and record `detection`, `transient` and `cleared` Events
    - Report detections to the Incident_Manager interface
    - _Requirements: 5.1, 5.2, 5.4, 5.7, 14.7_

- [x] 6. Incident_Manager
  - [x] 6.1 Implement the state machine transition table
    - States: `detected`, `investigating`, `planned`, `repairing`, `verifying`, `recovered`, `rolled_back`, `escalated`
    - Terminal: `recovered`, `escalated`. `rolled_back` is transient with exits to `investigating` and `escalated`
    - Encode the permitted transitions from the design state diagram, including rollback-verified preconditions and the `verifying`-only-from-`repairing` rule
    - _Requirements: 6.2, 6.3, 6.4, 10.10, 10.11_

  - [x] 6.2 Write property test for state machine conformance
    - **Property 8: State machine conformance**
    - **Validates: Requirements 6.2, 6.3, 6.4, 10.10, 10.11, 12.2, 12.5**

  - [x] 6.3 Write unit tests for every permitted and rejected transition
    - Cover each pair of states, rejected transitions leaving the Incident unchanged and recording an `error` Event
    - _Requirements: 19.2_

  - [x] 6.4 Implement the Incident_Manager
    - `create`, `attach` (no duplicate Incident for the same failing component), `transition` (persist, record `incident.state` Event, reject illegal transitions with an `error` Event), allow at most one non-terminal Incident
    - `reload()` at startup flags Incidents in `repairing` or `verifying` as needing rollback verification, blocking injection, and rejects resume to `verifying` without a completed executor record
    - Guard `recovered`: require a stored Verification_Result with `overall=pass` for the Incident and the Monitor's 3-check confirmation
    - Enforce the information barrier: never read `chaos.*` Events
    - _Requirements: 6.1, 6.5, 6.6, 6.7, 6.8, 6.9, 10.11, 11.7, 11.8, 11.9_

  - [x] 6.5 Write property test for duplicate detection attaches
    - **Property 9: Duplicate detection attaches**
    - **Validates: Requirements 6.7**

  - [x] 6.6 Write property test for recovery requires proof
    - **Property 19: Recovery requires proof**
    - **Validates: Requirements 11.7, 11.8, 11.9**

  - [x] 6.7 Write property test for single active Incident
    - **Property 4: Single active Incident**
    - **Validates: Requirements 3.4, 6.8, 13.4**

- [x] 7. Checkpoint - Foundations
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Safety_Gate and Repair_Executor
  - [x] 8.1 Implement the Safety_Gate
    - Pure deterministic `evaluate(plan, config)` with rules R1 to R7 from the design (allowlisted action, exact Approved_File after symlink resolution, no traversal or escape, forbidden categories, at most 50 changed lines and no deletion, no Secret/shell/external network/test-disable content, exactly one target and no shell field)
    - Return a decision listing every rule and reason, plus an in-memory-key HMAC approval token bound to the canonical plan hash on approval
    - Record a `gate` Event from the orchestrator side (the gate itself calls no AI model and does no I/O)
    - _Requirements: 8.2, 8.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.9_

  - [x] 8.2 Write property test for Safety_Gate decision correctness
    - **Property 13: Safety_Gate decision correctness**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7**

  - [x] 8.3 Write property test for Safety_Gate determinism
    - **Property 14: Safety_Gate determinism**
    - **Validates: Requirements 9.10**

  - [x] 8.4 Write unit tests for the Safety_Gate
    - Cover allowlist violations, path traversal, symlink escape, oversize change, each Secret pattern, shell content and test-disable attempts
    - _Requirements: 19.1_

  - [x] 8.5 Implement the Repair_Executor
    - `apply(plan, approval)` verifies the token matches the plan hash, snapshots all Approved_Files, writes only the single target file through the File_Guard, and records the `repair` Event with incident ID, target, snapshot ID and pre/post checksums
    - On failure restore the snapshot and record an error Event
    - `restore(snapshotId)` returns checksums for comparison
    - Expose no shell and no general write function
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.9_

  - [x] 8.6 Write property test for approval binding
    - **Property 16: Approval binding**
    - **Validates: Requirements 10.1**

  - [x] 8.7 Write property test for apply and restore round trip
    - **Property 17: Apply and restore round trip**
    - **Validates: Requirements 10.8, 12.3**

  - [x] 8.8 Write property test for repair write scope
    - **Property 3: Write scope and snapshot-first** (repair operations: single target, snapshot first, restore on failure)
    - **Validates: Requirements 10.2, 10.3, 10.7, 17.1, 17.7**

- [x] 9. Verification_Engine
  - [x] 9.1 Implement the command builder
    - Build process invocations only from fixed templates in `command-templates.json`, with parameters limited to the component enum, as an executable plus argument array with no shell
    - _Requirements: 11.2, 17.5, 17.6_

  - [x] 9.2 Write property test for fixed command templates
    - **Property 33: Fixed command templates**
    - **Validates: Requirements 17.6**

  - [x] 9.3 Implement the verification runner and aggregation
    - Run Health_Checks, Vitest and Playwright checks that cover the affected component as real processes against the running Test_App, store raw output as referenced files, and save a Verification_Result
    - Pure `aggregate(checkResults, evidence)` returns `pass` only if all checks pass, none errored or timed out, and a check covering the affected component both ran and failed in the Evidence
    - Cancel and return `fail` after 120 seconds
    - Expose the engine only to the Orchestrator
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.10, 11.11, 11.12, 19.8_

  - [x] 9.4 Write property test for verification aggregation
    - **Property 18: Verification aggregation**
    - **Validates: Requirements 11.3, 11.4, 11.5, 11.6**

- [ ] 10. Exorcist and Poltergeist agents
  - [ ] 10.1 Implement the Exorcist input builder
    - `buildExorcistInput(incident, eventLog)` returns only Evidence, a read-only redacted source view of the Approved_Files and the Incident's own prior attempts, with no scenario ID, injection method or `chaos.*` data and no `.env` or `.git` content
    - _Requirements: 3.8, 7.1, 7.4, 17.3_

  - [ ]* 10.2 Write property test for the information barrier
    - **Property 7: Information barrier**
    - **Validates: Requirements 3.8, 5.2, 7.4**

  - [ ] 10.3 Implement Diagnosis and Repair_Plan validators
    - Validate Diagnosis against the schema (confidence 0 to 1, evidence used, status) and treat confidence below 0.5 or a missing Diagnosis as `inconclusive`
    - Validate Repair_Plan structure: exactly one target, allowlisted action, structured change, no command field, and detect an identical plan to a previously failed one
    - _Requirements: 7.2, 7.5, 7.8, 7.9, 8.1, 8.2, 8.3, 8.6_

  - [ ]* 10.4 Write property test for Diagnosis validation and confidence gate
    - **Property 11: Diagnosis validation and confidence gate**
    - **Validates: Requirements 7.2, 7.5, 7.8, 7.9**

  - [ ]* 10.5 Write property test for Repair_Plan structural validity
    - **Property 12: Repair_Plan structural validity**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.6**

  - [ ] 10.6 Implement the Fallback_Mapping engine
    - Deterministic matching of Evidence patterns and Approved_Files content to a Diagnosis (`rule_based`) and Repair_Plan
    - No access to the scenario ID or chaos Events; covers only the approved demo scenarios
    - _Requirements: 16.6, 16.8, 16.10_

  - [ ]* 10.7 Write property test for Fallback_Mapping determinism and isolation
    - **Property 31: Fallback_Mapping determinism and isolation**
    - **Validates: Requirements 16.10**

  - [ ] 10.8 Implement the Exorcist module with source selection
    - Define an AI client interface and a stub implementation; do not add an AI SDK until the provider is chosen and reviewed
    - `diagnose` and `plan` use the AI service when available; when it is unavailable and a mapping entry matches use the mapping (mark `rule_based`); otherwise return a no-source outcome for the Orchestrator to escalate
    - On retries pass the failed plan and its Verification_Result and require a different plan
    - Read the credential only from an environment variable, never write it to a file; Exorcist has no write or shell tools
    - _Requirements: 7.1, 7.3, 8.1, 8.5, 13.9, 16.5, 16.6, 16.8, 16.9_

  - [ ]* 10.9 Write property test for repair source selection
    - **Property 30: Repair source selection**
    - **Validates: Requirements 16.5, 16.6, 16.8, 16.9**

  - [ ] 10.10 Implement the Poltergeist module
    - Select scenarios only from the catalog public view (ID, label, severity), or use the validated user choice
    - Generate a run ID, record the selection Event with rationale, trigger failures only through the Scenario_Engine injection interface
    - Record the `battle_result` Event at the terminal state; no file or shell access and no access to Exorcist interfaces
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 11. Orchestrator cycle controller
  - [ ] 11.1 Implement `decideAfterFailure`
    - Pure function of attempt count and cause (failed verification, rejected plan, rejected diagnosis, apply error) returning `retry` or `rollbackAndEscalate` with a Retry_Budget of 3
    - _Requirements: 7.8, 8.6, 9.8, 12.1, 12.2, 12.5_

  - [ ]* 11.2 Write property test for retry budget bound
    - **Property 20: Retry budget bound**
    - **Validates: Requirements 12.1, 12.2, 12.5, 12.7**

  - [ ] 11.3 Implement the cycle controller
    - Drive `detected` through `investigating`, `planned`, `repairing`, `verifying` to a terminal state, recording each stage Event before the next stage begins
    - Apply the 60 second Diagnosis timeout, call the Safety_Gate before the executor, move to `repairing` before apply and to `verifying` after completion
    - After a failed verification or rejected step: rollback, verify restored checksums equal the snapshot, pass through `rolled_back`, then retry or escalate, recording rollback evidence
    - Escalate with an escalation Event (incident ID, every plan, every Verification_Result, reason) on exhausted budget, inconclusive diagnosis, no repair source, a rejected Fallback_Mapping plan (no substitute plan), checksum mismatch, unhandled error or Event_Log write failure
    - Record `recovered` only after a stored pass Verification_Result plus the Monitor's 3 healthy checks
    - Preserve evidence and snapshots for escalated Incidents until manual reset
    - Provide `startChaosRun(scenarioId?)` returning a conflict while an Incident is non-terminal
    - _Requirements: 7.7, 8.4, 9.8, 10.6, 10.10, 11.7, 11.9, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 14.8, 16.1, 16.2, 16.4, 16.5, 16.7, 16.11, 17.8, 20.7_

  - [ ]* 11.4 Write property test for rejection does not execute
    - **Property 15: Rejection does not execute**
    - **Validates: Requirements 9.8**

  - [ ]* 11.5 Write property test for rollback failure escalates
    - **Property 21: Rollback failure escalates**
    - **Validates: Requirements 12.4, 12.6**

  - [ ]* 11.6 Write property test for rule-based plan rejection escalates
    - **Property 32: Rule-based plan rejection escalates**
    - **Validates: Requirements 16.11**

  - [ ]* 11.7 Write integration tests with a stubbed Exorcist
    - Fixed correct plan for each of the six Scenarios ends in `recovered` with a stored pass result
    - Incorrect plan: confirm Rollback, at most three attempts and escalation
    - Cosmetic plan (change message text or hide the component): Verification fails and the Incident is never `recovered`
    - Event_Log unwritable stops the cycle and rolls back
    - Every Scenario ends in `recovered` or `escalated` only
    - _Requirements: 14.8, 16.4, 19.5, 19.6, 19.7_

- [ ] 12. HTTP API and live event stream
  - [ ] 12.1 Implement the Express API
    - Bind to 127.0.0.1, CORS only for the configured Dashboard origin, schema validation of every request body with HTTP 400 and no state change on failure
    - Endpoints: `GET /api/v1/health`, `GET /api/v1/scenarios` (public fields only), `POST /api/v1/chaos-runs` (409 while an Incident is non-terminal), `GET /api/v1/incidents`, `GET /api/v1/incidents/:id`, `GET /api/v1/incidents/:id/verification`, `GET /api/v1/events`, `POST /api/v1/reset`
    - Report storage errors in the health endpoint and never include Secrets in a response
    - Mount the SSE handler from 12.3
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 14.8_

  - [ ]* 12.2 Write property test for API input validation
    - **Property 22: API input validation**
    - **Validates: Requirements 13.3**

  - [ ] 12.3 Implement the SSE stream and replay
    - `GET /api/v1/events/stream` emits `id: <seq>`, honors `Last-Event-ID` and `afterSeq`, replays all greater sequence numbers in order before live Events, and delivers new Events within 1 second of persistence
    - _Requirements: 14.3, 14.4, 14.5_

  - [ ]* 12.4 Write property test for stream replay
    - **Property 26: Stream replay**
    - **Validates: Requirements 14.4**

  - [ ]* 12.5 Write API unit and integration tests
    - CORS allows only the configured origin, 409 on start while active, refusal to start on invalid config, SSE delivery latency and reconnect replay
    - _Requirements: 13.4, 13.5, 13.7, 14.5_

  - [ ] 12.6 Document the API
    - Complete `docs/api.md` (versioned) and the schema documents so the Dashboard can integrate; include request and response bodies, error format and Event types
    - _Requirements: 13.1, 20.3_

- [ ] 13. Checkpoint - Backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. React Dashboard
  - [ ] 14.1 Scaffold the frontend
    - After the team approves React and Vite in the dependency review, create the Vite React app in `frontend/` (JavaScript) with a test setup
    - Configure only the documented API base URL; no imports from `backend/`
    - _Requirements: 15.11, 20.1_

  - [ ] 14.2 Implement the Dashboard reducer
    - `reduce(state, event | apiResponse) -> state` builds all UI state from Events and API responses only
    - Timeline sorted by sequence number and deduplicated, recovery shown only with a `verification` Event of `overall=pass`, `escalated` and `rolled_back` shown distinctly, no state change from a start-chaos action alone
    - _Requirements: 14.11, 15.1, 15.2, 15.3, 15.5, 15.6, 15.8, 15.12_

  - [ ]* 14.3 Write property test for timeline ordering
    - **Property 28: Dashboard timeline ordering**
    - **Validates: Requirements 15.2, 15.7**

  - [ ]* 14.4 Write property test for outcome derived from Events
    - **Property 29: Dashboard derives outcome from Events**
    - **Validates: Requirements 14.11, 15.5, 15.6, 15.8**

  - [ ] 14.5 Implement the API client and SSE hook
    - Fetch health, scenarios, incidents and events through the documented API only
    - Use `EventSource` with reconnect from the last-seen sequence number and expose a connected or disconnected flag
    - Start chaos and reset only call the API and rely on later Events for state
    - _Requirements: 15.4, 15.7, 15.8, 15.9, 15.11_

  - [ ] 14.6 Implement the Dashboard views
    - Component health panel, live Event timeline, current Incident panel (state, component, Diagnosis, Repair_Plan, gate decision, attempt count, Verification_Result), idle state, and disconnected indicator
    - Escalation view that differs visibly from recovery and shows reason and rollback evidence
    - Past Incident viewer showing that Incident's Events and Evidence
    - Visual styling is owned by Aathavan; keep markup simple and testable
    - _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7, 15.12, 15.13_

  - [ ] 14.7 Implement controls and the repair diff
    - Start chaos with a chosen or random Scenario and a reset control
    - Render the repair diff from the `repair` Event content and checksums, and link the recovery panel to its Verification_Result
    - Wire into the views from 14.6 and the client from 14.5
    - _Requirements: 15.5, 15.9, 15.10_

  - [ ] 14.8 Add Playwright end-to-end tests
    - Cover the baseline healthy state, one injected failure shown on the Dashboard, one verified recovery with the Verification_Result visible, the disconnected indicator, and that start-chaos alone changes no displayed state
    - Run against the real backend and Test_App, never against canned success data
    - _Requirements: 15.8, 19.4_

- [ ] 15. Wiring and documentation
  - [ ] 15.1 Write the README run instructions
    - Add a README section on installing, starting the Test_App, backend and frontend on a local machine, running the demo and resetting the Test_App
    - State the AI-provider variable name and the Fallback_Mapping behavior
    - _Requirements: 20.5, 13.9_

  - [ ] 15.2 Create the backend entry point
    - Load and validate the configuration, start the Event_Log, Incident_Manager reload, Monitor, Scenario_Engine, Orchestrator and API in the documented order, and refuse to start on any invalid config
    - Provide an npm script for starting the backend
    - _Requirements: 6.9, 13.7, 13.8_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Skipping all property tests skips the fast-check install.
- Install fast-check in the first property test task that is executed, not before, and record it in `docs/dependency-review.md`. Every later property test task assumes it is already installed.
- Branch plan: `docs/governance` for tasks 1.1 and 15.1; `backend/*` branches (owner Dhanashri) for tasks 1.2 to 13 and 15.2; `frontend/*` branches (owner Aathavan) for task 14; `testapp/*` for tasks 2.1 and 2.3. Review before merging into main.
- Task 2.1 and 2.3 create real defects detectable by real checks. Do not simulate success in any task.
- Report a task complete only after its tests ran and their output is available. A repair or recovery task requires verification output.
- Open decision: the AI model provider. The stub client in 10.8 keeps the work unblocked; adding an SDK needs a review step.
- Property 3 appears twice (4.6 for injection, 8.8 for repair) because the two parts depend on different modules.
- Each task references requirements for traceability. Property tests validate universal properties and unit tests cover specific examples.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "14.1"] },
    { "id": 3, "tasks": ["1.4", "2.3", "3.1", "3.3", "3.4", "14.2"] },
    { "id": 4, "tasks": ["3.2", "3.5", "3.6", "4.1", "5.1", "6.1", "8.1", "9.1", "10.3", "14.3", "14.4", "14.6"] },
    { "id": 5, "tasks": ["3.7", "3.8", "3.9", "4.2", "5.2", "5.3", "6.2", "6.3", "6.4", "8.2", "8.3", "8.4", "9.2", "10.1", "10.4", "10.5", "10.6", "11.1"] },
    { "id": 6, "tasks": ["4.3", "5.4", "6.5", "6.6", "6.7", "8.5", "9.3", "10.2", "10.7", "10.8", "10.10", "11.2", "12.3"] },
    { "id": 7, "tasks": ["4.4", "4.5", "4.6", "8.6", "8.7", "8.8", "9.4", "10.9", "12.4"] },
    { "id": 8, "tasks": ["11.3"] },
    { "id": 9, "tasks": ["11.4", "11.5", "11.6", "11.7", "12.1"] },
    { "id": 10, "tasks": ["12.2", "12.5", "12.6", "15.2"] },
    { "id": 11, "tasks": ["14.5", "15.1"] },
    { "id": 12, "tasks": ["14.7"] },
    { "id": 13, "tasks": ["14.8"] }
  ]
}
```
