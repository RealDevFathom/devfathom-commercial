# Restaurant reports gap fixes — 2026-10-22

## Selection and verification

This follow-up covers the three highest-ranked findings whose severity is **High** or **Medium** in
`docs/rgap-restaurant-reports-20261022.md`: findings 2, 3, and 4. Finding 1 is Critical and is outside
the requested High/Medium selection.

Before editing, each selected finding was re-checked against the current branch:

1. **Catering aggregates stopped at the detail limit — verified, not already fixed.**
   `readCateringReport` still fetched `limit + 1` orders and calculated all headline, status,
   completeness, and delivery values only while iterating `rows.slice(0, limit)`.
2. **Incomplete cash-count evidence was displayed as authoritative — verified, not already fixed.**
   The payments UI still rendered `cashCounted` and `cashVariance` without consulting the existing
   `cashCountCoverage`, even though the CSV path already withheld those values unless coverage was
   complete.
3. **Wastage and stock movement used UTC report boundaries — verified, not already fixed.**
   Both SQL paths still compared `occurredAt` with the UTC-midnight dates returned by range parsing;
   wastage day labels also used the UTC timestamp directly.

No selected finding was skipped as already fixed. Open-issue exclusion could not be completed: this
checkout has no Git remote and `gh auth status` reports no authenticated GitHub host, so the private
repository's open issues are unavailable. No finding is claimed to be untracked beyond what can be
verified in this environment.

## Changes

- **Catering full-scope aggregates:** the catering reader now pages through every branch- and
  date-scoped matching order, folds full-range revenue, cost, margin completeness, delivery, and
  status values, and retains only the requested bounded detail rows. The UI now explicitly states
  that headline/status totals cover all matching orders when detail is truncated.
  (`src/lib/restaurant/reports.ts:805-980`; `src/app/(app)/restaurant/reports/page.tsx:768-771`)
- **Cash evidence qualification:** counted cash and drawer variance now render only when
  `cashCountCoverage.status` is `COMPLETE`. Otherwise the UI displays an unavailable state plus the
  drawer-session, missing-count, unverified-close, and mismatched-day counts.
  (`src/app/(app)/restaurant/reports/page.tsx:1001-1035`)
- **Branch business-date stock windows:** wastage and stock-movement SQL now derives each selected
  branch's inclusive window from that branch's IANA timezone and `businessDayCutoff`. Wastage day
  grouping and export labels use the same resolved business date; stock opening/in/out/net/closing
  partitions use the per-row branch boundary.
  (`src/lib/restaurant/reports.ts:1290-1349`; `src/lib/restaurant/reports.ts:1410-1425`;
  `src/lib/restaurant/reports.ts:1498-1584`; `src/lib/restaurant/reports.ts:1660-1688`)

The existing router-level `can()` authorization, scoped database access, selected branch filters,
and optional stock-location filter remain in place. These changes do not introduce an alternate
permission path or alter DENY-over-ALLOW evaluation.

## Validation constraint

Per the task instruction, no dependencies were installed and no automated tests, type checks,
linters, builds, or browser runs were performed.
