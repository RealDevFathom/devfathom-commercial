# Fix #635 — regulatory profile branch binding

## Code evidence

- `src/server/routers/pharmacy-onboarding.ts:115-123` limits the overview's current-profile
  lookup to profiles belonging to active branches.
- `src/server/routers/pharmacy-onboarding.ts:394-412` loads the active branch's province and
  premises and rejects a submitted province, address, or city that does not exactly match it.
- `src/lib/pharmacy/onboarding.ts:268-277` limits the `PREMISES_AND_LICENCES` candidate lookup to
  an active branch before the shared operation guard evaluates it.
- `src/lib/platform/commands.ts:457-473` applies the same active-branch restriction during the
  platform activation preflight.
- `src/lib/pharmacy/regulatory.ts:113-173` loads the profile's tenant-bound branch in the central
  operation guard, denies inactive branches, and denies province or premises drift. Denials use
  the existing audited, fail-closed path.
- `src/lib/pharmacy/regulatory.test.ts:132-169` covers inactive, wrong-province, and wrong-address
  profiles at the shared guard. `src/server/routers/pharmacy-onboarding.db.test.ts:230-258` covers
  mutation-time rejection without a write, while
  `src/lib/pharmacy/onboarding.owner-operator.test.ts:53-64` checks the readiness query's active
  branch predicate.

## Preserved constraints

All reads and writes retain the explicit `organizationId` and `branchId` predicates. The change
does not alter authorization procedures, permission resolution, dispensing/safety/catalogue-review
grants, stock or money paths, idempotency, outbound WhatsApp behavior, or logging. No migration is
needed: the existing composite profile-to-branch foreign key remains the tenant/branch identity
boundary; this fix validates mutable branch operational state and premises data at save and use.

## Skipped by instruction

- Dependency installation was not attempted (the task specifies npm returns 403).
- Automated tests and database tests were not run (the task specifies Bun 1.2.14 with no database
  and explicitly says not to run tests). Focused tests were added and reviewed from code instead.
- No migration was added because the fix requires no schema change; therefore the timestamp and
  concurrent-index requirements are not applicable.
