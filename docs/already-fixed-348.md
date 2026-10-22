# GitHub issue #348 is already fixed

Issue #348 reported that pharmacy day close inserted a `pharmacy_daily_closes` row and then
updated that row with the variance reason. That update was rejected because the table is
append-only.

Verification against the current tree shows that the reported defect has already been fixed:

- `prisma/migrations/20260902180000_pharmacy_money_settlement/migration.sql:94-98` still defines
  the append-only rejection function and installs
  `pharmacy_daily_closes_append_only` for every `UPDATE` or `DELETE`. The invariant was not
  weakened to make day close succeed.
- `src/lib/pharmacy/day-close.ts:117-123` closes each counted drawer and passes the variance note
  into `cutPharmacyDailyClose`. It does not update the newly created close row.
- `src/lib/pharmacy/settlement.ts:872-887` creates the immutable close once and includes the
  trimmed variance note in `reason` during that insert. A reopen reason retains precedence, so
  the existing re-close semantics remain unchanged.
- `src/lib/pharmacy/day-close.db.test.ts:124-160` exercises the real migrated PostgreSQL path,
  verifies that the drawer and close commit together, and proves that a later close-row update is
  still rejected by the append-only trigger.
- `src/lib/pharmacy/day-close.db.test.ts:162-183` covers retry idempotency and the exact-count,
  blank-note case. `src/lib/pharmacy/day-close.db.test.ts:186-213` also proves that a variance note
  cannot substitute for the separately required reopen reason.

The fix is present in commit `b609aec50716df7a3187495062a47a439434a92f` (`fix(pharmacy): write
the day-close variance note with the Z report`). No production code, schema, migration, or test
change is needed for issue #348.
