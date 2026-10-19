# WHA-1374 independent verification — PASS (source/focused checks only)

2026-09-06 · Verification Engineer · one bounded independent review of WHA-1371.

Inspected cwd: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/WHA-1374-verify-ph-growth-independently-verify-supplier-credit-follow-up-8057582f`.
Branch: `codex/WHA-1374-verify-ph-growth-independently-verify-supplier-credit-follow-up-8057582f`.
HEAD/source: `8057582fbc890c51bfe354c620f08e9e34338c55`.
Parent/base: `bd218de8fa39c1c464a3b22b16a0021a86b736e1`.
Tree: `5996fdaacfdbd3db52cd2eec5e33a704d4ceac8b`.
Initial status empty. Branch/HEAD/tree preserved; final additions are owned verification evidence/probes only. No product edits or commits.

Exact source diff: six paths, 690 additions, zero deletions:

- `src/lib/pharmacy/supplier-credit-follow-up.ts`
- `src/lib/pharmacy/supplier-credit-follow-up.test.ts`
- `src/app/(app)/pharmacy/purchasing/returns/follow-up-queue.tsx`
- `src/app/(app)/pharmacy/purchasing/returns/follow-up-queue.test.tsx`
- `src/app/(app)/pharmacy/purchasing/returns/page.tsx`
- `src/app/(app)/pharmacy/purchasing/returns/page.test.tsx`

Before: existing return windows, debit-note positions, and allocation forms. After: additive advisory queue of oldest open issued claims and submitted-undispatched returns, five visible per category, with existing return/credit navigation. No additional DB query, mutation, schema, or financial fact.

## Independent evidence

Two Vitest executions, six distinct files, **89 unique passed / 0 failed / 0 skipped / 0 pending / 0 todo**. Baseline execution 85; owned probes 4. Test identities/statuses are retained in `wha1374/test-results.json`. No producer test results are counted as independent evidence.

Commands (run in inspected cwd):

```sh
node_modules/.bin/prisma generate
node_modules/.bin/next typegen
node_modules/.bin/vitest run src/lib/pharmacy/supplier-credit-follow-up.test.ts 'src/app/(app)/pharmacy/purchasing/returns/' 'src/app/(app)/pharmacy/purchasing/purchasing-console.test.tsx' src/lib/pharmacy/supplier-returns.test.ts --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/vitest.json"
node_modules/.bin/vitest run tests/verification/wha1374-follow-up.test.tsx --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/probes.json"
node --max-old-space-size=6144 node_modules/typescript/bin/tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/wha1374-tsconfig.json" --pretty false
node_modules/.bin/eslint src/lib/pharmacy/supplier-credit-follow-up.ts src/lib/pharmacy/supplier-credit-follow-up.test.ts 'src/app/(app)/pharmacy/purchasing/returns/'
node_modules/.bin/prettier --check src/lib/pharmacy/supplier-credit-follow-up.ts src/lib/pharmacy/supplier-credit-follow-up.test.ts 'src/app/(app)/pharmacy/purchasing/returns/follow-up-queue.tsx' 'src/app/(app)/pharmacy/purchasing/returns/follow-up-queue.test.tsx' 'src/app/(app)/pharmacy/purchasing/returns/page.tsx' 'src/app/(app)/pharmacy/purchasing/returns/page.test.tsx'
node_modules/.bin/eslint tests/verification/wha1374-follow-up.test.tsx
node_modules/.bin/prettier --check tests/verification/wha1374-follow-up.test.tsx
git diff HEAD^ HEAD --check
git diff --check
```

Prisma generation, Next type generation, both Vitest executions: rc=0. Scoped types: three executions, rc=0 (source), rc=2 (new probe unused `params` fixture), rc=0 (fixture removed). Failure was `tests/verification/wha1374-follow-up.test.tsx(31,7): error TS6133: 'params' is declared but its value is never read.` No product change. Final config, including real Next route types, auth/test declarations, transitive imports and owned probe, is retained as `wha1374/scoped-tsconfig.json`.

Source ESLint/Prettier/diff batch rc=0, no lint diagnostics, all six files formatted. Probe ESLint first rc=0 with one unused-variable warning; final rc=0 with zero warnings/errors. Probe Prettier write rc=0, final check rc=0. Final source/worktree diff checks rc=0. Thus one failed type-check execution, zero unresolved check failures, zero failed test executions. Read-only checkout/parent/diff and byte-comparison scripts rc=0; comparison results retained in `wha1374/unchanged.json`.

Producer package.json and bun.lock byte-match source. Dependencies are reused via links into producer node_modules; local node_modules directory owns Vite caches. Prisma output and Next route types generated in this workspace. No install, dependency edit, DB connection, or producer-worktree write.

## Source review and acceptance coverage

Findings: **S1=0, S2=0, S3=0, S4=0** attributable to this source. No defect ticket required.

- All helper callers found: production call only at returns/page.tsx:364; queue imports helper for its return type; remaining callers are focused tests. Page resolves tenant/module/caller before reads (page.tsx:81–145); existing protected router calls preserve session/module checks and scoped DB behavior. Query inputs remain branch-only; organization is resolved server-side. No new authorization path or exposure.
- Actual `listPurchaseReturns` (purchasing-console.ts:574) includes all nested notes/allocations and lines. `listSupplierCredits` (:735) includes all allocations. Both filter organization/branch and have no take/skip/cursor cap. `coverage: complete` means these loaded projections, not an atomic financial snapshot. Repeated creditPosition calculation uses the same existing facts; invalid DTO projection can fail the existing read and reach LoadFailure before the queue.
- Helper rejects foreign organization/branch, mismatched note supplier/return/allocation ownership, invalid/unsafe money and overallocation. Tests cover partial and full allocation, cancelled/settled/draft exclusions, future/unknown issue dates, exact elapsed-day and dispatch boundaries. Open issued notes with unknown issue time remain explicitly unknown. A known expired line blocks dispatch despite another unknown line.
- Owned probes additionally cover invalid principal values and unsafe aggregate allocations; seven returns with expired backlog keep upcoming work first; six matching credits disclose the five-credit cap; populated page selects return and resolves encoded credit target, then a second read removes an exhausted suggestion. Changes to projections are recomputed without caching.
- Same-supplier available credit may appear beside multiple claims. Visible copy says it is not reserved or additive, and proves neither cash recovery nor revenue. Outstanding, allocated and available amounts stay separate. Independent reads can disagree during concurrent allocation; UI remains advisory, with reload guidance and existing guarded actions as authority.
- Four action bodies (`createReturn`, `advanceReturn`, `recordCredit`, `allocateCredit`) byte-identical to base. Entire shared console/outcome helper, action-form locks, DTO service, purchasing router and supplier-return operations also byte-identical. Existing focused purchasing-console tests cover uncertain post-write outcomes. No prior hardware/void suites rerun.
- Queue uses Studio SectionCard and semantic tokens, h2/h3 hierarchy, list semantics, named native links, min-height 44px and focus-visible styles. Query parameters use URLSearchParams; credit IDs use matching encoded fragment/element IDs. Populated DOM probe verifies special characters, selected return and actual target. Empty, excluded/partial, denied, load-failure and loading states pass focused DOM checks. DOM evidence does not establish browser layout/accessibility acceptance.
- Additional helper work scans allocations and filters available credits per qualifying note, then sorts. No new database work. The five-row display does not bound processing of existing uncapped inputs; high-volume performance is not benchmarked in this review.

## Limits and disposition

Read full Studio contract and installed Next 16.2.12 layouts/pages guide before source/UI review. Applied bounded-operations, evidence, local source, tool-selection, code-review, frontend/Studio and security skills. Graph/Claude-Mem callable tools and Ponytail skill unavailable; no index could run. Used supplied paths and narrow grep/Python caller/DTO tracing. `rg` unavailable (127); no broader-history memory injected. Native CLI adapter used directly; no nested CLI or agents.

Pending acceptance categories **2**: (1) owner-deployed exact-revision browser/Studio matrix at 375/768/1024/1440, light/dark, normal/reduced motion, keyboard/focus, overflow and states/console; (2) supervisor integration/release acceptance. Existing shared/hardware/pharmacy owner gates remain unresolved and unchanged. No app/browser service, physical test, staging/live DB, full baseline build, push, merge, rebase, deploy or outreach.

**PASS for exact source and focused checks only.** This completes WHA-1374's independent review; it does not release or accept the UI. Supervisor/Chief of Staff owns subsequent integration and owner-gate routing. Rollback, if later required, is supervisor removal/revert of this additive source commit; no ledger/data reversal is introduced.
