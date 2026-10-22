# Issue #292: already fixed

The reported `pg_trgm` grant problem is already addressed on `main`; no migration or
runtime code needs to be ported.

## Evidence

- `prisma/prepare-extensions.sql:40-51` derives the preparation role and its
  superuser status from the connected database session instead of naming
  `devfathom_app`.
- `prisma/prepare-extensions.sql:53-54` applies the same owner-aware preparation
  to both `btree_gist` and `pg_trgm`.
- `prisma/prepare-extensions.sql:98-131` checks every extension function owner
  before attempting an ACL change. If the connected role cannot assume an owner,
  it records a `managed-owner` hardening gap and does not issue an ineffective
  privilege statement.
- `prisma/prepare-extensions.sql:134-168` changes ACLs only while running as a
  superuser, the object owner, or a role with explicit `SET` privilege on the
  owner, and revokes `PUBLIC EXECUTE` function by function.
- `prisma/prepare-extensions.sql:170-199` verifies that no remediable extension
  function retains `PUBLIC EXECUTE` and fails the preparation transaction if the
  postcondition is not met.
- `tests/sql/btree-gist-public-execute-acl.sql:99-169` covers the production-shaped
  non-owner case: the preparation records the skipped owner, the migration gate
  accepts only the unremediable managed-owner condition, and the function ACLs
  remain unchanged rather than producing misleading grant/revoke warnings.
- `tests/production-deployment-contract.test.ts:180-220` proves that every
  extension created by deployment code is present in the preparation list and
  in each environment's extension allow-list, preventing `pg_trgm` from silently
  falling outside the hardened path.

The current implementation deliberately does not hardcode or grant to the
application role. Extension ACL work belongs to the separately configured
extension administrator, while an owner that cannot be assumed is surfaced in
`platform_ops.platform_db_hardening` for operator follow-up.
