# WHA-1362 — consolidated independent review

Verdict: **FAIL**. Review complete; private foundation is not accepted for downstream integration. Board owns correction/integration decisions. No implementation fixes made.

## Exact candidate

Assigned cwd: /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1362-verify-hw-combined-receipt-layout-queue-authorization-and-printer-runtime-review
Branch: WHA-1362-verify-hw-combined-receipt-layout-queue-authorization-and-printer-runtime-review
Initial HEAD: 411306de8d88b8eea574caa93750a972afa028d7; parent 806f1138395c595ca27e3eb086581b9961fb441e. Initial tracked/untracked status clean.
Both source candidates have parent fe1e3e383c8b966cdb68669ba5366db00fe2320a, verified ancestor of foundation. Exact source paths matched assignment.

- bc0693705163c618c3445ffcc7c8b89f13ac8024: five service/API/test files; private cherry-pick 4ba8cd08ac2f15a3a16d48196a1d8e2924cd51f5, parent 411306de8d88b8eea574caa93750a972afa028d7.
- 655c7f9a1668c122b6319a5fea33910564b9cfa7: four runtime/PowerShell/test/documentation files; private cherry-pick 872984e7bd434e203b5bf8047b5848971a42325f, parent 4ba8cd08ac2f15a3a16d48196a1d8e2924cd51f5.
- Combined Git tree: 63f03dc0b491399ffc38b3ea47c713266729aceb. Both cherry-picks exit0, no conflicts. No source edits beyond authorized composition. Review evidence remains untracked under docs/reviews/wha-1362; it is not part of candidate SHA.

## Findings

**S2 — unsupported text starves branch queue.** Primary [GitHub91](https://github.com/WhatTheStack1/devfathom-commercial/issues/91). Owners WHA-1354/WHA-1360. PrintJobSchema accepts legacy Urdu labels; enqueue returns QUEUED. claimNextPrintJob renders the oldest candidate before its state update. renderEscPos throws; no job state changes and no later valid candidate is reached. Two independently executed claims produced the same error and both rows stayed PENDING/attemptCount0/lastAttemptAtNULL. withDeviceAuth converts this to generic500; runtime stops. Required honest browser fallback is not delivered to caller. Reproduction in wha1362-review.db.test.ts.txt; review-repro.json records the confirming assertion. This is a confirmed failure, not a passing acceptance test.

**S2 — required combined typecheck fails.** Primary [GitHub92](https://github.com/WhatTheStack1/devfathom-commercial/issues/92). Owners WHA-1356/WHA-1360. scripts/print-bridge.ts:128 and :144 produce TS2352: minimal native environments asserted as NodeJS.ProcessEnv lack required NODE_ENV under combined Next imports. printing.db.test.ts:158 produces TS2554: writeToPrinter expects3 arguments but receives2; allowlist argument missing. Exact three diagnostics retained in typecheck.log. claimToken missing-property error is resolved, but overall graph remains failing.

## Acceptance matrix

| Criterion | Verdict and evidence |
| --- | --- |
| Three-way token protocol | PASS behavior:64 lowercase hex HMAC produced, runtime validates/echoes same token with same Bearer; strict ACK body; overall type gate FAIL as above. |
| Current claim/device/branch binding | PASS focused route tests plus8 independent claim DB tests: unclaimed, wrong-device, sibling/cross-tenant, tampered/old token rejected; concurrent claimant/ACK behavior checked. |
| Expiry/replay/uncertain delivery | PASS reviewed bridge path: exact30000ms lease boundary rejects; attempted PENDING/OFFLINE never reclaimed; matching status ACK idempotent; persistent pre-write marker blocks host replay; no physical exactly-once claim. Recovery requires operator reconciliation. |
| Host allowlist/native invocation | PASS source/unit behavior: exact allowlist before dispatch, fixed native command, shell:false, bounded payload, minimal child env, macOS localhost lp RAW/Windows local RAW helper. Actual OS spooler and physical device acceptance NOT RUN. |
| Preview/queued financial snapshot | PASS shared foundation: exact preview bytes persisted and claimed after source layout/totals mutation, at58mm; existing snapshot tests cover58/80mm, mandatory groups, copying, command rejection and legacy ASCII bytes. Authentic invoice-to-snapshot consumer integration remains WHA-1355/1358 scope. |
| Unsupported Urdu/browser fallback | FAIL: render rejects honestly internally but accepted job starves queue and caller sees no usable fallback. |
| Settings schema/API/source security | PASS scoped tests/source: session, tenant, module, configure permission, strict origin, SQLNULL-only defaults, object constraints, tenant/active/branch/revision CAS, preserved failures. |
| Settings persistence/RLS | PASS4 independent DB tests, enforcing runtime role, fresh tenants; migration/table evidence below. Pharmacy adapter remains outside foundation. |
| Studio visual release matrix | BLOCKED by explicit no app/browser-services rule;375/768/1024/1440, light/dark, reduced motion, keyboard/overflow/console and screenshots not executed. Component tests alone do not satisfy it. |

## Independent commands and results

All execution used an archive of exact combined HEAD in PAPERCLIP_RUN_SCRATCH_DIR/combined. Shared node_modules linked read-only from WHA-1116 compose checkout. Vite cache redirected to owned scratch; Prisma generated only there. No nested Codex, agents, global changes, existing tenant tests, remote synchronization, push, merge, rebase, reset, deployment, app/browser service or real device access. Runtime tests use isolated fake loopback sockets and mocked native process dispatch.

1. node node_modules/prisma/build/index.js generate — exit0, Prisma7.9.1, scratch client.
2. node node_modules/vitest/vitest.mjs run tests/print-bridge.test.ts src/lib/restaurant/printing/printing.test.ts src/lib/restaurant/printing/receipt-snapshot.test.ts src/app/api/restaurant/print-bridge/route.test.ts src/lib/receipts/configuration.test.ts src/lib/receipts/restaurant-settings.test.ts src/app/api/restaurant/receipt-layout/route.test.ts src/components/receipts/receipt-designer.test.tsx --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=<scratch>/unit.json — exit0, **111 passed,0 failed,0 pending/skipped**,8 files. Database URLs removed from this process.
3. Same Vitest flags with src/lib/receipts/restaurant-settings.db.test.ts src/lib/restaurant/printing/claim.db.test.ts — exit0, **12 passed,0 failed,0 pending/skipped**,2 files. Own randomized fixture tenants, cleanup limited to their IDs.
4. Same flags with scratch-only tests/wha1362-review.db.test.ts — exit0, **2 assertions passed**: one snapshot acceptance, one confirming queue-starvation defect. One fresh randomized review tenant, removed afterward.
5. node node_modules/typescript/bin/tsc --noEmit -p tsconfig.verify.json — **exit2,3 errors**. Exact config retained; transitive imports included. No source alterations or suppressed errors.
6. node node_modules/eslint/bin/eslint.js <all22 changed TS/TSX paths from git diff fe1e3e38..HEAD> — exit0,0 diagnostics.
7. git diff --check fe1e3e38..HEAD — exit0.

No tests skipped in executed suites. Existing printing.db.test.ts was included in typecheck and not executed; its stale transport call is a finding, not claimed pass. Full build, browser/axe and actual Windows/macOS spooler tests were not run.

## Database identity and reused evidence

WHA-1354 published final documentation SHA bdea63a2cd3d35eab300dc585e7e1352cf64c4e4, parent411306de; source/test/migrations unchanged. Retained fixture: sibling WHA-1354 checkout/.wha1354-verification-NSdov4. Read its README, identity.json and evidence.json. Only runtime connection used; credentials never output/copied into evidence.

DB wha1354_disposable_b032106891, PostgreSQL16.15,127.0.0.1:52027; runtime wha1354_runtime_b032106891. URL identity checked before execution; role guard independently passed in all DB suites. Published evidence:105 exact migrations,0 unsuccessful,0 checksum mismatches; runtime0 owned app tables, NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE; Restaurant and Pharmacy branch ENABLE/FORCE RLS. Existing WHA1350 database never accessed. WHA-1354 owns environment cleanup; shared cluster left running. Migration checksum/table metadata reused, not independently re-provisioned.

## Remaining gates and disposition

Board/original owners: one correction pass for GitHub91/92, then one recheck on exact corrected composition. Do not accept current foundation into WHA-1355/1358 yet. Those owners still own canonical invoice consumers, Pharmacy adapter, usable browser fallback and final composed caller validation. Authorized staging owner owns Studio visual/build gate. Saad/hardware owner owns named OS/driver/queue/device tests; socket/spool acceptance never proves paper output.

Recovery: retain additive schema/data; do not deploy this candidate. Any later application rollback should keep additive receipt columns. Uncertain delivery requires reconciliation before any new physical attempt; no automatic retry claim.

Review disposition: DONE with FAIL verdict, not waiting for paused Chief of Staff/CTO. Graph/task memory/Ponytail/rg unavailable; narrow source fallback used and reported once.

## Exact candidate changed paths (28)

- docs/product/modules/printing.md
- docs/receipt-layout-WHA-1354.md
- prisma/migrations/20260905180000_receipt_layout/migration.sql
- prisma/migrations/20260905190000_pharmacy_receipt_layout/migration.sql
- prisma/schema.prisma
- scripts/print-bridge-windows.ps1
- scripts/print-bridge.ts
- src/app/(app)/settings/receipts/page.tsx
- src/app/(app)/settings/settings-content.tsx
- src/app/api/restaurant/print-bridge/route.test.ts
- src/app/api/restaurant/print-bridge/route.ts
- src/app/api/restaurant/receipt-layout/route.test.ts
- src/app/api/restaurant/receipt-layout/route.ts
- src/components/receipts/receipt-designer.test.tsx
- src/components/receipts/receipt-designer.tsx
- src/lib/receipts/configuration.test.ts
- src/lib/receipts/configuration.ts
- src/lib/receipts/preview.ts
- src/lib/receipts/restaurant-settings.db.test.ts
- src/lib/receipts/restaurant-settings.test.ts
- src/lib/receipts/restaurant-settings.ts
- src/lib/restaurant/printing/claim.db.test.ts
- src/lib/restaurant/printing/contract.ts
- src/lib/restaurant/printing/esc-pos.ts
- src/lib/restaurant/printing/printing.db.test.ts
- src/lib/restaurant/printing/receipt-snapshot.test.ts
- src/lib/restaurant/printing/service.ts
- tests/print-bridge.test.ts
