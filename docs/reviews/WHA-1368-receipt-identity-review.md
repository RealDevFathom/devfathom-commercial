# WHA-1368 independent review — PASS (backend source/DB scope only)

Recommendation to current Codex supervisor: accept the private GitHub #90 backend identity repair at the exact revision below. No blocking finding within these seven paths. Keep GitHub #89 authorization policy and UI/physical acceptance gates open; this is not release approval.

## Source identity and ownership

- SHA: `c49b1afa252f20905269a044d09bdb0406eb7b60`.
- Tree: `e8be20e3dfc4ef326842c9892f6363cc4a2ac3d0`.
- Immediate parent: `fe1e3e383c8b966cdb68669ba5366db00fe2320a`.
- Assigned branch: `WHA-1368-verify-hw-independently-accept-or-reject-pharmacy-issued-receipt-identity-repair-c49b1afa`; initial tracked and untracked status clean. No branch change or source edits.
- Exact parent diff: `src/lib/pharmacy/counter-receipt.ts`, `counter.ts`, `receipt-identity.db.test.ts`, `receipt-identity.test.ts`, `receipt-identity.ts`, `settlement.test.ts`, `settlement.ts` (all under `src/lib/pharmacy/`). Seven files, 870 insertions, 11 deletions; no schema, migration, dependency, or authorization-policy change.
- Tests executed from an exact local Git archive in run-owned scratch. All seven files byte-compared to the review checkout after tests; identical. Prisma output and Vite cache confined to scratch; compose node_modules reused read-only. No installs or shared generated-client changes.

## Independent results

**53 passed, 0 failed, 0 skipped**, four files, Vitest exit 0. These are this review's fresh executions, not copied implementer counts: receipt model 18, strict identity 19, settlement 7, migrated DB 9.

- New PostgreSQL 16 cluster in run-owned scratch, TCP localhost port 56468, database `wha1364_review1368` (prefix required by existing test guard). No existing tenant database accessed. Dedicated admin `wha1368_admin`; tests use `wha1368_runtime`, verified `rolsuper=false`, `rolbypassrls=false`. Synthetic organization/branch fixtures only.
- Extension preparation succeeded; **103 migrations applied**, 0 migration failures. Prisma 7.9.1 generated in scratch. Cluster stopped successfully after evidence collection.
- `node node_modules/vitest/vitest.mjs run --config vitest.config.mts src/lib/pharmacy/receipt-identity.test.ts src/lib/pharmacy/receipt-identity.db.test.ts src/lib/pharmacy/settlement.test.ts src/lib/pharmacy/counter-receipt.test.ts --reporter=json --outputFile=<run-scratch>/tests.json`: exit 0, 53/0/0 above; `WHA1364_RECEIPT_TEST_DATABASE_URL` pointed only at the new runtime role/database.
- `node node_modules/typescript/bin/tsc --project tsconfig.review.json --noEmit`: exit 0. Scratch config preserves repository strict compiler settings, limits roots to seven changed files and their transitive imports, disables incremental output and Next plugin.
- `node node_modules/eslint/bin/eslint.js <seven exact changed paths>`: exit 0.
- `git diff --check`: exit 0.
- No test/setup failure. Existing pg concurrent-query deprecation warning emitted; no failed or skipped assertions. Implementer fail-before results were context only and were not independently rerun or claimed here.

## Acceptance findings

1. Numbered settlement creates one version-1 COMPLETED event inside the existing transaction, after scoped sale locking. Production tender router wraps the helper in `$transaction`. Snapshot validation/event errors propagate; DB rollback covers issuance. Partial payment creates no issuance snapshot.
2. Strict Zod objects enforce supported version, required shape, valid dates, positive safe integer quantities and receipt number. Correspondence validation covers sale/device/date/time, exact line IDs and medicine/presentation IDs, complete allocation IDs/lot IDs/units, duplicates and per-line totals. Issued labels are deliberately not compared to today's mutable catalog.
3. Migrated DB proves identical receipt before/after medicine name, strength, presentation, batch number and expiry edits, plus separate refund. Both actual batches persist as 3 and 7 canonical units with original expiries. One financial line remains; gross 1000, discount 50, net/tendered 950, change 0.
4. Same-key concurrent final tenders and replay yield one tender/event. Different-key competition yields one winner and one SALE_NOT_OPEN refusal. Invalid identity rolls back sale, tender, sequence and idempotency; corrected retry receives receipt 1. Injected event-write failure aborts issuance.
5. Duplicate snapshots and unknown version are refused. Status-only and numbered legacy records return unavailable historical identity without live-label reconstruction. Tenant/requested-branch mismatch is refused in the DB test; this does not establish staff capability authorization.
6. No new patient/customer data is added to payload. Existing append-only event storage reused; no migration or dependency risk introduced by this patch. Source/DB review is limited to identity persistence and reads, not claims against privileged direct database tampering.

## Limits and recovery

GitHub #89 authorization policy remains unresolved. UI owner still must render every allocation/expiry, localized unavailable states, thermal/A4 and responsive layouts; physical printer/device gates remain untested. Existing receipt model English/Urdu tests passing is not browser/physical evidence. No app/browser service, hardware access, push, merge, deploy, production operation, nested CLI or extra agent used.

Read repository AGENTS and relevant bundled Next server-only guidance. Claude-Mem/graph tools unavailable in this session; task-specific exact-path fallback used, no tool-setup repair. Prior WHA-1361 baseline and WHA-1364 repair90-evidence informed scope only. Reviewer changed only this report/evidence, never implementation.

Recovery: omit the private repair before integration if needed. Any later rollback must preserve already-recorded issuance events rather than rewriting/deleting history. Supervisor owns integration disposition; retain separate policy/UI/hardware gates.
