# Dashboard e2e tests (Task 14.8)

## What these tests are

**UI-contract tests against a FAKE API.** They are not the real-backend acceptance run that Task 14.8 asks for.

- `support/fake-api.js` is a dependency-free Node `http` fake of the API in `docs/api.md`. Tests drive it: push schema-valid Events, drop SSE connections, force status codes (409, 500), delay responses.
- The fake never creates Events by itself. `POST /chaos-runs` and `POST /reset` only answer and log the request.
- Every Event, repair, rollback and "Verification_Result" in these tests is synthetic and written by the test (`support/synthetic-incidents.js`). **They show that the Dashboard renders and requests according to the documented contract. They do not show that any real recovery happened.**

## What is not covered (blocked)

- Running against the **real backend and Test_App**. The backend has no runnable entry point yet (Task 15.2).
- One injected failure and one **verified recovery with the real Verification_Result**, produced by the real Poltergeist and Exorcist.

When Task 15.2 exists, add real-stack specs here, then mark Task 14.8 done.

## Req 15.10 limitation

The real `repair` Event carries checksums only (`preChecksum`, `postChecksum`, `snapshotChecksums`), never file content. The Dashboard therefore shows a "Repair record" and a block labelled "Plan-derived preview (NOT the actual file change)", built from the `plan` Event's `find` / `replace`. An actual before/after diff is not possible from the Events. The specs check the label and that the text "applied diff" never appears.

## Running

From `frontend/`:

```
npm run test:e2e
```

- `playwright.config.js` builds the Dashboard with `VITE_API_BASE_URL` pointing at the fake (e2e build only, output in `.e2e-dist/`) and serves it with `vite preview` on port 5199. The fake listens on 5198. Neither is the backend port. `src/config.js` is unchanged.
- Specs are `e2e/*.spec.js`, so Vitest (`src/**/*.test.*`) does not pick them up.
- No browser is downloaded. `@playwright/test` 1.65.1 expects Chromium revision 1255, which is already in the Playwright cache (`%LOCALAPPDATA%\ms-playwright`). Never run `playwright install` for this suite without approval.
- Workers are fixed to 1 because the fake uses a fixed port.
