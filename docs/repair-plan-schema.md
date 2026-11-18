# Repair Plan Schema

Implemented in `backend/src/contracts/repair-plan.schema.js` (schema name `RepairPlan`). Related configuration contracts are documented here: Action_Allowlist, Fallback_Mapping entry and Command template. See `event-schema.md` for the `validate` helper and shared formats. Unknown properties are rejected on all of them.

## Repair_Plan

All fields are required. No property other than these can be present, so no command or shell field can be carried.

| Field | Type | Constraint |
|---|---|---|
| `incidentId` | string | non-empty |
| `actionType` | string | non-empty. Membership in the Action_Allowlist is decided by the Safety_Gate |
| `targetFile` | string | non-empty. Exactly one file. Approved_File check is done by the Safety_Gate |
| `change` | object | structured change data (for example `{find, replace}` pairs or a line range replacement), at least one property |
| `rationale` | string | non-empty |

## Action_Allowlist

Schema `ActionAllowlist` is an array of entries. Schema `ActionAllowlistEntry` validates a single entry.

| Field | Type | Constraint |
|---|---|---|
| `actionType` | string | non-empty |
| `allowedFiles` | string[] | at least one, unique, non-empty strings |
| `maxChangedLines` | integer | >= 1 |

## Fallback_Mapping entry

Schema `FallbackMappingEntry`. All fields required.

| Field | Type | Constraint |
|---|---|---|
| `entryId` | string | non-empty |
| `evidencePattern` | object | matchers over Health_Check identifiers, console error text and DOM snapshot features, at least one property |
| `sourceCheck` | object | deterministic check over Approved_Files content, at least one property |
| `diagnosisTemplate` | object | at least one property |
| `planTemplate` | object | at least one property |

The inner shapes of the four objects are not fixed by the design and are defined with the Fallback_Mapping module. The rule that entries contain no scenario ID is not enforced by the schema.

## Command template

Schema `CommandTemplate`. All fields required.

| Field | Type | Constraint |
|---|---|---|
| `templateId` | string | non-empty |
| `executable` | string | non-empty |
| `args` | string[] | fixed arguments |
| `allowedParams` | string[] | unique, non-empty strings; the enumeration of permitted component IDs |
| `timeoutMs` | integer | >= 1 |
