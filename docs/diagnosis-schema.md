# Diagnosis Schema

Implemented in `backend/src/contracts/diagnosis.schema.js` (schema name `Diagnosis`). Unknown properties are rejected. See `event-schema.md` for the `validate` helper and shared formats.

All fields are required.

| Field | Type | Constraint |
|---|---|---|
| `incidentId` | string | non-empty |
| `component` | string | non-empty |
| `suspectedFile` | string | non-empty |
| `location` | string | non-empty |
| `rootCause` | string | non-empty |
| `confidence` | number | 0 to 1 inclusive |
| `evidenceUsed` | string[] | non-empty strings |
| `status` | string | `ok`, `inconclusive`, `rule_based` |

Not enforced by the schema (handled by the Orchestrator): the confidence gate (below 0.5 means `inconclusive` and escalation), and the rule that `suspectedFile` is an Approved_File.
