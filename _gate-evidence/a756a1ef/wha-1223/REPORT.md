# WHA-1223 — independent a756a1ef correction review

Date: 2026-09-06. Reviewer: Codex Verification Engineer. Run: ca62f3bf-d2ab-4303-9cbd-d434c9b00481.

**Artifact verdict: PASS for the authorized static/component/procedure/type correction review. Complete journey/release status: PARTIAL; fresh-organization and Studio/browser gates UNRUN.** No new product defect established in this bounded pass. No release approval implied.

## Exact identity and scope

Candidate `a756a1efd157d1f005239eed322734998b2397ff`; parent `0eddf3675a92e3876a5b9f3e642d91d2af538898`. Source `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.paperclip/worktrees/WHA-1203-wha-1195a-build-first-run-checklist-and-first-sale-scenario`, native branch `codex/WHA-1203-pharmacy-fresh-first-sale`, common Git repository `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.git`. Initial and final source status empty. Candidate and parent verified by `git rev-parse HEAD HEAD^ --git-common-dir`.

Execution cwd is the assigned WHA-1223 worktree containing this report; branch remains `WHA-1223-gate-candidate-b20b577f-browser-suite-wha-1132-contract-on-the-runner-with-the-working-postgresql-path-self-cho`, HEAD remains `b20b577f9d397855458cbef15ea8d178870d85a3`. Initial status empty. No reset, branch mutation, fetch, owner-app use, code edits, install or shared generation. Historical b20b577f report preserved. Original source artifacts including 8b107092 untouched. Archives created using read-only `git archive <SHA>` into `$PAPERCLIP_RUN_SCRATCH_DIR/{parent,candidate}`. Eight source/archive file hashes independently match commit blobs; see blob-identities.json. Only new review evidence added in the execution workspace.

Read full builder comment `b85cad5f-3660-43ea-8e39-443fbaccb5fa` through WHA-1203 comments API, and GitHub97 body using `gh issue view 97 --repo WhatTheStack1/devfathom-commercial --json title,body` (exit 0). Acceptance is the September6 correction description, superseding old destructive browser instructions. Source-confirmed original gap is not a browser reproduction.

## Actual delta and behavior

Eight files, +693/-12 (`git diff --stat HEAD^ HEAD`). Changed files:

- `src/app/(app)/pharmacy/inventory/page.tsx` — blob `802a1bf1651abd02847accbc8de18bc742785b93`.
- `src/components/pharmacy/medicine-pack-setup.procedure.test.ts` — blob `c68a0e982eeb9b9513282fc85427e6636328ee38`.
- `src/components/pharmacy/medicine-pack-setup.test.tsx` — blob `0e1e4a4802e40514d65edbc50cfcc73664501e11`.
- `src/components/pharmacy/medicine-pack-setup.tsx` — blob `d776f9f2e08d7dcd08d17af68d7f32d48c914876`.
- `src/components/pharmacy/medicine-reference-workbench.tsx` — blob `b6a0ea3ae32588115adcc808d0b2f1dee9fa2a75`.
- `src/lib/pharmacy/onboarding-checklist.test.ts` — blob `457e7077cedb13f566b0558e17e43e0a4a241bc0`.
- `src/lib/pharmacy/onboarding-checklist.ts` — blob `b8d8555d82247946e5e25f5f68cd8785624c1415`.
- `src/lib/vertical-catalog.ts` — blob `4281bcf7fb0b98e0624baf2ace14dce1a090209c`.

Before: no frontend createPackLevel caller; catalog/opening-stock checklist destinations null; inventory empty state had no setup/receiving actions. After: existing workbench mounts explicit medicine/presentation/pack form, PLAT-03 links reach medicines/receiving/suppliers, six-row checklist returns to canonical `/pharmacy`, inventory links expose setup and receiving. No dedicated first-sale spec added.

## Independently executed checks

Commands below run in exact candidate archive unless stated. Full logs and Vitest JSON retained adjacent to this report.

1. `./node_modules/.bin/vitest run src/components/pharmacy/medicine-pack-setup.test.tsx src/components/pharmacy/medicine-pack-setup.procedure.test.ts src/lib/pharmacy/onboarding-checklist.test.ts src/lib/vertical-catalog.test.ts src/lib/onboarding/setup-evaluator.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=$PAPERCLIP_RUN_SCRATCH_DIR/combined.json`: exit 0; **5 files, 79 passed, 0 failed, 0 pending/skipped, 0 todo**, 3.46s. Counts respectively **9/6/9/51/4**. This is a combined current run, not the builder's mixed-run sum. Three React warnings in the existing success test: `An update to MedicinePackSetup inside a test was not wrapped in act(...).` No test edits made.
2. `./node_modules/.bin/eslint <all eight paths above>`: exit 0, no diagnostics. `./node_modules/.bin/prettier --check <all eight paths above>`: exit 0, all matched. Source `git diff --check HEAD^ HEAD`: exit 0, no output.
3. Parent and candidate each: `./node_modules/.bin/prisma generate`: exit 0, Prisma 7.9.1 output only to each owned archive's `src/generated/prisma`.
4. Parent and candidate each: `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --incremental false`: **both exit 0, 0 diagnostics; actual candidate-minus-parent delta 0**. Logs empty. Typechecks completed before independent probe files were added. No ignore/suppression flags or configuration edits.
5. `./node_modules/.bin/vitest run tests/qa-wha1223/ui.test.tsx tests/qa-wha1223/procedure.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=$PAPERCLIP_RUN_SCRATCH_DIR/adversarial.json`: exit 0; **2 files, 10 passed, 0 failed/pending/skipped/todo**, 1.41s. Four UI probes: medicine switch clears old presentation; refetched detail cannot submit a removed presentation; whitespace-equivalent search refetches and clears selections; failed detail refresh preserves values and blocks submission with retry. Six procedure probes: NaN, infinity, unsafe integer, invalid date, foreign-parent presentation, unauthenticated caller all denied before persistence. Probe files retained under adversarial-probes; copy to `tests/qa-wha1223` in a fresh review archive for reproduction. Mock fixture scaffolding reused from candidate tests; assertions independently authored. Product files and original tests unchanged.

## Controlled TypeScript environment

Read-only dependency source: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/WHA-1376-verify-ph-growth-independently-verify-gross-margin-comparison-addf0323`, HEAD exactly parent. Own node_modules directories contain links to installed dependency entries, excluding shared `.vite`, `.vite-temp`, `.cache`; generated output and tool cache directories stay in scratch. No package install, shared copy, repair, generation, build or service.

Candidate, parent and dependency-owner files share SHA256:

- package.json: `e8088e73bb1e48cf95f7b0d510b67fe1387cbad2431df904fa2c5fe1318b3722`
- bun.lock: `a879bb6bb776a37e36c1e28bb4b36fea79ce3aec700847c2073007069553d38b`
- tsconfig.json: `fe18cad2b63960649a2dca17419d25ef3753dae5bf435f07ebf702d0b6ed89dc`
- prisma/schema.prisma: `ea8f40a29b95fcba8abfe7a41344402765f1efde5fff9e60f8faccb6a28608a5`
- prisma.config.ts: `1a3320a9913d9161d35b37415b3bc6e99b70714d195a035546bd443c854c4285`

Installed relevant versions match lock entries: Next 16.2.12, Vitest 4.1.10, TypeScript 5.9.3, Prisma and @prisma/client 7.9.1, exceljs 4.4.0. Node v22.23.1. Both generated Prisma trees hash `5d1464c087e8fe65ca1790a6908618ce11e4eb663f077cca1fcc76bfa99ad4af` (sorted relative paths plus file bytes).

Both archives equally lack untracked `next-env.d.ts` and `.next/types`; no Next build/type generation was run or borrowed. These are clean-archive source typechecks with matching Prisma clients, not full generated Next route/build acceptance. Existing tsconfig exclusions and skipLibCheck were unchanged.

Builder's reported 450 diagnostics/48 mentioning legacy touched files were NOT copied as a baseline. Its current installed exceljs package is absent and generated PharmacyTemperatureLog model is absent; both present in controlled scratch. Builder models.ts hash differs from generated current schema. This supports dependency/generated-client mismatch for the quoted examples, without claiming individual attribution for all 450 diagnostics. Corrected environment independently measures 0/0; no pre-existing-source-error claim required.

## Source trace and guard assessment

- MedicineReferenceWorkbench mounts MedicinePackSetup after reviewed publication. Component uses existing namespaced pharmacyMedicine.search/get/createPackLevel. Search/get require saleable medicines (`pharmacy-medicine.ts:525,717`); labels expose product, brand, strength/manufacturer and dosage/presentation rather than requiring raw IDs. Selection resets on medicine/search change; submit requires selected presentation in fetched medicine. Identical trimmed query explicitly refetches.
- Explicit root packs count individual units directly. Safe positive integer validation and UNIT=1 frontend constraint; required effective date serialized at midnight UTC; existing Zod schema requires integer-positive quantity and valid Date. Mutation supplies no parent, price, stock or inferred pack. Existing server UNIT semantics were not changed or certified beyond existing schema. Only one packLevel.create occurs (`pharmacy-medicine.ts:540-569`), no inventory/price writes.
- Existing createPackLevel checks presentation through scoped DB and optional parent ownership. Protected middleware authenticates active session and namespaced pharmacy-core entitlement (`trpc.ts:174-195,229`; module-catalog.ts:212). createTRPCContext constructs tenant DB; scoped-db sets organization/user context in transactions. These are server controls, not frontend authorization. In-memory denials exercise routing/schema; actual PostgreSQL/RLS remains unrun.
- Success invalidates medicine detail and purchasing workspace. Existing purchasingWorkspace queries saleable medicines in organization and presentation.packLevels (`purchasing-console.ts:265-352`), applies packConversions and current effective interval, then receiving's packOptions exposes readable medicine/pack/conversion (`receiving/page.tsx:748-754,1182-1195`). Component and procedure tests establish effective/future availability with actual conversion/workspace functions and in-memory delegates. Not browser cache-navigation proof.
- `/pharmacy` renders existing PharmacyOnboardingConsole; existing row renderer consumes guidance href. Medicines route exists, requires ADMIN and pharmacy-core; suppliers/receiving exist and require pharmacy-procurement plus authenticated tenant context. Receiving still requires branch prerequisites. Eligibility is conditional on existing entitlements; links do not grant access. ONBOARDING lifecycle remains accessible (`tenancy/host.ts:57-58`). No duplicate checklist, role, capability, router, schema, RLS or activation change in delta.
- Publication still admin-only and rejects unreviewed assertions (`pharmacy-medicine.ts:892-911`). Order approval still uses actual session approver and rejects creator/requester (`pharmacy-purchasing.ts:605`; purchasing.ts:133). Receiving bypass rejects receiver self-approval (`receiving.ts:159`; router call at 804); workspace excludes current actor from approver choices. Controls unchanged; no real second-person execution claimed.

## Studio and remaining gates

Full Studio contract read, plus installed Next use-client and App Router Vitest guides. Applied Studio/security/frontend quality gate constraints to this bounded review. New form reuses SectionCard, Button/buttonVariants, semantic text/surface/border/focus tokens, labeled native controls, minimum 44px form controls and responsive grid. Static/component states covered; visual quality not certified.

UNRUN: SuperAdmin creates fresh organization; admin ONBOARDING setup with actual second person; reviewed catalog/pack/receiving; activation LAST; first sale; no-4xx/raw-ID assertions and click/time measurements. Studio 375/768/1024/1440, light/dark, reduced motion, keyboard, overflow, states, console/hydration, screenshots/axe/performance remain unrun. No full build, DB/SQL/seed/migration, browser/local/staging app or old suite replay, fixtures bypassing setup, live tenant/device data, nested agents/Codex, push/merge/deploy.

Graph, Claude-Mem and Ponytail tools unavailable in exposed session; no graph indexing possible. rg unavailable (FileNotFoundError); exact-path Python reads used. Current harness CLI session used; no nested Codex launch per task prohibition. No claim that unavailable tools/profile settings were activated.

Disposition: bounded independent review complete; WHA-1223 done. Original WHA-1203 Product Engineer owns remaining journey work; Chief of Staff/supervisor owns routing an authorized exact-candidate environment for later journey/Studio evidence. No new issue or automatic further-review dispatch. No new product defect to post to GitHub97. Historical artifacts and source preserved; no product rollback necessary from QA activity.
