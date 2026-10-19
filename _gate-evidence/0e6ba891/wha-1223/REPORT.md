# WHA-1223: navigation-only 0e6ba891 review

**PASS — navigation artifact only. Full onboarding, first sale, and Studio/browser acceptance remain UNRUN.**

Reviewed 2026-09-06, run 11f7e81a-5b6d-4b61-ae68-31b8c9a094ff. No new product defect established. Original WHA-1203 owns the separately reported staff-invite correction; it is outside this review. No acknowledgment wake or follow-up issue created.

## Identity and read-only scope

Pinned candidate `0e6ba8911b3d1c41f64875ba644097ef3bbf6ed6`, exact parent `a756a1efd157d1f005239eed322734998b2397ff`. Source `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.paperclip/worktrees/WHA-1203-wha-1195a-build-first-run-checklist-and-first-sale-scenario`, native branch `codex/WHA-1203-pharmacy-fresh-first-sale`, Git common repo `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.git`. Initial source HEAD was pinned candidate and status empty; final observation in identity.json. Source may advance for another builder; review archive came from **git archive 0e6ba8911b3d1c41f64875ba644097ef3bbf6ed6**, never moving HEAD or overlaying source files. No source writes/generation/install or branch operations.

Reviewer cwd `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1223-gate-candidate-b20b577f-browser-suite-wha-1132-contract-on-the-runner-with-the-working-postgresql-path-self-cho`, native branch unchanged; HEAD remains `b20b577f9d397855458cbef15ea8d178870d85a3`. Tracked files clean; untracked _gate-evidence contains accepted prior reports and this new report. No reset, checkout rebuild, switch, commit, fetch, push, merge or deployment. Original 8b107092 and prior a756/b20 reports untouched.

Exact diff is two files, +39/-4:

- `src/lib/pharmacy/onboarding-checklist.test.ts`: parent blob `457e7077cedb13f566b0558e17e43e0a4a241bc0`; candidate/archive blob `5378a1e4dc9406ca8a506c860e722d3068a935ef`.
- `src/lib/pharmacy/onboarding-checklist.ts`: parent blob `b8d8555d82247946e5e25f5f68cd8785624c1415`; candidate/archive blob `41c1c8c0555d602a3b5c8bad4a39a9498d0e054a`.

Both archive blobs rehashed after checks and match pinned Git objects. Full diff and identity.json retained. Product delta changes only href/linkLabel for BRANCHES_AND_LOCATIONS and READINESS_AND_PARALLEL_RUN; test delta adds 35 lines. No new first-sale spec.

## Independent checks

Commands run inside owned `$PAPERCLIP_RUN_SCRATCH_DIR/navigation-candidate`. Logs, commands.json, checklist.json and focused config retained beside this report.

- `./node_modules/.bin/prisma generate`: exit 0, client 7.9.1 generated only into own archive src/generated/prisma. No DB connection/migration.
- `./node_modules/.bin/vitest run src/lib/pharmacy/onboarding-checklist.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=$PAPERCLIP_RUN_SCRATCH_DIR/checklist.json`: exit 0, **1 file, 11 passed, 0 failed/skipped/pending/todo**, 1.31s. No warning/error output.
- `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.navigation.json`: exit 0, 0 diagnostics. Config extends unchanged repository config and includes the two touched files with imported dependencies. This is focused checking, not a full-project/Next-generated-route build or repeated parent comparison. No suppression added.
- `./node_modules/.bin/eslint src/lib/pharmacy/onboarding-checklist.ts src/lib/pharmacy/onboarding-checklist.test.ts`: exit 0, 0 diagnostics.
- `./node_modules/.bin/prettier --check src/lib/pharmacy/onboarding-checklist.ts src/lib/pharmacy/onboarding-checklist.test.ts`: exit 0, both matched; no formatting writes.
- Source `git diff --check a756a1efd157d1f005239eed322734998b2397ff 0e6ba8911b3d1c41f64875ba644097ef3bbf6ed6`: exit 0.

No additional suite warranted: the 11 tests cover pending/done branch attestation, pending counter evidence, derived gates and activation semantics; actual consumers/destinations were inspected. Prior 79+10 pack baseline and controlled 0/0 comparison were NOT rerun or attributed to this artifact.

Dependency provenance: same read-only installed packages from `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/WHA-1376-verify-ph-growth-independently-verify-gross-margin-comparison-addf0323`. Candidate and dependency-owner SHA256 equality independently asserted for package.json (`e8088e73bb1e48cf95f7b0d510b67fe1387cbad2431df904fa2c5fe1318b3722`), bun.lock (`a879bb6bb776a37e36c1e28bb4b36fea79ce3aec700847c2073007069553d38b`), schema (`ea8f40a29b95fcba8abfe7a41344402765f1efde5fff9e60f8faccb6a28608a5`), tsconfig (`fe18cad2b63960649a2dca17419d25ef3753dae5bf435f07ebf702d0b6ed89dc`). Own node_modules links exclude shared .vite/.vite-temp/.cache; all cache/generation writes confined to scratch. No install or owner app use.

Builder comment `90648614-5f2c-4edd-bfb9-e7efe3d1d893` read in full. It reports initial Vitest exit 1, failed suite with **zero collected tests**, from missing scratch `@/generated/prisma/client`; own-scratch Prisma generation then final 11/11 exit 0. That initial failure is retained as builder-reported evidence, not concealed or counted as passing. Reviewer generated required scratch client before its single test run. Referenced builder GitHub evidence: https://github.com/WhatTheStack1/devfathom-commercial/issues/97#issuecomment-5559595409.

## Consumers, destinations, and preserved controls

All production references to checklist exports traced: pharmacy-onboarding router readOverview evaluates readiness, builds checklist and activation summary (`pharmacy-onboarding.ts:105-127`); canonical `/pharmacy` passes overview to PharmacyOnboardingConsole (`page.tsx:50`). Console maps href/label into shared ReadinessChecklist (`onboarding-console.tsx:75-83,235-240`) and separately renders blocking-list links (`199-219`). Shared renderer uses ordinary Next Link and retains the separate attestation action (`readiness-checklist.tsx:100-109`). Neither link calls recordGate or an activation mutation. Other references found were definitions/tests; no second checklist introduced.

BRANCHES_AND_LOCATIONS label **Create or review stock locations** honestly targets `/pharmacy/inventory`: existing Locations list and labeled creation form (`inventory/page.tsx:490-560`), server action calling existing createLocation (`246-258`), existing protected procedure (`pharmacy-inventory.ts:189-229`). Branch ID is resolved from active tenant branches/hidden field; users enter location name/code, not a raw branch ID. Eligibility requires existing pharmacy-inventory entitlement, authenticated tenant and active branch (`page.tsx:91-138`). No active branch yields existing prerequisite state: link is not a promise to create branches or bypass their setup.

READINESS_AND_PARALLEL_RUN label **Open pharmacy counter** honestly targets existing `/pharmacy/counter`, which renders PharmacyCounterConsole (`counter/page.tsx:7-14`). Console reads names via pharmacySales.counterBranches and chooses/permits selection of active branches (`counter-console.tsx:124-131`); namespaced protected procedure reads active branches for current organization (`pharmacy-sales.ts:567-581`), governed by pharmacy-counter entitlement (`module-catalog.ts:228`). Existing unavailable/no-branch states remain (`counter-console.tsx:745-779`). Opening the counter neither records a parallel-run result nor certifies a sale.

Setup eligibility is conditional on those existing modules/prerequisites. Tenant lifecycle allows ONBOARDING (`tenancy/host.ts:57-58`); these link additions impose no activation requirement and grant no access. Gate state/blocksActivation/attestable derive from evaluated gate status, while ready remains readiness.ready (`onboarding-checklist.ts:155-200`). Existing admin-only recordGate separately requires evidenceRef and refuses evidence-backed gates (`pharmacy-onboarding.ts:178-200`). Four string changes cannot auto-attest or relax activation; no evaluator, role, schema, router or policy change.

## Limits and disposition

Full pinned Studio contract read; installed Next 16.2.12 Link reference (href/navigation) consulted. Existing shared semantic link styling and focus grammar reused; no shell/style change. Earlier applicable bounded/evidence/source-of-truth skills remain applied. Graph/Claude-Mem/Ponytail unavailable; rg previously established unavailable; focused Python symbol/reference reads used. No claim unavailable tools were activated; no nested session launched.

UNRUN: actual fresh organization creation, actual second person, activation-last, first sale, no-4xx/raw-ID runtime assertions, click/time, full Studio viewports/themes/reduced-motion/keyboard/overflow/states/console matrix. No app/browser/DB/services/migrations/seeds/staging/physical tests, broad suites, full build, owner3218/3217 usage or live data. No QA product edits or new independent probe files.

Bounded navigation review complete; WHA-1223 done. Full onboarding remains incomplete and separately owned by WHA-1203 Product Engineer/supervisor. No new defect to send to GitHub97. Stop after evidence; no automatic further-review dispatch.
