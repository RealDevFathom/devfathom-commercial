# Restaurant dashboard gap follow-up — 2026-10-22

## Verification and issue check

I rechecked the three highest-impact High/Medium findings from the supplied static report against
the current branch before changing code. None was already fixed:

1. **Dashboard reachability:** `DashboardPage` still redirected every authenticated restaurant user
   before its existing `RestaurantDashboardContent` render branch could run.
2. **Effective branch authorization:** the insight guard still recognized only an active staff
   profile's `primaryBranchId`, falling back to organization-wide `restaurant:configure` for every
   other branch returned by the authorized branch directory.
3. **Branch-local closed dates:** `closedDateRange` still truncated the browser clock at UTC midnight
   even though each branch directory row already includes its IANA timezone.

No finding could be confirmed as covered by an open GitHub issue. This checkout has no Git remote,
and `gh auth status` reports that no GitHub host is authenticated, so the private issue tracker could
not be enumerated. A repository search found no local WHA reference for these three findings. No item
was skipped as already fixed or issue-covered; the next P1 (partial/failed-data presentation) was not
selected because the request limits this follow-up to the top three findings by user impact.

## Changes

- Restaurant tenants now reach the existing restaurant dashboard composition at `/dashboard`
  instead of being unconditionally redirected (`src/app/(app)/dashboard/page.tsx:19-39`,
  `src/app/(app)/dashboard/page.tsx:72-87`). The dispatch test covers both administrator and employee
  sessions (`src/app/(app)/dashboard/page.test.tsx:61-80`).
- Insight reads now validate a selected branch against the actor's effective branch authorization
  for the exact report capability, while branchless/consolidated reads continue to require
  `restaurant:configure` (`src/server/routers/restaurant-insights.ts:75-97`,
  `src/server/routers/restaurant-insights.ts:153-207`). The behavioral router test proves an
  authorized secondary branch is readable without widening access to arbitrary branches
  (`src/server/routers/restaurant-insights.test.ts:231-263`).
- Closed-date windows now derive “today” in the selected branch's IANA timezone and then select the
  previous local calendar date (`src/app/(app)/dashboard/restaurant-management-overview.tsx:63-70`,
  `src/app/(app)/dashboard/restaurant-management-overview.tsx:570-590`). Tests cover UTC and opposite
  sides of local midnight in Karachi and New York
  (`src/app/(app)/dashboard/restaurant-management-overview.test.tsx:394-415`).

No migration, secret handling, money representation, WhatsApp transport, pharmacy capability, ABAC
precedence, or mutation authorization behavior was changed.
