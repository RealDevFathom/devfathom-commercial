# GitHub issue #260 is already fixed

The current code already contains a dedicated repair migration for issue #260:

- `prisma/migrations/20261023000260_repair_default_department_conflict_target/migration.sql:43-46`
  limits `DO NOTHING` to the intended `("organizationId", "key")` conflict. A collision on
  the tenant-scoped department name is therefore not ignored and remains visible as a unique-
  constraint error.
- `prisma/migrations/20261023000260_repair_default_department_conflict_target/migration.sql:3-5`
  uses a transaction-local platform-admin setting for the cross-tenant repair, preserving the
  migration's explicit FORCE RLS handling without leaking the setting beyond the transaction.
- `tests/default-department-repair-migration.test.ts:14-28` provides focused regression coverage
  for the conflict target, name-collision behavior, and transaction-local RLS override.

No additional code or migration change is required.
