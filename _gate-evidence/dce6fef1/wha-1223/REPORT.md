# WHA-1223 — invitation and authored first-sale review

2026-09-06; run a8ff68d4-1d23-4649-b07d-377e35cf6926. Independent read-only QA.

**Invitation code: PASS (static/component scope). Authored first-sale journey: FAIL. Safe collection: PASS, one test collected, zero executed. Full journey/Studio acceptance: UNRUN.**

## Exact source and preservation

Invitation `98bc27736c9600f698d716252627b0835d484fca`, parent `0e6ba8911b3d1c41f64875ba644097ef3bbf6ed6`. Authored test `dce6fef1407a9211aa8801cc8ab0c115c40107a7`, parent invitation SHA. Both parents independently verified.

Native source `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.paperclip/worktrees/WHA-1203-wha-1195a-build-first-run-checklist-and-first-sale-scenario`, branch `codex/WHA-1203-pharmacy-fresh-first-sale`; common Git repo `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.git`. Initial/final source clean at dce6fef1. Exported **pinned full dce6 SHA** using git archive into `$PAPERCLIP_RUN_SCRATCH_DIR/candidate`, no moving HEAD/overlays. Review workspace `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1223-gate-candidate-b20b577f-browser-suite-wha-1132-contract-on-the-runner-with-the-working-postgresql-path-self-cho` retains original branch and HEAD `b20b577f9d397855458cbef15ea8d178870d85a3`; tracked source unchanged, only review evidence untracked. Original 8b107092 and all prior reports preserved. No source writes, install, shared generation, composition, commit, fetch/reset/rebuild/switch or owner service use.

Exact cumulative scope: six files +982/-219. Each exported file rehashed after checks against pinned Git blob:

- `src/app/(app)/team/team-content.departments.test.ts` — `f0b58335aa7d4529507415c058c92728cbc1c0fe`.
- `src/app/(app)/team/team-content.test.tsx` — `ebf22daa4be5ef5627a7c25953dc6f45759ad8fc`.
- `src/app/(app)/team/team-content.tsx` — `89161e4b47b1c9187d216d8ef74016337523db7e`.
- `tests/e2e/fixtures/pharmacy-first-sale.ts` — `bd53c0c8e6317b991ec078890223d13a54cba93d`.
- `tests/e2e/time-to-first-sale.config.ts` — `d4cff388ab9a9bc4d588be143a166c4b200891d1`.
- `tests/e2e/time-to-first-sale.spec.ts` — `50b3f1b945a7efa2227d43d8fb8f2f300adae3d4`.

Full diff, whitespace-insensitive product diff and identity.json attached. Semantic product changes: export modal for tests; remove fixed six-department list/default Engineering; query existing tenant department read; active-option filtering; explicit blank choice; selected-option eligibility/fetch/error/pending guards; readable names, status, retry, stale feedback and disabled submission. Role choices, payload fields other than department selection, success/error handling and other team functions preserved; bulk modal churn is indentation/wrapping. No router/schema/permission/stock/money file changed.

Restaurant function from `async function restaurantFirstSale` through its end is **3039 bytes unchanged**, SHA256 `8efa75fa3116d2fc4992091bd0c99746217f5ec9855f8db2eb8e936dab698ae7`. Pack component, navigation checklist, full Studio contract blobs equal accepted base. No prior pack79+10, navigation11 or controlled0/0 rerun.

## Finding — P1 authored-test blocker

`tests/e2e/fixtures/pharmacy-first-sale.ts:250` uses exact accessible link name containing only supplied linkLabel. Real shared renderer `src/components/onboarding/readiness-checklist.tsx:100-106` appends an accessible screen-reader suffix `— {row.label}`. First call at helper line311 supplies `Create or review stock locations`; actual link includes `— Branches and locations`. Exact role/name lookup matches zero links. This stops the first setup link after organization creation; all later follow calls repeat this mismatch.

Independent DOM reproduction renders the actual shared ReadinessChecklistItem: exact short-name query returns null, suffix-inclusive query resolves `/pharmacy/inventory`. This is source/component evidence, **not browser reproduction**. Initial probe's positive-control expectation inserted a space before the dash; jsdom accessible-name output omits that space (`Create or review stock locations— Branches and locations`). The short-name negative assertion already passed. Corrected only the QA positive-control whitespace matcher; final probe passed. Initial log retained, no product/test artifact corrected.

Required implementer action: make helper match the real accessible name or precise row-scoped destination with readable-label assertion; retain accessibility suffix; add focused renderer-backed regression. Original WHA-1203 Product Engineer owns correction, supervisor routes it. Finding posted to existing GitHub97 first; no new issue or builder acknowledgment wake. Source-selected runtime environment cannot repair this locator.

## Independently executed checks

Existing matching dependencies linked read-only from `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/WHA-1376-verify-ph-growth-independently-verify-gross-margin-comparison-addf0323`. Candidate package.json, bun.lock, Prisma schema and tsconfig SHA256 equality asserted with dependency owner. Versions remain Next16.2.12, Prisma7.9.1, Vitest4.1.10, TypeScript5.9.3. Own node_modules links exclude shared .vite/.vite-temp/.cache. No dependency installation or shared generation.

1. `./node_modules/.bin/prisma generate` — exit0, own src/generated/prisma only, 1.58s; no DB/service.
2. `./node_modules/.bin/vitest run 'src/app/(app)/team/team-content.test.tsx' 'src/app/(app)/team/team-content.departments.test.ts' --maxWorkers=1 --reporter=default --reporter=json --outputFile=$PAPERCLIP_RUN_SCRATCH_DIR/team.json` — exit0, **2 files, 12/12, zero failed/skipped/pending/todo**, 2.10s. Eight component cases, four read-procedure cases.
3. `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.review.json` — exit0, zero diagnostics. Own config extends unchanged repo config; six files, next-env entry, vitest.setup and src/types declarations plus transitive imports. No suppression; no full-project/generated Next-route/build claim. Completed before QA probes added.
4. `./node_modules/.bin/eslint --max-warnings=0 <six exact paths above>` — exit0, zero warnings/errors. `./node_modules/.bin/prettier --check <six paths>` — exit0, six matched. `git diff --check 0e6ba8911b3d1c41f64875ba644097ef3bbf6ed6 dce6fef1407a9211aa8801cc8ab0c115c40107a7` — exit0.
5. `PHARMACY_E2E=1 ./node_modules/.bin/playwright test --config tests/e2e/time-to-first-sale.config.ts --list` — exit0, **1 test in 1 file collected, 0 executed**. Inspected config and full imported Restaurant helpers first: no webServer/globalSetup, module-level DB/service/network start; pg connection code only inside uncalled function. Pharmacy input reads occur inside unexecuted helper. No browser launched.
6. `vitest run tests/qa-wha1223 --maxWorkers=1` (default/json reporters) — initial exit1, pending-invite probe passes, link-name positive-control probe fails on QA whitespace assumption described above. Then **only** corrected QA name probe run: exit0, 1/1. Two distinct probes ultimately pass: pending duplicate submission refused with values preserved; real accessible name disproves authored locator. Original tests immutable; probes/logs retained.

Full builder comment `6637fecf-d615-4c09-bd29-7d32f019b413` read. Its historical attempts remain builder-reported: initial invalid Testing Library option, omitted NextAuth augmentation/config includes, four unused warnings; one correction pass then types/lint clean. These are not independently reproduced product/full-build failures. Reviewer focused checks passed first attempt. Prior builder navigation zero-test collection failure remains in preserved prior report.

## Invitation boundaries and consumers

One production invite caller: AddMemberModal's inviteMember.useMutation (`team-content.tsx:243`), mounted by TeamContent (`161`). Existing department read (`organization-admin.ts:36-48`) obtains tenant from session and explicitly scopes organizationId; it returns both active/inactive rows. **Active filtering occurs in the new UI**, not in the read endpoint. Existing invite write (`team.ts:106-129`) independently requires active department key through tenant-scoped DB. It retains seat-limit and duplicate-account checks.

Both procedures use existing adminProcedure. Real `requireCapability` checks session usability and can(admin:access) (`trpc.ts:203-224,248-251`); actual policy permits ADMIN (`abac/policies.ts:80,91`). Context constructs scoped DB, tenant-actor binds session organization, scoped-db sets current organization/user transaction context. team module remains HR. These real boundaries were inspected; four mocked capability tests are not DB/RLS proof. No new endpoint/capability or frontend-only authorization assumption.

UI presents tenant names and submits keys; default blank prevents accidental choice. Missing/fetching/error/empty/stale/inactive/pending data block submission; retry and server errors preserve values. Probe fills missing pending case. Pharmacy/Restaurant/Agency explicit selections pass; active custom tenant departments replace fixed Agency vocabulary intentionally. No new role options or Restaurant flow changes. Full visual states remain unverified in browser.

## Authored flow and runtime limits

Source flow intends unique organization creation while ONBOARDING, canonical checklist, stock-location form, regulatory supplied evidence, synthetic CSV upload/review/publication, explicit pack, supplier/licence, real invite token acceptance with phone in separate browser context, owner's order submission and colleague approval/send, receipt posting, supplied attestations, shared deployment selection if needed, activation last, counter payment/receipt. Actual source inspected for shared checklist, regulatory labels/default premises address/city, workbench upload/review/publication buttons, invitation modal/server, order form/selectors and segregation UI, receiving, and counter entry. Locator finding blocks acceptance of authored flow; safe collection is not proof remaining selectors execute.

Own-order denial assertion is UI copy plus absence of Approve (`orders/page.tsx:1122-1127`), not a real forbidden mutation. Existing server self-approval guard remains unchanged; no fabricated approver or direct bypass request. Therefore no expected4xx exception is needed, and no broad response ignore exists: observers collect all4xx across owner/platform/colleague. No API/domain/SQL seeds in Pharmacy helper, conditional skip or borrowed tenant. Conditional shared-deployment button is an existing UI action, not skip. Restaurant-only seeded helpers remain uncalled in Pharmacy mode.

Input loader requires nonempty fields/evidence references, schedule list, readable licence file, ISOLATED_SHARED_STAGING marker, equal40hex source/deployed strings, separate explicit HTTPS nonlocal origins, and platform credentials before organization writes. No default app URL. Actual supplied authorization, licence/qualified-person/jurisdiction/source/shared-host evidence and compatible package/invite/upload infrastructure remain operator/runtime responsibilities. **Equal operator-supplied SHAs do not automatically attest deployed revision or pin to this reviewed commit.** Report this boundary before later execution. Supplied evidence truthfulness is not certified by string validation. No actual inputs or credentials used here.

No-raw-ID helper checks visible editable input names/labels at navigational checkpoints, allows opaque select values, and is not exhaustive proof of every transient form. Click/time annotations only occur on actual completed execution; counts/time not claimed. Full browser flow, actual second person, activation/first sale, no4xx/raw-ID runtime acceptance and Studio375/768/1024/1440 light/dark/reduced-motion/keyboard/overflow/states/console matrix remain UNRUN. No DB/RLS, build, migration, seed, staging, physical device, app/service or owner3218/3217 use.

Previously read full Studio and installed Next use-client/Link/Vitest guides remain applicable; Studio blob independently unchanged. Existing shared UI grammar retained. Graph/Claude-Mem/Ponytail unavailable; rg previously unavailable; exact-path reads and focused reference searches used. No nested session, global config or human approvals.

## Disposition

Consolidated review complete with invitation PASS and authored-test FAIL; WHA-1223 done as completed review, not full onboarding acceptance. WHA-1203 Product Engineer owns locator correction; supervisor routes bounded recheck/runtime separately. No automatic further-review dispatch. QA made no product fixes; only owned report/probe/cache artifacts need preservation, no product rollback required.
