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
| Playwright | Browser tests of the four Test_App components (button, layout, data panel, card) and `/health`; required by the pinned `Playwright` command template (`node testapp/node_modules/@playwright/test/cli.js test --config testapp/playwright.config.js`) | Approved, package and Chromium installed | Approved by the user for Task 2.3 on 2026-11-19. Installed `@playwright/test@1.65.1` as a devDependency in `testapp/package.json` only (range `^1.65.1`, exact version locked in `testapp/package-lock.json`). Transitive packages: `playwright@1.65.1`, `playwright-core@1.65.1`; nothing else. Not added to `backend/` or `frontend/`. Browser: Chromium only, via `node testapp/node_modules/@playwright/test/cli.js install chromium`; installation confirmed: Chrome for Testing 159.0.8154.6, Playwright build `chromium-1255` (plus `chromium_headless_shell-1255`), in the default cache `%LOCALAPPDATA%\ms-playwright`. Verified by the user: installer processes exited, browser files and completion markers present, and Playwright launched Chromium headless. `ffmpeg-1013` and `winldd-1007` in the same cache are Playwright-bundled companions installed with Chromium. Chromium only; Firefox and WebKit were not installed |
| fast-check | Property-based testing | Approved, installed | Installed in `backend/` in task 8.2 (the first property test task executed) as a devDependency `fast-check@^4.10.3`. Used by `backend/tests/safety-gate.property.test.js`. Task 3.2 reused the existing install (no new install) for `backend/tests/serialization-round-trip.property.test.js`. Task 6.2 reused the existing install (no new install) for `backend/tests/state-machine-conformance.property.test.js` |
| Ajv | JSON schema validation for events, diagnoses, repair plans and scenario catalog | Approved, installed | Installed in `backend/` in task 1.3 as `ajv@^8.20.0` (resolved 8.20.0). `ajv-formats` was not added; date-time and UUID checks use patterns |
| Open AI model SDK | Model access for Exorcist diagnosis and repair generation | Open decision | Provider not chosen |
