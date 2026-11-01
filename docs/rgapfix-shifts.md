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

## Review remediation — 2026-10-31

The five findings from the failed follow-up review are addressed:

1. Employee punches now use corrected attendance for transition and ordering checks. A server-observed
   clock-out after a missing clock-in repair is appended to history, preserving the absent raw punch
   and the existing raw-time database CHECK. Replays retain their command receipts.
2. Managers can open the correction dialog when both source punches are missing.
3. Break corrections explicitly reject missing and other-shift break targets with `NOT_FOUND`.
4. Completing attendance requires an effective clock-in and completed, ordered breaks. Incomplete
   breaks also leave exported worked-time values blank until repaired.
5. `COMPLETE_LATE` retains warning styling in both roster views and the employee lateness explanation.

The additive `20261031090000_restaurant_effective_break_closure` migration maintains a derived
`closedByAdjustment` flag from immutable break-end history. The unique open-break index uses this
projection so a repaired break permits the next break without changing its absent raw end. Direct
writes cannot forge the projection. Tenant RLS, history immutability, raw punch guards, and the
one-open-break arbiter remain enforced. The migration backfills existing repairs under forced RLS.

Verification passed all 87 focused presenter/export, router, component, migration-contract, routing,
and restricted-role PostgreSQL tests, including `workforce.db.test.ts` and
`restaurant-shifts-rls.test.ts`. Database checks used an isolated clone of the review database; a
separate upgrade probe verified pre-existing repairs with a non-superuser, non-bypass-RLS owner.

Browser component checks used the real roster, shared components, tokens, and local fonts with
fixture data: 375/768/1024/1440px, light/dark, normal/reduced motion, missing-punch repair, warning
statuses, cancelled and pending controls, dialog focus trapping/restoration and Escape, bounded
overflow, loading/empty/error/permission-denied states, and no browser console/render errors. This
fixture does not verify authenticated Next.js routing or hydration. The prohibited broad checks
remain delegated to the separate checks machine.
