# WHA-278 — Vertical-configurable departments

## Data model

`organization_departments` owns an organization's editable department set. Its stable uppercase
`key` remains the value stored in `users.department`, preserving the existing string-facing auth,
API, audit, and reporting contracts. `(organizationId, key)` is unique and is the composite foreign
key target for users. Names, active state, and sort order are tenant-editable; keys are immutable.

The vertical catalog supplies Agency defaults (the six legacy enum values) and Restaurant defaults
(`KITCHEN` / Kitchen and `FRONT_OF_HOUSE` / Front of House). Restaurant defaults do not inherit
Agency values.

## Compatibility and migration/backfill

The migration creates and seeds each organization's vertical defaults, then inserts every distinct
legacy user department before converting `users.department` from the PostgreSQL enum to text. It
adds the tenant-composite foreign key only after backfill, so no existing value is discarded or
rewritten. Existing consumers continue receiving the same department string.

New and updated members must reference an active department in the caller's tenant. Tenant admins
may list, add, rename, reorder, activate/deactivate, and remove unused departments. In-use rows must
be reassigned before removal. Tenant scoping is enforced both by scoped application data access and
forced RLS on the new table.

## Rollback

Application rollback is compatible while all user values remain among the original six Agency enum
members. A database rollback after tenants create new keys is destructive and must fail closed:
identify/reassign non-legacy user values first, drop the composite foreign key, cast the column back
to `Department`, then drop the catalog table. Automated destructive rollback is intentionally not
provided.
