# Restaurant growth source milestone — October 7

Issue WHA-1400. Owner 987. Branch `codex/restaurant-growth-20261007`.
Exact parent `4df017cce6c0baeeed6ce6eb0f18718ea2d77d02`; preserves
`c42551d84366e448dd4e4a2c0e5a395ee2277ea5` and all previous evidence.
Commit SHA/tree and final clean-state receipt are in the issue comment and attached patch.

## Changes

- Consumed **unchanged** accepted a6f0addad0a60ac555bacb7e23c3e066bca79026
  shared generator, tests and interface. Patch SHA256
  `a8e44778b52c70fa0ee9d31e9d296b38d567cdb96b22d4ec8e547120c1c9a125`.
  Source SHA256 `b7b5936117ee80ee25fc525858c8931490e4af184c077cdc1ed2ab33608a36f7`;
  test SHA256 `3c6b11b9f5cb3365695804bf2cc57e3f14d0b36487c8fa5de4a70e014a9ec83a`.
  Verified against saved handoff manifest. No shared implementation edits.
- Branch context now precedes insight locking. Service and Restaurant SQL guard
  use identical scope-keyed transaction advisory locks; no UPDATE grant on immutable
  `growth_insights` is needed. Explicit tenant/branch predicates and RLS remain.
- Binding calls accepted strict input/output validators, rejects suppressed cohorts,
  unsupported money/receipt semantics and action/evidence mismatches. JSONB key
  order is harmless. Canonical shared hash is checked before authoritative evidence
  reread. Current reader lacks cohort/freshness, so READY remains unreviewable.
  No default-true freshness, fake evidence or invented BUSINESS_DATE interpretation.
- Generation authorizes before evidence and persistence, serializes actor/request
  identity, persists idempotent sparse/unavailable records with source snapshot and
  evidence hash, and rejects conflicting retries. No config/model/provider call.
  Accepted SQL permits only five failure codes: both no-evidence cases use `SPARSE`,
  while private `failureReason` distinguishes unsupported contract/source unavailable.
- Bounded list (latest 20, 21st-row truncation flag), scoped selection and generation
  form added to existing review route. Unknown response retains exact request UUID.
  Studio PageHeader/SectionCard/Button/Input and semantic tokens reused. No export.
- Internal TEST_SANDBOX adapter only: actual server database, port, loopback address,
  non-superuser/non-BYPASSRLS checks; explicit named disposable database admission;
  customer-management/configure/financial/module/branch checks; server-owned fixture
  registry; only approved current-evidence loyalty drafts; no inventory/catering
  outreach. Current customer/loyalty state locked and rechecked; existing consent
  order used after lock with current DB clock. STOP appends a withdrawn WHATSAPP
  event through existing `appendCustomerConsent`. Caps are explicit campaign and
  **branch-recipient rolling 24-hour** caps, not organization-wide claims. Quiet
  hours use configured timezone and are rechecked before capture. Exact saved
  attempt replay includes UNKNOWN; changed request/policy/lineage cannot resend.
- Proposed Restaurant-only fixture/attempt/receipt-event SQL fragment: scoped FKs,
  append-only triggers, exact branch RLS, unique receipt lineage, loyalty guard.
  Not applied. No production endpoint, sender, notification or pharmacy tables.
- Internal diagnostic joins exact attempt/customer/branch/numbered SETTLED receipt
  and cutoff lineage, excludes UNKNOWN attempts, caps at 100 receipts and refuses
  overflow. It returns operational receipt IDs only. No supported per-receipt posted
  Finance/refund reader was established at this base: settled money, posted margin
  and message cost remain null. No live attribution writes or causal ROI claim.

## Validation

Final focused evidence spans seven files / **161 passing tests**, no model calls:

- Existing `growth-evidence.test.ts`: 48, reused unchanged after this run's pass.
- `growth-review.test.ts`: 36 (35 preserved plus branch-before-lock regression).
- `growth-generation.test.ts`: 17, includes shared validator/binding, sparse/source
  failure persistence, tenant/module/revocation, replay, JSONB order, bounded list.
- `growth-sandbox.test.ts`: 20, including identity/role denial, consent withdrawal,
  STOP normalization, quiet hours/caps, UNKNOWN replay, operational action refusal,
  eligibility recheck, capability and diagnostic predicates. Readers/consent are
  doubles; not PostgreSQL consent/concurrency/receipt proof.
- Existing review panel: 9 preserved; new entries panel: 4.
- Accepted shared generator tests: 27 with provider doubles only.

Commands (repository root, existing read-only dependency symlink):

1. `node node_modules/vitest/vitest.mjs run src/lib/restaurant/growth-evidence.test.ts src/lib/restaurant/growth-review.test.ts src/lib/restaurant/growth-generation.test.ts src/components/restaurant/growth/growth-review-panel.test.tsx src/lib/ai/growth-recommendations.test.ts --no-cache`
   initial 134/134, exit 0. Subsequent changed service/generation tests final 53/53,
   exit 0. Sandbox final run 20/20, exit 0; entries results below.
2. `node node_modules/vitest/vitest.mjs run src/components/restaurant/growth/growth-entries.test.tsx src/lib/restaurant/growth-concurrency.db.test.ts --no-cache`
   4 passed, 3 skipped (not admitted), exit 0; no DB connection.
3. Scoped `tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/growth-tsconfig.json" --pretty false`:
   extends repository tsconfig, incremental false, includes Restaurant growth TS,
   growth components/page/actions/router/shared source and src ambient declarations;
   imported dependencies checked. Final exit 0, zero diagnostics. A redundant older
   repeat was stopped (SIGTERM, exit 143); the newer final check completed exit 0
   before a proposed stop reached it. No owned typecheck remains running.
4. Scoped ESLint: exit 0; no errors, one pre-existing unused `_input` warning in
   preserved review panel test. Prettier scoped check exit 0.
5. Protected package/lock/schema/migrations/pharmacy/provider/root-router diff against
   parent exit 0; shared manifest SHA256 matches; whitespace check exit 0.

Correction evidence: initial scoped tsc found unused React import in new UI test;
removed. One review test expected old FOR UPDATE string after advisory-lock change;
updated to scope-keyed lock. SQL source review caught unavailable failure code outside
accepted enum; mapped to SPARSE with private detail. Binding JSONB key ordering and
sandbox post-lock eligibility/current consent were tightened in consolidated review.
Final sandbox check also caught a flaky substring assertion (customer token c1 inside
a random UUID); replaced with exact response-key and ID checks. No new dependency
trees, auth/env files, caches, DB clusters or listeners created.

## Executable acceptance still not run

- Existing five storage tests plus three new **actual-service** two-connection
  replay/distinct-final/rollback cases. Set `RESTAURANT_GROWTH_DB_ADMITTED=1`,
  `RESTAURANT_GROWTH_TEST_ENVIRONMENT=TEST_SANDBOX`, and an approved loopback URL
  whose actual DB name matches `restaurant_growth_test_*`, then run
  `node node_modules/vitest/vitest.mjs run src/lib/restaurant/growth-concurrency.db.test.ts --no-cache`.
  Coordinator first composes accepted shared storage and Restaurant review fragment.
  New fixture checks actual server identity and runtime role before writes; uses a
  named TEST_DOUBLE binding and committed synthetic rows in the disposable DB.
  It calls the actual review service, injects only draft-write failure for rollback,
  and retains append-only fixtures until the disposable database is retired.
- No DB schema application, listeners, browser/Studio visual matrix, build,
  actual sandbox capture/STOP/receipt acceptance, or configured model execution.
  Existing five browser cases remain prepared. Disk hold remains in force.
- Exact shared migration was read and SHA verified
  (`b7b45d2be5825245ffbaba6502ac3edb3c1c673172842ee859bee12fd0ed477f`).
  It includes pharmacy review DDL; not copied or edited here. Central composer owns
  the additive schema union and actual runtime grants/acceptance.

## Remaining / reviewer path

Local-board/coordinator reviews this source candidate, coordinates shared owner
WHA-1622 and reserves resources for composed acceptance. Missing real cohort/source
freshness, explicit BUSINESS_DATE/refund semantics and gross metric remain exact
shared-contract needs. Binding deliberately blocks READY until those authoritative
readers/contracts exist. Configured model requires separately approved existing
configuration plus real execution evidence; no provider/config inspection performed.
The deterministic source is delivered, but complete growth-loop acceptance is not.
Actual receipt-money diagnostic needs a supported per-receipt Finance/refund reader;
we did not create a parallel analytics engine. No source tests prove PostgreSQL RLS,
transaction races, runtime SQL privileges, visual quality or real AI execution.
Rollback before central composition: omit this additive candidate. No schema applied,
no push/merge/rebase/deployment/shared refs or concurrent catering/integration edits.

## Exact candidate files

- `docs/pharmacy/growth/interface.md`
- `docs/restaurant/growth/continuation-evidence.md`
- `docs/restaurant/growth/review-storage.sql`
- `docs/restaurant/growth/sandbox-storage.sql`
- `src/app/(app)/restaurant/growth/actions.ts`
- `src/app/(app)/restaurant/growth/page.tsx`
- `src/components/restaurant/growth/growth-entries.test.tsx`
- `src/components/restaurant/growth/growth-entries.tsx`
- `src/components/restaurant/growth/growth-review-panel.tsx`
- `src/lib/ai/growth-recommendations.test.ts`
- `src/lib/ai/growth-recommendations.ts`
- `src/lib/restaurant/growth-binding.ts`
- `src/lib/restaurant/growth-concurrency.db.test.ts`
- `src/lib/restaurant/growth-generation.test.ts`
- `src/lib/restaurant/growth-generation.ts`
- `src/lib/restaurant/growth-review.test.ts`
- `src/lib/restaurant/growth-review.ts`
- `src/lib/restaurant/growth-sandbox.test.ts`
- `src/lib/restaurant/growth-sandbox.ts`
- `src/server/routers/restaurant-growth.ts`
