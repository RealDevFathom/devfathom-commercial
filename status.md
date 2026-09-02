# DevFathom delivery status

Last reconciled: 2026-09-02 08:00 PKT (03:00 UTC) — Claude (Cowork supervisor) leading; both
Codex and Claude Paperclip teams executed the final gate cycle.

Restaurant is **gate-complete**: the canonical code candidate passed the full automated gate and the
full browser gate (Restaurant 15 / SuperAdmin 7 / Agency 8, zero skipped) on the same SHA, documentation
is reconciled, and the branch is published as `restaurantv2` on `origin` (owner-authorized). Remaining:
the Linux/amd64 image (Docker on the host needs a reboot; the Azure staging deploy builds it in ACR),
staging deployment and smoke (owner-authorized, prompt prepared), and production.

## Authoritative checkpoint

| Item | Exact state |
| --- | --- |
| Canonical code candidate (gated) | `046340ab3143043a2b51de491c2f2ebc4fccaca0` |
| Release tip (code + infra + docs) | the commit that carries this status (branch tip); code identical to `046340ab` |
| Lineage from Codex handoff | `6cd73e4b` → `6c862469` status/manifest → `9c69bbdb` spec alignment → `f2c59457` price-list decimals, unit counts, runner guard → `4042a1a9` platform redirect-before-render, lane config, agency locator → `fee1686e` Playwright outputDir → `a7c109f9` offline replay exactly-once → `9786f562` fractional split-bill settlement → `e92b8c5c` audit-ledger lookup, agency env → `046340ab` navigation focus restoration → `a7e078e0` CAMERA_CREDENTIAL_KEY infra → `05ed1623` docs |
| Candidate worktree | `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1116-compose-the-final-accepted-restaurant-artifacts-into-one-clean-private-candidate` |
| Candidate working tree | Clean at every gate run and at this commit |
| Local preview | Tenant and SuperAdmin health return 200 on port 3105, but the running preview is from older `c7f15f65`, so it is not final-candidate proof |
| Paperclip execution | Paused; no live run should be resumed without reconciling it to this candidate and the contracts below |
| Remote/release state | `origin/restaurantv2` created at `a7c109f9` (WHA-1149) and fast-forwarded to this tip; `main` untouched; not deployed; not production-smoked |

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

| Lane | Required | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- | --- |
| Restaurant integrated (6 specs) | 15 | **15** | 0 | 0 | 0 |
| SuperAdmin control plane | 7 | **7** | 0 | 0 | 0 |
| Agency acceptance | 8 | **8** | 0 | 0 | 0 |
| **Total** | **30** | **30** | 0 | 0 | 0 |

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

| Issue | State at handoff |
| --- | --- |
| WHA-1116 — compose final candidate | Done at `6cd73e4b…` |
| WHA-1129 — source/delta completion audit | Done; no code blocker found |
| WHA-1130 — documentation pass | Blocked and unassigned. Automatic recovery created private docs commit `5f371718428bc088b3b00c4c40a2f155f50b781c` on stale base `c7f15f65` before cancellation. Preserve it for selective review only; do not merge or cherry-pick it blindly. This canonical `status.md` supersedes its root ledger. |
| WHA-1125 — final automated release gate | PASS on `046340ab` (see Final gate evidence) |
| WHA-1100 / WHA-1132 — final browser gate | PASS 30/30 on `046340ab`; WHA-1100 closed against WHA-1132 evidence |
| WHA-1130 — documentation | Composed as `05ed1623` (status.md written by the supervisor instead) |
| WHA-1143 — CAMERA_CREDENTIAL_KEY infra | Composed as `a7e078e0` |
| WHA-1149 — push | `origin/restaurantv2` created (owner-authorized) |

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
