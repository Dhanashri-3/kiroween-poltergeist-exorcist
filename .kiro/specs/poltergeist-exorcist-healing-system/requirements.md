# Requirements Document

## Introduction

Poltergeist QA vs. The Exorcist is a local hackathon demonstration of an autonomous chaos engineering and self-healing loop. A Poltergeist agent injects controlled, reversible failures into an isolated Test_App. An independent Monitor detects the failures and opens Incidents. An Exorcist agent investigates each Incident, proposes a Repair_Plan, and applies it through a restricted Repair_Executor after a Safety_Gate approves it. The Verification_Engine then proves recovery with real tests and health checks. A React Dashboard shows the real events and state over a live event stream.

The system is a demo environment, not a production repair platform. Every requirement below applies only to the local Test_App and its approved files.

Technology direction (subject to architecture review before any new dependency is added): React + Vite frontend (owned by Aathavan, in `frontend/`), Node.js + Express backend orchestrator (owned by Dhanashri, in `backend/`), Server-Sent Events for live streaming, Vitest and Playwright for verification, fast-check for property-based testing, Ajv for JSON Schema validation, and local JSON file storage. The Test_App directory is `testapp/` at the repository root (approved). The fast-check and Ajv dependencies are approved but SHALL NOT be installed until the relevant implementation tasks, after review. The AI model provider remains an open decision.

Scope of this document: requirements only. No implementation code is part of this specification.

## Glossary

- **System**: The complete Poltergeist QA vs. The Exorcist application, including all components below.
- **Test_App**: The isolated web application, located in the `testapp/` directory at the repository root, that is the only target of chaos and repair.
- **Orchestrator**: The Node.js + Express backend service that coordinates all components and exposes the API.
- **Scenario_Engine**: The component that holds the Scenario_Catalog and performs controlled injection and reversal of failures.
- **Scenario_Catalog**: The fixed, versioned list of approved chaos scenarios, each with a target component, an injection method, a reversal method, and an expected Repair_Action.
- **Scenario**: One entry of the Scenario_Catalog.
- **Poltergeist**: The chaos agent that selects a Scenario and requests injection through the Scenario_Engine.
- **Monitor**: The detection component that checks Test_App health independently of the Poltergeist and the Exorcist.
- **Health_Check**: A scripted probe of the Test_App (HTTP status, DOM presence, or behavior check) that returns pass or fail with evidence.
- **Incident**: A persisted record of one detected failure, identified by a unique Incident_ID.
- **Incident_Manager**: The component that creates, updates, and closes Incidents and enforces the Incident state machine.
- **Evidence**: Captured data attached to an Incident, such as Health_Check results, error messages, console logs, DOM snapshot, screenshot path, and test output.
- **Exorcist**: The diagnostic agent that investigates an Incident and produces a Diagnosis and a Repair_Plan. The Exorcist has read-only access to the Test_App sources.
- **Diagnosis**: The Exorcist's structured statement of the affected component, root cause, and confidence.
- **Repair_Plan**: A structured, declarative description of the proposed change: Repair_Action type, target file, and change content.
- **Repair_Action**: One of the approved action types listed in the Action_Allowlist.
- **Action_Allowlist**: The fixed list of Repair_Action types and the Approved_Files each may modify.
- **Approved_Files**: The explicit list of Test_App file paths that the System may modify.
- **Safety_Gate**: The component that validates a Repair_Plan against the Action_Allowlist, Approved_Files, and size limits before execution.
- **Repair_Executor**: The restricted component that is the only component allowed to write to Approved_Files during repair. The Repair_Executor accepts a validated Repair_Plan and has no general shell access.
- **Snapshot**: A stored copy of every Approved_File taken before any modification, with a checksum.
- **Verification_Engine**: The component that runs Vitest tests, Playwright tests, and Health_Checks after a repair and returns a Verification_Result.
- **Verification_Result**: A record containing each check executed, its outcome, its raw output reference, and an overall pass or fail.
- **Recovery**: The state in which the Verification_Result is pass for the Incident's relevant checks.
- **Retry_Budget**: The maximum number of repair attempts per Incident, fixed at 3.
- **Rollback**: Restoring Approved_Files from a Snapshot and confirming the restored checksums.
- **Fallback_Mapping**: A configured, deterministic, evidence-based mapping from observed Evidence patterns of approved demo scenarios to a Diagnosis and a Repair_Plan, used without an AI model service.
- **Escalation**: Marking an Incident as requiring human attention, with a summary of attempts.
- **Event**: A structured, timestamped, sequence-numbered record of a System occurrence, stored in the Event_Log.
- **Event_Log**: The append-only local JSON store of all Events.
- **Event_Stream**: The SSE endpoint that delivers Events to the Dashboard.
- **Dashboard**: The React user interface that renders Test_App health, Incidents, Events, and results.
- **Secret**: Any credential, API key, token, or environment file content.
- **Demo_Mode**: The default operating mode in which all components run on the local machine against the Test_App only.

## Requirements

### Requirement 1: Isolated Test Application

**User Story:** As a demo presenter, I want a small isolated web application to be the only target of failures and repairs, so that the demo is safe and repeatable.

#### Acceptance Criteria

1. THE Test_App SHALL run as a local process bound only to the loopback address 127.0.0.1.
2. THE Test_App SHALL contain at least four designated test components: a button, a layout section, a data panel that loads from a mock API, and a styled card.
3. THE Test_App SHALL expose a Health_Check endpoint that returns an HTTP 200 status and a JSON body listing the status of each designated test component.
4. THE Test_App SHALL keep all of its source files within the `testapp/` directory at the repository root, which is separate from `frontend/` and `backend/`.
5. THE Test_App SHALL use only a local mock API and SHALL make no network requests to external hosts.
6. THE System SHALL maintain a configuration file that lists the Approved_Files, and the Approved_Files SHALL reside only within the Test_App directory.
7. WHEN the Test_App starts in its unmodified baseline state, THE Verification_Engine SHALL report pass for all Health_Checks and all baseline tests.
8. IF any Health_Check fails in the baseline state, THEN THE Verification_Engine SHALL return a baseline Verification_Result of fail, even when all baseline tests pass.

### Requirement 2: Scenario Catalog

**User Story:** As a project owner, I want a fixed catalog of approved chaos scenarios, so that failures are controlled and reversible.

#### Acceptance Criteria

1. THE Scenario_Catalog SHALL contain exactly these initial Scenarios: button failure, layout corruption, component disappearance, API failure, styling failure, and loading failure.
2. THE Scenario_Catalog SHALL define for each Scenario a unique scenario ID, a target component, an injection method, a reversal method, a severity label, and an expected Repair_Action.
3. THE Scenario_Engine SHALL load the Scenario_Catalog from a versioned file at startup.
4. IF the Scenario_Catalog file is missing, malformed, or contains a Scenario whose target is outside the Approved_Files, THEN THE Scenario_Engine SHALL refuse to start and SHALL record an error Event naming the invalid entry.
5. THE Scenario_Engine SHALL reject any injection request whose scenario ID is not present in the Scenario_Catalog.
6. FOR ALL Scenarios, injecting the Scenario and then applying the reversal method SHALL restore every affected Approved_File to a checksum identical to its baseline checksum (round-trip property).

### Requirement 3: Controlled Chaos Injection

**User Story:** As a demo presenter, I want failures injected in a controlled and recorded way, so that each failure is real, bounded, and traceable.

#### Acceptance Criteria

1. WHEN the Poltergeist requests injection of a Scenario, THE Scenario_Engine SHALL create a Snapshot of all Approved_Files before modifying any file.
2. WHEN the Scenario_Engine injects a Scenario, THE Scenario_Engine SHALL modify only the Approved_Files designated for that Scenario.
3. WHEN the Scenario_Engine completes an injection, THE Scenario_Engine SHALL record a chaos Event containing the scenario ID, target component, files modified, pre-injection checksums, post-injection checksums, and timestamp.
4. WHILE an Incident is in any non-terminal state, THE Scenario_Engine SHALL reject new injection requests and SHALL record a rejection Event.
5. IF an injection fails midway, THEN THE Scenario_Engine SHALL restore the Approved_Files from the Snapshot taken in criterion 1 and SHALL record an error Event.
6. THE Scenario_Engine SHALL provide a manual reset operation that restores the Test_App to the baseline state and records a reset Event.
7. WHEN an injection completes, THE Scenario_Engine SHALL leave the injected change observable as a real defect in the running Test_App, detectable by at least one Health_Check or test.
8. THE Scenario_Engine SHALL NOT report to the Monitor, the Exorcist, or the Incident_Manager which Scenario was injected, so that detection and diagnosis rely on Evidence only.

### Requirement 4: Poltergeist Agent Boundaries

**User Story:** As a project owner, I want the Poltergeist limited to approved chaos actions, so that it cannot damage anything beyond the test target.

#### Acceptance Criteria

1. THE Poltergeist SHALL select Scenarios only from the Scenario_Catalog.
2. THE Poltergeist SHALL trigger failures only by calling the Scenario_Engine injection interface.
3. THE Poltergeist SHALL have no write access to any file and no shell access.
4. WHEN the Poltergeist selects a Scenario, THE Poltergeist SHALL generate a unique Incident_ID-independent chaos run ID and record a selection Event with the scenario ID and rationale.
5. THE Poltergeist SHALL have no access to the Exorcist's Diagnosis, Repair_Plan, or Repair_Executor interfaces.
6. WHERE a user selects a specific Scenario on the Dashboard, THE Poltergeist SHALL use the user-selected Scenario instead of choosing one.
7. WHEN an Incident reaches a terminal state, THE Poltergeist SHALL record the final battle result Event referencing the chaos run ID and the Incident_ID.

### Requirement 5: Independent Monitoring and Detection

**User Story:** As a project owner, I want detection to be independent of the agents, so that failures are found from observed evidence and not from agent claims.

#### Acceptance Criteria

1. THE Monitor SHALL execute Health_Checks against the Test_App at a configurable interval with a default of 2 seconds.
2. THE Monitor SHALL operate without reading the Poltergeist's selection Events or the Scenario_Engine's chaos Events.
3. WHEN a Health_Check fails for 2 consecutive executions, THE Monitor SHALL report a detection to the Incident_Manager with the failing Health_Check identifiers and Evidence.
4. WHEN a detection occurs, THE Monitor SHALL capture Evidence consisting of the Health_Check response, the browser console errors, a DOM snapshot of the affected component, and a screenshot path.
5. IF the Monitor cannot reach the Test_App, THEN THE Monitor SHALL report an availability failure detection.
6. WHEN a failed Health_Check later passes for 2 consecutive executions while no Incident references it, THE Monitor SHALL record a cleared Event.
7. THE Monitor SHALL record a detection Event within 10 seconds of the first failing Health_Check under the default interval.
8. IF a Health_Check fails for only 1 execution followed by a pass, THEN THE Monitor SHALL record a transient Event and SHALL NOT open an Incident.
9. WHILE a non-terminal Incident references a Health_Check, WHEN that Health_Check passes for 2 consecutive executions, THE Monitor SHALL withhold the cleared Event until the Incident reaches a terminal state.

### Requirement 6: Incident Management

**User Story:** As an operator, I want every detected failure tracked as an incident with a clear lifecycle, so that I can see what happened and what state it is in.

#### Acceptance Criteria

1. WHEN the Incident_Manager receives a detection, THE Incident_Manager SHALL create an Incident with a unique Incident_ID, detection timestamp, affected component, attached Evidence, and the state `detected`.
2. THE Incident_Manager SHALL enforce the Incident state machine with these states: `detected`, `investigating`, `planned`, `repairing`, `verifying`, `recovered`, `rolled_back`, and `escalated`.
3. THE Incident_Manager SHALL treat only `recovered` and `escalated` as terminal states and SHALL treat `rolled_back` as a transient state.
4. THE Incident_Manager SHALL permit a transition to `rolled_back` only after a Rollback has restored the affected Approved_Files and the restored checksums have been verified as equal to the Snapshot checksums.
5. IF a component requests a state transition not permitted by the state machine, THEN THE Incident_Manager SHALL reject the transition and SHALL record an error Event.
6. WHEN an Incident changes state, THE Incident_Manager SHALL persist the Incident and record a state-change Event containing the previous state, the new state, and a timestamp.
7. WHEN a detection references a failing component already covered by a non-terminal Incident, THE Incident_Manager SHALL attach the new Evidence to the existing Incident and SHALL NOT create a duplicate Incident.
8. THE Incident_Manager SHALL allow at most one non-terminal Incident at a time in Demo_Mode.
9. WHEN the System restarts, THE Incident_Manager SHALL reload persisted Incidents and SHALL mark any Incident left in `repairing` or `verifying` as requiring Rollback verification before any new injection is permitted.
10. FOR ALL Incidents, the persisted Incident record SHALL be serializable to JSON and deserializable back to an equivalent Incident (round-trip property).

### Requirement 7: Exorcist Diagnosis

**User Story:** As an operator, I want the Exorcist to investigate evidence and source code to find the real root cause, so that repairs are targeted and not guesses.

#### Acceptance Criteria

1. WHEN an Incident enters `investigating`, THE Exorcist SHALL receive the Incident Evidence and read access to the Approved_Files.
2. THE Exorcist SHALL produce a Diagnosis containing the Incident_ID, the affected component, the suspected file and location, the root cause statement, a confidence value between 0 and 1, and the list of Evidence items used.
3. THE Exorcist SHALL have no write access to any file and no shell access.
4. THE Exorcist SHALL NOT receive the scenario ID, the injection method, or any chaos Event for the Incident.
5. IF the Exorcist cannot determine a root cause with confidence of at least 0.5, THEN THE Exorcist SHALL return a Diagnosis marked `inconclusive` and THE Incident_Manager SHALL move the Incident to `escalated`.
6. WHEN the Exorcist completes a Diagnosis, THE Orchestrator SHALL validate that the Diagnosis conforms to the Diagnosis schema and SHALL record a diagnosis Event.
7. IF the Exorcist does not return a Diagnosis within 60 seconds, THEN THE Orchestrator SHALL record a timeout Event and SHALL move the Incident to `escalated`.
8. IF a Diagnosis fails schema validation, THEN THE Orchestrator SHALL reject the Diagnosis and SHALL count the rejection as one attempt against the Retry_Budget.
9. IF the confidence in a root cause is below 0.5 and no Diagnosis object was produced, THEN THE Orchestrator SHALL treat the outcome as `inconclusive` and THE Incident_Manager SHALL move the Incident to `escalated`.

### Requirement 8: Repair Planning

**User Story:** As an operator, I want the Exorcist to propose a minimal, structured repair, so that each change can be reviewed and validated before it is applied.

#### Acceptance Criteria

1. WHEN a Diagnosis is accepted, THE Exorcist SHALL produce a Repair_Plan containing the Incident_ID, one Repair_Action type from the Action_Allowlist, the target file path, the exact change content, and a rationale.
2. THE Repair_Plan SHALL describe a change to exactly one Approved_File per plan.
3. THE Repair_Plan SHALL be expressed as structured data and SHALL contain no executable shell command.
4. WHEN the Exorcist produces a Repair_Plan, THE Orchestrator SHALL record a plan Event and SHALL move the Incident to `planned`.
5. WHEN a previous repair attempt for the same Incident has failed, THE Exorcist SHALL receive the failed Repair_Plan and its Verification_Result and SHALL produce a different Repair_Plan.
6. IF the Exorcist returns a Repair_Plan that is identical to a previously failed Repair_Plan for the same Incident, THEN THE Orchestrator SHALL reject the plan and SHALL count the rejection as one attempt against the Retry_Budget.
7. THE Repair_Plan SHALL be serializable to JSON and deserializable back to an equivalent Repair_Plan (round-trip property).

### Requirement 9: Safety Gate

**User Story:** As a project owner, I want every repair validated against strict rules before it runs, so that the repair agent cannot cause harm.

#### Acceptance Criteria

1. WHEN a Repair_Plan is submitted, THE Safety_Gate SHALL validate that the Repair_Action type is in the Action_Allowlist.
2. WHEN a Repair_Plan is submitted, THE Safety_Gate SHALL validate that the normalized, symlink-resolved target path is an exact member of the Approved_Files.
3. IF a target path contains path traversal segments, an absolute path outside the Test_App directory, or resolves outside the Test_App directory, THEN THE Safety_Gate SHALL reject the Repair_Plan.
4. IF a Repair_Plan targets an environment file, a Secret, a configuration file, a package manifest, a test file, or a file in `frontend/`, `backend/`, or `.kiro/`, THEN THE Safety_Gate SHALL reject the Repair_Plan.
5. IF a Repair_Plan changes more than 50 lines, or deletes a file, THEN THE Safety_Gate SHALL reject the Repair_Plan.
6. IF a Repair_Plan content contains a Secret pattern, a shell command, a network call to an external host, or an instruction to disable or modify a test or Health_Check, THEN THE Safety_Gate SHALL reject the Repair_Plan.
7. WHEN the Safety_Gate evaluates a Repair_Plan, THE Safety_Gate SHALL record a gate Event containing the decision (`approved` or `rejected`), each rule evaluated, and the reason for each rejection.
8. WHEN the Safety_Gate rejects a Repair_Plan, THE Orchestrator SHALL count the rejection as one attempt against the Retry_Budget and SHALL NOT invoke the Repair_Executor.
9. THE Safety_Gate SHALL make its decision using deterministic code that does not call any AI model.
10. FOR ALL Repair_Plans, THE Safety_Gate SHALL return the same decision when evaluating the same Repair_Plan against the same configuration repeatedly (idempotence).

### Requirement 10: Restricted Repair Execution

**User Story:** As a project owner, I want repairs applied by a restricted executor with snapshots, so that every change is bounded and recoverable.

#### Acceptance Criteria

1. THE Repair_Executor SHALL accept only a Repair_Plan that carries a Safety_Gate approval decision for the same plan content.
2. WHEN the Repair_Executor receives an approved Repair_Plan, THE Repair_Executor SHALL create a Snapshot of all Approved_Files, record the Snapshot checksums, and then apply the change.
3. THE Repair_Executor SHALL write only to the single target file named in the approved Repair_Plan.
4. THE Repair_Executor SHALL expose no general shell execution and no arbitrary file write interface.
5. WHEN the Repair_Executor applies a change, THE Repair_Executor SHALL record a repair Event containing the Incident_ID, target file, Snapshot identifier, pre-change checksum, and post-change checksum.
6. WHEN the Repair_Executor receives an approved Repair_Plan, THE Orchestrator SHALL move the Incident to `repairing` before the Repair_Executor applies the change.
7. IF the Repair_Executor fails to apply a change, THEN THE Repair_Executor SHALL restore the Snapshot and SHALL record an error Event.
8. FOR ALL approved Repair_Plans, applying the change and then restoring the Snapshot SHALL produce Approved_Files with checksums identical to the pre-change checksums (round-trip property).
9. THE Repair_Executor SHALL retain Snapshots for the duration of the Incident and for at least the current demo session.
10. WHEN the Repair_Executor completes the change while the Incident is in `repairing`, THE Orchestrator SHALL move the Incident to `verifying`.
11. IF a transition to `verifying` is requested while the Incident is not in `repairing` or before the Repair_Executor has completed the change, including a request made when the System resumes after a restart, THEN THE Incident_Manager SHALL reject the transition as invalid and SHALL record an error Event.

### Requirement 11: Verification and Recovery Confirmation

**User Story:** As an operator, I want recovery confirmed only by real tests and health checks, so that the System never reports a false recovery.

#### Acceptance Criteria

1. WHEN the Incident enters `verifying`, THE Verification_Engine SHALL execute the Health_Checks, the Vitest unit tests, and the Playwright end-to-end tests that cover the affected component.
2. THE Verification_Engine SHALL execute the checks as actual process runs against the running Test_App and SHALL store the raw output of each check.
3. WHEN all executed checks pass, THE Verification_Engine SHALL return a Verification_Result of pass and THE Incident_Manager SHALL move the Incident to `recovered`.
4. IF any executed check fails, THEN THE Verification_Engine SHALL return a Verification_Result of fail listing each failing check.
5. IF a check cannot run because of a tooling error or timeout, THEN THE Verification_Engine SHALL return a Verification_Result of fail.
6. THE Verification_Engine SHALL require that at least one check exercised the originally failing component and that this check previously failed in the Incident Evidence.
7. WHEN the Incident moves to `recovered`, THE Incident_Manager SHALL verify that the Verification_Result referenced by the Incident exists in the Event_Log and has an overall result of pass.
8. THE System SHALL NOT mark an Incident as `recovered` without a stored Verification_Result of pass.
9. WHEN the Verification_Result is pass, THE Monitor SHALL additionally confirm 3 consecutive passing Health_Checks before the `recovered` Event is recorded.
10. THE Verification_Engine SHALL complete all checks for a single verification run within 120 seconds.
11. IF the Verification_Engine does not complete within 120 seconds, THEN THE Verification_Engine SHALL cancel the run and SHALL return a Verification_Result of fail.
12. THE Verification_Engine SHALL NOT be callable by the Exorcist or the Repair_Executor for the purpose of altering a Verification_Result.

### Requirement 12: Retry, Rollback and Escalation

**User Story:** As an operator, I want failed repairs to be retried a limited number of times and then rolled back or escalated, so that the demo never ends in a worse state.

#### Acceptance Criteria

1. THE Orchestrator SHALL apply a Retry_Budget of 3 attempts per Incident.
2. WHEN a Verification_Result is fail and the Retry_Budget is not exhausted, THE Orchestrator SHALL perform a Rollback, SHALL record the Rollback evidence, SHALL move the Incident to `rolled_back` after the restored checksums are verified, and SHALL then return the Incident to `investigating` with the failed attempt record.
3. WHEN a Rollback is performed, THE Repair_Executor SHALL restore Approved_Files from the Snapshot and the Orchestrator SHALL verify that the restored checksums equal the Snapshot checksums.
4. IF the restored checksums differ from the Snapshot checksums, THEN THE Orchestrator SHALL move the Incident to `escalated` and SHALL record a rollback-failure Event.
5. WHEN the Retry_Budget is exhausted, THE Orchestrator SHALL perform a Rollback, SHALL record the Rollback evidence, SHALL move the Incident to `rolled_back` after the restored checksums are verified, and then SHALL move the Incident to `escalated`.
6. WHEN an Incident is `escalated`, THE Orchestrator SHALL record an escalation Event containing the Incident_ID, every attempt's Repair_Plan, every Verification_Result, and the reason for Escalation.
7. WHEN an Incident is `escalated`, THE Orchestrator SHALL stop all further automated repair attempts for that Incident.
8. WHEN an Incident is `escalated`, THE Scenario_Engine SHALL permit the manual reset operation from Requirement 3 to restore the baseline state.
9. IF any component throws an unhandled error during the repair cycle, THEN THE Orchestrator SHALL perform a Rollback, SHALL record an error Event, and SHALL move the Incident to `escalated`, passing through `rolled_back` only when the restored checksums are verified.
10. WHEN a Rollback restores the Test_App to the injected-failure state, THE Monitor SHALL continue to report the failure as an active Incident rather than as healthy.

### Requirement 13: Orchestrator and API

**User Story:** As a frontend developer, I want a documented API, so that the Dashboard integrates without depending on backend internals.

#### Acceptance Criteria

1. THE Orchestrator SHALL expose an HTTP API bound to 127.0.0.1 and documented in a versioned interface document stored in the repository.
2. THE Orchestrator SHALL expose endpoints to get current Test_App health, list Scenarios, start a chaos run, list Incidents, get one Incident, get a Verification_Result, list Events, and reset the Test_App.
3. WHEN a client sends a request with a body that fails schema validation, THE Orchestrator SHALL return an HTTP 400 response with a structured error body and SHALL NOT change System state.
4. IF a client sends a start-chaos request while an Incident is non-terminal, THEN THE Orchestrator SHALL return an HTTP 409 response.
5. THE Orchestrator SHALL permit cross-origin requests only from the configured Dashboard origin on the loopback address.
6. THE Orchestrator SHALL read configuration from environment variables or a non-secret configuration file and SHALL NOT include Secrets in any API response, Event, log, or Evidence.
7. WHEN the Orchestrator starts, THE Orchestrator SHALL verify that the Approved_Files, Scenario_Catalog, and Action_Allowlist configuration files are present and valid, and SHALL refuse to start otherwise.
8. THE Orchestrator SHALL keep the Poltergeist, the Exorcist, the Safety_Gate, the Repair_Executor, the Monitor, and the Verification_Engine in separate modules that communicate only through defined interfaces.
9. WHERE the Exorcist or the Poltergeist uses an AI model service, THE Orchestrator SHALL read the access credential from an environment variable and SHALL NOT write the credential to any file in the repository.

### Requirement 14: Event Log and Live Event Stream

**User Story:** As a judge, I want to watch real events appear live, so that I can trust the battle is genuine.

#### Acceptance Criteria

1. THE Event_Log SHALL store each Event as an append-only JSON record with a unique ID, a monotonically increasing sequence number, a timestamp, an event type, an Incident_ID or chaos run ID where applicable, the originating component, and a payload.
2. WHEN any component records an Event, THE Orchestrator SHALL persist the Event to the Event_Log before publishing the Event to the Event_Stream.
3. THE Event_Stream SHALL deliver Events to connected Dashboards through Server-Sent Events.
4. WHEN a Dashboard connects to the Event_Stream with a last-seen sequence number, THE Event_Stream SHALL replay all Events with a greater sequence number before delivering new Events.
5. THE Event_Stream SHALL deliver an Event to a connected Dashboard within 1 second of the Event being persisted.
6. THE Event_Log SHALL record Events for at least these types: chaos selection, injection, detection, incident state change, diagnosis, plan, gate decision, repair, verification, rollback, escalation, recovery, reset, and error.
7. THE Orchestrator SHALL apply an Event payload size limit of 64 KB and SHALL store larger Evidence as a referenced file.
8. IF the Event_Log file is unwritable, THEN THE Orchestrator SHALL stop the active repair cycle, SHALL perform a Rollback, and SHALL report the storage error through the API health endpoint.
9. FOR ALL Events, serializing an Event to JSON and deserializing the result SHALL produce an equivalent Event (round-trip property).
10. FOR ALL Event_Log contents, sequence numbers SHALL be strictly increasing with no duplicates (invariant).
11. THE System SHALL generate Dashboard state only from Events and API responses and SHALL NOT include precomputed success outcomes.

### Requirement 15: Live Dashboard

**User Story:** As a judge, I want a live dashboard that shows the failure, diagnosis, repair, and verified recovery, so that I can follow the battle in real time.

#### Acceptance Criteria

1. THE Dashboard SHALL display the current health status of each designated test component of the Test_App, derived from the API health response.
2. THE Dashboard SHALL display a live Event timeline fed from the Event_Stream, ordered by sequence number.
3. THE Dashboard SHALL display the current Incident with its state, affected component, Diagnosis, Repair_Plan, gate decision, attempt count, and Verification_Result.
4. WHEN a new Event arrives through the Event_Stream, THE Dashboard SHALL display the Event within 1 second.
5. WHEN the Incident state becomes `recovered`, THE Dashboard SHALL display the recovery result only together with a link or panel showing the Verification_Result that supports it.
6. WHEN the Incident state becomes `escalated`, THE Dashboard SHALL display the failure outcome, the reason, and any Rollback evidence distinctly from a recovery.
7. IF the Event_Stream connection is lost, THEN THE Dashboard SHALL display a disconnected indicator and SHALL attempt to reconnect, resuming from the last-seen sequence number.
8. WHEN a user activates a start-chaos control, THE Dashboard SHALL call the Orchestrator API and SHALL NOT change any displayed health or Incident state until the corresponding Events or API responses arrive.
9. THE Dashboard SHALL provide controls to start a chaos run with a chosen or random Scenario and to reset the Test_App.
10. THE Dashboard SHALL display a visual diff of the applied repair using the checksums and the changed content from the repair Event.
11. THE Dashboard SHALL communicate with the Orchestrator only through the documented API and SHALL NOT import backend source code.
12. WHILE no Incident exists, THE Dashboard SHALL display an idle state with the latest known component health.
13. WHEN a user selects a past Incident, THE Dashboard SHALL display the Events and Evidence for that Incident from the Event_Log.

### Requirement 16: Autonomous Repair Cycle

**User Story:** As a judge, I want the full cycle from failure to verified recovery to run without human input, so that the demo shows genuine autonomy.

#### Acceptance Criteria

1. WHEN a chaos run is started and the Monitor detects the resulting failure, THE System SHALL proceed through `detected`, `investigating`, `planned`, `repairing`, `verifying`, and `recovered` without human input when each stage succeeds.
2. WHEN each stage of the cycle completes, THE System SHALL record the stage Event before the next stage begins.
3. THE System SHALL complete the full cycle for a single Scenario within 3 minutes of injection, assuming successful first-attempt repair and an available AI model service.
4. FOR ALL Scenarios in the Scenario_Catalog, WHEN the Scenario is injected and the repair cycle runs to completion, THE System SHALL end in `recovered` with a Verification_Result of pass or in `escalated` with an escalation Event, and in no other terminal outcome.
5. IF the AI model service is unavailable and no Fallback_Mapping matches the Incident Evidence, THEN THE Orchestrator SHALL record an error Event, SHALL perform any needed Rollback, and SHALL move the Incident to `escalated`.
6. WHEN the AI model service is unavailable and a configured Fallback_Mapping matches the Incident Evidence, THE Exorcist SHALL use the Fallback_Mapping to produce the Diagnosis and Repair_Plan.
7. WHEN the cycle ends in `recovered`, THE System SHALL leave the Approved_Files in a state whose Health_Checks pass and SHALL leave the Snapshot available for manual comparison.
8. THE Exorcist SHALL mark each Diagnosis produced from the Fallback_Mapping as `rule_based`.
9. WHILE the AI model service is available, THE Exorcist SHALL use the AI model service instead of the Fallback_Mapping.
10. THE Fallback_Mapping SHALL cover only approved demo Scenarios, SHALL be deterministic, and SHALL derive each Diagnosis from Incident Evidence and Approved_Files content without access to the scenario ID or any chaos Event.
11. IF the Safety_Gate rejects a Repair_Plan produced from the Fallback_Mapping, THEN THE Orchestrator SHALL move the Incident to `escalated` and SHALL NOT generate a substitute Repair_Plan.

### Requirement 17: Safety and Isolation Guarantees

**User Story:** As a project owner, I want global safety boundaries enforced by the System, so that no component can act beyond the demo scope.

#### Acceptance Criteria

1. THE System SHALL perform all file writes during chaos injection, repair, and Rollback only on Approved_Files and the System's own storage directories.
2. THE System SHALL make no network requests to hosts other than 127.0.0.1 and the configured AI model service endpoint.
3. THE System SHALL exclude Secrets, environment files, and the `.git` directory from every Evidence capture, every Event payload, and every file provided to the Exorcist.
4. IF a component attempts a file operation on a path that is not an Approved_File and not within the System's storage directories, THEN THE System SHALL deny the operation and SHALL record a security Event.
5. THE System SHALL provide the Exorcist and the Poltergeist with a tool set that excludes arbitrary shell execution.
6. THE System SHALL execute test processes only from a fixed list of command templates defined in configuration, and SHALL NOT interpolate agent-provided text into a command line.
7. THE System SHALL enforce that every code modification of the Test_App by the System is preceded by a Snapshot.
8. IF an Incident is `escalated`, THEN THE System SHALL preserve the failure Evidence, the Snapshots, and the Event_Log for that Incident until the next manual reset.

### Requirement 18: Persistence

**User Story:** As a developer, I want simple local storage, so that the project stays easy to run and cost-free.

#### Acceptance Criteria

1. THE System SHALL store Incidents, Events, Verification_Results, and Snapshots metadata as JSON files within a dedicated storage directory that is excluded from version control.
2. WHEN the System writes a JSON storage file, THE System SHALL write to a temporary file and then rename the temporary file to the target name to prevent partial writes.
3. IF a JSON storage file is corrupt at startup, THEN THE System SHALL preserve the corrupt file under a distinct name, SHALL start with an empty store for that file, and SHALL record an error Event.
4. THE System SHALL provide an interface for storage that allows a replacement of local JSON files by another store without changes to the agent modules.
5. FOR ALL stored records, writing a record and then reading the record SHALL return an equivalent record (round-trip property).

### Requirement 19: Testing and Quality of the System

**User Story:** As a developer, I want the System's own logic to be tested, so that the safety claims are provable.

#### Acceptance Criteria

1. THE System SHALL include Vitest unit tests for the Safety_Gate covering allowlist violations, path traversal, oversized changes, and Secret patterns.
2. THE System SHALL include Vitest unit tests for the Incident state machine covering every permitted and every rejected transition.
3. THE System SHALL include property-based tests for the round-trip, idempotence, and invariant properties named in Requirements 2, 6, 8, 9, 10, 14, and 18.
4. THE System SHALL include Playwright end-to-end tests that cover at least the baseline healthy state, one injected failure, and one verified recovery.
5. THE System SHALL include an integration test that runs the full repair cycle against a stubbed Exorcist, which returns a fixed Repair_Plan, so that the cycle can be tested without an AI model service.
6. THE System SHALL include an integration test in which the stubbed Exorcist returns an incorrect Repair_Plan, and the test SHALL confirm Rollback, bounded retries, and Escalation.
7. THE System SHALL include a test confirming that a Repair_Plan which only changes a message string or hides the failing component fails Verification and is not reported as `recovered`.
8. WHEN a test run completes, THE System SHALL store the test output so that the Dashboard can display the Verification_Result.

### Requirement 20: Development Governance and Ownership

**User Story:** As a team member, I want clear module ownership and review rules, so that two developers can work in parallel without conflicts.

#### Acceptance Criteria

1. THE System SHALL place all frontend code in `frontend/`, all backend and agent orchestration code in `backend/`, and the Test_App in `testapp/` at the repository root.
2. THE System SHALL keep the Poltergeist module and the Exorcist module in separate directories with no direct imports between them.
3. THE System SHALL document the API, the Event schema, the Diagnosis schema, the Repair_Plan schema, and the Scenario_Catalog schema in a repository document before the Dashboard integrates with the Orchestrator.
4. THE System SHALL list every runtime dependency in a dependency review document that records its purpose, and each dependency SHALL be approved by the team before installation. The dependency review document SHALL record fast-check (property-based testing) and Ajv (JSON Schema validation) as approved, and THE System SHALL install each of them only during the implementation task that requires it, after review.
5. THE System SHALL include a README section that describes how to install, start, and run the demo on a local machine and how to reset the Test_App.
6. WHERE Kiro agents, steering files, specs, and hooks are used during development, THE System SHALL store them under `.kiro/` and SHALL restrict each agent to the tools defined in its agent configuration.
7. THE System SHALL record each Scenario, repair, and Verification_Result of a demo session in the Event_Log so that the session can be reviewed after the demo.
