# Issue #451: archived restaurant retest is already fixed

The archived `qa/retest-restaurants-144-145-146` branch does not need to be
re-opened or cherry-picked. The current `main` code and its focused regression
coverage already contain the valuable outcomes for all three retested issues.

## File-and-line evidence

- **#144 (audit/report reliability and tenant isolation):** the restricted-PostgreSQL
  acceptance suite verifies `FORCE ROW LEVEL SECURITY` and cross-tenant hiding in
  `tests/qa144-audit-reports.db.test.ts:70-89`. It also reproduces the former audit
  foreign-key lock and verifies post-commit persistence at lines 91-144, verifies
  rollback/failure behavior at lines 146-190, and exercises a 1,201-drawer report
  within the bounded read time at lines 192-225. The production report reader
  pages drawer sessions in bounded batches while retaining only per-day
  accumulators in `src/lib/restaurant/reports.ts:330-385`.
- **#145 (restaurant co-authorization through job roles):**
  `operatorHasCapability` requires an active, branch-bound staff profile and
  recognizes branch job-role membership in
  `src/lib/restaurant/checkout-routes.ts:211-249`. It resolves staff job-role
  capability decisions at lines 261-275, with an explicit DENY winning over
  every ALLOW source at lines 264-269.
- **#146 (restaurant administrators can invite team members without buying HR):**
  Administration is a mandatory baseline module in
  `src/lib/module-catalog.ts:21-24,43-53`, and baseline grants cannot be removed by
  a caller's commercial module list (`src/lib/module-catalog.ts:113-127`). The
  focused invitation tests supply no enabled commercial modules, require the
  `admin` module, and verify both the administrator capability and seat-limit
  guards in `src/server/routers/team.invite.test.ts:20-23,56-68,116-127`.

## Archive disposition

Close the archive recovery as **obsolete** rather than re-opening it as a PR.
No archive change is ported:

- Retest coverage for #144 is skipped because equivalent restricted-database,
  tenant-isolation, transaction, and high-row-count coverage is already on main.
- Retest coverage for #145 is skipped because main already covers the production
  job-role resolution path and preserves fail-closed, branch-bound,
  DENY-over-ALLOW behavior.
- Retest coverage for #146 is skipped because main already pins baseline-admin
  entitlement, authorization, and seat-limit behavior with focused tests.
- Historical retest receipts are not copied: they would duplicate executable
  evidence without changing runtime behavior.

The archive tag named by the issue could not be fetched in this checkout because
the repository remote is intentionally absent and outbound GitHub access returns
HTTP 403. This does not weaken the code-level conclusion above: the current tree
contains both the fixes and focused regression evidence, so there is no valuable
runtime fix to recover.
