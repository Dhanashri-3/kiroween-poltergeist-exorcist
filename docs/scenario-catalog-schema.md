# Scenario Catalog Schema

Implemented in `backend/src/contracts/scenario-catalog-entry.schema.js` (schema name `ScenarioCatalogEntry`). It validates one catalog entry. See `event-schema.md` for the `validate` helper and shared formats. Unknown properties are rejected.

All fields are required.

| Field | Type | Constraint |
|---|---|---|
| `scenarioId` | string | non-empty |
| `label` | string | non-empty |
| `targetComponent` | string | non-empty |
| `severity` | string | non-empty (the design does not enumerate severity labels) |
| `targetFiles` | string[] | at least one, unique, non-empty strings |
| `injection` | object or string | deterministic transform description |
| `reversal` | object or string | |
| `expectedRepairAction` | object or string | used only by tests, never sent to the Monitor, the Exorcist or the Fallback_Mapping |

Not enforced by the entry schema (handled by the Scenario_Engine at load): exactly six entries, unique `scenarioId` values across the catalog, and every `targetFiles` item being an Approved_File.
