# Dependency Review

No dependency is installed until it is listed here and approved by the team. Approved dependencies are installed only in the task that first needs them.

## Review process

1. Propose the dependency in this document with its purpose.
2. The team reviews it (Dhanashri for backend and agents, Aathavan for frontend).
3. Status changes to Approved, and the install task is recorded.
4. Install only in the task named in the Notes column.

## Candidates

| Candidate | Purpose | Status | Notes |
|---|---|---|---|
| Node.js | Backend runtime; verify installed version before setup| Approved | |
| Express | Install during Task 1.2 | Approved | |
| React | Dashboard UI framework | Pending team approval | Frontend, owner Aathavan |
| Vite | Frontend build tool and dev server | Pending team approval | Frontend, owner Aathavan |
| Vitest | Install during Task 1.2| Approved | |
| Playwright | Browser-based detection and verification of UI failures | Pending team approval | |
| fast-check | Property-based testing | Approved, install deferred | Install in task 3.2 (first property test task executed) |
| Ajv | JSON schema validation for events, diagnoses, repair plans and scenario catalog | Approved, installed | Installed in `backend/` in task 1.3 as `ajv@^8.20.0` (resolved 8.20.0). `ajv-formats` was not added; date-time and UUID checks use patterns |
| Open AI model SDK | Model access for Exorcist diagnosis and repair generation | Open decision | Provider not chosen |
