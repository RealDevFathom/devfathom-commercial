# PR 383 review notes

## Scope reviewed

- Compared the available PR commit with its first parent. The checkout has no `origin` remote, so
  `git fetch origin main` and the requested `origin/main...HEAD` comparison were unavailable.
- Reviewed the controlled-medicine actor test fixture and the QA-304 cleanup database tests.
- Kept this PR test-only; production authorization, entitlement, settlement, and money code is
  unchanged.

## Findings and resolutions

1. **Controlled-actor tests did not model the current branch authorization path.** The fixture now
   supplies the active-branch lookup, the actor's organization, and active branch assignments.
2. **Branch-scope behavior lacked focused regression coverage.** The tests now assert every branch
   lookup is tenant- and active-scoped, assert assignment lookup is tenant/user/active-scoped, and
   cover both an unassigned pharmacist and a branch outside the tenant. Each rejection is verified
   to happen before PIN lookup, sale mutation, or controlled-register writes.
3. **QA-304 setup and migration execution required a database owner.** The cleanup tests now use
   `OWNER_DATABASE_URL` (falling back to `MIGRATION_DATABASE_URL`) for schema DDL, fixture setup,
   cleanup migration execution, and schema teardown. The runtime connection is retained only to
   verify the post-migration state through the application role.
4. **Security invariants reviewed.** Existing DENY-over-ALLOW coverage remains in place. The PR does
   not change pharmacy capability grants or financial calculations, so exact-grant-only capability
   caps and money invariants are unaffected.

## Validation

Per the request, no dependencies were installed and no tests were run. Review was limited to static
inspection of the diff and relevant authorization/migration code.
