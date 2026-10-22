# GitHub issue #330 — already fixed

Verified by static code review at `64e687bf` on 2026-10-22. Per the issue's
environment constraints, this conclusion does not rely on a live database or a
test run.

## Evidence

The reported `pharmacy_controlled_register_retention_guard` does not exist in
the current migration history. Controlled-register rows instead have the
`pharmacy_controlled_register_entries_append_only` trigger, which invokes
`pharmacy_rx_append_only` for every `UPDATE` or `DELETE`. That function always
raises SQLSTATE `23514` and does not inspect `app.purging_organization_id`
(`prisma/migrations/20260902170000_pharmacy_rx_review_substitution_controlled_register/migration.sql:111-115`).

The later legal-hold trigger does not weaken that protection. It either rejects
a deletion protected by an active hold or returns `OLD`, after which PostgreSQL
still runs the append-only trigger above
(`prisma/migrations/20260902201000_pharmacy_safety_inspection_retention/migration.sql:38-63`).
Therefore, setting the purge GUC cannot authorize deletion of a controlled-register
row, regardless of which application session sets it.

The purge worker does set `app.purging_organization_id` transaction-locally
before deleting tenant-owned records (`src/lib/platform/jobs.ts:671-690`). For
the separate append-only guards that intentionally support this purge path, the
current migration requires both an exact organization match and
`app.is_platform_admin = 'true'`
(`prisma/migrations/20261021104500_purge_guards_require_platform_admin/migration.sql:1-19`).
The pharmacy onboarding and regulatory-profile guards apply that conjunction at
lines 26-68 of the same migration. Consequently, an ordinary tenant session
cannot turn those purge exceptions into a cross-tenant or same-tenant bypass.

## Conclusion

The suspected vulnerability is already fixed in the current code. The claimed
three-year controlled-register guard is absent, controlled-register deletion is
unconditionally blocked with SQLSTATE `23514`, and every actual purge-GUC
exception also requires the platform-admin transaction context. No production
code, migration, or test change is warranted.
