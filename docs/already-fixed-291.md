# Issue #291 — already fixed

Verified against `main` at `16a2a37` on 2026-10-22.

The stale database-test expectation described in #291 is no longer present. The
current test saves a regulatory profile and expects version 1 to be returned at
`src/server/routers/pharmacy-onboarding.db.test.ts:243-246`; it does not expect an
expiring-today licence to be rejected.

The save path validates the branch, jurisdiction, licence category, permitted
schedules, and profile version dates at
`src/server/routers/pharmacy-onboarding.ts:345-399`. It performs no comparison
between `licenceValidTo` and the current time. Instead, it writes
`licenceValidTo` directly after date normalization at
`src/server/routers/pharmacy-onboarding.ts:408-426`. An expiring-today licence is
therefore accepted, consistent with the #240 product decision.

No product-code or test change is required for #291. Per the task constraints,
no dependencies were installed and no tests were run.
