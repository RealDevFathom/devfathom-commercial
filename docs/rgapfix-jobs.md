# Restaurant jobs gap follow-up — 2026-10-22

## Verification and issue check

This follow-up covers the three highest-impact **High/Medium** findings in
`docs/rgap-restaurant-jobs-20261022.md` (findings 2–4). Finding 1 is Critical and therefore is outside
the requested High/Medium selection.

Each finding was reproduced in the current branch before editing. Repository search found no local
open-issue reference for any of the three. `gh issue list --state open --limit 100` could not verify
private GitHub issues because this checkout has no authenticated GitHub CLI session. None was skipped
as already fixed or as covered by a discoverable open issue.

## Changes

1. **High — stale crash loops:** `src/lib/restaurant/scheduler.ts:379-412` now separates expired claims in one
   tenant-scoped transaction. Attempts below the budget return to `QUEUED`; attempts at or above the
   budget become `DEAD`, with claims cleared and a diagnostic error. Behavioral coverage is in
   `src/lib/restaurant/scheduler.test.ts:341-356`.
2. **High — replayable dead-job requeue:** `src/server/routers/restaurant-jobs.ts:202-245` now derives a stable
   idempotency key from the retained dead job, returns whether the successor was deduplicated, and
   annotates the mutation audit with old/new job IDs. The existing `reports:operational` capability
   procedure remains the central `can()` gate. Behavioral replay and audit coverage is in
   `src/server/routers/restaurant-jobs.test.ts:159-226`.
3. **Medium — missing operator guidance:** `docs/product/restaurant-administrator-guide.md:531-548` now
   documents authorization, inspection, safe retry criteria, replay behavior, audit evidence, and
   escalation while explicitly warning that the discoverable operator route is not shipped yet.
