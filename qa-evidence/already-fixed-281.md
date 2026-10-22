# QA #281 — controlled-register purge-GUC bypass does not reproduce on main

Verified by code review on `16a2a370` (2026-10-22). No database was available, so this
evidence intentionally records the static verification requested for the old environment.

## Finding

The suspected `pharmacy_controlled_register_retention_guard` is not part of the migration
history on main. The controlled-register table instead receives
`pharmacy_controlled_register_entries_append_only`, backed by `pharmacy_rx_append_only`,
which unconditionally raises SQLSTATE `23514` for both `UPDATE` and `DELETE`
(`prisma/migrations/20260902170000_pharmacy_rx_review_substitution_controlled_register/migration.sql:111-115`).
That function neither reads nor grants an exception for `app.purging_organization_id`.

The additional controlled-register legal-hold trigger returns `OLD` when no active hold
exists (`prisma/migrations/20260902201000_pharmacy_safety_inspection_retention/migration.sql:38-60`),
but it does not replace or disable the append-only trigger; both are installed on the table
(`prisma/migrations/20260902201000_pharmacy_safety_inspection_retention/migration.sql:62-65` and
`prisma/migrations/20260902170000_pharmacy_rx_review_substitution_controlled_register/migration.sql:111-115`).
Consequently, a session-local purge name cannot make a controlled-register `DELETE` pass.

The repo-wide purge worker does set `app.purging_organization_id` transaction-locally before
deleting tenant rows (`src/lib/platform/jobs.ts:671-690`). On main, every append-only guard
that actually recognizes that setting also requires
`app.is_platform_admin = 'true'`; the migration documents the tenant-session threat and adds
the conjunction (`prisma/migrations/20261021104500_purge_guards_require_platform_admin/migration.sql:3-19`),
including the pharmacy guards at lines 26-68. Thus an ordinary tenant context cannot use the
purge GUC to activate any of those supported purge exceptions either.

## Conclusion

The issue does **not** reproduce on main: there is no three-year controlled-register delete
exception to bypass, controlled-register entries remain unconditionally append-only, and the
existing purge-GUC exceptions elsewhere are tied to the platform-admin transaction context.
No production-code or test change is warranted for this suspected issue.
