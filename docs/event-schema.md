# Event Schema

Implemented in `backend/src/contracts/event.schema.js` (schema name `Event`). Incident, Evidence, Snapshot and Verification_Result are documented here because they are the records carried by or referenced from Events. Shared definitions are in `backend/src/contracts/common.js`. Unknown properties are rejected on every schema (`additionalProperties: false`).

Validation: `validate(schemaName, value)` from `backend/src/contracts/index.js` returns `{ valid, errors[] }`. Each error is `{ path, keyword, message, params }`. An unknown schema name returns `valid: false` with one error of keyword `unknownSchema`.

Shared formats: UUID = 8-4-4-4-12 hex pattern. ISO-8601 timestamp = `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` (pattern, no `ajv-formats`). SHA-256 = 64 lowercase hex characters.

## Event

All fields are required.

| Field | Type | Constraint |
|---|---|---|
| `id` | string | UUID pattern |
| `seq` | integer | >= 0 (uniqueness and strict increase are enforced by the Event store) |
| `ts` | string | ISO-8601 timestamp |
| `type` | string | one of `chaos.selection`, `chaos.injection`, `chaos.rejected`, `detection`, `transient`, `cleared`, `incident.state`, `diagnosis`, `plan`, `gate`, `repair`, `verification`, `rollback`, `escalation`, `recovery`, `battle_result`, `reset`, `security`, `error`, `timeout` |
| `component` | string | non-empty, originating module |
| `incidentId` | string or null | non-empty when a string |
| `runId` | string or null | non-empty when a string |
| `payload` | object | The 64 KB limit (replace with `{ref}`) is enforced by the Event store, not by the schema |

## Incident

Schema name `Incident`. Required: `incidentId`, `state`, `detectedAt`, `component`, `evidenceRefs`, `plans`, `gateDecisions`, `attempts`, `attemptCount`, `needsRollbackVerification`, `updatedAt`. Optional: `diagnosis`, `terminalReason`.

| Field | Type | Constraint |
|---|---|---|
| `incidentId` | string | non-empty |
| `state` | string | `detected`, `investigating`, `planned`, `repairing`, `verifying`, `recovered`, `rolled_back`, `escalated` |
| `detectedAt`, `updatedAt` | string | ISO-8601 timestamp |
| `component` | string | non-empty |
| `evidenceRefs` | string[] | non-empty strings |
| `diagnosis` (optional) | object | a Diagnosis (see `diagnosis-schema.md`) |
| `plans` | object[] | each a Repair_Plan (see `repair-plan-schema.md`) |
| `gateDecisions` | object[] | each an object; shape is owned by the Safety_Gate |
| `attempts` | object[] | each: `attemptNo` (integer >= 1), `planHash` (non-empty string), `snapshotId` (non-empty string), `verificationId` (optional non-empty string), `outcome` (non-empty string) |
| `attemptCount` | integer | >= 0 |
| `needsRollbackVerification` | boolean | |
| `terminalReason` (optional) | string | non-empty |

State transition rules are enforced by the Incident_Manager, not by the schema.

## Evidence

Schema name `Evidence`. All fields required.

| Field | Type | Constraint |
|---|---|---|
| `evidenceId` | string | non-empty |
| `incidentId` | string | non-empty |
| `healthCheckResults` | object[] | item shape not fixed by the design |
| `consoleErrors` | string[] | |
| `domSnapshotRef` | string | non-empty |
| `screenshotPath` | string | non-empty |
| `capturedAt` | string | ISO-8601 timestamp |

The rule that Evidence never contains scenario IDs, Secrets or `.git` content is enforced by the redactor and Evidence builder, not by the schema.

## Snapshot

Schema name `Snapshot`. All fields required.

| Field | Type | Constraint |
|---|---|---|
| `snapshotId` | string | non-empty |
| `createdAt` | string | ISO-8601 timestamp |
| `reason` | string | `injection`, `repair`, `baseline` |
| `files` | object[] | each: `path` (non-empty), `checksum` (SHA-256), `contentRef` (non-empty); no extra properties |

## Verification_Result

Schema name `VerificationResult`. All fields required.

| Field | Type | Constraint |
|---|---|---|
| `verificationId` | string | non-empty |
| `incidentId` | string | non-empty |
| `attemptNo` | integer | >= 1 |
| `checks` | object[] | each: `checkId` (non-empty), `kind` (`health`, `vitest`, `playwright`), `coversComponent` (non-empty), `outcome` (`pass`, `fail`, `error`, `timeout`), `rawOutputRef` (non-empty) |
| `originalFailingCheckRan` | boolean | |
| `overall` | string | `pass`, `fail` |
| `startedAt` | string | ISO-8601 timestamp |
| `durationMs` | integer | >= 0 |

The aggregation rule for `overall` (Property 18) is enforced by the verification module, not by the schema.
