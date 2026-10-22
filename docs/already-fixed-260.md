# GitHub issue #260 is already fixed

The current code already contains a dedicated repair migration for issue #260:

- `prisma/migrations/20261023000260_repair_default_department_conflict_target/migration.sql:45-48`
  limits `DO NOTHING` to the intended `("organizationId", "key")` conflict. A collision on
  the tenant-scoped department name is therefore not ignored and remains visible as a unique-
  constraint error.
- `prisma/migrations/20261023000260_repair_default_department_conflict_target/migration.sql:3-7`
  opens an explicit transaction before applying the transaction-local platform-admin setting for
  the cross-tenant repair, preserving FORCE RLS handling even when the migration runner does not
  wrap migration files atomically.
- `tests/default-department-repair-migration.test.ts:14-30` provides focused regression coverage
  for the conflict target, name-collision behavior, and the explicitly bounded RLS override.

No additional code or migration change is required.
