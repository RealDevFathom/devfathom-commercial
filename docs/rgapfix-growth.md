# Restaurant Growth gap follow-up — 2026-10-22

## Verification and issue screening

The three highest-impact findings in `docs/rgap-restaurant-growth-20261022.md` were verified against
the current branch before changes. All three were still present:

1. `listRestaurantGrowth` authorized the normal report/branch read but queried `growth_insights`
   without checking `catering:read` (previously `src/lib/restaurant/growth-generation.ts:26-49`).
2. The generation form retained every failed request as an unknown write outcome and had no
   ordering or 45-calendar-date validation (previously
   `src/components/restaurant/growth/growth-entries.tsx:63-119`).
3. The Growth entry form accepted only a free-text branch ID and the page did not load an
   authorized branch directory (previously
   `src/components/restaurant/growth/growth-entries.tsx:29-44` and
   `src/app/(app)/restaurant/growth/page.tsx:10-16`).

No finding was skipped as already fixed. Open-issue screening could not be completed against GitHub:
this checkout has no Git remote and `gh auth status` reports no authenticated GitHub host. A local
`rg` review of the Restaurant Growth work-item records found only WHA-1400 and WHA-1622; as the gap
report notes, neither tracks these three findings. Therefore no finding was skipped as covered by a
known open issue. The lower-ranked “approved drafts are opaque” finding was not selected because the
request was limited to the top three High/Medium findings by user impact.

## Changes

- The saved-insight list now checks `catering:read` before setting branch scope or querying insight
  metadata (`src/lib/restaurant/growth-generation.ts:93-112`). Its behavioral coverage verifies the
  denial occurs before insight SQL (`src/lib/restaurant/growth-generation.test.ts:240-246` and
  `src/server/routers/restaurant-growth.test.ts:124-134`).
- Invalid comparison windows are now classified as known `INVALID` failures
  (`src/lib/restaurant/growth-generation.ts:127-134`), mapped to a specific `BAD_REQUEST` response
  (`src/server/routers/restaurant-growth.ts:53-71`), and converted by the server action to an
  editable typed result (`src/app/(app)/restaurant/growth/actions.ts:47-67`). The client also checks
  ordering and the inclusive 45-day maximum before submission, clears pending state for typed
  validation failures, and retains same-request replay only for unknown outcomes
  (`src/components/restaurant/growth/growth-entries.tsx:12-16` and
  `src/components/restaurant/growth/growth-entries.tsx:78-111`). Behavioral tests cover both local
  and server-returned validation paths (`src/components/restaurant/growth/growth-entries.test.tsx:91-140`).
- A read-only branch-scope query now returns names only for active, tenant-scoped branches the actor
  may use, requires `reports:financial` and `catering:read`, and prefers the staff primary branch
  (`src/lib/restaurant/growth-generation.ts:26-92`). The router exposes that read
  (`src/server/routers/restaurant-growth.ts:45-52`), the route loads the default scope
  (`src/app/(app)/restaurant/growth/page.tsx:16-24`), and the UI reuses the shared Restaurant branch
  selector rather than accepting an opaque ID
  (`src/components/restaurant/growth/growth-entries.tsx:44-59`).

## Validation limits

The requested environment limitation applies: dependencies are not installed. An attempted bounded
Vitest invocation caused Bun to resolve the missing `vitest` package and failed with the documented
npm `403`, before any test executed. No database, install, build, or browser session was run. The
behavioral Vitest coverage was written by inspection and uses rendered behavior / mocked adapters,
not source-text assertions.
