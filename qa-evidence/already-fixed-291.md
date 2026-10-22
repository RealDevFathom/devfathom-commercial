# Issue #291 — already fixed

Verified on `main` at `16a2a37` on 2026-10-22.

- Neither pharmacy onboarding database test contains the stale
  `refuses a expiring today licence window` rejection case.
- `saveRegulatoryProfile` persists `licenceValidTo` without comparing it with
  the current instant, so a licence expiring today is accepted at save time as
  required by the #240 product decision.
- No product-code or test change is needed for #291.

Per the task constraint for the old environment, no dependencies were installed
and no test suite was run.
