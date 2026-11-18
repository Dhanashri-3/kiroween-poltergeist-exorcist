
# Technical Architecture — Poltergeist vs. Exorcist

## 1. Frontend

- Framework: React
- Build tool: Vite
- Language: JavaScript initially
- Purpose: Display the application under attack, agent status, battle events, and recovery results.
- Owner: Aathavan (Visual Architect)

## 2. AI Agent Layer

Two distinct agent roles are required.

### Poltergeist

- Creates controlled failures in the test application.
- Uses explicitly approved failure scenarios.
- Records the type and location of each injected failure.

### Exorcist

- Detects application failures.
- Investigates the affected component and likely cause.
- Proposes a minimal code repair.
- Validates and applies the repair safely.
- Verifies recovery through tests.

Owner: Dhanashri (AI Commander)

## 3. Backend

The backend will coordinate the agents and communicate with the frontend.

Planned responsibilities:
- Agent orchestration.
- Chaos event management.
- Failure detection.
- Repair generation.
- Patch validation and application.
- Test execution.
- Recovery reporting.

The backend framework and agent integration method are not finalized yet. Do not select or install additional technologies without reviewing the architecture first.

## 4. Communication

The frontend and backend should communicate through a clearly defined API.

The backend should provide structured information about:
- Current application health.
- Active chaos events.
- Detected failures.
- Repair progress.
- Verification results.

## 5. Safety Architecture

- Run the target application in an isolated environment.
- Restrict chaos operations to approved test components.
- Never allow unrestricted filesystem modifications.
- Validate patches before applying them.
- Preserve snapshots for rollback.
- Run verification after every repair.
- Never report success without evidence.

## 6. Development Rules

- Keep frontend, backend, and agent responsibilities separate.
- Use Git branches for independent development.
- Review code before merging.
- Do not overwrite existing project files without approval.
- Prefer small, testable changes.
- Do not create fake AI success messages in place of real execution.
- Ask before introducing new dependencies or services.

## 7. Current Development Ownership

Dhanashri:
- Kiro agent instructions.
- Agent architecture.
- Chaos detection and healing coordination.
- Backend integration.

Aathavan:
- React frontend.
- Dashboard and visual design.
- Chaos and recovery visualizations.
- Frontend-backend integration.
