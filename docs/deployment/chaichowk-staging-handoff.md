# Chai Chowk Local LAN / Azure staging handoff

**DRAFT — Restaurant seed independently PASS; human confirmation PENDING. New package UNAPPLIED on both live targets.**
Updated through the supervisor’s 2026-09-06 20:11 UTC amendment (2026-09-07 local date). Preparation is advancing;
this is not package acceptance, release approval, or a claim that all functions are seeded.
Active Codex Desktop task supervises; one designated Codex writer owns Local LAN application;
Claude Code / owner executes Azure **STAGING only**. No production, main, DNS or Vercel changes.

## Sources and current disposition

- WHA-1384 owns only this file, in `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-staging-handoff`, branch `codex/chaichowk-staging-handoff`, unchanged audit base `2d3c0effc3af5d5bdd2351f831f231909b4432c0`. This document remains uncommitted; no source/infra/seed/status.md/canonical edits.
- [Supervisor correction](/WHA/issues/WHA-1384), comment `01374816-8fe1-4b83-bb30-5ae16fc1ceec`, 2026-09-06 17:55 UTC, supplies current package/review/release distinctions.
- [Claude’s supplied blocked preflight](/Users/Saad/.codex/attachments/c6a9260f-50d8-4542-a43b-a63b33c6905b/pasted-text.txt) read in full. Claude reports no Azure changes. Its suggestions are evidence, not permission to push, edit user status, waive credential writes, read secrets, or repair Claude-Mem.
- Canonical `/Users/Saad/Downloads/Projects & Code/DevFathom hub/deploy-staging.md` previously read in full (175 lines), unchanged. Derive the approved candidate at execution; never deploy a SHA copied from this audit or assume its historical worktree constant is current.
- **Current Restaurant package:** private `e75da60b1b81fcfbf2feb8aedb784b4b3420b8a6`, parent `372e1e90d976942eb2deec1a50156332998b9c19`, product base above. Full committed `docs/demo/chaichowk-seed-manifest.md` read READ ONLY from original `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-staging-demo-seed`. No sibling files copied or executed.
- **Independent corrective review DONE/PASS:** [GitHub-first evidence](https://github.com/WhatTheStack1/devfathom-commercial/issues/99#issuecomment-5561185883); [WHA-1383 integrated review](/api/issues/29a88c72-2c65-4774-8dfe-a8f93d1759d6/documents/integrated-seed-review), latest revision `f06b241f-70af-4d6d-b765-11950bf3c478`, final `20cc043c-c8f3-4473-a9dc-784d9e13e8c4`. Applies exactly to e75da60b and lifts the #99 verifier hold only. Original [coverage matrix](/api/issues/29a88c72-2c65-4774-8dfe-a8f93d1759d6/documents/chaichowk-seed-coverage) remains source coverage evidence.
- **Human source-review confirmation STILL PENDING:** WHA-1382 `human_only` interaction `0c8f2143-fc68-40e9-9536-2c5ad444eb43`. Agents must not approve as Saad or equate independent PASS with human confirmation. WHA-1354/WHA-1364 owner policies unchanged.
- Accepted private product `37906386` / 119 unique PASS, independently verified Restaurant seed, and new Pharmacy demo preparation are separate artifacts. None constitutes authoritative WHA-1116 composition, remote QA success, live application or deployment approval.

## Local LAN: completed audit, new package unapplied

Authoritative [WHA-1385 LAN preflight](/api/issues/9b2c89de-05cd-46ef-93ca-e9358d8292ec/documents/lan-preflight), document `ec97d5ca-48eb-46b0-8832-48dd921e8a71`, revision `2bc4ea44-fcc9-4f5e-b4bc-c734b6666be4`, completed 2026-09-06 16:59 UTC; final `1660f795-433b-44ae-9859-3e4d48da1f7d`. This corrects the earlier handoff’s stale “audit not performed” statement. Consume this evidence; do not repeat LAN, DB, network, module or credential discovery.

| Verified item | WHA-1385 result |
| --- | --- |
| Existing service | `http://192.168.3.1:3218/login`; existing Next dev process, not immutable build evidence |
| Actual database | `127.0.0.1:65377`, `devfathom_win7_lan_test_20260906` |
| Runtime role | `devfathom_win7_lan_test_app`, NOSUPERUSER / NOBYPASSRLS |
| Organization / owner | `org_chai_chowk` / `chai-chowk`, RESTAURANT ACTIVE; `owner@chaichowk.pk` = `demo_user_owner`, ACTIVE ADMIN |
| Permissions / branch | Existing `restaurant-e2e-manager`, wildcard ALLOW, zero user overrides; assigned `branch_restaurant_e2e` / `BR-1`, active/default. BR-2 exists but owner is not assigned. |
| Owner staff actor | No linked active or suspended profile, including exact staff-email lookup. Existing preservation-aware helper may link the already-authorized identity; no all-role grant. |
| Migration evidence | 106 history rows/directories; zero missing/unexpected/checksum mismatch/unfinished/rolled-back migrations. Does not exclude every manual schema drift. |
| Source compatibility | Served `0eddf3675a92e3876a5b9f3e642d91d2af538898` versus audit base: `prisma`/`scripts` identical; whole product differs. No build/restart attestation. |
| Historical tenant counts | 36 products (35 demo), 34 orders, 31 bills, 10 payments, 36 stock movements; preserve these rows. |
| Supported module resolver | 13 enabled: 3 baseline + 10 Restaurant; 27 disabled, including Pharmacy. Seat limit 25, active seats 13. Enablement is not actor/device/SOP-depth access proof. |

Limits must retain their exact names: `restaurant.locations.max=2` and
`restaurant-core.restaurant.locations.max=5` coexist; no normalization. Evidence
retention is 365 days, insights retention 24 months; these do not satisfy every
SOP-depth requirement. The LAN report contains the complete limit snapshot.
Existing stable demo IDs/counts support demo/test classification; no formal synthetic
organization flag was found and counts do not certify every row’s provenance.
No password source was read or changed. **Audit DONE does not mean new seed or
live workflows applied/verified.** Preserve services 3218/3217 and business records.

## Azure staging: metadata known, account/access unknown

Reuse the 2026-09-06 read-only audit and Claude’s report; no new Azure or credential exploration.
Subscription `8f456d9c-74ac-4a21-aaa3-2d65719120c5`; group `rg-devfathom-staging-uaenorth`;
app `devfathom-stg`; PostgreSQL `df-stg-7azfl6tid4bb4-pg` Ready, private subnet/DNS,
public network disabled. No supported private read-only database session was supplied.
Staging owner existence/ID, organization/vertical, branch, permissions/modules and
counts remain **unknown, not absent or zero**. LAN metadata is never an Azure default.
Missing live target JSON is an application preflight, not a source-package blocker.

Observed app/job image: `dfacrrz2qg5k5ucouy.azurecr.io/devfathom-commercial@sha256:3a546bd682e04bb5a019b95b59e50c5fdaf9f38c7489c6503a66bc033b218333`;
tag `bootstrap-6cc482c8-20260904011850`. Active/latest-ready revision
`devfathom-stg--dbrepair0904`, Healthy, 100% latest traffic; Azure hostname
`devfathom-stg.bravewater-2487da89.uaenorth.azurecontainerapps.io`. This is not proof
of the candidate. Claude recorded `~/devfathom-gates/deploy/rollback-point-fe1e3e38.json`;
reported backup retention seven days, geo-redundancy disabled, earliest restore
`2026-08-31T01:21:56Z`. These are dated observations, to be refreshed at approved
release preflight. Image rollback does not undo schema/data; recovery needs migration
compatibility and owner-reviewed database recovery metadata.

Key Vault `df-stg-7azfl6tid4bb4-kv` names only: `admin-password`, `app-database-url`,
`auth-secret`, `camera-credential-key`, `cron-secret`, `database-url`,
`platform-admin-password`, `platform-encryption-key`, `seed-password`.
Migration wiring maps `DATABASE_URL`/`EXTENSION_ADMIN_DATABASE_URL` to `database-url`,
`APP_DATABASE_URL` to `app-database-url`, and initialization password inputs to their
similarly named secrets. **None establishes the Chai Chowk owner password source.**
Never substitute them or print values/hashes. Preserving existing passwords needs
no blanket new approval; actual release/target gates still apply.

## Delivered command contract — NOT approved for live execution

The same package supports `lan`, `staging` and owned `disposable` targets. Existing
ACTIVE ADMIN owner, ACTIVE RESTAURANT organization/branch, assigned branch, PKR,
matching identifiers/timezone and required existing capabilities are mandatory.
Missing owner returns `OWNER_PROVISIONING_REQUIRED`: **this version does not create
accounts or consume an account-creation password input**. Provisioning, if needed,
is separate. Suspended/ambiguous actors refuse; existing passwords, roles, statuses
and business rows are preserved. Owner actor creation alone does not unlock Ops.

Secret input NAME: `CHAICHOWK_SEED_DATABASE_URL`, supplied privately to a fresh
standalone process with normal dependencies/generated Prisma client. Other
`DATABASE_URL`, `TEST_DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL` inputs must
be absent or exactly identical. No dotenv; startup GUC/service/host overrides refuse.
No connection URL, credential, PIN, hash or token in logs, argv, screenshots or history.

Operator-reviewed nonsecret target JSON fields, exactly as delivered:
`environment`, `host`, `port`, `database`, `organizationId`, `organizationSlug`,
`vertical`, `branchId`, `branchCode`, `ownerUserId`, `email`, `currency`, `timezone`,
`businessDate`, `scenarioAt`, `approvalReference`, `expiresAt`.
Use RESTAURANT / PKR / `owner@chaichowk.pk`; explicit business date and UTC ISO
milliseconds scenario must agree with actual branch timezone/cutoff. Expiry is future,
within 24 hours. LAN endpoint is fenced to the audited host/port/database above;
staging requires its own approved non-loopback endpoint and `sslmode=verify-full`.
No actual approved target JSON is supplied by this document.

Commands copied from the delivered manifest; paths/digest placeholders are not
existing artifacts. Execute only from the reviewed/composed package, after the
relevant gates, by its designated writer—not a sibling worktree against staging.

```sh
# Default READ ONLY dry-runs; documented, not executed here.
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-lan.json
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-staging.json

# Application syntax only; NOT current live execution approval.
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-lan.json --apply --confirm <reviewed-LAN-digest>
TSX_TSCONFIG_PATH=scripts/tsconfig.json node --import tsx scripts/seed-chaichowk-staging.ts --target /secure/approved-chaichowk-staging.json --apply --confirm <reviewed-staging-digest>
```

Dry-run returns static planned counts, helper/service names, gaps and a target-specific
digest—not observed helper insert counts. Stable namespace `ccdemo_v1_<hash(organizationId:branchId)>_`,
fingerprint `v2-integrated`; date/owner/groups pinned. Receipt and audit tombstone cover
created references and hashes; changed/missing rows or incompatible v1 receipts refuse,
not repair. Deleting both markers and all evidence exceeds detection guarantees;
retain operator-side sanitized evidence. No destructive cleanup/reset command.

## Limited independent disposable PASS — not live acceptance

Reviewer ran exact e75da60b from an immutable export on ONE fresh owned PostgreSQL16
cluster with 106 unchanged SQL migrations, restricted runtime/FORCE RLS, explicit
`TZ=Asia/Karachi`. Main, `--billing-check`, then `--billing-replay-check` ran on the
SAME DB in order, all exit0, with no reinitialization. Eleven main assertions passed;
all public rows/sequences restored unchanged and immediate original-target dry-run
and apply replay produced zero writes. Reviewer cluster stopped; nothing ran here.

| Scenario | Independently observed result / limit |
| --- | --- |
| Full prerequisite main | **227 fixture rows + 2 audit markers**, including 65 Catering and 43 Operations rows. Supersedes stale 218 count; nine additional billing records account for difference. |
| Core | Recipes/catalog/modifiers, floor/stock, linked PO/receiving documents; 3 live takeaway order/KDS states; suppressed external outbox. |
| Catering | 4 orders: DRAFT, two QUOTED, pre-production CANCELLED; recipes, estimated costs, planned deliveries/events. No later fulfilment proof. |
| Operations | Shifts/break/swaps, rejection, SOP examples/evidence and local notifications. Actual actor/grant/roster/quota/depth prerequisites remain; no fabricated safety approval. |
| Separate billing branches, same DB | Actually reached absent-owner crossbranch first applications: **8 OPEN bills, PKR1320, 4 fractional, 0 tenders, exactly 1 owner profile, 0 new staff capability grants, 0 print jobs/pending external outbox**. Both branches' dry-run/apply replay preserved every row/sequence. Not additive to main's 227-row count. |
| Reused checks | No old 35-test/helper/unit/full-build/browser reruns. Earlier 35 = 10 root + 7 Catering + 18 Operations, not 35 new independent tests. Types/lint/format remain builder-attributed. |

Historical exact `682327b3c437db188bfadbe012044c57747974a6` review **FAIL** remains
valid history: duplicate `payments:collect` insertion blocked fresh billing bootstrap;
JS Date serialization shifted restored Catering timestamps in Asia/Karachi. Corrected
verifier removes the duplicate and restores PostgreSQL `row_to_json(t)::text` unchanged,
then asserts complete snapshot equality and original-target replay. Only verifier and
manifest changed through e75; runner/core/helpers/root tests retain identical blobs.
This was verifier evidence failure, not established live runner data corruption.

PASS proves that focused correction and inherited source-safety checks. It does not
prove Prisma migration-history, all normal-product-writer races, live account/workflows,
all functions, policy or release approval. Retain operator-side receipts; validate
actual synthetic actors, capabilities, quotas/depth, unexpired target and stable
operational state before separately authorized application. Profile creation grants
no Operations permissions. Changed receipt rows refuse without repair; deletion of
all markers/evidence exceeds in-DB detection guarantees.

**Missing:** settlements/payments/refunds, closed sales/revenue/history, financial
projections, loyalty accrual/redemption; actual Catering CONFIRMED/production/READY
consumption/deposits/dispatch/delivery/CLOSED outcomes. OPEN bills are not settled
revenue. No physical printer/camera/device, external payment/email/webhook/AI, licence,
tax or clinical success. Catering UI hardcodes USD for PKR; product limitation,
not a seed fix. No discovered Restaurant table-reservation surface. Separate Pharmacy
workspace under the same email is **recommended and schema/login-supported, not
confirmed or provisioned**; do not reask here, convert Restaurant, or broaden roles.

## New Pharmacy DEMO preparation — source only

Saad renewed Pharmacy/all-Codex completion priority. Per the 19:12 UTC supervisor
update, six lanes are newly assigned from exact private product `37906386`:
WHA-1388 target/preservation runner; WHA-1389 stock/purchasing helpers; WHA-1390
POS money/returns helpers; WHA-1391 retention/report examples; WHA-1392 business
oracles; WHA-1393 safety review. At that snapshot code was not delivered. The
20:11 UTC supervisor amendment now reports genuine partial source, not a complete package:

| Pharmacy lane | Current private source / evidence, supervisor-attributed |
| --- | --- |
| WHA-1388 root | Draft + atomic receipt `375f4b17`; corrected verifier `59dc93f0` / `d8747b9e` undergoing actual disposable PostgreSQL proof. No package PASS claimed. |
| WHA-1389 inventory | `d6f6b683`, prepared-receipt conditional service path; under WHA-1392 QA. |
| WHA-1390 cash | `711b6314`; under independent [WHA-1398](/api/issues/3740a078-94ed-43ac-a387-e9d2345c46a0) review. |
| WHA-1391 readback | `fc47454b`; narrow source-PASS by [WHA-1397](/api/issues/af6dbade-ed43-48af-a315-ac17268b2786), six actual-reader composition checks. Not SQL/RLS/live proof. |

No future commands or all-functions promises are supplied here; never run
`seed-pharmacy-e2e.ts` on live targets. Separate Pharmacy workspace
under the same email remains recommended, not approved/provisioned; no Restaurant
conversion, live activation/grants or fake clinical credentials. Do not reask the
workspace question or reinterpret source preparation as live provisioning authority.

## Reported staging login failure — diagnosis independent of deployment

Supervisor reports Saad's screenshot shows `https://staging.devfathom.com/login`
rejecting `owner@chaichowk.pk`. Generic invalid credentials does not prove a wrong
password or absent account. Staging identity/status/org and failure cause remain
unknown; no new login or live probe was performed here. Do not ask for the URL again
or require green deployment merely to inspect the existing account read-only.
The narrow owner-run Claude diagnostic below is proposed, not executed, and grants
no Codex app-shell/tunnel permission.

## Release evidence and smallest existing-mechanism option

Claude correctly reported remote/candidate `fe1e3e383c8b966cdb68669ba5366db00fe2320a`,
[qa.yml run 33976399055](https://github.com/WhatTheStack1/devfathom-commercial/actions/runs/33976399055):
automated PASS / browser FAIL; 5 unexpected, 6 skipped, 6 did-not-run, missing platform
report. Main freshly verified at approximately 20:00 UTC on 2026-09-06 that
`restaurantv2` remains this exact SHA/run FAILURE; no push, deployment, LAN seed
or Azure seed occurred. This is supervisor-supplied evidence, not a new remote
probe by this lane. These are old **exact-head** failures.
Already-delivered private corrections and product `37906386` / 119 unique PASS do
not change that run, and neither that product nor seed delivery constitutes accepted
WHA-1116 composition or release approval. Do not redispatch historical fixes or rerun
WHA-1370’s two test-only corrections here. User/supervisor’s dirty historical
`status.md` must not be deleted, staged or committed by this lane.

`infra/environment.bicep:98-111` ALREADY defines `migrateDatabaseCommand` and selects
it when **seedDatabase=false AND bootstrapDatabase=false**. Verified in reported
remote source and Restaurant package. Their `infra/staging.bicepparam:10` enables
`seedDatabase=true`, appending `bun prisma/seed.ts`; this remains historical/current
remote configuration, not the new private fix described below.

**20:11 UTC source amendment — WHA-1394 / WHA-1395:** private candidate
`33077b3ea60ea43049fbca9c6a4a78afcb672e19`, exact parent
`37906386a59700ce4a168e410ca68594baa97c75`, now selects false/false using that
existing mechanism. Only `infra/staging.bicepparam` and
`tests/production-deployment-contract.test.ts` change, +3/-3. Independent narrow
**source-PASS**, seven tests PASS; builder also compiled Bicep offline (not repeated
by reviewer or this lane). [Full WHA-1395 review](/api/issues/288a2077-e8e4-414a-b98d-845b255533b4/documents/staging-seed-preservation-review),
document `33516a84-5660-46af-b62d-c21bf10b100f`, revision
`e5ba0f31-a0f4-4c08-8788-e2445baee7fd`, read in full.

This accepted private source is **UNAPPLIED / uncomposed**, not deployment or human
source approval. It selects extensions + migrations + runtime-role + catalog,
without generic seed/bootstrap; initialization secret references/inputs are omitted
from the migration job, database secret references retained. Release owner must
review composition and remaining mutating/secret scope before the separate accepted
account seed follows successful preparation. No new deployment mechanism needed.

The existing base command still runs prepare-extensions, migrate deploy,
prepare-runtime-role and sync-catalog. Review those role/catalog writes and retained
secret scope; “migrations-only” is not a promise of schema-only or read-only behavior.
No approved live configuration change has been applied. The generic seed refreshes
credentials/permissions; a waiver is not an accepted solution here.
`infra/deploy-staging.sh` regenerates DB/auth/encryption/cron inputs and updates the
app before starting migration; retaining initialization vault secrets alone does
not make it secret-preserving. No safe bootstrap replacement/release invocation has
been approved/applied. Existing workflow orders migration before app update but uses
the configured job. Do not run bootstrap, dispatch workflow, grant roles, use app
shell/tunnel/job overrides, or change infra under this document’s authority.

## Short paste-ready Claude preflight reply

```text
Do not deploy yet. Restaurant seed corrective review is DONE/PASS at the exact
private package documented in this handoff, but WHA-1382 human_only source-review
confirmation remains pending. Do not approve it as Saad. Partial Pharmacy root,
inventory, cash and readback source now exists, but combined proof/reviews remain
incomplete; no live-ready package or Pharmacy provisioning is established.
Both new live seed applications remain UNAPPLIED; read-only LAN preflight is DONE.
The private false/false staging preservation fix has narrow independent source-PASS
but remains uncomposed/unapplied. Its wrapper still regenerates secrets and updates
the app before migration; runtime-role/catalog still mutate. Do not run bootstrap
or treat this fix as login diagnosis. Remote exact-head QA remains FAILURE.

Independently of the red deployment gate, diagnose the existing rejection of
owner@chaichowk.pk at https://staging.devfathom.com/login using ONLY already-configured
staging DB access in STRICT READ ONLY mode. Report explicit account existence/status,
organization/vertical and a sanitized authentication error from already-available
evidence. Generic invalid credentials does not establish wrong password or absence.
Do not select/print hashes, secrets, connection strings or unrelated tenant/customer
rows. No reset, seed, deploy, permission/network change, new tunnel or job override;
stop if existing approved access is unavailable. This diagnostic has not run yet.
Do not require deployment simply to inspect the account; do not repeat LAN audits.

Release remains blocked separately: human source confirmation and applicable owner
policies, authoritative WHA-1116 composition/review, exact composed HEAD qa.yml numeric
failed=0 AND pending=0, reviewed secret-preserving release configuration and valid
staging target input/access. Existing seedDatabase=false plus bootstrapDatabase=false
selects the base migration command; review its role/catalog/secret scope rather than
invent a deployment system. No live configuration change is approved here.
Your historical remote exact-head failure remains correct; do not redispatch delivered
private corrections, edit user status.md, repair plugins or fetch secrets from the
old report's suggestions. Report package, LAN, Azure and Pharmacy status separately.
```

## Subsequent execution and evidence gates

Claude must first read canonical, this handoff, the committed accepted seed manifest
and coverage/QA9 verdict plus the still-required human source confirmation. Derive candidate from actual clean approved worktree HEAD;
review full source scope/ancestry/composition, including integrated helper scripts and
runtime dependencies. No audit SHA above pins deployment. Require approved fast-forward
release path and owner release/target authorization; no automatic authorization from
canonical’s red/pending “deploy anyway,” login-retry or optional SQL-grant branches.
Missing/red/skipped/cancelled required gates stop execution. Require exact-head qa.yml
completed success with numeric failed=0 AND pending=0 and complete report provenance.

Before live mutation record active/ready revisions, traffic, app/job image and immutable
digest provenance, migration plan/compatibility, backup/PITR and rollback reference;
resolve concurrent release ownership. Use approved private READ ONLY staging access
with explicit account/tenant/branch/module/count projections, never hashes or arbitrary
customer data. Existing LAN evidence stays with its single writer. No cross-target
identity or password assumptions. Preserve credentials/business/permissions; absent
staging owner stops this existing-account runner, rather than falling back to a seed.

After release/target gates pass: reviewed migrations must succeed for the exact image
and execution ID; record result/duration and schema readiness. At the approved separate
seed point, review target-specific dry-run and gaps before manifest application.
Do not blindly execute helper verification against live targets or broaden permissions
to force Ops coverage. Capture actual inserted counts, reconciliation, preserved rows,
safe replay/receipt evidence without exposing hashes, and explicit missing workflows.
Failure means stop, no improvised grant/retry/reset/restore. A valid target digest is
not independent safety acceptance or authorization for another target.

Verify ready active web revision, traffic and migration/registry digest match accepted
source. Authenticate owner privately through actual tenant URL; verify permitted
seeded views/actions and receipt settings/preview with approved synthetic scenarios.
POS/KDS need separate legitimate device/operator prerequisites; login redirects/HTTP
200 alone are insufficient. Record report/CSV filters, business date, stock/money
invariants and actual gaps; no claimed settled revenue from OPEN bills, imported labour
as real attendance, or simulated devices as physical success. Never log sessions,
passwords, PINs, URLs containing credentials, hashes or tokens.

Final evidence must separately state package-reviewed/ready, Local LAN applied/verified,
Azure applied/verified; exact source/review/approvals, qa.yml run/headSha/counts,
image/digest/revision/traffic, migration execution, seed target/input names/results,
actual counts and preservation/replay proof, authenticated workflow matrix, physical
limits and recovery reference. No “all functions seeded” claim. No new Pharmacy
provisioning until the pending separate-workspace decision is confirmed.

## Verification of this correction

Only this existing document changed; branch/base preserved. Read committed manifest
and supplied reports, checked existing Bicep selection; no live audit repeated.
Whitespace, fences, required contract/gates and file scope checked. No build/test/browser
suite warranted for documentation; builder/QA evidence attributed, not rerun. No
commit, push, seed, migration, secret retrieval, service action, deployment, plugin
repair or agent changes performed. Graph/Claude-Mem unavailable in this session;
known paths used without new exploration or nested CLI/agents. Recovery is document
revision only. Document remains DRAFT pending human source confirmation, applicable owner policies,
source composition/release/access/target gates. Independent corrective review is DONE/PASS.
