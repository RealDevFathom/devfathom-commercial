# DevFathom delivery status

Last reconciled: 2026-09-04 10:50 PKT (05:50 UTC) — Claude (Cowork supervisor) handing over to Codex.
Everything below the "Handoff" section is the 2026-09-02 checkpoint, kept for history.

## HANDOFF 2026-09-04 — read this first (for the Codex supervisor / owner)

### Where things are
- **06:50 UTC 4 Sep: Codex usage limit hit at 06:18 and reset by the owner at 06:49.** Errors cleared,
  the four in-flight lanes re-fired (WHA-1286 19th heading route on the tip, WHA-1292 axe check of
  WHA-1285's f553515b, WHA-1243 `QA PERF 2026-09-04` on staging in SHARED mode, WHA-1288 select names).
  Chief of Staff stays paused (it only creates "Review productivity" issues and burns Codex tokens).
- **Candidate:** the tip of this branch (`2311714b` + this status commit; clean). Everything composed
  today is in it: WHA-1301 administrator guide for recipes/costing/catering/reports (08:25), WHA-1297
  catering console + nav (08:15), WHA-1295 wastage / stock-movement reports (08:15; two indexes via
  migration `20260904123700_restaurant_stock_report_indexes`), WHA-1296 recipe cost / cost per portion / food-cost % in the catalog console (08:00),
  WHA-1288 labelled platform selects (08:00, rebased), WHA-1294 catering phase 2 (07:50; productionRequirements, costSummary with cost-per-portion
  snapshot on CONFIRMED, RECIPE_CONSUMPTION on IN_PRODUCTION→READY, reversal on cancel), WHA-1293 recipe explosion + costing library (07:50; `src/lib/restaurant/recipe-costing.ts`,
  ledger consumption now routed through it, getRecipeCost/listRecipeCosts), WHA-1294 catering phase 1
  (07:50; models + migration `20260904133000_restaurant_catering_orders`, `restaurant-catering` router,
  state machine, 6/6 tests; phase 2 = production requirements, cost summary, consumption), WHA-1270 DEDICATED-provisioning guard (07:40; Fixes #61 — the staging provisioning
  failure QA hit), WHA-1286 heading hierarchy on all 19 routes (07:25), WHA-1239 Playwright regression specs
  (06:08; first run in the cloud gate), a11y fixes WHA-1287/1289/1290/1291 (05:56), WHA-1271 (server-side platform-session
  validation on /platform/login), WHA-1273 (idempotent `prepare-runtime-role`), the two infra fixes from the first staging deploy (pg_trgm allow-list, Azure-safe
  `prepare-runtime-role`), Key Vault as the single source of truth for seed/admin/platform-admin
  passwords (WHA-1265), the SuperAdmin login-limiter fix, per-tender refunds (WHA-333), device-branch
  enforcement (WHA-461), Promotions A2 (WHA-281), three back-office UX fixes (WHA-1267/1268/1269),
  the GitHub Actions QA gate (`.github/workflows/qa.yml`, WHA-1247), and the complete pharmacy P0
  (67/67: dispensing UI, owner command centre + report catalog, OFF-04 safety lease, OFF-05 scenarios,
  INV-05 cold chain, CRM/loyalty P0-lite, FIN-05 fiscal contract with a sandbox integrator, RPT-03
  owner digest, MED-06 reference-data connectors). Owner decisions D02/D04/D10 were defaulted the safe
  way: pluggable interfaces, sandbox/capture modes, no real provider, no fabricated fiscal references.
- **Staging** runs candidate `6cc482c8` (revision `devfathom-stg--dbrepair0904`, healthy). Known
  degradations until the next deploy: platform login limiter 8 attempts / 15 min per IP+e-mail (the
  candidate resets it after a successful login); the platform-admin password hash is stale (the
  first deploy regenerated job secrets while Key Vault kept the Aug 2 values — the live values are
  the migration job's secrets: `az containerapp job secret list … --show-values`); DEDICATED
  provisioning mode fails without Vercel settings — use SHARED mode.
- **`origin/restaurantv2` = `6cc482c8`.** The owner has a push-only prompt (fast-forward to
  `8a522bd8`) and a second-deploy prompt (`DevFathom hub/deploy-staging-8a522bd8-prompt.md`, which
  includes the push, the deploy, and a fallback for `ALTER ROLE` being refused on the hand-created
  runtime role). The push starts the cloud gate automatically. `main` and production: untouched,
  not authorized.
- **Open engineering lanes (base = branch tip):** WHA-1270 (guard DEDICATED provisioning mode when
  Vercel is unconfigured — COMPOSED, not yet on staging), WHA-1239 (feature inventory + any spec fixes the cloud gate asks for), WHA-1281 (cold-load
  investigation covering QA findings 1277–1284: probably scale-to-zero cold start on the 0.5-CPU
  staging plan — if infra, close them and propose minReplicas/CPU to the owner; 1281/1280 are parked
  until QA8 provisions `QA PERF 2026-09-04` on staging in SHARED mode, WHA-1243), a11y fixes
  WHA-1285 (dark-theme contrast, commit f553515b under verification in WHA-1292 — f553515b FAILED 4 platform nodes, fix in progress), 1288 composed (bbe9d718); WHA-1284's
  perf refactor (2e7de87d stream SOP report cold path, 58aea51b defer deployment forms) is NOT composed —
  accept only with warm-load numbers and test evidence, rebased on the tip.
  New lanes use the branch tip as their base; keep ≤5 heavy runs on the Mac.
- **Restaurant completion — costing & catering (owner direction 07:10 UTC 4 Sep: "complete restaurants
  first including catering; use the Codex army to the full").** Gap analysis against the client brief:
  built = multi-branch, recipes with units/conversions, stock ledger with RECIPE_CONSUMPTION and
  WASTAGE/SPOILAGE/STAFF_MEAL, purchasing, overview/payments/inventory/purchasing/workforce/SOP reports;
  missing = recipe-cost rollup, food-cost/profitability/wastage reports, catering. Lanes (all `high`,
  base = branch tip, one commit each, supervisor composes):
  WHA-1293 A recipe costing + explosion library (`src/lib/restaurant/recipe-costing.ts`:
  `explodeRecipe`, `computeRecipeCost`; extracts the ledger's explosion; tRPC getRecipeCost/listRecipeCosts)
  — COMPOSED 1aa4f429; WHA-1294 D1 catering server (models RestaurantCateringOrder/Line/
  ExtraCost/Delivery/Event + one migration, `restaurant-catering` router, state machine, production
  requirements via explodeRecipe, cost summary, RECIPE_CONSUMPTION on IN_PRODUCTION→READY) — phase 1
  COMPOSED 8f079c9b, phase 2 COMPOSED; WHA-1295 C1 wastage + stock-movement reports — COMPOSED ee2f031b; backlog until their dependency is on the tip: WHA-1296 B recipe cost / food-cost %
  in the catalog UI — COMPOSED 4a661588; WHA-1297 E catering console UI — COMPOSED 12e9cf6c; WHA-1298 C2 food-cost, dish-profitability (menu-engineering quadrants) and catering
  reports — Reports Engineer, PROMOTED 08:15 (base = tip). Follow-ups opened 08:15: docs lane for the
  Documentation Engineer (recipes & costing, catering, wastage/food-cost reports) and a catering
  end-to-end Playwright spec for QA Engineer 4. Promote a backlog lane to `todo` only when its
  dependency is composed AND heavy runs ≤ 7. Not in scope yet (owner said restaurants first): hotel
  bookings/guest journey, online payment gateways (providers are MOCK/TERMINAL only).
- **Compose-procedure lessons (07:40):** after `apply --cached --3way` check
  `git diff --cached --name-only --diff-filter=U` — any unmerged path means abort (`git reset -q`) and
  ask the lane to rebase; `git show ":path"` on an unmerged path fails and the redirect leaves an EMPTY
  file. Never run `git checkout -- .` from the device VM (unlink is refused on the mount) — restore a
  file with `git show HEAD:path > path` instead. Agents sometimes base on `origin/restaurantv2`
  (6cc482c8) or on the shared a11y branch: compose single commits and verify the diff is new.
- **Paperclip note:** when a run is killed (usage limit, recovery backstop) Paperclip escalates the
  issue to the agent's manager (Chief of Staff, paused) — reassign it back to the engineer; the
  reassignment also wakes the agent.
- **QA team** (Codex QA Engineers 1–9, lanes WHA-1235/1236/1238/1240/1241/1242/1243/1260/1239) tests
  STAGING ONLY in their own `QA <AREA> 2026-09-04` organizations; never the owner's org "Mugd" /
  LakeCity; GitHub issue first (`WhatTheStack1/devfathom-commercial`, labels qa, restaurant|pharmacy,
  S1–S4), then a Paperclip `QA-<AREA>: …` mirror with the URL on line 1. QA engineers never change
  product code and never deploy. Every QA issue is assigned to an idle Codex builder at the next
  check-in with the standard fix contract (reproduce on staging, smallest root-cause fix, focused
  test, tsc 8 GiB + touched vitest + Prettier/ESLint + `git diff --check`, `Fixes #<n>`, no push).

### Rules that must survive the handoff
- Owner constraints: never push/merge/deploy without explicit owner authorization (only
  `restaurantv2` pushes and owner-run staging deploys have been authorized; each staging deploy is
  authorized separately); never touch `main` or production; no over-engineering; never delete or skip
  tests, never relax RLS, never weaken the seed guard in `scripts/restaurant-e2e-database.ts`, never
  grant CREATEROLE/SUPERUSER/BYPASSRLS to the runtime role; no third try on the same failure path.
- Agents NEVER deploy, push, merge, or mutate Azure — cancel any agent-created "Deploy…"/"Push…"
  issue and refuse "deployment authorization" interactions. Staging mutations are the owner's.
- Codex agents only (all `claude_local` agents are paused — owner rule while Claude limits are tight).
- Mac load: hard cap ~5 heavy runs (tsc/vitest/PostgreSQL/Next/Playwright); the Mac crashed at 12.
  QA runs against staging (light); gates run in GitHub Actions, never on the Mac.
- Paperclip API notes: comments come newest-first; `POST /api/companies/{cid}/issues` dedupes on an
  identical title; `PATCH` cannot change `projectId`; code lanes must use project DevFathom Commercial
  `383ffdb1-6723-44f0-aea3-9eb573b44c49`; re-fire a lane with status `backlog` → `todo`; agent
  interactions: `GET /api/issues/{id}/interactions`, accept with
  `POST /api/issues/{issueId}/interactions/{interactionId}/accept` (body
  `{companyId, resolution:"accepted", status:"accepted", note}`) — accept staging-QA / base-reset /
  correction-pass requests, refuse deploy/push/merge/grant ones; `ask_user_questions` kinds are
  answered in a comment and the lane re-fired.
- Composition (the device that composes cannot unlink files): `git diff <tip>^ <tip> | git apply
  --cached --3way`, write the worktree from the index (`git show :path > path`, `chmod 755` any
  script), `update-index --really-refresh`, `prisma validate` by exit code when the schema changed,
  `commit --no-verify` with the trailer `(Composed from WHA-xxxx @ sha by the supervisor.)`; before
  and after every git write move `*.lock` files under `.git/worktrees/<lane>/` and
  `.git/refs/heads/` out of the way. Always verify a delivery's parent chain reaches a known base and
  that the diff is the real change (several "deliveries" were Prettier-only or built on stale bases).
  Never rename a deployed migration; two NEW migrations must not share a timestamp prefix.
- Evidence and QA artefacts live outside the repo (`/Users/Saad/Developer/paperclip-worktrees/
  _gate-evidence/`, `_qa-evidence/`). Never compose them.

### Next steps, in order
1. Owner pushes the branch tip → `restaurantv2` (prompt given; any tip at or after `8a522bd8` is fine) → cloud gate `qa.yml` runs (~45–60 min).
   A Codex agent reads it read-only (`gh run list --workflow qa.yml`; `gh run view <id>
   --log-failed`) and every red step becomes a fix lane on the current candidate (workflow fixes to
   the engineer who wrote it, bf4edfeb).
2. Owner runs the second staging deploy prompt (it re-seeds from Key Vault, fixing the login drift;
   if the migration job is refused the `ALTER ROLE`, the prompt's fallback applies the grants).
3. Post "staging deployed — candidate <sha>" on every QA lane; QA phase B continues; every finding →
   engineer → compose → next candidate.
4. Green cloud gate + no open S1/S2 → owner decides production (needs the production preflight, the
   image gate with Docker up, DNS for production hostnames, and `promote-production.yml` with a
   staging-approved digest).
- Still pending from the owner: confirm the D02/D04/D10 defaults, decide D09/D01 and the two numbers
  (materiality threshold, share-of-PO trigger); SPF record for Brevo; Google Wallet issuer (WHA-268).

### Companion documents
- Cowork project doc `claude/devfathom-status.md` (same facts, Claude-side pointer) and the
  "DevFathom Delivery Board" artifact; owner prompts in `DevFathom hub/`
  (`deploy-staging-6cc482c8-prompt.md`, `staging-repair-pg_trgm-prompt.md`,
  `deploy-staging-8a522bd8-prompt.md`); PRD-PHARMACY-001 v1.0 in `DevFathom hub/pharmacy-prd-v1.0.md`.

---

# (2026-09-02 checkpoint — history)

Last reconciled: 2026-09-02 08:00 PKT (03:00 UTC) — Claude (Cowork supervisor) leading; both
Codex and Claude Paperclip teams executed the final gate cycle.

Restaurant is **gate-complete**: the canonical code candidate passed the full automated gate and the
full browser gate (Restaurant 15 / SuperAdmin 7 / Agency 8, zero skipped) on the same SHA, documentation
is reconciled, and the branch is published as `restaurantv2` on `origin` (owner-authorized). Remaining:
the Linux/amd64 image (Docker on the host needs a reboot; the Azure staging deploy builds it in ACR),
staging deployment and smoke (owner-authorized, prompt prepared), and production.

## Authoritative checkpoint

| Item                              | Exact state                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical code candidate (gated)  | `046340ab3143043a2b51de491c2f2ebc4fccaca0`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Release tip (code + infra + docs) | the commit that carries this status (branch tip); code identical to `046340ab`                                                                                                                                                                                                                                                                                                                                                                                                       |
| Lineage from Codex handoff        | `6cd73e4b` → `6c862469` status/manifest → `9c69bbdb` spec alignment → `f2c59457` price-list decimals, unit counts, runner guard → `4042a1a9` platform redirect-before-render, lane config, agency locator → `fee1686e` Playwright outputDir → `a7c109f9` offline replay exactly-once → `9786f562` fractional split-bill settlement → `e92b8c5c` audit-ledger lookup, agency env → `046340ab` navigation focus restoration → `a7e078e0` CAMERA_CREDENTIAL_KEY infra → `05ed1623` docs |
| Candidate worktree                | `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1116-compose-the-final-accepted-restaurant-artifacts-into-one-clean-private-candidate`                                                                                                                                                                                                                                                                                                                                      |
| Candidate working tree            | Clean at every gate run and at this commit                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Local preview                     | Tenant and SuperAdmin health return 200 on port 3105, but the running preview is from older `c7f15f65`, so it is not final-candidate proof                                                                                                                                                                                                                                                                                                                                           |
| Paperclip execution               | Paused; no live run should be resumed without reconciling it to this candidate and the contracts below                                                                                                                                                                                                                                                                                                                                                                               |
| Remote/release state              | `origin/restaurantv2` created at `a7c109f9` (WHA-1149) and fast-forwarded to this tip; `main` untouched; not deployed; not production-smoked                                                                                                                                                                                                                                                                                                                                         |

## What is implemented in the candidate

The assembled source covers Restaurant onboarding; staff, roles, branches, and devices; catalog,
menu, pricing, modifiers, and OCR import; POS, dine-in/takeaway/direct delivery, tables, KDS, orders,
discounts, complimentary items, payments, split bills, refunds, voids, drawers, and daily closing;
Pakistan tax and custom tax profiles; recipes/BOM, ingredients, stock, wastage, suppliers, purchasing,
and alerts; shifts/workforce; SOP library, schedules, evidence, verification, escalation, scores, and
audit; customers/loyalty; dashboard, finance, reports, analytics, and multi-branch foundations.

Important product boundaries:

- Printing has durable jobs, routing, idempotency, and ESC/POS rendering, but only a simulation
  adapter. No physical, network, or OS printer I/O has been accepted.
- Direct connected Delivery includes publications, addresses, zones, frozen snapshots, PREPAID/COD
  kitchen handoff, settlement, close, Reports, and Insights. Marketplace providers and full driver
  logistics are deferred.
- Offline POS new-order capture/replay is browser-proven (exactly-once replay after `a7c109f9`).
- OPay New 9220 is only a candidate card terminal. No provider documentation, credentials,
  authorization, reconciliation, or hardware acceptance has been completed.
- Pakistan tax calculation/configuration exists. Fiscal filing, fiscal-device certification,
  authority e-invoicing, and legal/accounting approval remain external.

## Final gate evidence — `046340ab3143043a2b51de491c2f2ebc4fccaca0`

Automated gate (WHA-1125, Codex Verification Engineer; evidence
`/Users/Saad/Developer/paperclip-worktrees/_gate-evidence/046340ab/wha-1125/`, verified by the supervisor
from `vitest.json` and the exit files):

- fresh `initdb` PostgreSQL 16.15 on port 55591, disposable DB, `prepare-extensions` as owner, **56 migrations**;
- restricted runtime role `LOGIN` with superuser, bypass-RLS, create-database, create-role, inherit all
  **false**, memberships 0, extension PUBLIC EXECUTE 0;
- serialized Vitest (`--maxWorkers=1 --no-file-parallelism --reporter=json`): **1141 files / 4052 tests,
  0 failed, 0 skipped, 0 todo**, 285 s;
- email-collisions, RLS verification, Prisma generate, Next typegen, lint, changed-file Prettier, `tsc`
  (8 GiB): all exit 0; production `next build` exit 0 (first attempt failed only because the build
  shell lacked the run-only `AUTH_SECRET`; rerun with secrets exported: exit 0; the browser gate's clean
  build of the same SHA also exited 0, `BUILD_ID JRj5GySkjWeAep1OliobK`);
- Linux/amd64 image: **NOT RUN** — Docker Desktop crashes on this host until a login-session restart;
  the staging deploy builds the amd64 image in ACR instead.

Browser gate (WHA-1132, Claude Verification Engineer; evidence
`/Users/Saad/Developer/paperclip-worktrees/_gate-evidence/046340ab/wha-1132/`, verified from the
Playwright JSON `stats`): fresh databases per lane (56 migrations each), restricted runtime role
`gate_app`, clean production build, `next start`, HEAD `046340ab` clean before and after:

| Lane                            | Required | Passed | Failed | Skipped | Flaky |
| ------------------------------- | -------- | ------ | ------ | ------- | ----- |
| Restaurant integrated (6 specs) | 15       | **15** | 0      | 0       | 0     |
| SuperAdmin control plane        | 7        | **7**  | 0      | 0       | 0     |
| Agency acceptance               | 8        | **8**  | 0      | 0       | 0     |
| **Total**                       | **30**   | **30** | 0      | 0       | 0     |

Defects found and fixed by the gates on 2026-09-01/02 (all product-side unless noted): four stale
spec assertions (test-only, `9c69bbdb`); price lists rendered `950` instead of `950.00`; open-orders
count showed lines instead of units and `1 items`; a stale Vitest runner guard (test-only); denied
`/platform` routes rendered the shell with the caller's identity before redirecting; concurrent
offline replay could open an order twice; fractional split-bill settlement threw `DecimalError`
(FRACTIONAL bills carry no lines — settlement now scales the parent order's evidence proportionally
with largest-remainder rounding); the platform navigation drawer dropped focus on keyboard close;
plus fixture/config corrections for the platform and agency lanes. Independent review of the proxy
authorization change (WHA-1145): safe to release; one non-blocking hardening note (wrap the session
lookup in try/catch — it already fails closed).

Recorded on 2026-09-02 (UTC 01:20–02:55). Supervisor note: the first copies of some evidence files
were emptied during an emergency disk cleanup and re-copied from the originals; all numbers above were
re-verified from the re-copied files.

## Accepted evidence (pre-gate)

- WHA-1108 final-controls artifact `fc2841e5c6dd08d184f9e091f145b0ca912f7198`
  (parent `958575ba`): focused Vitest **63 passed**; final-controls browser acceptance **5/5**.
  One separately opt-in restoration test was skipped in that focused run.
- WHA-1116 composition `6cd73e4b5eb747b1d017d28ce6858d6606a7c6f9`: exact ten-file
  composition; focused Vitest **4 files / 81 passed**; correction rerun **11/11**; changed-file
  ESLint and Prettier passed; 8 GiB `tsc --noEmit` passed; worktree was clean.
- WHA-1129 static completion audit found no remaining repository-resolvable runtime development
  blocker. It made no changes and did not substitute for database, build, or browser QA.

The stale claims in `tests/e2e/restaurant-acceptance-manifest.ts` (friendly selectors as WHA-300,
offline order capture as under correction, golden-byte printing as WHA-228, and closed lanes
WHA-228/282/286/297/298/299/300 listed as active — all `done` in Paperclip, artifacts present in the
candidate; only WHA-281 remains open) are corrected in the commit that carries this status.
`validateRestaurantAcceptanceManifest()` reports no violations; Prettier passes.

## QA evidence that must not be treated as a green gate

Two full-suite attempts were cancelled and are invalid release evidence:

1. Run `35936265-a174-4546-a4b7-a3a94cda8f5d` omitted the Delivery owner mapping. It reported
   332 passed files, 1 failed file, 1 skipped file, 4,028 passed tests, and 7 skipped tests, then
   attempted an invalid runtime `CREATEROLE` shortcut. Discard this result.
2. Run `00fc8773-bdd6-4673-ac34-ac2abc015e19` ignored the corrected serialized/JSON contract and
   ran plain parallel `bun run test`; it also omitted Delivery owner mapping and the restoration
   opt-in. It reported 331 passed files, 2 failed files, 1 skipped file, 4,027 passed tests,
   1 failed test, and 7 skipped tests. Discard this result.

Useful but partial setup evidence from the second attempt: **56 migrations** applied; the restricted
runtime role was login-only with superuser, bypass-RLS, create-database, create-role, and inherit all
false; the required database subset passed **19 suites / 180 tests** in 2.93 seconds. This does not
complete the release gate.

## Paperclip state at stop

| Issue                                    | State at handoff                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WHA-1116 — compose final candidate       | Done at `6cd73e4b…`                                                                                                                                                                                                                                                                                   |
| WHA-1129 — source/delta completion audit | Done; no code blocker found                                                                                                                                                                                                                                                                           |
| WHA-1130 — documentation pass            | Blocked and unassigned. Automatic recovery created private docs commit `5f371718428bc088b3b00c4c40a2f155f50b781c` on stale base `c7f15f65` before cancellation. Preserve it for selective review only; do not merge or cherry-pick it blindly. This canonical `status.md` supersedes its root ledger. |
| WHA-1125 — final automated release gate  | PASS on `046340ab` (see Final gate evidence)                                                                                                                                                                                                                                                          |
| WHA-1100 / WHA-1132 — final browser gate | PASS 30/30 on `046340ab`; WHA-1100 closed against WHA-1132 evidence                                                                                                                                                                                                                                   |
| WHA-1130 — documentation                 | Composed as `05ed1623` (status.md written by the supervisor instead)                                                                                                                                                                                                                                  |
| WHA-1143 — CAMERA_CREDENTIAL_KEY infra   | Composed as `a7e078e0`                                                                                                                                                                                                                                                                                |
| WHA-1149 — push                          | `origin/restaurantv2` created (owner-authorized)                                                                                                                                                                                                                                                      |

The recurring ten-minute completion watcher is paused. The cancelled QA PostgreSQL instance on port
55587 was stopped. The older local tenant/SuperAdmin preview on port 3105 was deliberately left
running for inspection.

## Required continuation order

1. Done: manifest truth fix, six gate-found defects fixed, automated and browser gates green on `046340ab`.
2. Run WHA-1125 on a fresh PostgreSQL 16 database. Apply all 56 migrations and use separate owner
   and restricted-runtime mappings for every required suite, including Delivery. Run Vitest
   serialized with JSON evidence and the restoration opt-in. Require zero failures and zero skipped
   required tests; then run lint, typecheck, production build, and the Linux/amd64 image gate.
   Never grant `CREATEROLE` to the restricted runtime and never replace this with plain parallel
   `bun run test`.
3. Only after WHA-1125 is fully green, run WHA-1100 against the **same SHA** and a fresh seeded DB:
   Restaurant **15**, SuperAdmin **7**, and Agency regression **8** browser scenarios, all passing
   with zero skips. Cover the complete onboarding-to-close flow, role/tenant boundaries, responsive
   and keyboard behavior, and the final docs against the real UI.
4. Reconcile admin/operator documentation and this status against proven behavior. Record exact
   commands, SHA, database role flags, test counts, build/image result, browser evidence, and any
   external limitations.
5. Owner authorized (2026-09-02): push to `origin/restaurantv2` (done) and Azure **staging** deployment
   (`infra/deploy-staging.sh` from this tip: ACR linux/amd64 build, container app, migration job, smoke —
   Claude Code prompt `deploy-staging-prompt.md`). Production deployment and `main` remain unauthorized.
   Staging preflight (WHA-1141) gaps: Key Vault secret presence unverified by agents (RBAC); the deploy
   script regenerates all seven deployment credentials on every run; migrations run as the Postgres
   server admin.

## External inputs code work cannot close alone

- Card/online acquiring provider contract, OPay New 9220 documentation and credentials, test
  merchant account, device protocol, settlement, refunds, and physical acceptance.
- Physical printer, drawer, KDS, and camera hardware acceptance.
- Notification provider credentials and deliverability acceptance.
- Restaurant-authored SOP content, tax/rate/effective-date choices, loyalty and inventory operating
  policy, retention policy, and legal/accountant approval.

## Optional or deferred scope

Marketplace APIs, live rider tracking, route optimization, native mobile, reservations/waitlist,
stored value, payroll execution, tip payout, production batches, and full driver logistics remain
optional or deferred unless explicitly approved.

Detailed decisions and module-level scope remain in the
[Restaurant management system plan](industry-specific-docs/restaurants/restaurant-management-system-plan.md).

## Staging deployment — b59f39a8

Deployed 2026-09-02 05:07–05:13 UTC to `rg-devfathom-staging-uaenorth`. Production
(`rg-devfathom-production-*`, `df-prd-*`) was not touched.

| Item                   | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| Branch tip             | `b59f39a88d931195d1db29fdef2d235feaaa43fb`                                |
| Image tag              | `bootstrap-b59f39a8-20260902045117`                                       |
| Image digest           | `sha256:81d4a7a498560633e4ab274bc40cb814dc7b4b6929b862f11fd9d73a31185506` |
| Container App revision | `devfathom-stg--0000036`                                                  |
| Tenant hostname        | `https://staging.devfathom.com` (SNI bound, `/api/health` 200)            |
| Platform hostname      | `https://admin.staging.devfathom.com` (SNI bound, `/api/health` 200)      |
| Migration job          | `devfathom-stg-migrate-bfgo47v` — **Succeeded**                           |

### Commits in this deployment

- `6909b3716136fec29b8eaf35e1a762f8972541cf` — `fix(seed): apply PLATFORM_ADMIN_PASSWORD to an existing platform admin`
- `b59f39a88d931195d1db29fdef2d235feaaa43fb` — `fix(platform): reconcile the module and package registry on every deployment`

### Migration job result

The job now runs `bun prisma/prepare-extensions.ts && bunx prisma migrate deploy && bun prisma/sync-catalog.ts && bun prisma/seed.ts`.

```
56 migrations found in prisma/migrations
No pending migrations to apply.
Platform catalog sync: created 10 module(s), 3 package(s), 26 package-module link(s).
Platform catalog sync: created 0 module(s), 0 package(s), 0 package-module link(s).
🌱 Seeding DevFathom database...
  ✓ Seed data already present; refreshed seeded-user credentials
```

The 56 migrations were already applied by `89766448`; this deployment applied none. The first
catalog line is `prisma/sync-catalog.ts` registering the ten Restaurant modules and three Restaurant
packages with their 26 module links; the second is `prisma/seed.ts` running the same reconciliation
and finding nothing left to do — the idempotence property, observed in production rather than only
in the test. The seed then took its "seed data already present" early-return path, which is exactly
the path on which the platform administrator's password used to be left stale.

`prisma/prepare-extensions.ts` writes nothing to stdout on success (confirmed against the
`ecdxouh` log from `89766448` as well); its success is proven by the job's `&&` chain reaching
`prisma migrate deploy`. The managed-owner skip is recorded as a row in
`platform_ops.platform_db_hardening` (`extension_name='btree_gist'`, `owner_role='azuresu'`,
`reason='managed-owner'`), which cannot be read from a workstation — the staging PostgreSQL
flexible server has no publicly resolvable endpoint from outside its virtual network.

### Gates before the build

Run against a fresh local PostgreSQL 16 database (`wha1116b_gate`, 56 migrations) with a
NOSUPERUSER/NOBYPASSRLS owner role and a separate NOSUPERUSER/NOBYPASSRLS runtime role holding
`WITH GRANT OPTION` privileges.

| Gate                                                                                                                   | Result                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bun run lint`                                                                                                         | exit 0                                                                                                            |
| Prettier `--check` on every changed `.ts`                                                                              | clean                                                                                                             |
| `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck`                                                             | exit 0                                                                                                            |
| `bunx vitest run --fileParallelism=false` over `prisma/`, `src/lib/platform/`, entitlements and the new suites         | **16 files, 266 tests, 0 failed, 0 skipped**, exit 0                                                              |
| `bun run test:rls`                                                                                                     | exit 0 — forced policies, cross-tenant isolation, fail-closed writes, append-only ledgers, platform-only policies |
| `az bicep build` on `environment.bicep`; `az bicep build-params` on `staging`, `production` and `production.bootstrap` | all clean                                                                                                         |

Both new suites were shown non-vacuous by reverting the fix under test: dropping `passwordHash`
from the platform-administrator `update` branch fails the rotation case and leaves the other three
green; dropping the existing-package guard, or letting the pass re-compose a package that already
exists, fails the idempotence case.

Compiled migration command, read back out of the built ARM template:

```
bun prisma/prepare-extensions.ts && bunx prisma migrate deploy && bun prisma/sync-catalog.ts
```

### Smoke (custom hostnames only)

| Check                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://staging.devfathom.com/api/health`                            | 200 `{"status":"ok"}`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `https://admin.staging.devfathom.com/api/health`                      | 200                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Platform administrator signs in with the rotated password             | **PASS** — this is the credential that failed before `6909b371`                                                                                                                                                                                                                                                                                                                                                                        |
| `/platform/catalog` lists all ten `RESTAURANT_MODULES` keys           | PASS                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/platform/catalog` lists all three `RESTAURANT_PACKAGES`             | PASS — essentials 6 modules, operations 10, enterprise 10, `restaurant-core` carrying each package's `defaultLimits`                                                                                                                                                                                                                                                                                                                   |
| Agency Suite module links unchanged                                   | PASS — still exactly 18                                                                                                                                                                                                                                                                                                                                                                                                                |
| Console offers only Restaurant packages for a RESTAURANT organization | PASS — 3 options, all `Restaurant *`                                                                                                                                                                                                                                                                                                                                                                                                   |
| Organization `Staging Restaurant Smoke` created through the console   | PASS — `cmtjnwezp003r01aoc988pgpn`, slug `staging-restaurant-smoke-2b578e`                                                                                                                                                                                                                                                                                                                                                             |
| Restaurant readiness (branch + four policy acknowledgements)          | PASS                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Production deployment marked READY, organization activated            | PASS — status ACTIVE                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Its administrator signs in and reaches the restaurant workspace       | PASS — 27 navigation entries (Point of sale, Kitchen display, Floor, Orders, Finance & reconciliation, Inventory, Purchasing, SOP board/reports/admin/oversight, Restaurant staff, Roster, Tax, Branches, Delivery, Restaurant devices, Cameras, Catalog, Menus, Notifications, Customers & Loyalty, Reports, Advanced Insights, Organization, Settings); `/restaurant/orders`, `/restaurant/menus` and `/restaurant/floor` all render |
| `alex@company.com` still reaches `/dashboard`                         | PASS                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Web container schema errors across the smoke                          | **zero** `P2022` or schema errors, and zero error-level lines                                                                                                                                                                                                                                                                                                                                                                          |

Screenshots, all under `~/devfathom-gates/deploy/smoke-b59f39a8/`:
`platform-organizations.png`, `platform-catalog.png`, `platform-organization-created.png`,
`platform-restaurant-readiness.png`, `platform-organization-active.png`,
`tenant-restaurant-orders.png`, `tenant-restaurant-menus.png`, `tenant-restaurant-floor.png`,
`tenant-dashboard.png`.

This is the fix proved end to end: before `b59f39a8` the staging catalog had no Restaurant package
at all, so the onboarding form would have shown "No commercial package available" and a restaurant
organization could not be created on this database. It now onboards, activates, and serves the full
restaurant workspace.

### Defects found and fixed during this deployment session

1. **`btree_gist` extension not allow-listed** — the migration job failed (`devfathom-stg-migrate-fuvddv5`)
   because `azure.extensions` did not permit the extensions the migrations create. Fixed by
   `98707c8f` (`infra: allow-list PostgreSQL extensions required by migrations`).
2. **Managed extension owner (`azuresu`)** — on Azure Flexible Server the `btree_gist` functions are
   owned by `azuresu`, and the migration job's role can neither own them nor `SET ROLE` to them, so the
   ACL hardening migration failed closed (`devfathom-stg-migrate-hgf6dvx`). Fixed by `89766448`
   (`fix(db): tolerate managed PostgreSQL extension owners in ACL hardening`), which records the skip
   in `platform_ops.platform_db_hardening` rather than silently passing.
3. **Two rollbacks** were taken while diagnosing (1) and (2); the last-known-good image on the old
   schema is recorded in `~/devfathom-gates/deploy/rollback-point.json`
   (`sha256:8b864735af9d4faac89f5847a01ccaf2d626355bd529f617daf5c16b7da97cc9`, revision
   `devfathom-stg--0000027`). **The database is now migrated to the new schema, so rolling back to
   that image is a last resort, not a routine step.**
4. **Seed never rewrote an existing platform administrator's password hash** — the upsert carried
   `update: { active, role }` with no `passwordHash`, so a rotated `PLATFORM_ADMIN_PASSWORD` only ever
   reached an administrator that did not exist yet. Every redeploy reported a successful seed while the
   previous hash stayed in place, and the smoke login failed with credentials the deploy had just
   generated. Fixed by `6909b371`.
5. **Module and package registry was never reconciled on an existing database** — `RESTAURANT_MODULES`
   and `RESTAURANT_PACKAGES` were written only by `prisma/production-bootstrap.ts`, which runs solely on
   a fresh production bootstrap; `seed.ts` registered `PLATFORM_MODULES` alone and no migration inserts
   a module. The staging database, created 2026-08-14, therefore listed 18 agency modules and one
   Agency Suite package after every restaurant migration had been applied. Fixed by `b59f39a8`.
6. **`infra/production.bootstrap.bicepparam` did not compile** — `postgresExtensions` was added in
   `98707c8f` without a default and only the staging and production parameter files were updated, so
   `az bicep build-params` on the bootstrap file failed `BCP258`. Fixed in `b59f39a8` and pinned by
   `tests/production-deployment-contract.test.ts`.
7. **`/api/health` is `SELECT 1` only** (`src/app/api/health/route.ts`). It proves the process is up and
   the database is reachable; it proves nothing about schema, seed, catalog, or entitlement state. A
   green health check is not evidence a deployment succeeded.
8. **Four secrets are Key-Vault-only and unrecoverable by this account** — `auth-secret`,
   `platform-encryption-key`, `camera-credential-key` and `cron-secret` are not exposed as migration-job
   secrets, and this account's RBAC cannot read them back from the vault. Only `seed-password`,
   `admin-password`, `platform-admin-password` and `database-url` were recoverable.

### Open finding, not fixed here

**`prisma/seed.ts` bumps the Agency Suite package version on every run.** Its `agency-suite` upsert
still carries `update: { active: true, version: { increment: 1 } }`, so the package moved from
version 26 to **27** on this deployment with no composition change — its 18 module links are
byte-identical. This is pre-existing seed behaviour, not something `b59f39a8` introduced, and it is
the same misreporting that `syncPlatformCatalog` deliberately refuses for Restaurant packages
("a package that already exists is skipped entirely… bumping its version would report an unchanged
package as edited"). The one-line correction is to drop `version: { increment: 1 }` from that upsert.
It was left alone because it is outside the scope authorised for this session.

### Rollback

```bash
az containerapp update \
  --resource-group rg-devfathom-staging-uaenorth \
  --name devfathom-stg \
  --image dfacrrz2qg5k5ucouy.azurecr.io/devfathom-commercial@sha256:ab7481b1…
```

Rolling the **app image** back to `89766448` is safe: that build runs against the same 56-migration
schema. Rolling back to the `rollback-point.json` image
(`sha256:8b864735af9d4faac89f5847a01ccaf2d626355bd529f617daf5c16b7da97cc9`, revision
`devfathom-stg--0000027`) is **not** routine — the database has since been migrated forward and that
build predates the schema.

### Credentials

All eight deployment secrets were **rotated** by this run (`infra/deploy-staging.sh` regenerates
every one on every invocation): PostgreSQL administrator, `AUTH_SECRET`, platform encryption key,
camera credential key, cron secret, seed password, tenant administrator password, and platform
administrator password. No value is recorded here or in any commit. The four recoverable ones were
captured to `~/devfathom-gates/deploy/secrets-b59f39a8.env` (mode 600, outside the repository); the
other four are Key-Vault-only and unreadable by this account.

### Environment limits this smoke ran into (not code defects)

- **A new organization's workspace host does not exist on staging.** `src/lib/tenancy/host-routing.ts`
  classifies the apex of `PLATFORM_BASE_DOMAIN` as a _shared_ host — `staging.devfathom.com` "belongs
  to the product, never to a customer" — and a tenant workspace is reached at
  `<slug>.staging.devfathom.com`. That name has no DNS record (`NXDOMAIN`) and no Container App
  hostname binding, so a newly onboarded organization can only be exercised over the shared host,
  which resolves the signed-in user's own organization. Binding a wildcard hostname is infrastructure
  work outside this session's scope.
- **`/restaurant` has no index page.** `src/app/(app)/restaurant/` contains only sub-routes
  (`orders`, `menus`, `floor`, `settings`, …) and no `page.tsx`, so `/restaurant` returns 404 for
  every restaurant organization, correctly entitled or not. The earlier session's note that
  "`/restaurant` 404s because the seeded organization is AGENCY" was the wrong diagnosis; the route
  simply does not exist. Restaurant surfaces must be smoked at a real sub-route.
- **Sign-in rate limits gate repeated smoke runs.** Platform sign-in allows 8 attempts per 15 minutes
  per IP+email (`src/lib/platform/auth.ts`); tenant sign-in allows 30/IP and 10/account per 5 minutes
  (`src/lib/auth.ts`). Iterating on a browser smoke trips both, and the failure surfaces as a plain
  "sign-in failed" page rather than an obvious 429 unless the response is inspected.
- **The app scales to zero.** A first request after idle takes ~58 seconds; Playwright's default
  30-second navigation timeout is not enough, so a smoke must warm the host first or raise the timeout.
