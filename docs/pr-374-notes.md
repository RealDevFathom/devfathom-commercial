# 25 October 2026 — tenant department FK fixture follow-up

Parent `e3e7f6076544bd7d768d40f7f07de5470f1c3fa7` is **consumed**:
independent QA2 reported **147 passed / 0 case failures / 11 skipped**, plus
one failed DB `beforeAll`. The 112 focused cases and 35 real-ledger cases passed,
but all 11 authorization DB bodies remain **unexecuted**, not passing.
`user.create` failed with Prisma P2003 / SQL 23503 on
`users_organizationId_department_fkey` before any authorization DB body ran.
Do not replay that head or transfer its test/image results to this follow-up.

## Fixture-only correction and regression coverage

- The exact schema and migration `20260828100000_vertical_configurable_departments`
  require `User.(organizationId, department)` to reference
  `OrganizationDepartment.(organizationId, key)`.
- Create and assert an active synthetic `LEADERSHIP` department for **each** of
  the two fresh organizations, before any actors or same/foreign-tenant witnesses.
  Migration-time backfill does not populate subsequently created test tenants.
  This fixture key supplies no permission; no grants or runtime guards change.
- All 11 authorization DB cases remain intact: no-grant, DENY, unassigned/inactive
  assignments, sibling/foreign branch refusal, witness refusal, full no-effect
  snapshots and the authorized actual-branch 10-to-8 stock/custody control.
  The new setup assertion checks the persisted tenant/key for each FK parent.
- Source inspection also follows the existing nested role permission and medicine
  presentation parents and composite branch/lot/location dependencies. This is a
  source audit, **not** proof that the database fixtures or test bodies execute.

## Strict evidence boundary

Only this fixture and these notes change from the consumed parent. Production
inventoryControl/can(), DENY precedence, actual payload-branch assignment, witness
and stock/custody code, tenancy guards, Prisma schema/migrations, workflow gates,
lockfile and manifests remain byte-identical. No inferred ADMIN bypass.
No unit/app/DB execution, Prisma generation or consumed-head replay is performed
by Engineer 2. Formatting/parser/fixture shape/whitespace evidence is static only,
not a semantic typecheck or runtime/DB PASS. Independent QA2 must use one genuinely
fresh isolated restricted-role/FORCE-RLS database on the genuinely new published
SHA; Security and CI acceptance remain separate. **DRAFT / HOLD; no merge/deploy.**

---
## Historical correction notes (head-specific evidence; no PASS transfer)

# 25 October 2026 — TEST-374-01 and independent-QA fixture corrections

Follow-up to consumed head `2b37529e1a9804a27dab4b84e89fa53437983b89`.
Its independent QA2 receipt is **144 passed / 2 failed / 11 skipped**, plus
one failed database `beforeAll`; all 11 new authorization DB test bodies
never ran. Those results do not transfer to this correction commit.

## Narrow corrections; no production-guard changes

- Both foreign/inactive organization-reference rejection assertions now expect
  canonical `BAD_REQUEST` with `That record is not in this workspace.` Router
  no-read/no-write checks and the complete setup-owner DB snapshot stay intact.
- The synthetic organization fixture supplies schema-required `legalName` and
  `displayName`; remove the nonexistent `name` field. All other directly created
  fixture models were checked against required scalar fields in the exact schema.
- The existing empty-reason snooze/dismiss test explicitly grants canonical
  inventory permission so it reaches the intended input validation. A separate
  regression retains the no-grant `FORBIDDEN` precedence for the same malformed
  inputs and verifies no signal update.
- Runtime guards, role policy, witness checks, actual-payload-branch assignment,
  RLS requirements, fixtures-retained policy and CI workflows are unchanged from
  the reviewed parent. Net-main scope adds only the existing router test file to
  the prior six-file scope: **seven files**, with no additional runtime changes.

## Validation and disposition

No local application/unit/database execution, Prisma generation, dependency
installation or consumed-head replay is authorized or claimed by this follow-up.
Only source/fixture-shape inspection, formatting, parser and whitespace checks
may be recorded separately. These are not typecheck, runtime or DB PASS.
The 19 write-off router cases, 11 authorization DB cases and new malformed-input
capability regression remain **authored, not verified new-head passes**.

Security Lead found SEC-374-01 remediated in the parent source, but held acceptance
for TEST-374-01. Independent QA2 owns any genuinely new exact-head execution on
one fresh isolated database; no inherited result and no unchanged-head replay.
Exact new-head CI, independent QA/Security and CTO final check remain required.
**OPEN / DRAFT / HOLD. No merge or deployment authorization.**

---
## Previous remediation notes and historical evidence

# 25 October 2026 — SEC-374-01 remediation; HOLD pending changed-head acceptance

Canonical pharmacy issue #362, existing draft PR #374. Sole implementation writer: Engineer 2.
This update merges current main `08a247c1c68441a14c1a151c096c7d73552099f6`
without rewriting the original `fe1d46c34f7511c55e7c40bfbd36125554dcb9c9` history.
The only net main runtime changes are the original active same-tenant witness
validation plus an actual-payload-branch assignment check before write-off.

## Authorization and no-effect contract

- Keep main's `inventoryControl` / central `can()` decision for canonical
  `pharmacy:inventory`; do not duplicate role names, change wildcard/exact-grant
  rules, or weaken DENY-over-ALLOW precedence.
- Require an active actor assignment in the active tenant branch named by
  **input.branchId** before any witness, inventory, stock-balance, movement or
  custody read/write. Neither a selected-branch decoy nor a real witness is authority.
- No new admin exemption is inferred: ADMIN/SUPERADMIN still need an effective
  inventory grant and the actual-branch assignment. Main's inventory capability
  has no default static admin ALLOW (`src/lib/abac/policies.ts`).
- Retain the distinct active same-tenant witness requirement. Authorized control
  writes one negative WRITE_OFF movement and matching custody evidence.
- Source regression matrix: 19 authenticated-router cases (no grant, both DENY
  sources, wildcard DENY, missing/inactive assignment, sibling/foreign branch,
  assigned authorized control, explicit system-admin cases, witness failure) and
  11 PostgreSQL cases (full balances/movements/custody no-effect snapshots plus
  positive projection 10 -> 8 units). These are authored cases, **not pass counts**.
- The real-DB suite explicitly skips without separate `TEST_DATABASE_URL` and
  `TEST_DATABASE_ADMIN_URL`. It requires a non-superuser/non-BYPASSRLS runtime and
  forced RLS on all four scoped stock/custody/assignment tables. Setup-owner
  snapshots are intentional so RLS cannot conceal an unauthorized write.
  Run only against a verified isolated migrated throwaway database. Synthetic
  fixtures remain; there is no reset/delete/cleanup SQL.

## Evidence and blockers — do not relabel as PASS

Two local harness setup attempts ended **before Prisma generation, tests,
PostgreSQL initialization or database writes**: original worktree `.git` file
mount mismatch; corrected harness Python unterminated string at line71. No third
local attempt was made. **0 tests executed; 0 runtime/DB PASS.**
Static source formatting and TypeScript parser checks passed for changed source;
these are not a typecheck, application test or PostgreSQL acceptance.
Independent QA Engineer 2 and Security Lead must review the genuinely published
new head. Old fe1d... evidence is consumed and is not transferable. Existing
repo gates are unchanged; no dedicated new workflow is included. This remains
HOLD until exact-head CI, real permitted PostgreSQL regressions, independent
Security and QA, and CTO final check are satisfied. No merge/deploy authorization.

---
## Historical original branch notes (superseded acceptance statements)

# PR #374 review notes

## Scope

Reviewed the inventory write-off witness validation change for issue #362 against the branch's
pre-change parent. The requested `origin/main...HEAD` comparison could not be produced because this
checkout has no `origin` remote configured.

## Findings and resolution

- **Resolved:** `writeOff` previously accepted any non-actor string as `witnessId`. It now resolves
  the witness by ID, organization, and `ACTIVE` status before reading or mutating inventory. A
  missing, inactive, or cross-tenant user therefore fails closed with `COAUTH_REQUIRED`.
- **Tenant isolation:** The lookup includes `organizationId` explicitly rather than relying only on
  tenant-scoped database policy. The persisted custody record continues to use the same organization
  and branch as the inventory movement.
- **DENY-over-ALLOW:** An unresolved witness is denied before lot, balance, movement, or custody
  operations. The existing self-witness denial remains in place.
- **Regression coverage:** Tests verify the exact tenant-and-status lookup, the no-write failure
  behavior, and the successful path for an active tenant user.
- **Pharmacy caps and money invariants:** This change does not alter authorization grants, pharmacy
  capability evaluation, or monetary values. No related issue was found within the PR's scope.

## Validation

Per review instructions, dependencies were not installed and tests were not run. The final diff was
reviewed statically, including a whitespace/error scan with `git diff --check`.
