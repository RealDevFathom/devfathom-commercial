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
