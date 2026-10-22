# Issue #292 — already fixed on `main`

Verified against `main` at `16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca` on 2026-10-22.

The reported migration behavior is no longer present:

- `prisma/prepare-extensions.sql` handles both `btree_gist` and `pg_trgm`, discovers each
  extension function's actual owner from the PostgreSQL catalogs, and checks whether the
  preparation role is the owner, a superuser, or can `SET ROLE` to the owner before attempting
  an ACL change.
- For an owner the preparation role cannot assume, it does not issue ineffective grants or
  revokes. It records the `managed-owner` gap in `platform_ops.platform_db_hardening` and emits
  a notice identifying the extension, function count, owner, and preparation role.
- For an assumable owner, it switches to that owner before revoking `PUBLIC EXECUTE`, then
  verifies that no remediable extension function retains the privilege.
- The migration contains no hard-coded grant to `devfathom_app`. Runtime operation does not
  depend on direct execution of `pg_trgm` functions; repository application code contains no
  `similarity(...)`, `word_similarity(...)`, or `strict_word_similarity(...)` call.
- `tests/sql/btree-gist-public-execute-acl.sql` already includes the non-owner/managed-owner
  regression fixture, verifies that the skipped ACL is unchanged and the skip is recorded, and
  also exercises the positive `SET ROLE` path. The shared preparation loop covers `pg_trgm` as
  well as `btree_gist`.

Production ownership cannot be queried from this offline checkout. The repository now makes that
state observable in `platform_ops.platform_db_hardening`, so production operators can distinguish
an applied hardening action from a managed-owner skip without relying on PostgreSQL warnings.

Per the task constraint for an already-fixed issue, no product code or tests were changed and no
test commands were run in the old environment.
