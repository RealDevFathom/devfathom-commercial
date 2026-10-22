# GitHub issue #615: already fixed

Issue #615 is already fixed in the current code by commit `56cf857`.
No additional production or test code was changed for this follow-up.

## Code evidence

- `src/lib/restaurant/reports.ts:93-110` loads each selected branch through the
  tenant-scoped database handle, fails closed if any requested branch is unavailable,
  and converts the inclusive `from` and exclusive day-after-`to` midnights from each
  branch's IANA timezone to UTC.
- `src/lib/restaurant/reports.ts:113-124` couples each branch ID to its own half-open
  `[from, toExclusive)` timestamp range. This avoids both UTC-day filtering and reuse
  of one branch's timezone for another branch.
- `src/lib/restaurant/reports.ts:1362-1367` applies those branch-specific bounds to
  wastage `occurredAt` timestamps, while `src/lib/restaurant/reports.ts:1442-1447`
  groups the selected movements by branch-local calendar day.
- `src/lib/restaurant/reports.ts:1675-1707` uses the same bounds and branch-local day
  conversion for wastage exports, keeping exports aligned with the interactive report.
- `src/lib/restaurant/reports.ts:1712-1793` applies the branch-specific bounds to
  purchasing order `createdAt`, receipt `receivedAt`, every related raw-SQL aggregate,
  and the Prisma discrepancy-detail query.

For `Asia/Karachi`, local midnight on `2026-01-01` is
`2025-12-31T19:00:00.000Z`, and local midnight after `2026-01-31` is
`2026-01-31T19:00:00.000Z`. The focused assertions at
`src/lib/restaurant/reports.test.ts:660-670` verify those wastage query bounds, and
`src/lib/restaurant/reports.test.ts:1056-1082` verifies the same bounds for both the
purchasing Prisma filter and raw SQL parameters.

## Follow-up disposition

- No archive recovery applies to this issue; the existing fix is on the current branch,
  directly above the referenced main revision (`6e42538`).
- No security-review change was needed: the supplied latest QA retest is `PASS` and
  identifies no authorization, tenant-isolation/RLS, money-math, or migration defect.
- Additional code and tests were skipped because the requested behavior and focused
  regression coverage are already present. This avoids duplicating a correct minimal fix.
- Tests were not run, as requested for the constrained Bun/no-database/npm-403
  environment.
