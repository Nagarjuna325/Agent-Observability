# Ground truth: seeded bug (for our own verification only)

This file is the answer key for whatever bug we seed into `apps/demo-app/api`.
It exists so we (humans) can verify the Diagnosis Agent's hypothesis is actually
correct, not so agents can read it.

**The Fix Agent's filesystem MCP scope must never include this file's path.**

## Bug (seeded Phase 5, 2026-07-25)

- **File / function:** `apps/demo-app/backend/src/index.ts:87`, the
  `GET /api/bugs/:id` route handler. The guard reads `if (!bug.id) {` on a
  `Bug | null` value. Seeded change: upstream commit `4aedc2f` has `if (!bug) {`
  at that line; the seed appends `.id`. Nothing else in the file changed and the
  line count is identical, so stack traces point at line 87.
- **Root cause:** `getBug(id)` (`backend/src/bugService.ts`) returns `null` for a
  nonexistent id. The guard dereferences `.id` *before* the null check, so the
  missing-row path throws a sync `TypeError` instead of reaching the 404 branch.
  Express 4's default error handler turns it into a clean 500; the process stays up.
- **Trigger (canonical, exact request):** `GET http://localhost:3000/api/bugs/999999`
  — out of range by construction, never state-dependent.
- **Expected telemetry signature (service `demo-api`):**
  - span `GET /api/bugs/:id`, status ERROR, `http.status_code=500`
  - trace-correlated ERROR LogRecord containing
    `TypeError: Cannot read properties of null (reading 'id')` whose top stack frame
    is `src/index.ts:87`
  - happy path unaffected (list, existing id, health all 200); this is the only 5xx
    source in the app
- **Canonical fix:** restore `if (!bug) {`. Accepted equivalents: `bug == null`,
  `bug === null`, `!bug?.id`. After the fix the trigger must return
  `404 {"error":"not_found","message":"Bug not found."}`.
- **Known caveat:** `tsc --noEmit` flags the seeded line under strict null checks
  (`bug` is possibly `null`). Runtime via `tsx` is unaffected — the app runs and
  serves normally, the throw only happens on the missing-row path.
- **Reseed mechanism:** canonical copies live in `infra/seed/`
  (`index.ts.pristine`, `index.ts.seeded`); `scripts/reseed.mjs` restores the seeded
  state (or pristine with `--pristine`), hash-verifies the written file, and seeds
  the demo DB if the `bugs` table is empty. Reseed only while demo-api is stopped.
