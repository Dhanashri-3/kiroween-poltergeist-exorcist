
# 👻 Poltergeist QA vs. The Exorcist

### An AI vs AI Chaos Engineering Battle

Poltergeist QA vs. The Exorcist is an autonomous
software testing and self-healing platform.

## The Agents

- 👻 Poltergeist: Introduces controlled UI failures.
- 🛡️ The Exorcist: Detects, diagnoses and repairs failures.

## Core Features

- Controlled chaos injection
- Automated failure detection
- AI-powered repair generation
- Code patch validation
- Live battle dashboard

## Technology Stack

- Frontend: React + Vite
- Backend: To be finalized
- AI orchestration: Kiro + Kiro Crew
- Version control: GitHub

## Team

- Dhanashri — AI Commander
- Aathavan — Visual Architect

## Project Status

🚧 Under Development


## Running locally

Everything runs on your own machine and binds to `127.0.0.1` only. Node.js and npm are required. The commands below come from the `package.json` files and source in this repository. Run each one from the directory shown.

### 1. Install

```
cd testapp  && npm install
cd backend  && npm install
cd frontend && npm install
```

`testapp/` only has a Playwright dev dependency. The Test_App server itself uses plain Node with no packages.

### 2. Start the Test_App

```
cd testapp
node server.js
```

It listens on `http://127.0.0.1:4100`. Set `TESTAPP_PORT` to use another port. Health is at `http://127.0.0.1:4100/health`. Port 4100 is the live port, so the browser tests use 4101 (see `testapp/playwright.config.js`).

### 3. Start the backend

```
cd backend
npm start
```

The entry point is `backend/src/main.js`. It checks the settings and the five files in `backend/config/` first and refuses to start (exit code 1, every problem listed) if any is invalid. It then starts the Event_Log, reloads Incidents, builds the Monitor, Scenario_Engine and Orchestrator, and binds the API to `127.0.0.1` (default port 4200). Optional environment variables: `BACKEND_PORT`, `DASHBOARD_ORIGIN` (default `http://127.0.0.1:5173`), `TESTAPP_URL` (default `http://127.0.0.1:4100`), `BACKEND_STORAGE_DIR` (default `backend/storage-data`, excluded from Git) and `MONITOR_INTERVAL_MS`. Start the Test_App first. Restart it after a repair that changes `mock-api.js`, because the Test_App loads that file once.

### 4. Start the frontend

```
cd frontend
npm run dev
```

Vite serves the dashboard, normally at `http://127.0.0.1:5173`. The backend only accepts CORS requests from its configured `dashboardOrigin`, so use the same origin there. The dashboard calls `/api/v1` by default. To point it at the backend, copy `frontend/.env.example` to a local env file and set `VITE_API_BASE_URL=http://127.0.0.1:<backend-port>/api/v1`.

Other frontend scripts: `npm run build`, `npm run preview`, `npm test`, `npm run test:e2e`.

### 5. Run the demo

With the Test_App, backend and frontend running, open the dashboard and start a chaos run from its controls. The dashboard shows the Poltergeist failure, the Exorcist diagnosis and repair, and the verification result. Recovery is shown only after a `verification` Event with `overall=pass`. The same run can be started through the API described in [docs/api.md](docs/api.md). The demo needs the backend from task 15.2.

### 6. Reset the Test_App

Use the dashboard reset control or `POST /api/v1/reset` with an empty body or `{}`. This restores the Test_App to its baseline snapshot. It answers `409 incident_active` and changes nothing while an Incident is not yet terminal.

### Tests

`npm test` in `backend/` and `frontend/` runs the unit and property tests (vitest).

## AI provider and Fallback_Mapping

The AI provider is not chosen yet, and no AI SDK is installed. The code reads the AI credential from one environment variable, `EXORCIST_AI_API_KEY` (`AI_CREDENTIAL_ENV_VAR` in `backend/src/exorcist/exorcist.js`). It is read from the process environment only and never written to files, logs or Events. Do not commit it. Until a real AI client is wired in, the stub client reports the AI service as unavailable.

When the AI service is unavailable, the Exorcist uses the Fallback_Mapping (`backend/config/fallback-mapping.json`):

- If an entry matches the Evidence, a rule-based Diagnosis and Repair_Plan are used and marked `rule_based`.
- If no entry matches, the Incident escalates.
- If the Safety_Gate rejects a plan from the mapping, the Incident escalates. No substitute plan is generated.
