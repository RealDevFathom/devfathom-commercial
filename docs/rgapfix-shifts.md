# Restaurant shifts gap follow-up — 2026-10-22

## Verification and issue deduplication

The three highest-impact **High/Medium** findings were findings 3, 4, and 5. Each was reproduced in
the current branch before making changes:

1. **Finding 3 (actual labour hours): confirmed.** The attendance export calculated completed break
   minutes but had no net worked-time field (`src/lib/restaurant/workforce.ts:623-670`).
2. **Finding 4 (late classification lost at clock-out): confirmed.** The presenter selected
   `COMPLETE` before considering `lateMinutes` (`src/lib/restaurant/workforce.ts:176-189`).
3. **Finding 5 (missing punch repair): confirmed.** The correction helper rejected a null original
   timestamp, and the roster dialog only offered existing clock-in/out values
   (`src/lib/restaurant/workforce.ts:553-607`,
   `src/components/restaurant/restaurant-roster-console.tsx:949-989`).

None was already fixed, so none was skipped. No open GitHub issue could be matched: this checkout has
no configured Git remote, and its `.github` and documentation files contain no issue mirror covering
these findings. This is not a definitive check of inaccessible private GitHub issues.

## Changes

- **Finding 3:** added `workedMinutes` and `workedHours` to the branch/business-date-scoped attendance
  CSV. They are calculated from corrected clock-out minus corrected clock-in minus completed breaks;
  incomplete attendance exports blank worked-time values rather than a misleading zero
  (`src/lib/restaurant/workforce.ts:623-671`).
- **Finding 4:** completed late attendance now has the terminal `COMPLETE_LATE` status, while retaining
  `lateMinutes` (`src/lib/restaurant/workforce.ts:173-197`).
- **Finding 5:** missing clock-in, clock-out, and break-end values can be added through the existing
  manager-authorized correction mutation. A nullable `originalAt` explicitly preserves that the
  source punch was absent, while the existing lock, branch check, ordering validation, reason, actor,
  and append-only adjustment remain in force (`src/lib/restaurant/workforce.ts:538-607`,
  `prisma/schema.prisma:10601-10617`,
  `prisma/migrations/20261022090000_restaurant_missing_punch_adjustments/migration.sql:1-4`). The roster
  correction dialog now offers missing punches and each existing break's start/end correction
  (`src/components/restaurant/restaurant-roster-console.tsx:367-382`,
  `src/components/restaurant/restaurant-roster-console.tsx:949-989`).
- Added behavioral Vitest coverage for completed-late presentation, net worked-time export, incomplete
  records, and append-only missing-clock-out repair (`src/lib/restaurant/workforce.test.ts:33-105`,
  `src/server/routers/restaurant-shifts.test.ts:1077-1168`).

## Verification limitation

Tests and generation were not run because dependencies are unavailable in this environment. The
attempted `bunx prisma generate` was blocked by the documented npm registry HTTP 403 response before
any formatter or test command could execute.
