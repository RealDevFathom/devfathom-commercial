# GitHub issue #458: already fixed

## Archive review

Issue #458 asks whether the single commit preserved at `archive/rescue/WHA-34`
should be recovered:

| Archived commit | Claimed change | Disposition |
| --- | --- | --- |
| `9589f389` | `test(restaurant): add M3 database battery` | **Skipped as already present on `main`.** Porting the commit would duplicate the existing M3 database battery and provide no additional coverage. |

There are no production-code or migration changes to recover from the archived
work described by the issue. Consequently, the valuable fix is already present
and the archived commit should not be cherry-picked or reopened as a PR.

## Current-code evidence

The current tree already contains the focused real-PostgreSQL battery in
`tests/restaurant-m3-rls.test.ts`:

- Lines 6–12 require separate runtime and owner database connections, preventing
  the probes from accidentally exercising an owner/bypass role.
- Lines 21–50 pin all 28 M3 restaurant catalogue tables rather than testing a
  representative subset.
- Lines 164–202 refuse an unapproved remote database, create two tenant fixture
  sets, switch into tenant A, and wrap cleanup in a transaction.
- Lines 204–234 assert the runtime role is `NOSUPERUSER`/`NOBYPASSRLS` and every
  M3 table has enabled, forced row-level security.
- Lines 236–273 verify tenant A can read and write its own rows, tenant B remains
  invisible, and cross-tenant `INSERT`/`UPDATE` escape attempts fail.
- Lines 275–298 separately verify the explicit platform-administrator policy
  path and restore that setting afterward.

The broader schema-governance battery also includes the M3 allowlist and exact
column contract in `tests/restaurant-m3-governance.test.ts` lines 614–665. This
ensures schema drift cannot silently remove the coverage above.

## Decision

Close the recovery issue as obsolete. Nothing from `9589f389` is still valuable
to port: its test-only objective is represented by the current, stricter M3 RLS
and schema-governance batteries. No application behavior, authorization rule,
tenant-isolation rule, WhatsApp send block, secret handling, or migration is
changed by this resolution.
