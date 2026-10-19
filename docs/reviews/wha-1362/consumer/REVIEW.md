# WHA-1362 — authorized adjacent Restaurant consumer review

Verdict: **PASS — scoped consumer plus matched foundation functional review**. Exact archived HEAD `f0c6138ea9ef0572c1b7ecdd64af38676e6be7b0`, tree `7e8d6678b37673b05d3e6e6b8312552a3a2b4b33`, parent `f0f0fed35181327db506f4bf622a9ab7cf953c24`. This is independent execution, not the owner's207-test claim. No release, full UI, build or physical-device acceptance.

Authorization: Board comment cbe88e31-eae0-4763-8f7c-7ab59cb68d61 supplied the artifact after foundation completion and authorized one adjacent follow-up. No implementation lane, producer repetition, branch replacement or additional reviewer.

## Exact source identity

Assigned checkout/branch retained at `2b5ab7974116051e1075ab7f3006969b1959e697`; only untracked review evidence. Candidate consumed through `git archive f0c6138ea9ef0572c1b7ecdd64af38676e6be7b0` into PAPERCLIP_RUN_SCRATCH_DIR/consumer. Original reports and artifacts preserved; SHA256 inventory in identity.json. Complete source map and correction scope read from `docs/receipt-checkout-WHA-1355.md`.

Consumer chain:
- Initial owned74bb5b3c4e5e520845304d9200c6a37fe6d556e0, parentfe1e3e383c8b966cdb68669ba5366db00fe2320a.
- Owned integration2d90ac2b1a48ed56ffe4194feba67daf34ba9bf2, parent7562dde3057554278d73b35fc66c6e91a80ed68a.
- Final owned correction `f0c6138ea9ef0572c1b7ecdd64af38676e6be7b0`, parent `f0f0fed35181327db506f4bf622a9ab7cf953c24`:7 files,+425/-123. Those seven paths are receipt-dispatch.ts, route.test.ts, receipt-dispatch.db.test.ts, receipt-browser-print.ts, receipt-print-controls.tsx, receipt-print-controls.test.tsx and consumer documentation.

Producer original-to-local map:
- 806f1138395c595ca27e3eb086581b9961fb441e =4cb05b80a8bbc69efca2aa0abaefa2fc046433de
- 411306de8d88b8eea574caa93750a972afa028d7 =43b7b8d48a9720c23c3a1b2d26489115e1cdfd05
- bc0693705163c618c3445ffcc7c8b89f13ac8024 =f0685b7dcae1dd022dc62657e0c1079c53c35169
- 655c7f9a1668c122b6319a5fea33910564b9cfa7 =7562dde3057554278d73b35fc66c6e91a80ed68a
- bdea63a2cd3d35eab300dc585e7e1352cf64c4e4 =aaae082b745a88b53ce3bbc66ad48bae4653484c
- 513d05ad34f3268c2229c2ea5703786726e7ccde =a902808a9271bc617c83f17a8301f20910303f02
- 5c222a54ef24993693b4c07d4066c89a2ac5fb9b =5baea4db89c494e9183989f306cc5ab984a03c5e
- ceed2f40a78bafbc24d68506f010218c30a0a6fe =f0f0fed35181327db506f4bf622a9ab7cf953c24

Direct diff against passed foundation shows exactly12 consumer/settings paths below; all other tracked paths are identical. No unrelated source differences. Foundation-only153-test evidence remains separately recorded in ../recheck/RECHECK.md; it is not added to this consumer test count.

## Acceptance evidence

- **Branch/payment ACL PASS:** actual money wrapper tests enforce unlocked operator, payments:collect and POS register; strict body rejects client branch/routing/money/snapshot fields. Real DB consumer tests reject foreign-tenant and sibling-branch bills. GET is branch-scoped, no-store; internal queued document is not exposed. Device authentication is a test seam, not a new authentication-system acceptance claim.
- **Financial snapshot PASS:** saved bill/tender/tax facts are formatted without recomputation. Tests cover fractional splits, line tax/service/comp, tax currency/rate/discount buckets, cash received/tip/change and reason. DB confirms persisted58mm layout, exact shared preview/ESC-POS content, stable existing snapshot after settings change, and80mm settings for subsequent receipt. No client-supplied financial document is trusted by the dedicated consumer.
- **Original/reprint idempotency PASS:** original request concurrency, preserved offline state after route removal, existing-claim guards, reason/request ID stability and changed multiline reason rejection. Added independent DB test creates original, claims/ACKs through real service, concurrently requests same reprint:2 total jobs,1 reprint event,1 reprint outbox, one replay. Changed reason returns409. Copy snapshot includes COPY and exact full reason. Queue/event/outbox rollback passes.
- **Raw/semantic fallback PASS:** Unicode shared preview is preserved; raw dispatch returns422 with safe error/code/BROWSER_OS and persists no job/event/outbox. Invalid semantic data returns no browser preview/fallback. Dedicated consumer422 body contains error/code/fallback; unlike generic bridge API it does not serialize retryable:false. UI explicitly treats422 as typed refusal, clears retry and does not label it uncertain. Unknown422 messages fail closed. Network failures preserve same-request retry and duplicate-copy acknowledgment. No fallback renderer bypass when preview is absent.
- **Safe browser text PASS within DOM-unit scope:** real popup helper writes textContent, preserves Unicode/combining/joining/supplementary characters, nulls opener, carries CSP nonce, uses captured58/80mm width and pre-wrap. Injected img markup remains inert. Missing preview/popup blocked paths tested. afterprint never proves delivery. Added DB test connects real saved Unicode facts to preview and raw refusal with zero new events/jobs/outbox.
- **Settings preservation PASS within component/source scope:** sibling station routes survive editing; saved-route test disables unsaved/unconfigured states and retains retry key. Designer/settings entry and Devices settings link retained. Existing Studio Button/Input/tokens reused. Settings entitlement and devices component regressions pass.
- **Matched foundation PASS:** combined run repeats60 runtime tests,11 claim DB tests,4 fake-TCP/printing DB tests,4 layout DB tests and shared renderer/settings/API cases. Same restricted environment/allowlist/current-claim protocol compiles under actual Next imports. No physical OS queue invoked.

## Independent commands and numeric results

Exact commands/file arguments and exit codes: commands.json, independent-command.json. All unit/database tests used `--maxWorkers=1 --no-file-parallelism --reporter=json`.

- Scratch `node node_modules/prisma/build/index.js generate`: exit0; compose node_modules linked read-only; generated client and Vite cache owned by scratch only.
- New isolated provision, extension preparation,105 migrations, grants and evidence: each exit0. Logs retained.
- Owner-named combined Vitest scope independently rerun: **207 passed,0 failed,0 skipped/pending**,18 files, including24 DB tests. Evidence combined.json/log.
- New review-only `tests/wha1362-consumer.db.test.ts`: **2 passed,0 failed,0 skipped**, concurrency and Unicode cases. Exact fixture retained as .txt. Total **209 passed**, including26 DB tests; no copied owner count.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.verify.json`: exit0,0 diagnostics. Runtime-inclusive scoped transitive imports, no stubs/suppression. Config retained. `--listFilesOnly` exit0:2263 files,330 Next files. This is not whole-workspace typecheck.
- ESLint all11 TS/TSX consumer delta paths: exit0,0 diagnostics.
- `git diff --check fe1e3e38 f0c6138`: exit0.
- Identity-checked cleanup of only review database and2 owned roles: exit0, no FORCE/session termination/shared-cluster shutdown.

## Isolated database evidence

New database `wha1362consumer_disposable_5e015ddcf2`, PostgreSQL16.15,127.0.0.1:52027; owner/runtime names in db-identity.json. Admin connected only to maintenance postgres for creation/cleanup; disposable cluster data_directory checked against published identity. No existing database or tenant used for tests.

Runtime NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT;0 owned application tables. Branch/job/bill ENABLE/FORCE RLS.105 migrations independently checksum-verified,0 mismatches,0 unsuccessful. Fresh randomized fixtures only; append-only event guards preserved. Whole owned database removed after tests, as required by consumer fixture. No credentials published.

## Limits, recovery and disposition

Review DONE with scoped functional PASS. No new bug finding. GitHub91/92 receive consumer-tree evidence before Paperclip report. Foundation report remains a separate exact-tree result.

Full Studio375/768/1024/1440 light/dark/reduced-motion/keyboard/overflow/state/console matrix, screenshots/axe, real-browser shaping/printing dialog, full build, staging integration and physical/native printer/driver targets remain unexecuted. Frontend quality gate therefore remains open; component tests are not visual acceptance. Explicit no app/browser-services instruction governed this review. Pharmacy consumer is not part of this artifact.

Board owns authoritative integration. Authorized staging owner owns build/browser gate; Saad/hardware owner owns real OS/driver/device targets and human-only approvals. No additional authorization loop or owner wake requested. No source correction, nested CLI, agents, extra workers, push/merge/reset/rebase/deploy or production access.

Recovery: preserve queued snapshots and attempt state; browser copies of existing/uncertain jobs require duplicate acknowledgment. Never retry uncertain physical delivery automatically. Omit consumer integration before rollout if necessary; retain additive schema/data and matched semantic/raw queue guard together.

## Exact delta against passed foundation

- docs/receipt-checkout-WHA-1355.md
- src/app/(app)/settings/settings-content.tsx
- src/app/(app)/settings/settings-entitlements.test.tsx
- src/app/api/restaurant/checkout/receipt/receipt-dispatch.db.test.ts
- src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts
- src/app/api/restaurant/checkout/receipt/route.test.ts
- src/app/api/restaurant/checkout/receipt/route.ts
- src/components/restaurant/pos/receipt-browser-print.ts
- src/components/restaurant/pos/receipt-print-controls.test.tsx
- src/components/restaurant/pos/receipt-print-controls.tsx
- src/components/restaurant/pos/receipt-view.tsx
- src/components/restaurant/restaurant-devices-console.tsx
