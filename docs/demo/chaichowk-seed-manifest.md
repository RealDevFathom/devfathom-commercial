# Chai Chowk LAN / staging seed package — WHA-1382

## Current integrated package

The package supports explicitly approved **LAN**, **Azure staging**, and isolated
disposable targets. **No LAN or Azure database was written by this implementation
or verification.** Live staging identity remains unknown. The active Codex Desktop
supervisor owns package safety review and routing of the one LAN writer; Claude/owner
retains staging preflight and deployment. No paused supervisor is involved.

This is **partial workflow coverage, not all functions seeded**. Settlements,
payments/refunds, financial projections and loyalty accrual/redemption remain
unimplemented. OPEN bills and fractional splits are implemented. Tax approval,
physical fulfilment and hardware success are never fabricated.

Owned root files: `scripts/seed-chaichowk-staging.ts`,
`scripts/chaichowk-staging-fixtures.ts`, `scripts/seed-chaichowk-staging.test.ts`,
`scripts/verify-chaichowk-staging.ts`, and this manifest. Accepted helpers integrated
once without edits to their owned files:

| Lane                | Accepted source commits                                                                           | Integrated commits                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| WHA-1386 Catering   | `88bd3ecd17637218e9c8b89f54508e7264bcde93`                                                        | `ad82a57ba32f8a3b06c84a939bbc9da4989c8310`                                             |
| WHA-1387 Operations | `3a62d798951d3dfcfde2bbf3e053642350685759`, correction `d35e20a7fc89d67bad7f03e60a3026977f266824` | `6167ce0f96fad5213b15977a89e816c00cbb956d`, `e9fa6456fe1912b9e7831714263b3ea5c5ed1e7f` |

Both helpers receive only the owning raw transaction and
`{organizationId, branchId, ownerUserId, businessDate, timezone, id(key)}`.
The root captures all helper model/ID references; keys retain `catering.*` and
`operations.*`. No plugin framework, new dependency, schema, migration, product
feature, E2E-guard change, or shared-service mutation was introduced.

## Identity, access and rerun contract

The package requires an existing ACTIVE ADMIN owner, assigned branch, active
RESTAURANT organization/branch, PKR, matching slug/code/timezone, and explicit
existing user capabilities. It never reads/replaces passwords or changes existing
status, roles, permissions, vertical or business rows. Missing owner fails with
`OWNER_PROVISIONING_REQUIRED`; this version consumes no account-creation secret.
Secure account provisioning is a separate prerequisite, not an automatic seed step.

Missing owner actor uses the existing `ensureAdministratorStaffProfile` helper:
its generated ID and normal default/oldest-active branch choice are retained.
Existing profiles remain untouched. A suspended or ambiguous owner actor refuses.
The root serializes the shared owner and checks configured operator capacity before
creation. The helper does not create staff role/capability grants.

Effective modules use the established entitlement resolver. Catering additionally
requires restaurant-loyalty and customers:manage because it creates a customer.
Operations requires restaurant-workforce/restaurant-sop, owner user capabilities
staff:manage, sop:manage, sop:complete and sop:verify, all three actual SOP depth
checks through `evaluateSopDepth`, and capacity for one additional active template.
Its helper independently enforces existing branch staff capabilities and separate
synthetic actors; missing grants/actors/roster availability yield explicit gaps.
No grants are synthesized to unlock these examples. Owner profile creation alone
therefore does **not** establish full Operations coverage on LAN.

OPEN bills/splits require existing payments:collect and order/menu access. They use
`cutBills` inside the owning transaction. No tender is accepted, no tax snapshot is
invented, and no OPEN bill is reported as settled. Product settlement requires an
effective approved tax profile/rule (`tenders.ts:loadSettlementContext` and
`tax-calculator.ts`); this package does not yet implement those guarded scenarios.

Namespace `ccdemo_v1_<hash(organizationId:branchId)>_` is stable across reruns;
package fingerprint is `v2-integrated`. Business date, scenario instant, owner,
timezone and enabled groups are pinned. Source v1 receipts refuse rather than
silently migrating their namespace. No existing v1 LAN/staging application is known.

Each successful transaction stores a receipt containing **all created references
and scalar-row SHA-256 hashes**, observed gaps and the configuration fingerprint,
plus a separate audit tombstone containing the receipt metadata hash. Reruns verify
the original complete receipt before any helper can shrink its plan. Changed or
missing rows refuse; no repair, re-dating, duplicate stock or money writes occur.
Receipt/tombstone disagreement refuses. Surviving deterministic rows without a
receipt refuse. Deleting both audit markers AND all evidence is outside this
in-database detection guarantee; retain operator-side receipt evidence and never
clear a namespace. There is no destructive cleanup command.

## Runnable commands and secure inputs

Supply **only the secret name** `CHAICHOWK_SEED_DATABASE_URL` through the approved
private environment. Its value must exactly match the reviewed target host/port/DB
and restricted runtime role. Never print it, login files, tokens, hashes or PINs.
Existing DATABASE_URL, TEST_DATABASE_URL, DIRECT_URL and SHADOW_DATABASE_URL must
be absent or exactly identical; startup GUC/service/host overrides are refused.
No dotenv is loaded. Use a fresh standalone process and the normal repository
installation/generated Prisma client.

The non-secret, operator-reviewed JSON must contain exactly:
`environment`, `host`, `port`, `database`, `organizationId`, `organizationSlug`,
`vertical` (RESTAURANT), `branchId`, `branchCode`, `ownerUserId`, `email`
(owner@chaichowk.pk), `currency` (PKR), `timezone`, `businessDate` (YYYY-MM-DD),
`scenarioAt` (UTC ISO milliseconds), `approvalReference`, `expiresAt` (future, <=24h).
The actual branch timezone/cutoff must resolve scenarioAt to businessDate.

| Target                  | Explicit environment and endpoint fence                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| LAN                     | `lan`; exactly `127.0.0.1:65377`, database `devfathom_win7_lan_test_20260906` |
| Azure staging           | `staging`; approved non-loopback endpoint/DB, `sslmode=verify-full` required  |
| Disposable verification | `disposable`; loopback high port and `chaichowk_seed_disposable_*` database   |

Changing environment, endpoint, any identity field, dates or approval changes the
confirmation digest. LAN identity pointers from WHA-1385 are org_chai_chowk /
RESTAURANT / demo_user_owner / branch_restaurant_e2e; actual slug/code/date and
current identity still require approved input/read verification. These are **not
Azure defaults**. WHA-1385 reported 36 existing products, 34 orders, 31 bills,
10 payments and 36 movements; these are independent LAN audit counts to preserve,
not counts from this package or a fresh query by this writer.

Default dry-run for either approved target document:

```sh
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-lan.json
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-staging.json
```

Dry-run opens a READ ONLY tenant transaction, returning static planned counts,
planned service/helper names, gaps and a target-specific digest. Helper counts are
not predicted as actual inserted rows. Application syntax, for the separately
routed writer after safety review:

```sh
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-lan.json --apply --confirm <reviewed-LAN-digest>
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-staging.json --apply --confirm <reviewed-staging-digest>
```

These are runnable package commands, not authorization to execute against either
existing database. WHA-1384 owns the deployment handoff. No actual target document
or live secret was created/read by this pass.

## Observed isolated coverage

One fresh run-owned PostgreSQL 16.15 cluster replaced the previous run's expired
scratch cluster; no second concurrent verifier DB and no existing database used.
106 unchanged migrations applied. Runtime seed_runtime explicitly proved
NOSUPERUSER/NOBYPASSRLS; every registered fixture surface was checked FORCE RLS.
Administrative bootstrap grants/users/permissions existed only in this synthetic
cluster, before runtime verification.

The full Operations prerequisite scenario observed **218 created fixture rows +
two audit markers**. Its existing synthetic owner profile/grants were preserved.

| Surface                | Observed coverage                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog                | 4 products/ingredients/recipes/active versions/recipe lines (3 core + 1 Catering); 3 menu items/price entries; modifier group/option/link                                                                   |
| Floor/stock            | 1 floor, 3 tables; 1 pantry, 3 stock items/movements, each balance 1000 grams                                                                                                                               |
| Receiving              | 1 supplier, 1 received PO with 3 lines, linked receipt with 3 lines                                                                                                                                         |
| Orders/KDS             | 3 takeaway orders: SENT, IN_PREPARATION, READY; 3 items/tickets; 12 events/command keys                                                                                                                     |
| Catering               | **65 rows**: 4 orders (1 DRAFT, 2 QUOTED, 1 pre-production CANCELLED), 4 recipe-linked lines, 16 estimated costs, 3 planned deliveries, 31 events, dedicated catalog/customer                               |
| Operations             | **43 rows**: 4 shifts, 1 break, 7 shift events, 7 commands, 2 swaps/1 rejection, template/version/step, 4 assignments/occurrences/steps, 2 note evidence rows, 1 REJECT verification, 3 local notifications |
| Customers/local notice | 3 synthetic customers without real contacts; 1 core notice plus Operations notices                                                                                                                          |
| External effects       | Revoked credential-less attribution device; order outbox rows DEAD with suppression reason; zero print jobs/pending external outbox                                                                         |

Operations history is prominently marked SYNTHETIC DEMO, never actual work or
safety approval. Rejection uses a distinct existing synthetic completer and owner
reviewer. Branches without those prerequisites report gaps and seed zero related
Operations rows; this was also observed on the owner-profile creation scenarios.

A separate billing scenario in the SAME DB observed **4 OPEN bills per branch**:
two NONE and two equal FRACTIONAL bills over three PKR220 orders, total PKR660 per
branch. Across two branches: **8 bills, PKR1320, four fractional bills, zero tenders**.
Counts were 185/184 created rows plus two audit markers per branch; exactly one
owner actor was created across concurrent first applications. Both billing branches'
dry-run/apply reruns preserved all public rows and sequences, including money keys.

## Gaps and limits

- Unimplemented: settlements, payment/refund scenarios, closed sales/history,
  financial report projections, loyalty points/program transitions. OPEN bills
  and pending purchase/order amounts do not establish settled revenue coverage.
- Catering CONFIRMED/IN_PRODUCTION costing opens a separate tenant connection;
  READY consumption is router-private and recipe explosion opens another connection.
  No production consumption, deposits, dispatch, delivery or CLOSED success is
  inserted. Existing Catering console USD formatting for PKR remains out of lane.
- Operations coverage depends on actual branch staff grants, synthetic actors,
  SOP depths/retention/quota and roster availability. No VERIFIED safety outcomes,
  co-authorized waivers, external delivery or real attendance is claimed.
- Enabled print routes omit order/billing scenarios; a final generated-print-intent
  check aborts if routing changes concurrently. No printer/device/AI/email/webhook/
  payment provider calls, tax approval, licence or hardware success is fabricated.
- Pharmacy remains a separate workspace/account choice. Absent-owner provisioning
  and credentials for synthetic staff remain outside this existing-account runner.
- This is not the legacy 35-product/34-order/31-bill showcase and does not overwrite it.
- Whole-package safety and remaining financial scope need active-supervisor review
  before any claim of all-functions coverage or routing an existing-LAN write.

## Verification and provenance

Exact product base: `2d3c0effc3af5d5bdd2351f831f231909b4432c0`.
Wake starting clean HEAD: `46b9c0a67fcf04296ef26c4b99505c3c422b653e`.
Integration change parent after accepted cherry-picks:
`e9fa6456fe1912b9e7831714263b3ea5c5ed1e7f`.
Branch stayed `codex/chaichowk-staging-demo-seed`; prior `d437b780` and manifest
history are preserved. No push, merge, deploy, local app/browser or paused-agent wake.

Exact scoped commands (exit 0 unless stated):

```sh
bun test scripts/seed-chaichowk-staging.test.ts scripts/chaichowk-staging-catering-fixtures.test.ts scripts/chaichowk-staging-operations-fixtures.test.ts
node_modules/.bin/tsc --noEmit --project "$PAPERCLIP_RUN_SCRATCH_DIR/scoped-tsconfig.json"
node_modules/.bin/eslint --no-config-lookup --config "$PAPERCLIP_RUN_SCRATCH_DIR/seed-dependencies/eslint.config.mjs" scripts/seed-chaichowk-staging.ts scripts/chaichowk-staging-fixtures.ts scripts/seed-chaichowk-staging.test.ts scripts/verify-chaichowk-staging.ts scripts/chaichowk-staging-catering-fixtures.ts scripts/chaichowk-staging-catering-fixtures.test.ts scripts/chaichowk-staging-operations-fixtures.ts scripts/chaichowk-staging-operations-fixtures.test.ts
CHAICHOWK_VERIFY_OWNED_DISPOSABLE=1 TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/verify-chaichowk-staging.ts
CHAICHOWK_VERIFY_OWNED_DISPOSABLE=1 TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/verify-chaichowk-staging.ts --final-check
CHAICHOWK_VERIFY_OWNED_DISPOSABLE=1 TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/verify-chaichowk-staging.ts --billing-check
CHAICHOWK_VERIFY_OWNED_DISPOSABLE=1 TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/verify-chaichowk-staging.ts --billing-replay-check
git diff --check
```

35 focused tests passed (10 root, 7 Catering, 18 Operations). Typecheck includes
all eight scripts and actual imports; no diagnostics. ESLint uses lockfile-pinned
TypeScript recommended rules, not the full Next preset. Prettier covers the same
scripts and manifest. No full app typecheck/build/UI tests: no app/product change.
Owned scratch installs pinned the dependency closure from bun.lock; no lockfile or
new repository dependency. Earlier installed Next guide was read in the prior run;
this pass edits standalone scripts only. Generated client uses unchanged Prisma7.9.1.

Main DB verifier passed ten invariants: all-table/sequence dry-run preservation;
foreign-branch rejection; existing credentials/status/roles/business preservation;
unchanged reruns; concurrent reruns; KDS/stock/receiving/no-external reconciliation;
65/43 helper-row receipt coverage; edited/deleted helper-row and missing-receipt
refusal; late order-limit rollback; one application/one replay under concurrent
first apply; runtime restricted flags/foreign-row invisibility (some combined in
one reported assertion). Additional commands above prove shared-owner creation and
billing reconciliation/rerun preservation. Failure probes mutate only synthetic
owned disposable rows and restore their exact saved records; no live repair.

Initial check failures/corrections: root canonical-hash syntax, SOP template
isActive field, synthetic bootstrap EMPLOYEE enum, and Prisma reflection exposing
a hidden $transaction on the raw transaction proxy. The root helper adapter hides
that unavailable member; accepted helper guards remain unchanged. Failed applies
rolled back. pg8.22.0 emitted its existing concurrent-query deprecation warning;
no product dependency or service was changed to suppress it.

Migrations used `psql -X -v ON_ERROR_STOP=1` for every existing migration after
existing `prisma/prepare-extensions.sql`; no schema bypass. This replay does not
create Prisma's migration-history table and proves no live migration state.
Owned cluster is stopped after checks. Scratch reports/dependencies are ephemeral;
this manifest and issue comment preserve sanitized commands/counts/outcomes.

---

The record below is historical evidence from before package authorization was
clarified. Its blocked/no-implementation statements describe those earlier passes.

# Historical preflight record

Historical WHA-1382 status before supervisor clarification: **blocked pending staging identity and permission metadata**.
No staging seed entry point has been implemented or executed. This document is
source preflight evidence, not a deployment handoff or a verified coverage report.

## Checkout provenance

- Checkout: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-staging-demo-seed`
- Branch: `codex/chaichowk-staging-demo-seed`
- Exact source base: `2d3c0effc3af5d5bdd2351f831f231909b4432c0`
- Initial `git status --short`: empty; branch and HEAD matched the assignment.
- WHA-1382 assignment confirmed through the local Paperclip issue API.
- Only this manifest changed. Existing seeds, guards, schema and product code remain unchanged.

## Identity evidence and blocker

`scripts/seed-restaurant-e2e.ts` declares fixture organization `org_chai_chowk`.
`scripts/seed-restaurant-demo.ts:1278` creates the owner fixture using
`owner@chaichowk.pk`. Its control-plane helper stamps a Restaurant Operations
package on that fixture organization. These declarations do **not** establish
the actual staging organization, account existence, branch access or entitlements.

WHA-1384 owns the independent staging/account audit. At preflight, its issue thread
contained only the workspace-ready comment, with no verified target metadata.
The assignment explicitly requires stopping when identity or permissions are missing.

Unblock owner: WHA-1384 auditor, coordinated by Codex Chief of Staff. Supply sanitized
staging organization ID/slug/vertical; owner existence and ID or explicit absence;
existing branch and role assignments; enabled Restaurant/Catering modules; and
the approved target identifier plus secret **names**. If access is unavailable,
record the specific owner-run read-only preflight needed. Never put passwords,
password hashes, PINs, tokens or connection strings in the issue or this manifest.

Pharmacy is a separate vertical in `src/lib/vertical-catalog.ts`. No Pharmacy
workspace or membership is authorized here. A separate workspace/account decision
is required before provisioning Pharmacy; do not convert the restaurant tenant.

## Existing seed safety findings

| Source                                 | Evidence                                                                                                                           | Staging implication                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `scripts/restaurant-e2e-database.ts`   | Requires disposable database name, rejects staging hosts/targets and common PostgreSQL ports, checks competing URL settings        | Preserve the complete guard; do not route staging through this entry point  |
| `scripts/pharmacy-e2e-environment.ts`  | Requires explicit Pharmacy E2E opt-in and disposable target; rejects staging, shared targets and common ports                      | Preserve the complete guard; Pharmacy fixtures are not staging provisioning |
| `scripts/seed-restaurant-e2e.ts:516`   | Rejects runtime SUPERUSER/BYPASSRLS, then enters platform context; later replaces permission relations through nested `deleteMany` | Restricted runtime role alone does not make the seed additive               |
| `scripts/seed-restaurant-demo.ts:1034` | Upserts package/module configuration and updates organization commercial settings                                                  | Cannot preserve existing entitlements by calling this helper                |
| `scripts/seed-restaurant-demo.ts:1278` | Owner upsert replaces password on rerun and assigns fixture manager role on creation                                               | Never invoke against an existing staging account                            |
| `scripts/seed-restaurant-demo.ts:1142` | Updates base fixture catalog, prices and device presentation                                                                       | Fixture IDs are not permission to overwrite staging business rows           |
| `scripts/seed-restaurant-demo.ts:2375` | `countSeeded()` returns planned array lengths                                                                                      | These are not observed database counts or proof of safe reruns              |

Both environment guard files were read in full. Existing seed executables were
not imported or run. Full seed/service correctness review remains outstanding.
`src/lib/demo` is absent at this exact base; the historical graph pointer is stale.

## Proposed owned implementation, after unblock

- `scripts/seed-chaichowk-staging.ts`: separate, default-dry-run entry point with
  explicit target confirmation, tenant/account fence, stable synthetic IDs,
  transactional serialization and collision refusal. Preserve credentials,
  permissions and existing business rows; suppress external effects.
- `scripts/seed-chaichowk-staging.test.ts`: focused guard, failure, concurrency,
  rollback and rerun regression coverage, using one newly owned disposable DB
  when database verification is needed.
- This manifest: replace proposed coverage with observed counts and evidence.

The legacy source contains candidates for catalog/menu, floor/tables/staff,
customers/loyalty, suppliers/stock/purchases, orders/KDS, bills/payments/drawers,
daily closes and insights/history. Candidate data is not proof that these flows
are reachable by the staging owner. Modifier dependencies, refunds, catering and
report projection service paths still require assessment. No broader fixture file
ownership is claimed. WHA-1383 owns the independent workflow coverage report;
WHA-1384 owns the deployment handoff.

## Published source audit follow-through

WHA-1383 comment `05c95eb0-3153-4c98-a6bd-61b566cf9d00` reports the
[Chai Chowk coverage matrix](/api/issues/29a88c72-2c65-4774-8dfe-a8f93d1759d6/documents/chaichowk-seed-coverage),
revision `ad94f771-8a84-4731-b9b4-8a7e0b189238`, against the assigned source
base. This section records that audit's findings; it is not a second coverage
audit or runtime verification. Its reported footprint is 35 showcase products,
34 orders, 31 settled bills and three live orders; staging counts were not queried.

After the identity gate clears, the seed implementation must assess these reported
must-have gaps against actual enabled workflows and established service rules:

- Owner ACTIVE staff actor and scenarios anchored to the actual business date.
- Dish recipes and linked receiving documents; a `RECEIVED` purchase order alone
  does not demonstrate receiving coverage.
- Refunds and split payments; catering; roster and attendance.
- SOP outcomes and notifications, with external delivery suppressed.

The audit reports hardcoded USD in
`src/components/restaurant/catering/catering-console.tsx:89` despite the PKR
tenant. Record this as an unresolved product limitation for the Chief of Staff;
it is not a seed fix, authorization to edit UI, or reason to change tenant currency.
Hardware, external integrations, tax and Pharmacy remain separately gated.
No additional fixture ownership is claimed. WHA-1382 retains the seed runner;
WHA-1383 owns the matrix; WHA-1384 owns target verification and the Claude handoff.
The audit supplies no staging identity or permission evidence, so the named
WHA-1384 unblock action above remains required.

## Commands, counts and limitations

### WHA-1383 comment reconciliation (2026-09-06)

- Reviewed comments `4e5e74ec-7749-48ca-b670-7537508a50dc` and
  `43e70cbe-2856-4b44-90d6-522c8278323e`. Neither supplies the missing
  WHA-1384 staging identity/permission evidence; implementation remains blocked.
- Source-planned counts are **34 orders = 30 historical closed + 1 current-day
  closed + 3 live**, hence **31 bills/tenders**, not 32. The live statuses are
  `SENT`, `IN_PREPARATION`, and `READY` (`planDay`, lines 848–868). These are
  legacy fixture expectations, not observed staging counts or promised new-seed coverage.
- Owner actor prerequisite: `seedPeople` creates the owner and branch assignment
  outside the staff-profile loop. `src/server/restaurant-actor.ts` requires
  exactly one ACTIVE user-linked profile and authorized branch access.
  After identity/permission verification, assess reuse of
  `src/lib/restaurant/administrator-staff-profile.ts:ensureAdministratorStaffProfile`
  within the owning transaction for an absent administrator profile. It leaves
  existing profiles untouched, including suspended profiles, and selects an
  active default/oldest branch. Validate that branch against the approved target;
  do not broaden roles, change assignments or reactivate profiles to pass the gate.
  Missing/ambiguous actor authorization must stop with an explicit blocker.
- Legacy dates are fixed to August 21–27, 2026, with related stock/purchase dates
  outside that range. The future seed must use an explicit, confirmed staging
  business date and business timezone, consistently anchor dependent timestamps,
  and preserve that anchor on rerun. Do not silently move existing rows with the
  wall clock or label August 27 as the actual staging current day.
- This heartbeat started clean at `72727ebb9680d4769e5881984331f5122e600cf5`,
  whose parent is the exact assigned source base above. Only this manifest is
  being amended; seed implementation and runtime verification remain outstanding.

- `pwd`, `git status --short`, `git branch --show-current`, `git rev-parse HEAD`:
  exit 0; correct checkout, clean initial state, assigned branch and exact base.
- `codebase-memory-mcp cli list_projects '{}'`: succeeded; assigned checkout was
  not indexed. No index created because work stopped at the identity gate.
- `ls -ld node_modules`: exit 1, directory absent. Installed Next guides therefore
  unavailable. No code/UI work or dependency installation performed.
- `rg` unavailable; used focused `grep`/`sed` source reads. Initial historical
  path probes for `src/lib/demo`, `docs/demo` and
  `scripts/restaurant-e2e-environment.ts` failed; the actual restaurant guard is
  `scripts/restaurant-e2e-database.ts`.
- No runtime tests, typecheck, lint, format tool, migrations, build, browser,
  application or database commands executed. No runtime RLS claim made.
- Seed runs: **0**. Seed-created rows: **0**. Existing staging row counts: **unknown**.
  Dry-run zero-write proof, first-run invariants, rerun/password preservation,
  foreign-tenant preservation and concurrency tests: **not performed**.
- Runnable staging command and verified secure input names: **not yet available**.
  Do not substitute an E2E seed command. No account-ready or all-workflows-seeded claim.
- Ponytail skill and Claude-Mem tools were unavailable in this session; no nested
  CLI or agent launched. No shared index/cache or foreign worktree modified.
- No deployment, push, role changes, service restarts, cloud writes or schema changes.
  No data rollback required: this artifact is documentation only.
