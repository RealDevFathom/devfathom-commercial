# Chai Chowk staging seed package — WHA-1382

## Current package and scope

Supervisor comment `0aafe0ec-66a7-41cd-84d4-7ea6ac552087` clarified that live
identity blocks staging application, not source implementation or disposable-DB
verification. The source package is now implemented. **No staging account or
staging row counts have been verified, and no staging command has been executed.**
The active Codex Desktop supervisor owns review; do not wake the paused Chief of Staff.

Owned source files:

- `scripts/seed-chaichowk-staging.ts`: explicit target validation, default dry-run,
  tenant/account fence, restricted runtime/FORCE RLS checks, existing entitlements
  and capability checks, branch advisory lock and additive audit receipt.
- `scripts/chaichowk-staging-fixtures.ts`: pure relational plan and transaction-only
  fixture application; uses purchasing and order services for their state changes.
- `scripts/seed-chaichowk-staging.test.ts`: eight guard/plan regression tests.
- `scripts/verify-chaichowk-staging.ts`: verification harness fenced to this run's
  newly initialized disposable cluster. Never accepts a staging URL.
- This manifest. Product code, schema, migrations, lockfile and old E2E seeds are unchanged.

The package requires an existing ACTIVE ADMIN owner, existing branch assignment,
Restaurant classification, PKR currency, active organization/branch and effective
module/capability grants. It never reads or replaces the login password, changes
roles/permissions, resets tenant tables, or activates an existing suspended profile.
An absent owner fails with `OWNER_PROVISIONING_REQUIRED`; secure owner provisioning
is a separate prerequisite. No fixed password or account-creation secret is consumed
by this version. Missing owner actor profiles are added with a stable ID and the
explicitly approved branch; existing profiles remain untouched. This follows the
administrator-profile helper's preservation behavior while avoiding its generated
ID and default-branch selection for this branch-fenced fixture.

Namespace `ccdemo_v1_<hash(organizationId:branchId)>_` is stable across reruns.
Collision without a valid receipt fails; a committed receipt checks that its rows
still exist and returns without updating them. Business date, scenario instant,
timezone, owner and enabled fixture groups are immutable for that namespace.
Changing them refuses instead of creating another stock or money history.
Generated service rows are tracked by receipt and stable command idempotency keys.

## Executable inputs (Claude/owner application only)

Secure environment input: `CHAICHOWK_SEED_DATABASE_URL`. It must identify the exact
approved host, port and database, using the restricted runtime role. Staging requires
`sslmode=verify-full`. Do not put its value in logs, documents or command arguments.
Existing `DATABASE_URL`, `TEST_DATABASE_URL`, `DIRECT_URL`, and `SHADOW_DATABASE_URL`
must be absent or exactly identical. Startup option/service overrides are refused.
The script loads no dotenv files. Run in a fresh standalone process.

The owner-reviewed non-secret JSON target document must contain exactly:
`environment` (`staging`), `host`, `port`, `database`, `organizationId`,
`organizationSlug`, `vertical` (`RESTAURANT`), `branchId`, `branchCode`,
`ownerUserId`, `email` (`owner@chaichowk.pk`), `currency` (`PKR`), `timezone`,
`businessDate` (`YYYY-MM-DD`), `scenarioAt` (UTC ISO instant with milliseconds),
`approvalReference`, and `expiresAt` (future, at most 24 hours away).
The server verifies that `scenarioAt` resolves to the stated business date using
the actual branch timezone/cutoff. WHA-1384/owner must supply actual target metadata;
fixture organization/branch IDs are not staging defaults.

After normal repository dependency installation and Prisma generation:

```sh
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-target.json
```

This is the default dry-run; it opens a READ ONLY tenant transaction and reports
planned static counts, service scenarios, gaps and a target-document confirmation
digest. Review that result before the separately authorized staging application:

```sh
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-target.json --apply --confirm <digest-from-reviewed-dry-run>
```

Duplicate TLS parameters are refused. Cross-branch applications also lock the shared owner prerequisite to prevent duplicate actor profiles.

These commands are package usage, not a deployment prompt or authorization to run
against Azure. WHA-1384 retains the Claude deployment handoff.

## Observed disposable coverage

One new owned PostgreSQL 16.15 cluster, loopback TCP only; database
`chaichowk_seed_disposable_wha1382`. Runtime `seed_runtime` explicitly asserted
`rolsuper=false`, `rolbypassrls=false`; the runner checked FORCE RLS on its required
surfaces. Bootstrap and migration administration used a separate role only in this
new cluster. No existing local, staging, foreign or production database was used.

For the original synthetic branch, observed **122 receipt-tracked rows plus one
audit receipt** (including its previously missing owner actor):

| Surface           | Observed rows/state                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Catalog/menu      | 3 products, 3 menu items, 3 price entries; one menu/publication, category and brand                      |
| Modifiers/recipes | 1 modifier group/option/link; 3 ingredients, recipes, active recipe versions and recipe lines            |
| Floor             | 1 synthetic floor, 3 tables                                                                              |
| Owner/staff       | 1 missing owner actor added; 2 synthetic staff profiles without logins                                   |
| Workforce         | 2 scheduled shifts; no attendance asserted                                                               |
| Purchasing        | 1 supplier, 1 received PO with 3 lines, 1 linked receipt with 3 lines                                    |
| Inventory         | 3 stock items/movements; balances 1000 grams each in a separate synthetic pantry                         |
| Orders/KDS        | 3 takeaway orders: 1 SENT, 1 IN_PREPARATION, 1 READY; 3 items/modifier snapshots/tickets/ticket items    |
| Order history     | 12 order events and 12 command idempotency rows                                                          |
| Customers         | 2 synthetic guests; no real contacts                                                                     |
| Catering          | 1 DRAFT order, 2 recipe-linked lines, 1 estimated extra cost                                             |
| SOP               | 1 DRAFT template/version/step; no completed or verified outcome                                          |
| In-app notice     | 1 notice explaining synthetic data and integration limitations                                           |
| External/device   | 1 revoked attribution-only device; 12 outbox rows DEAD with explicit suppression reason; zero print jobs |

Order transitions and receiving use established service paths. Newly generated
outbox events are retained in the existing DEAD state with an explicit suppression
reason, never falsely marked dispatched. Branches with enabled print routes omit
order scenarios; a final transaction check refuses any newly generated print intent
if routing changes concurrently. No email, webhook, AI, payment or hardware call is
made. No external success, regulatory approval or actual printer success is claimed.

## Explicit missing coverage and review limits

- No settled bills, payments, refunds, split settlement, daily closes or financial
  projections. No approved tax configuration is created or inferred; no report
  totals or fake historical financial facts are written.
- No loyalty accrual/redemption; only synthetic customer records.
- No clock-in/attendance, completed/verified SOP outcomes or external notification
  delivery. Scheduled shifts and draft SOP templates are the current coverage.
- Catering planning is draft-only: no deposit, production consumption, fulfilment
  or delivered state. Existing console USD formatting for a PKR tenant remains a
  product limitation outside this seed lane.
- No absent-owner provisioning, Pharmacy membership, credentials for synthetic
  staff, live devices or enabled integration examples.
- This is a smaller package than the legacy showcase. The legacy 35 products /
  34 orders / 31 bills are source-audit facts, not this package's counts.

These gaps require active-supervisor review before describing the account as
seeded for all functions. Staging identity, grants, module availability, target
approval and execution remain with WHA-1384/owner and Claude.

## Verification evidence and provenance

Initial HEAD: `eba7a64017c00c26346de9c39d1fb4c156399469`; exact product base remains
`2d3c0effc3af5d5bdd2351f831f231909b4432c0`. Assigned checkout/branch verified clean
before editing. Prior manifest commits, including `d437b780`, are preserved.

Commands/results:

- `bun test scripts/seed-chaichowk-staging.test.ts`: 8 passed, 0 failed.
- `prisma generate`: exit 0, generated client 7.9.1 from unchanged schema.
- Applied all 106 existing migration SQL files with `psql -X -v ON_ERROR_STOP=1`
  to the single new database. Extension ACL migration initially refused PUBLIC
  EXECUTE; ran existing `prisma/prepare-extensions.ts` with its admin URL supplied
  privately, then resumed unchanged migrations; exit 0. No schema bypass. This
  SQL replay does not create Prisma's migration-history table and is not a claim
  about staging migration status.
- Scoped TypeScript check uses a run-owned config including the four owned scripts
  and their actual imports: exit 0, no diagnostics. Command: `tsc -p "$PAPERCLIP_RUN_SCRATCH_DIR/seed-typecheck.json" --pretty false`.
- Scoped ESLint with repository-lockfile `typescript-eslint@8.61.1` recommended rules: exit 0, no diagnostics. The Next lint-config installation could not resolve `next@16.2.12`, so this is the script-focused TypeScript ruleset, not a claim that the full Next lint preset ran. Prettier check over the four scripts and this manifest, and `git diff --check`: exit 0. No full app build/browser test: no app/product code changed.
- `TSX_TSCONFIG_PATH=scripts/tsconfig.json CHAICHOWK_VERIFY_OWNED_DISPOSABLE=1 node --import tsx scripts/verify-chaichowk-staging.ts`:
  exit 0. All public-table row and sequence snapshots unchanged on dry-run and
  rerun; existing owner password/status/roles and existing/foreign business rows
  preserved; foreign branch rejected before writes; late order-limit failure
  rolled back prior catalog/receiving/stock changes; concurrent first applies
  yielded one apply and one replay; concurrent reruns made no writes; runtime
  role flags asserted and foreign rows invisible under tenant RLS.
- The successful final verifier inspected the already-applied original branch
  and performed a fresh first-application race on another synthetic branch in
  the SAME database. Earlier first application succeeded before test-harness
  enum-order/output-parsing assertions were corrected. No reset or fixture-row
  deletion was used to repeat tests.

Final source concurrency check: the same verifier with `--final-check` exited 0. Two concurrent first applications on different synthetic branches in the SAME disposable DB both applied, created exactly one user-linked owner actor, and left zero print intents and zero pending external outbox rows. This exercised the final shared-owner lock and print-intent guard.

Verification setup limitations/corrections: full and initial minimal dependency
installs hit ENOSPC. Reclaimed only run-owned failed output, pinned the minimal
verification closure to repository lockfile versions and used hardlinks; install
succeeded. Setup also corrected an overlong Unix socket path, bootstrap enum/branch
code and timezone assumptions, and harness enum sorting, immutable-date reuse and
stdout/stderr separation. Initial typecheck found three fixture field mismatches;
corrected against generated Prisma types. pg emitted a query-concurrency deprecation
warning during service execution; checks ran on the pinned pg 8.22.0 runtime.
No raw password, hash or connection value is part of this evidence.

The eight unit tests are not represented as database/RLS proof; the disposable
verification provides that evidence. Database initialization, temporary dependencies,
logs and generated output stayed in this worktree/run-owned scratch. No shared
service restart, cloud write, deployment, push, merge or paused-agent wake occurred.
There is no automatic cleanup/rollback command for an applied seed: preserve and
review the receipt's exact rows rather than deleting tenant data. Application is
atomic; failed transactions require no data repair.

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
