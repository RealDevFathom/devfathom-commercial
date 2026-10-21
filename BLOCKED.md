# Pharmacy compliance review: stopped under the two-failure rule

The user requires stopping after two failures of the same problem, committing this file,
and pushing only improve/pharmacy-compliance-register. That threshold was reached by
QA138's dispenser-visible authorization regression test. No more implementation or QA
was attempted after the second failure. Unfinished QA138 and CTO edits were discarded
so they do not ship as partially validated changes.

## Completed focused commits

- eded1f58 — review 1: central can() decisions replace every shadow dispense check;
  the unused evaluator is removed. Legacy dotted pharmacy grants normalize centrally.
  Focused tests: 3 files, 29 passed.
- a1a09874 — review 2: controlled void/return domain callers require dispense and a
  fresh independent witness PIN before status or stock writes. Restoration entries
  record the new witness and unique PIN verification reference. Router denial paths
  preserve failed-PIN counters; return fingerprints exclude credentials.
  Focused tests: 4 files, 36 passed.
- 32ac9d2c — review 3: new 20261021160000 migration enforces manual correction delta,
  cap, no stacking, original scope, prior-balance arithmetic and sellable on-hand.
  Movement-backed restorations have separate identities, movement validation and
  cumulative caps. The 20261021140000 migration was not edited.
  Focused tests: 4 files, 41 passed. Real PostgreSQL tests: 1 file, 13 passed, using
  NOSUPERUSER/NOBYPASSRLS and FORCE RLS in an isolated schema.
- ce568b68 — review 6: both witness enumeration procedures require safety or dispense.
  Focused tests: 1 file, 6 passed.
- 9e986dfd — review 7: witness profile and user queries carry explicit organizationId
  from ctx; foreign users are rejected. userHoldsDispense was removed in review 1.
  Focused tests: 2 files, 7 passed.

## Exact stopping failure

The existing counter-console.test.tsx mocks CounterRxPanel as a component returning
null. The added QA138 assertion looked for the authorization region in the DOM.
The dispenser case therefore received null. Both attempts failed for that same
reason; these were actual failed assertions, not expected negative security tests:

1. counter-console.test.tsx plus pharmacy-witness-enumeration.test.ts:
   1 failed, 87 passed (2 files).
2. counter-console.test.tsx -t QA138:
   1 failed, 3 passed, 75 skipped (1 file).

A continuation must inspect the panel props or use a rendering panel mock/real panel
before rerunning QA138. The visibility implementation and test were discarded.

## Remaining authorized work and validation

- QA138: expose the same can('pharmacy:dispense') decision through the existing access
  query, conditionally pass controlled to CounterRxPanel, and enable witness enumeration
  only for authorized actors. Cashier absent / dispenser present regression remains.
- CTO alignment: upstream branch fetched at de91f612. Copy its PharmacyBranchAssignment
  model exactly, add reverse relations only to PharmacyBranch and User, and remove all
  assignment DDL from the undeployed 20261021150000 migration. No undo migration.
  The first generation attempt accidentally added a reverse relation to OrganizationRole
  too and Prisma rejected it. All those unfinished edits were discarded. The current
  branch therefore STILL has the prior assignment model and duplicate DDL; do not deploy
  until this requested alignment is completed.
- Final combined relevant tests and final typecheck were not run after all commits.
  NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck passed once after review 2,
  before the correction schema and later commits. This is not a final clean validation.
- PostgreSQL testing used the actual new correction migration on a minimal isolated schema
  with restricted-role/RLS assertions, not the full repository migration chain. There is
  no test:db package script. Full pharmacy DB integration suites were not run.
- Visual QA matrix and live-screen inspection were not completed; no UI changes remain.
- Items 4, 5 (including backfill/admin UI), and 8 were intentionally skipped as instructed.

## Repository state and push restriction

Initial worktree was clean. Work remained on improve/pharmacy-compliance-register.
Before pushing, git fetch origin improve/pharmacy-compliance-register confirmed the
remote was still 70ef8f519363ba57f59ec901e3f57b5e7d9a01fd. No rebase was needed.
Only that branch is to be pushed, without force; no PR, merge, main or deployment action.
