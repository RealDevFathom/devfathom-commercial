# PR683 consolidated pharmacy authorization QA

The implementation folds **h2 (#686)**, **h7 (#687)**, **m1 (#688)**,
**mbr (#689)** and **h3 (#690)** into H1. Those five PRs are already closed;
this work does not close or modify them. PR246/247 scope is excluded.

## Security behavior

- A pharmacy owner is an ACTIVE member with its tenant's system `owner` role in
  a PHARMACY organization. ADMIN alone is not solo-owner identity.
- DENY wins before fallback. Exact-only clinical capabilities require explicit
  grants. Resource policies run before any granted or inherited ALLOW, including
  resignation self-review restrictions. Retained receipt aliases now pass through
  `can()`; legacy dotted dispense is rejected.
- Solo approvals count ACTIVE pharmacy users tenant-wide, including unassigned
  and sibling-branch colleagues. Restaurant operator profiles hold credentials,
  not pharmacy membership. ON_LEAVE cannot approve. A staffed pharmacy requires
  a different authorized approver.
- The PIN bucket is `pharmacy:solo-owner-pin:<organization>:<actor>`, five attempts
  per 15 minutes. Rate-limit storage and credential lockout updates survive
  request rollback. Successful proof and its target/branch-bound audit commit
  with the approved document; PIN values are redacted.
- Owner branch inheritance is written by lifecycle triggers, with ownerManaged
  true on promotion, reactivation and backfill. Demotion revokes only marked
  rows. Ordinary assignments, including IDs prefixed `pba_`, remain intact.
  Read guards perform no repair/upsert.
- Purchasing workspace branches/locations, requisitions and purchase orders are
  filtered by assignments; NULL branch central procurement is preserved. Linked
  requisition and quote branches are checked again before PO approval, and an
  order must be authorized before received quantities are returned. Returns and
  supplier-credit follow-up retain financial-reader access.
- Support sessions recheck the platform operator's active status. Deactivation
  revokes ordinary and support sessions. Support queries deny email.getMessage
  and meetings.getOccurrences because those reads write data.

## Database deployment

A fresh, disposable local PostgreSQL database deployed all 177 migrations after
`prisma/prepare-extensions.ts`, using its local migrator URL without logging
credentials. Its migration table contains exactly these six new names and no
old `20261028120000`–`20261028124000` names:

1. `20261029100000_pharmacy_owner_identity`
2. `20261029101000_pharmacy_solo_maker_checker`
3. `20261029102000_pharmacy_solo_settlement_scope`
4. `20261029103000_pharmacy_settlement_branch_guard`
5. `20261029104000_pharmacy_owner_branch_assignments`
6. `20261029105000_pharmacy_owner_authorization`

The five H1 migrations were moved with git mv. Catalogue grants are folded into
identity; owner assignments are consolidated in 104000; 105000 contains the
nonduplicate H2 authorization grant backfill. Backfill set_config calls share
BEGIN/COMMIT with their writes. Constraint drops use IF EXISTS.

Serialization uses the tenant organizations row, never table SHARE locks. The
row lock is FOR NO KEY UPDATE, followed by the existing no-op MVCC update:
this is compatible with foreign-key KEY SHARE locks and avoids the deadlock
reproduced with FOR UPDATE. Real connection tests verify simultaneous approvals,
roster races, unrelated-tenant concurrency, and stale repeatable-read rejection.

## Verified results

- Changed unit/component suites: **650 tests, 27 files, zero skips**.
- Core PostgreSQL suites: **33 tests, 5 files, zero skips**, including all
  **28 solo-approval.db.test.ts** cases.
- Restricted runtime PostgreSQL suites: **91 tests, 8 files, zero skips**.
  Runtime role attributes were checked: NOSUPERUSER and NOBYPASSRLS.
- Separate `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit`:
  passed. Production build uses the repository's separate-typecheck mode so
  bundler and TypeScript heaps are not retained together.
- Changed-file ESLint reports one existing `react-hooks/set-state-in-effect`
  error at counter-console.tsx's stageRow effect. Linting the original HEAD
  contents through stdin reproduces the same error. No rule was disabled.
- Prettier and git diff --check run on the changed files.

The final webpack production build passed: 213 static pages, optimization,
tracing and standalone output. Its separate-typecheck mode is the existing
NEXT_BUILD_SKIP_TYPECHECK setting documented in next.config.ts; the independent
full typecheck passed. Initial combined builds exhausted the worker's default
heap before this supported split workflow was used.

Browser verification passed **64 combinations** on the production standalone
server and the restricted runtime role: orders, receiving and returns at 375,
768, 1024 and 1440 pixels in light/dark and normal/reduced motion (48), plus
financial-only read-only returns across the same matrix (16). No document
horizontal overflow, page/console errors, or failed route loads were found.
Each route retained one H1, keyboard focus reached a control, and Escape smoke
checks passed. Screenshots were captured for both themes at every viewport in
/tmp/fix683-visual and /tmp/fix683-financial-visual, with JSON check results.
The financial-only user saw the read-only notice and no Record credit control.
Loading/error/disabled/PIN/destructive states are covered in the component and
outcome suites; browser checks are read-only and do not execute destructive
workflow acceptance.

Unit coverage includes
PIN-required, masked, missing/wrong/locked credentials, permission denial, request
outcomes and clinical branch boundaries. Browser smoke does not replace full
workflow acceptance.

Optional `/workspace/security/real-pr{688,689,690}-*.md` review files were not
present. The fetched PR heads and their actual diffs supplied the fold evidence.

## Release constraints

Merge only after #699. Expect rebase/conflict resolution when integrating it;
this consolidation does not rebase or force-push the published H1 history and
keeps the sale transition function unchanged.

**Manual staging gate:** before deployment, verify that old
20261028120000–20261028124000 migration names MUST NOT exist in staging's
_prisma_migrations. Staging and Azure were not accessed for this verification.
