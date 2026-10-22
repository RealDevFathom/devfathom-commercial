# Restaurant Insights gap fixes — 2026-10-22

## Verification and issue exclusion

The requested scope was interpreted as the three highest-ranked findings whose severity is High or
Medium: findings 2, 3, and 4. Finding 1 is Critical and finding 5 ranks below those three.

Each selected finding was still present before this change:

1. **Secondary branch assignments:** the Insights router compared only `primaryBranchId` and fell
   back to `restaurant:configure`; it did not use the canonical active-assignment authorization.
2. **Incomplete long ranges:** list reads still had an undisclosed fixed first page and both CSV
   paths still requested only 5,000 rows.
3. **Stale rebuild dead end:** the console still rendered “Stale — rebuild” without calling the
   existing configure-gated backfill mutation.

No selected finding was skipped as already fixed. Open-issue exclusion could not be completed:
this checkout has no Git remote and `gh auth status` reports no authenticated GitHub host. A
repository-local search found no issue/spec document recording these fixes, so none was skipped as
covered by an open issue.

## Changes

- **Finding 2 — fixed.** Insights branch checks now resolve the report capability through the
  canonical active staff assignment helper, assert the selected branch from that scope, and require
  organization-wide authorization when no branch is supplied. The existing capability procedures
  and `can()` checks remain the first authorization boundary, so explicit DENY behavior and tenant
  scoping remain centralized. (`src/server/routers/restaurant-insights.ts:77-95`,
  `src/server/routers/restaurant-insights.ts:161-213`)
- **Finding 3 — fixed.** The range contract now accepts a bounded offset; financial, operational,
  and labour screens fetch one look-ahead row, show an exact displayed range, and provide Previous
  and Next controls. Filter and tab changes reset the page. CSV generation now performs an
  unbounded service read rather than silently stopping at 5,000 rows, while the external export
  contract rejects pagination controls. (`src/server/routers/restaurant-insights.ts:45-55`,
  `src/lib/restaurant/insights.ts:12-20`, `src/lib/restaurant/insights.ts:233-260`,
  `src/lib/restaurant/insights.ts:304-330`, `src/lib/restaurant/insights.ts:388-406`,
  `src/components/restaurant/insights/insights-console.tsx:186-234`,
  `src/components/restaurant/insights/insights-console.tsx:480-648`,
  `src/components/restaurant/insights/insights-console.tsx:779-869`)
- **Finding 4 — fixed.** A server-computed `restaurant:configure` decision controls whether stale
  rows expose a confirmed, single-day rebuild action. Authorized users receive queue success/error
  feedback and the report queries refetch after enqueue; other users receive an explicit escalation
  instruction instead of an unusable imperative. The mutation itself remains guarded by the
  configure capability and validates the branch through the tenant-scoped database.
  (`src/server/routers/restaurant-insights.ts:111-120`,
  `src/server/routers/restaurant-insights.ts:217-229`,
  `src/components/restaurant/insights/insights-console.tsx:179-184`,
  `src/components/restaurant/insights/insights-console.tsx:484-498`,
  `src/components/restaurant/insights/insights-console.tsx:557-577`,
  `src/components/restaurant/insights/insights-console.tsx:640-648`)

## Validation constraints

Per the task instruction, no dependency installation, automated test, typecheck, lint, build,
database call, browser run, or screenshot was performed. Only static code inspection and Git diff
checks were used.
