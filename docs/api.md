# API

Version: **v1**. All endpoints are under the prefix `/api/v1`. This document describes what `backend/src/api/app.js`, `backend/src/api/sse.js` and `backend/src/api/server.js` do. Record shapes are in [event-schema.md](event-schema.md), [diagnosis-schema.md](diagnosis-schema.md), [repair-plan-schema.md](repair-plan-schema.md) and [scenario-catalog-schema.md](scenario-catalog-schema.md).

## Transport rules

- **Binding.** The server listens on `127.0.0.1` only (`API_HOST`). The port is chosen by the caller of `startApiServer` (0 picks a free port).
- **Content type.** Responses are `application/json`, except the event stream. A request with a body must use `Content-Type: application/json`, otherwise the answer is `400 invalid_content_type`. Request bodies are limited to 16 KB (`413 payload_too_large`).
- **CORS.** One origin is allowed: the configured `dashboardOrigin`, which must be a bare `http`/`https` loopback origin (`127.0.0.1`, `localhost` or `[::1]`, no path, query or credentials), for example `http://127.0.0.1:5173`. Any other value makes `createApiApp` throw `ApiConfigError`.
  - Requests from the allowed origin get `Access-Control-Allow-Origin: <origin>`. Every response carries `Vary: Origin`.
  - Preflight `OPTIONS` from the allowed origin answers `204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Last-Event-ID` and `Access-Control-Max-Age: 600`.
  - A request from any other origin that is not `GET` or `HEAD` (including preflight) answers `403 origin_not_allowed`. A `GET` from another origin is answered without CORS headers, so a browser will not expose it.
  - Requests without an `Origin` header (curl, server-side) are not restricted by CORS.
- **Redaction.** Every response body is passed through the Redactor, so Secrets are never returned.
- **Unknown routes** answer `404 not_found`.

## Error format

Every error response has this body:

```json
{ "error": { "code": "invalid_request", "message": "The request body failed schema validation.", "details": [ ... ] } }
```

`details` is present only for some errors. For validation errors it is an array of `{ path, keyword, message, params? }` (the same shape as the `validate` helper).

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Body failed schema validation (unknown property, wrong type, empty `scenarioId`). `details` lists the errors. |
| 400 | `unknown_scenario` | `scenarioId` is not in the Scenario_Catalog. |
| 400 | `invalid_query` | `afterSeq` is not a non-negative integer (digits only, up to 15), or `incidentId` is empty or longer than 200 characters. |
| 400 | `invalid_json` | Body is not valid JSON. |
| 400 | `invalid_content_type` | Body sent without `application/json`. |
| 403 | `origin_not_allowed` | Non-GET/HEAD request from an origin other than `dashboardOrigin`. |
| 404 | `not_found` | No such endpoint. |
| 404 | `incident_not_found` | No Incident has that ID. |
| 404 | `verification_not_found` | The Incident has no Verification_Result yet. |
| 409 | `incident_active` | An Incident is not terminal. `details` is `{ "incidentId": <id or null> }`. |
| 413 | `payload_too_large` | Body over 16 KB. |
| 500 | `internal_error` | Unexpected failure. |
| 501 | `not_implemented` | The event stream route was mounted without an SSE handler. |
| 503 | `storage_error` | The Event_Log could not persist or read data. |

A rejected request changes nothing: bodies are validated before any action runs.

## Endpoints

### GET /api/v1/health

Reports Test_App health and Event_Log storage status. Always `200` when the API itself is running.

```json
{
  "status": "ok",
  "testApp": { "reachable": true, "httpStatus": 200, "components": { } },
  "storage": { "ok": true }
}
```

- `status`: `ok` (Test_App reachable and answered 200), `degraded` (unreachable or non-200), or `storage_error` (the last Event_Log write failed; takes precedence).
- `testApp.components`: the `components` property of the Test_App health body if present, otherwise the whole body, otherwise `null`.
- When the Test_App is unreachable: `{ "reachable": false, "httpStatus": null, "components": null, "error": "<message>" }`.
- `storage` when failing: `{ "ok": false, "error": "<message>", "at": "<ISO-8601>" }`.

### GET /api/v1/scenarios

Public catalog fields only. Targets, injection, reversal and expected repair are never returned.

```json
{ "scenarios": [ { "id": "scenario-id", "label": "Human label", "severity": "high" } ] }
```

### POST /api/v1/chaos-runs

Starts a chaos run. Body (optional, may be empty or `{}`):

```json
{ "scenarioId": "scenario-id" }
```

Only `scenarioId` (non-empty string) is allowed. If omitted, the Poltergeist picks a scenario.

- `202`: `{ "runId": "<id>", "scenarioId": "<id>" }`. The run proceeds asynchronously; follow it through the Events.
- `400`: `invalid_request` or `unknown_scenario`.
- `409`: `incident_active`, because an Incident is not yet terminal.

Chaos runs and resets are serialized, so they never execute at the same time.

### GET /api/v1/incidents

`200`: `{ "incidents": [ Incident, ... ] }`. See `Incident` in event-schema.md.

### GET /api/v1/incidents/:id

`200`: an `Incident` object (with `diagnosis`, `plans`, `gateDecisions`, `attempts` as available). `404 incident_not_found`.

### GET /api/v1/incidents/:id/verification

`200`: the latest `Verification_Result` for the Incident (see event-schema.md). `404 incident_not_found` or `404 verification_not_found`.

### GET /api/v1/events

Returns Events from the Dashboard view of the Event_Log (all event types, including `chaos.*`), ascending by `seq`.

| Query | Meaning |
|---|---|
| `afterSeq` | Return only events with `seq` greater than this value. Default `0`. |
| `incidentId` | Return only events whose `incidentId` equals this value. |

`200`: `{ "events": [ Event, ... ] }`. `400 invalid_query` for malformed parameters.

### GET /api/v1/events/stream

Server-Sent Events. Same Dashboard view as `/events`, replayed and then live.

- **Query:** `afterSeq` (optional, non-negative integer; `400 invalid_query` if malformed).
- **Header:** `Last-Event-ID` (set automatically by `EventSource` on reconnect). A malformed value is ignored.
- **Resume point:** the larger of `afterSeq` and `Last-Event-ID`. Events with `seq` at or below it are not sent. The stream has no `incidentId` filter.
- **Response:** `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.
- **Framing:** the stream starts with `retry: 2000`. Each Event is sent as:

```
id: <seq>
event: <Event.type>
data: <Event as one line of JSON>

```

- `id` is the Event `seq`, `event` is the Event `type` (so `EventSource.addEventListener('detection', ...)` works per type; there is no default `message` event).
- A comment line `: keep-alive` is sent every 15 seconds.
- **Ordering:** missed events are replayed in ascending `seq` order, then live events follow. There are no duplicates and no gaps. Live events are written as soon as they are persisted.
- If the replay fails (for example a storage error) the server closes the stream. The browser reconnects with its `Last-Event-ID`.

### POST /api/v1/reset

Restores the Test_App to its baseline. Body: empty or `{}` (no properties accepted, otherwise `400 invalid_request`).

- `200`: `{ "reset": true, "snapshotId": "<id>", "checksums": { ... }, "timestamp": "<ISO-8601>", "eventId": "<uuid>" }`.
- `409 incident_active`: an Incident is not terminal; nothing is reset.

## Event types

The `type` of an Event is one of:

| Type | Meaning |
|---|---|
| `chaos.selection` | Poltergeist selected a scenario. |
| `chaos.injection` | A failure was injected. |
| `chaos.rejected` | An injection was refused. |
| `detection` | The Monitor detected a failure. |
| `transient` | A failure looked transient. |
| `cleared` | A failure cleared by itself. |
| `incident.state` | An Incident changed state. |
| `diagnosis` | The Exorcist produced a Diagnosis. |
| `plan` | The Exorcist produced a Repair_Plan. |
| `gate` | The Safety_Gate decided on a plan. |
| `repair` | A repair was applied. |
| `verification` | A Verification_Result was produced. |
| `rollback` | A repair was rolled back. |
| `escalation` | The Incident was escalated. |
| `recovery` | Recovery was confirmed. |
| `battle_result` | The outcome of a chaos run. |
| `reset` | The Test_App was reset. |
| `security` | A security-relevant refusal or finding. |
| `error` | An internal error. |
| `timeout` | An operation timed out. |

The meanings are summaries; the payload shape per type is defined by the module that emits it and is not fixed by the `Event` schema (`payload` is any object).

Event shape (all fields present):

```json
{
  "id": "uuid",
  "seq": 42,
  "ts": "2025-01-01T12:00:00.000Z",
  "type": "detection",
  "component": "monitor",
  "incidentId": "incident-id or null",
  "runId": "run-id or null",
  "payload": { }
}
```

`seq` is a positive integer, strictly increasing, and is the cursor for `afterSeq` and `Last-Event-ID`. Payloads are redacted before they are stored.

### The 64 KB payload rule

If a serialized Event is larger than 64 KB (65,536 bytes), the Event_Log stores the payload in a separate file and replaces the Event `payload` with a reference:

```json
{ "ref": "<event-id>.payload.json", "bytes": 123456 }
```

`bytes` is the UTF-8 size of the original payload. Clients should treat a payload of the form `{ ref, bytes }` as "payload omitted". The API has no endpoint to fetch the referenced file.

## Typical Dashboard flow

1. `GET /api/v1/events` once to load history; remember the highest `seq`.
2. Open `EventSource('/api/v1/events/stream?afterSeq=<seq>')`; listen per event type.
3. `POST /api/v1/chaos-runs` to start a run; expect `202`, or `409` while an Incident is active.
4. `GET /api/v1/incidents/:id` and `/verification` to show state and results.
