# Pharmacy demo evidence runner — WHA-1388

## September 7 approved PO fixture pass

**Result: partial; original replay failed.** Tested immutable source
`30433fc073075ab3ac2c9cfd33c1242c2f7d8463`, tree
`48280c60b3de555ee8b9e15419c9dbacb5f55130`, package digest
`848018282b14ecc01043ac24c764b9a30ce9795c5a909684481ae84a78523daf`.
The single fresh command
`bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts --integrated`
exited **1**. Overall **3 PASS / 1 FAIL**, including all 106 unchanged migrations;
integrated **8 selected / 3 executed / 2 PASS / 1 FAIL / 5 pending / 0 skipped**.

Both default read-only preservation and actual goods receipt/cash/report cases
passed as `wha1388_runtime`, NOSUPERUSER/NOBYPASSRLS/FORCE RLS. The latter
reported 30 writes, 25 generated records, 31 retained rows, sale 100, change 50,
remaining stock 1, two balanced journals/six legs, margin 80, and one anonymous
completed receipt. Retention horizons remain ineligible with null rates.
These are synthetic disposable results, not live onboarding or clinical proof.

Original dry-run/apply replay failed with `PharmacyDemoRefusal: CHANGED_REFERENCE`
at `scripts/seed-pharmacy-demo.ts:1386`. Replay, concurrent execution, late rollback,
changed/removed-row and foreign-history acceptance are not established by this run.
No further correction or execution was attempted. The root runner is outside
this fixture-only pass; active Desktop/Saad must decide and route the next
bounded correction before work can resume.

New database `wha1388_26313b3a023922e0b06c1d26`, directory
`/private/tmp/wha1388-pg-Xm9Z5K`, stopped by verifier; independent `pg_ctl status`
returned no server running (exit 3). `evidence.json`, `failure.txt`, migration and
PostgreSQL logs are retained there. Old clusters remain untouched. Scoped
TypeScript, ESLint, Prettier and diff checks completed without errors. Only the
verifier fixture and this manifest changed; acceptance and live seeding remain
separate gates. This result is an evidence-only addition after the tested commit.

Saad's approval in comment `5f3f3cdf-c2dd-4e45-99a6-16f9e462ff96`
permits one additional correction and one fresh disposable verification cluster.
Base: `054f48effef98d7669029b57fe15bbc4954dd01d`, clean assigned branch.
The prepared TEST PO now transitions APPROVED to SENT after its approval event,
recording sentAt as the existing sendPurchaseOrder procedure does. The unchanged
supplier-licence and status-machine triggers validate that update. This fixture
establishes a pre-existing sent order; it does not prove the send endpoint or
contact a supplier. No runtime, helper, schema or permission changes.

Preflight checked the existing transition function, send procedure, supplier
backstop and receiving trigger. Prior failed evidence below remains retained.
Corrected source is committed before the single integrated verification attempt.
Acceptance results are recorded above; this approval's single pass is exhausted.

## Approved additional fixture-repair pass

**Result: incomplete; receiving scenario failed.** Tested immutable source
`432f63a825d4a2191c59a57424e0c37b5e29c8bb`, tree
`35fb23704e0ddce96a535f4f4578d007f410a705`, package digest
`59b34ad821fb2b296a9254b1cceb5cd4be49215c8ea5fa7a146dca782f2ba309`.
The exact fresh `--integrated` command below exited **1** on the only newly
created cluster `/private/tmp/wha1388-pg-yksd0V`. All 106 unchanged migrations
passed; the read-only preservation case passed under NOSUPERUSER/NOBYPASSRLS/
FORCE RLS with zero writes and unchanged rows/sequences/operator bytes.
Totals: **2 checks PASS, 1 FAIL; 8 integrated selected, 2 executed (1 pass/1 fail),
6 unexecuted, 0 skipped**. No cash/report/replay/concurrency/late-rollback
acceptance is claimed.

The actual `postGoodsReceipt` path failed on `pharmacyGoodsReceipt.update`,
SQLSTATE `23514`: `a goods receipt can only be posted against a sent purchase order`.
The TEST fixture creates an APPROVED PO, whereas unchanged
`pharmacy_assert_goods_receipt_postable` in migration
`20260902150000_pharmacy_goods_receiving` requires SENT or RECEIVING.
The static field/CHECK/FK/enum preflight described below missed this runtime
lifecycle trigger; it was not sufficient to establish service compatibility.
This is a remaining root TEST-fixture defect, not a new finance eligibility
regression. Neither the trigger nor the frozen root/helper sources were changed.

The new cluster stopped; `pg_ctl -D /private/tmp/wha1388-pg-yksd0V/data status`
reported `no server running` (exit 3). Its `evidence.json`, `failure.txt`,
`migrations.log` and PostgreSQL log remain intact. No previous cluster was
accessed. Scoped TypeScript, ESLint, Prettier and diff checks exited 0.
This result section is an evidence-only update after the tested commit;
the verifier remains byte-identical to that tested source. The approved single
additional pass is exhausted. Further fixture correction and proof require a
new bounded decision; no new issue, routing card or correction loop was started.

Saad's explicit additional-pass approval is relayed in Desktop comment
`8ce202a8-545b-4624-ae6f-f4e0d63c1ba1`. Starting clean source:
`fde9e44605792e3748b74bf5b7072e3cbe03a2cc`, parent
`082d1974c9d2e1c781508170c041cb2dacea5090`, tree
`c7ccef15e76c1ed17ab67b6fa92c259feaaf96fe`, package digest
`99d71d814cf884b99f40b63500de3042d7aa25a0069cf4050913f5c23695b6a8`.
Only this verifier and manifest change. Root execution/contract/regression and
accepted inventory d6f6, finance f191, retention fc474 inputs remain frozen.

The original device placeholder violated the unchanged CHECK in
`20260902200000_pharmacy_offline_counter_runtime/migration.sql`: the stored
value must match `^[0-9a-f]{64}$`. The verifier now computes SHA-256 from the
public namespace plus `synthetic-only`, matching the read-only inspected fixture
pattern in the independent cash review's `tests/pharmacy-demo-cash-review.db.test.ts`.
That uncommitted review file is not imported, copied or executed. No existing
credential is read; the synthetic value is never used for device authentication.
No constraint, schema, service or permission changes accompany the repair.

Preflight covered all 28 INSERT statements against current Prisma required
non-default scalar fields: no omissions remain, including `users.title`.
Migration checks also cover device format/revocation/name/actor; open drawer
float/close facts; profile date intervals; distinct PO creator/approver and paired
approval timestamps; receipt PO-versus-direct shape; line quantity/money/accepted
split; branch-scoped receipt/location/product/pack foreign keys; and enum values
including RACK_BIN, UNIT, DAY, APPROVED and SUBMITTED. The prepared line has two
accepted UNIT packs, no rejection, cost20/MRP100; cash150 is sufficient. These are
static fixture checks, not database acceptance. Stock balances retain their actual
composite primary key; the verifier does not fabricate an `id` or stock balance.

Publish the corrected immutable source before exactly one **new** owned cluster:

```sh
bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts --integrated
```

The previous `BVqlKW` cluster and evidence stay untouched. No resume option is
used for this pass. All 106 unchanged migrations follow extension preparation;
all eight existing integrated cases remain selected. Evidence now explicitly
reports selected/executed/unexecuted/skipped counts and the source tree. A failed
bootstrap is never counted as an executed scenario. Results belong to the exact
source SHA/digest in its retained report and the WHA-1388 issue comment; publication
of this pre-execution manifest does not claim success. A passing builder result
still requires a separate independent fresh integrated review routed by Desktop.

## Current revision: integrated disposable TEST execution

Desktop delivery `a3fc7328-1288-47d4-99e9-6f5c03b6e9af` clears the GitHub101
source-delivery blocker. Starting checkout was clean `f1770314613994a012f7e86c4bf8e170da532742`,
parent `0d5e9de3e2ca4d4942e779138031edbd46b94b90`, tree
`eaac4c84909a952ff4a005d9efc50bca866c3638`, on the existing
`codex/pharmacy-demo-runner` branch. The original failed regression and report
below are retained. Their blocker disposition is historical.

Only the finance source/test pair is replaced with accepted
`f1919dbdbfe9825f0290ac8d1ab62f8e664073f5` bytes. SHA256 values:
source `ad8b515e160126c0278928b9636f81e72b55f4d7cc382b78127faa928303ccfe`,
test `68c59f04ca2337747420535d0c9398548b785a0189451d4e4bdf7a318720083b`.
Inventory `d6f6b683` and retention `fc47454b` pairs stay byte-identical. Shared
helper contract semantics and namespace are unchanged. `PharmacyDraftRequest`
adds an optional `integration` object containing existing `goodsReceiptId`,
`stockLocationId`, `deviceId`, `drawerSessionId` and integer `cashReceivedMinor`.
The default remains read-only; only the existing private disposable SQL fence
accepts a reviewed digest/expiry. LAN/staging and top-level `--apply` remain disabled.

The root now composes its existing draft PO with accepted
`executePreparedInventoryReceipt` (`postGoodsReceipt` / `receiveLot`), then the
actual generated lot with `executePharmacyDemoCashSale`, then
`readbackPharmacyDemoRetention`. All execute in the same owning `withTenantDb`
transaction. No helper opens a connection, creates an account or owns a nested
independent transaction. No receipt valuation journal is invented: receiving is
stock-only; the cash helper posts its actual sale/tender journals.

Root checks actual runtime/migrations/FORCE RLS, active Pharmacy target/owner,
existing purchasing grants, active namespaced TEST actor/device/location/drawer,
current OTC UNIT product/pack, prepared receipt/approval, current branch profile,
effective module entitlements and the owner's real ABAC report capabilities.
No request flag creates permission. Applying holds the stable namespace advisory
lock and table locks covering prerequisites and affected domain tables.
Entitlement control-plane resolution remains a **separate transaction**; neither
atomic tenant observation nor SQL READ ONLY is claimed for that callback. Default
dry-run is a sequence of tenant read-only observations, not an atomic snapshot;
apply reobserves and checks the reviewed digest under its locks.

Replay reconciles original external history and both audit markers before dynamic
planning or fresh-only helper calls. The atomic receipt retains original TEST
prerequisite rows, every resulting branch-domain ID/scalar hash, receipt-number
sequence, and original service/report results. Database JSON preserves scalar
timestamp precision for domain rows. Returns/refunds and other rows in this bounded
TEST footprint also participate in preservation checks. Missing, added, or edited
retained rows refuse; nothing is reconstructed. Safe projections exclude user
credentials and device secret hashes. Replayed reports are retained observations
at their original cutoff, not refreshed business metrics. `writes` on apply counts
distinct inserted/changed retained rows plus the two audit markers, not SQL statements.

The external intent and prepared record use the existing awaited fsync protocol.
An uncertain or rolled-back transaction keeps its intent and refuses recreation.
No crash/fsync injection or adversarial external-file atomicity proof is claimed.

Run the genuinely new integrated proof after publishing the immutable source:

```sh
bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts --integrated
```

This reuses the existing verifier bootstrap, creates one new short-socket private
TEST cluster, applies all 106 unchanged migrations after extension preparation,
and checks restricted NOSUPERUSER/NOBYPASSRLS/FORCE RLS execution. Six target
branches have TEST-only prerequisite fixtures; the runner creates only its
business outputs. Cases cover actual receiving/cash/report readback, original
zero-write replay with all row/sequence/operator-byte preservation, concurrent
same-target apply, late tombstone failure rolling back all business outputs,
changed/removed generated sequence refusal and foreign external history refusal.
The verifier stops its cluster and retains `evidence.json`, migrations and any
failure diagnostics in its owned directory. No previous cluster is reused.
Proof results and exact immutable source SHA/digest are published on WHA-1388;
this pre-execution section does not claim a passing SQL result.

Initial source `082d1974c9d2e1c781508170c041cb2dacea5090`, digest
`a80cd21e3e40b40b8a08e5e3fe011eeac694fdc8b30983ecaf3109be641c2983`,
ran the command above on new owned `/private/tmp/wha1388-pg-BVqlKW`.
All 106 migrations passed; initialization failed before any scenario because the
TEST actor insert omitted required `users.title`: **1 migration check pass,
1 bootstrap failure, exit 1**. Cluster stopped; original diagnostics retained.
One correction supplies the fixture title and makes each branch fixture batch
transactional. Static schema inspection also corrected the footprint observer:
stock balances have a composite primary key, not an `id` column. Their retained
identity is the actual organization/lot/location/disposition tuple, not an
invented generated ID. The verification snapshot similarly orders by SQL row JSON.

The corrected verifier permits **one same-run initialization continuation only**:

```sh
bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts --resume-integrated-initialized /private/tmp/wha1388-pg-BVqlKW
```

It checks the original run marker, PostgreSQL version, previous bootstrap-only
evidence, absent TEST actors and zero orders/lines/audits. It preserves the first
report and failure under `initial-bootstrap-*`, does not redeploy migrations or
reset business data, and cannot resume executed scenarios. This is not a clean
one-shot bootstrap claim and creates no second PostgreSQL cluster. The remaining
integrated proof is still required; corrected source is published before execution.

Scoped TypeScript and ESLint cover the changed root files and actual imports;
Prettier excludes the immutable helper pairs. Initial TypeScript identified three
nullable-actor errors; an explicit assertion corrected those before SQL execution.
An initial exact-copy patch had malformed hunk headers and changed nothing;
corrected application preserved accepted bytes. No product dependency changes.
Read-only sibling toolchain package, lock and Prisma schema match local SHA256.
Relevant installed Next guide and security/privacy gate applied; unavailable
graph/Claude-Mem/Ponytail tools remain unavailable, without claimed activation.

Coverage remains limited: starter TEST receipt stock, one anonymous OTC cash sale,
its receipt/drawer/journals/margin, and actual branch report readback. Prepared
approvals, licences, profiles, actors and devices are TEST prerequisites, not newly
seeded authorization or onboarding. Procurement approval/send, receipt valuation,
supplier settlement, Rx/controlled/clinical workflows, fiscal/provider/printing,
customer consent/outreach, mature cohorts and hardware remain UNSEEDED/OWNER-INPUT.
No all-functions claim, live execution, deployment, push or merge. Independent
integrated review must be routed by active Desktop after this proof.

## Historical revision: disposable draft and atomic receipt

This section supersedes the historical offline-only limitations below for the
**fresh disposable TEST target only**. LAN and staging application remain disabled
and unauthorized. No helper artifacts are integrated. No product service, schema,
migration, dependency version, account, permission or clinical record is changed
on an existing target.

The new `runDisposablePharmacyDraft` uses the genuine `withTenantDb` owning
transaction and `createCentralPurchaseOrder`. It creates exactly one namespaced
DRAFT purchase order with one canonical-unit line, zero synthetic draft price,
one awaited `tx.auditLog` receipt and one awaited tombstone. Database-generated
PO, line and audit IDs are retained; none are forced. Every PO/line scalar,
including timestamps and status, contributes to its retained SHA256. Reference
IDs and scalar hashes survive later changes and package revisions. No stock,
approval, goods receipt, posted revenue, payment, journal or external effect is
created. This is DRAFT-ONLY coverage, not Pharmacy onboarding or all-functions
acceptance. Existing coverage gaps below still apply.

`--evidence` retains the original offline behavior. The new executable form is:

```sh
bun --no-env-file --conditions=react-server scripts/seed-pharmacy-demo.ts --disposable /owned/path/request.pharmacy-demo.json
```

The document has exactly `target`, `request`, `options`. See the exported
`DisposablePharmacyTarget`, `PharmacyDraftRequest` and `PharmacyDraftOptions`
types. Empty options perform actual SQL observation in a READ ONLY transaction.
Apply requires that observation's `reviewedDigest` and an expiry within one hour.
Those fields bind a reviewed plan; they do not authorize a live environment.
The runtime accepts no arbitrary URL and loads no dotenv files or credentials.
It binds only an owner-private `wha1388-pg-*` directory under canonical `/tmp`
directory and its Unix socket. It independently asserts actual database name,
cluster identity, runtime role, no network address, NOSUPERUSER, NOBYPASSRLS,
tenant/user settings, row security, forced RLS on all 13 involved tables, and
the complete applied 110-migration checksum manifest. The schema source is pinned.
The verifier creates this identity; no existing database is reused.

Actual tenant, active unique owner, active existing test purchaser, org-wide
purchasing access, branch, currency, timezone, date, effective procurement
entitlement, supplier/licence and medicine/presentation/pack relationships are
queried. User queries exclude password/token/2FA fields. Entitlements use the
existing resolver's separate **read** transaction. It is not covered by the
draft transaction; no writes are performed there. The domain service and both
receipt rows use the one owning transaction. This TEST-only path makes no claim
to authenticate a live browser session or owner email.

An advisory transaction lock serializes each stable database/tenant/branch
namespace. SHARE table locks prevent prerequisite mutation during apply. The
disposable runtime has SELECT, INSERT on the three output tables and UPDATE on
the ten prerequisite tables solely because PostgreSQL requires that privilege
for SHARE locks. Runner code never issues UPDATE or DELETE. Fixture bootstrap
is privileged; all actual runner/RLS tests use the restricted role. No policy,
constraint, trigger or migration is weakened.

The operator history is a required private, bounded, retained file initialized
once by the fresh verifier. The runner never creates a replacement genesis.
It fsyncs intent before business writes and the original generated mappings
before transaction completion. A successful replay compares both stored audit
rows, all generated IDs, original scalar hashes and references **before dynamic
planning**, then returns zero writes without modifying the file. Concurrent
processes reread history after acquiring the database lock. Changed, partial,
foreign, missing or prior-package history refuses; no delete/reseed repair exists.
If SQL rolls back or the process dies after history fsync, the retained intent
or prepared mapping deliberately prevents automatic resurrection. An operator
must retain the directory independently of database retention; deletion or
replacement of both the database and its only external history cannot be
detected by any local-only protocol. Live enrollment/history custody remains a
separate future scope.

Fresh reproduction command (source must be committed and published first):

```sh
bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts
```

The verifier creates ONE private PostgreSQL cluster, uses a socket only, applies
all 106 unchanged migrations through Prisma, creates explicitly synthetic TEST
prerequisites, runs targeted checks, stops the cluster and retains `evidence.json`,
migration output, database data and operator histories. Checks cover default
zero-write observation, generated-ID draft/receipt, identical replay, changed or
missing references, two independent concurrent processes, SQL receipt-permission
failure with rollback, removed history, operator scalar edits and preservation.
Reproduction results will be published as retained issue evidence after execution;
no real-PG PASS is claimed by this pre-verifier source publication.

The first bootstrap attempt at source `375f4b172b01bf30ac8efcb776feb2494b67296c`
failed before PostgreSQL startup or migration: the harness TMPDIR produced a
socket path longer than macOS PostgreSQL's 103-byte limit. The correction uses
canonical `/tmp`. The same initialized, never-started cluster was relocated;
`--resume-initialized <directory>` permits one bootstrap continuation only for
the same initializing Paperclip run, without another `initdb` or database reuse.
No second cluster is required. Initial failure logs are retained with it.

Implementation base: `9691ab142cf05b46cc6154d20302dc9e4cdbe4cf`, parent
`586ad042b5250340d64f9982d50c8b1c4f6a135f`, tree
`c2093e54c52a8043debf9c6a8bfffc43dd5e6e8b`; clean
`codex/pharmacy-demo-runner` checkout. Exact original product remains
`37906386a59700ce4a168e410ca68594baa97c75`.
Ownership: the four root files plus the explicitly permitted
`scripts/verify-pharmacy-demo.ts`. Independent actual-PG review belongs to active
Codex Desktop. No existing human-only interaction is changed by this work.

## Historical source and evidence (prior revisions)

## Canonical namespace correction routing — GitHub 100

Independent WHA-1392 review of root `72ac8671` and delivered helpers reproduced
three mutually exclusive helper namespace rules: inventory `2728f0d` requires
`demo:`, finance `6d84d2b` requires `pharmacy-demo:`, retention `f46bca8` requires
`demo-`. No root-only prefix choice can satisfy all three.

Canonical choice stays **`phdemo_<24 lowercase hex>_`**, exactly the existing
`targetNamespace` output. The shared contract exports `isPharmacyDemoNamespace`;
root validation consumes it. Helpers must import that predicate and accept the
root namespace unchanged, replacing only their local namespace predicate and
updating their own fixtures. Never translate prefixes per lane or change existing
namespace/hash inputs to bypass retained history. This source publication does
not claim helper compatibility until their corrected artifacts are delivered and
the unchanged namespace passes all three real planners.

New focused check:
`bun --no-env-file test scripts/seed-pharmacy-demo.test.ts --test-name-pattern 'canonical namespace contract'`
— 1 pass, 0 fail, 54 filtered, exit 0. Includes a pinned pre-existing namespace,
target-dimension separation, and malformed/alternate-prefix refusal. No prior
suite replay. Independent review's 121 checks characterize the old mismatch;
they are not acceptance evidence for this correction or live seeding.

Root correction is limited to publishing/consuming the shared predicate. Helper
owners WHA-1389/1390/1391 own binding and focused planner evidence; WHA-1392 owns
independent cross-lane verification. Receipt integration remains incomplete as
documented below. No helper files, product services, database or live targets changed.

## Generated-ID contract correction (2026-09-07)

Previous source/evidence remains at `72ac8671086a4d7c46ab2075d80685bb50a508e4`.
The correction replaces planned `id` with a deterministic business `reference`;
`key` remains the logical plan key. Execution results use `DemoObservedRecord`
with `planKey`, service-returned `persistedId`, retained `receiptReference`, and
observed facts/hash. Neither a reference nor a planned hash proves persistence.
`validateObservedMapping` checks a supplied mapping without establishing its
provenance, creating a receipt, or enabling apply. Helpers are not integrated.

New focused check:
`bun --no-env-file test scripts/seed-pharmacy-demo.test.ts --test-name-pattern 'generated-ID mapping'`
— 1 passed, 0 failed, 53 unchanged tests filtered out, exit 0. It checks generated
IDs distinct from logical references and rejects mismatched keys/models, missing
IDs/receipt references, changed hashes and changed facts. Prior 53-test evidence
is preserved above its original source revision; it was not replayed or presented
as fresh evidence for this correction. Scoped strict TypeScript and ESLint checks
using the previously documented matching sibling toolchain exited 0. Package,
lock and schema bytes still match. `git diff --check` exited 0.

Source-only offline dry-run. **No live application is implemented or approved.**
This package validates a supplied non-secret evidence document, reconciles its
namespace-history facts before coverage planning, and emits a retainable JSON
report. It never connects to a database, invokes a service, imports another seed,
loads connection settings, provisions an account, or writes business data.

## Transaction seam findings after the support correction

- `src/lib/pharmacy/central-purchasing.ts:62` exports
  `createCentralPurchaseOrder(db: ScopedDb, scope, input)`. It checks organization
  purchasing grants, supplier authorization/current licence, active branch and
  catalog existence, then returns the created order including generated line IDs.
  It starts no independent transaction. `reference` is supported; caller IDs are not.
- `src/lib/tenancy/scoped-db.ts:84` exports
  `withTenantDb<T>(organizationId, run: (tx: ScopedDb) => Promise<T>, options)`.
  It owns the Prisma transaction and tenant/user settings. A draft and awaited
  receipt delegate writes can technically commit or roll back together here.
  It does not authenticate the supplied user ID or grant purchasing authority.
- The existing audit service is `recordAudit(row: AuditRowInput): void` at
  `src/server/audit.ts:368`. It accepts no caller transaction. It opens its own
  `withTenantDb`, returns before persistence, and catches/logs failure at line 436.
  Calling it inside the draft transaction permits a committed draft with a failed
  receipt, or an independently committed receipt followed by draft rollback.
  `flushAuditWritesForTest` only waits for independent writes; it does not make
  them atomic. This API cannot supply the required durable receipt contract.
- The accepted Restaurant script uses direct `tx.auditLog.create` for its own
  receipt/tombstone (lines 585–615), not this service. The table is available;
  this is **not** evidence that PostgreSQL or `withTenantDb` lacks atomicity.
  Reproducing that storage protocol would be new runner receipt code, requiring
  namespace locking, generated-ID mapping, retained-fact reconciliation and
  rollback/concurrency proof. No general seed framework was copied.
- Existing authenticated paths are `resolveTenantActor` in
  `src/lib/tenancy/tenant-actor.ts`, `createTRPCContext` and
  `auditedProtectedProcedure` in `src/server/trpc.ts`, and the purchasing mutation
  at `src/server/routers/pharmacy-purchasing.ts:1327`. The mutation receives its
  actor from `ctx.session.user.id`, and middleware checks active session/module
  access. Calling the domain service with evidence-JSON booleans would bypass
  those checks; it is not an authenticated preflight.

Integration remains incomplete. Under the instruction to stop at an exact missing
service contract, the identified boundary is a caller-transaction receipt API
that propagates failure. Active Codex Desktop owns routing that contract work
outside the four-file lane, or directing a bounded runner-owned audit-delegate
receipt implementation. No change to the purchase-order service is needed for
the ID correction. This is a technical escalation, not a request to approve the
offline evidence or grant live-write authority. No disposable PostgreSQL was
created because no database-writing path was changed or claimed proven. No
database, RLS, authorization, rollback or concurrency acceptance is claimed.

The JSON observations are operator-supplied claims. A digest binds their content;
it is **not a signature, proof of authorization, live observation, RLS test, or
proof that an approved Pharmacy workspace exists**. A valid offline report sets
`liveTargetVerified: false`, `applyEnabled: false`, `writes: 0`, and
`plannedRecords: 0`. Seed safety acceptance and live application remain separate.

## Source and ownership

- Checkout: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/pharmacy-demo-runner`
- Branch: `codex/pharmacy-demo-runner`; initial working state clean.
- Exact base: `37906386a59700ce4a168e410ca68594baa97c75`
- Base parent: `2a32649afacd9763d97778acbf7a41bbeb256975`
- Base tree: `d4d077c986250ee69952ecaff508798143a8d2e7`
- Initial contract commit: `5b00a056`; published on WHA-1388 in comment
  `6a1c2da5-939a-4e85-ab91-3f2238769949` before runner implementation.
- Owned files: `scripts/pharmacy-demo-contract.ts`,
  `scripts/seed-pharmacy-demo.ts`, `scripts/seed-pharmacy-demo.test.ts`, this manifest.

Accepted Restaurant source/manifest at
`/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-staging-demo-seed`,
HEAD `e75da60b1b81fcfbf2feb8aedb784b4b3420b8a6`, consumed read-only. Its executable,
authentication changes and receipt implementation are not imported or copied.
Its receipt/tombstone refusal principle informs the smaller Pharmacy fence.
No Restaurant files, helper-owned files, schema, migration, dependencies or
product functions changed. No helpers integrated without Desktop instruction.

## Running the offline check

Use installed Bun with automatic environment-file loading disabled:

```sh
bun --no-env-file scripts/seed-pharmacy-demo.ts
# exit 2: EVIDENCE_REQUIRED; no file/database access

bun --no-env-file scripts/seed-pharmacy-demo.ts --evidence /approved/location/lan.pharmacy-demo.json
bun --no-env-file scripts/seed-pharmacy-demo.ts --evidence /approved/location/staging.pharmacy-demo.json
# exit 0 only means the supplied offline evidence passed validation

bun --no-env-file scripts/seed-pharmacy-demo.ts --apply
# exit 2: APPLY_DISABLED, before opening any evidence file
```

Neither LAN nor staging evidence exists in this package. Both require separate,
existing, explicitly approved Pharmacy workspace facts for `owner@chaichowk.pk`.
A recommended workspace is not a provisioned workspace. Do not substitute the
Restaurant workspace, a disposable E2E fixture, or real patient data.

Supply the exact `PharmacyDemoEvidence` shape from the contract. No extra keys,
passwords, hashes of passwords, tokens, connection strings, patient fields,
regulatory metadata or network destinations are accepted. File names must end in
`.pharmacy-demo.json`; final-component symlinks, nonregular files and files over
64 KiB refuse. This is a bounded local file reader, not a general filesystem
sandbox. Errors omit input content, paths, IDs and underlying exception messages.

Required evidence:

- Target environment `lan`, `staging` or `disposable`, stable non-secret
  target key, exact organization/branch/owner IDs, PHARMACY vertical, PKR currency,
  timezone, business date and explicit scenario instant.
- Matching observed environment/target/organization/branch/currency/timezone,
  active organization and branch, exactly one active ADMIN owner with exact email,
  matching owner ID and existing branch assignment. Owner report capabilities must
  include `reports:operational` and `reports:financial`, matching the established
  financial-report router checks. This does not assert all service capabilities.
- Observed runtime facts `superuser: false`, `bypassRls: false`, `forceRls: true`.
  These are validated fields, not a runtime role assertion against a database.
- Schema SHA256 and 110-migration manifest SHA256 pinned in the contract. The
  migration digest hashes sorted `prisma/migrations/*/migration.sql` paths plus
  newline plus each file's bytes, in sequence. No migrations are run here.
- Observed effective module facts, existing pre-approved reference IDs/hashes,
  and existing synthetic service actors/capabilities, scoped to the exact tenant
  and branch. Empty arrays produce explicit prerequisite gaps, never grants or
  fabricated references. Reference relationships and actual service capability
  rules still need reviewed helper validation. No pharmacist identity is invented.
- Observation instant no older than one hour, never future-dated. Confirmation
  expiry must be after now and at most one hour after observation. Instants use
  exact UTC ISO format `YYYY-MM-DDTHH:mm:ss.sssZ`; scenario date is checked in the
  explicit IANA timezone. Historical scenarios are allowed when date-consistent.
- Explicit workspace confirmation and a non-secret approval reference. Compute
  `targetNamespace(target)`, then set both target/history namespaces. Compute
  `evidenceDigest({version,target,observed,history})` for confirmation. These pure
  exports do not connect anywhere. Reordering object keys preserves the digest;
  changing any covered fact requires a new digest and operator review.

The stable namespace includes environment, target key, tenant and branch, but
does not rotate with business date, owner or package version. A future live
adapter must independently bind that key to its actual target and immutable
namespace history. Supplying a different label cannot authorize reseeding.

## Preservation and apply blockers

Before producing coverage, the runner refuses mismatched receipt/tombstone
presence, any existing complete receipt pair, or any observed namespace records.
It never repairs, deletes, recreates, resets or replays history. Complete receipt
pairs require a future live reconciliation adapter that verifies retained hashes,
row facts and service resumption state. Absence in JSON cannot prove live absence.

`--apply` unconditionally refuses. There is no hidden opt-in, SQL shortcut,
transaction facade, credential reader, execution adapter, or claimed successful
application. Required future work, owned/routed by active Codex Desktop:

1. Review exact source package, then explicitly instruct integration of delivered,
   reviewed inventory/finance/retention helpers. Their genuine domain-service
   signatures and owning transactions determine orchestration.
2. Implement and review actual target/identity/entitlement/schema/runtime-role
   observation using established read paths, with explicit separately approved
   nonproduction targets. No such target access is authorized in this wave.
3. Implement retained seed receipt/tombstone reconciliation before planning,
   immutable synthetic-record facts, collisions and operator-change refusal.
4. Prove genuine service idempotency, partial resumption, concurrency and
   preservation on authorized disposable infrastructure. Never pretend a caller
   transaction owns a service's independently committed transaction.
5. Obtain separate exact-package and live-target approval with reviewed digest
   and expiry. Fiscal/clinical/provider/hardware prerequisites remain owner-gated.

The stdout `dry-run-report` is retainable with the reviewed evidence document;
it explicitly is **not a seed receipt**. No database receipts are created. Root
must not implement live writes until these blockers are resolved.

## Function coverage

| Function                                                | Source runner coverage                         | Live LAN   | STAGING    |
| ------------------------------------------------------- | ---------------------------------------------- | ---------- | ---------- |
| Target/owner/branch/configuration                       | Offline evidence validation only               | Unverified | Unverified |
| Catalog, medicine, presentation, pack                   | OWNER-INPUT; approved existing references only | UNSEEDED   | UNSEEDED   |
| Purchasing, receiving, stock, transfers, counts         | UNSEEDED; inventory helper not integrated      | UNSEEDED   | UNSEEDED   |
| Sales, returns, tenders, khata                          | UNSEEDED; finance helper not integrated        | UNSEEDED   | UNSEEDED   |
| Journals, settlements, bank reconciliation              | UNSEEDED; no posted financial facts            | UNSEEDED   | UNSEEDED   |
| Operational, financial, growth reports                  | UNSEEDED; no report outputs observed           | UNSEEDED   | UNSEEDED   |
| Loyalty, refills, campaigns                             | UNSEEDED; retention helper not integrated      | UNSEEDED   | UNSEEDED   |
| Prescription, dispensing, controlled drugs              | OWNER-INPUT; no approval impersonation         | UNSEEDED   | UNSEEDED   |
| Safety, recalls, temperatures, regulatory               | OWNER-INPUT; no invented safety state          | UNSEEDED   | UNSEEDED   |
| Providers, catalog crawl, fiscal, email/SMS             | OWNER-INPUT; external effects absent           | UNSEEDED   | UNSEEDED   |
| Hardware, print, branch/receipt permissions, first sale | OWNER-INPUT; separate real-input acceptance    | UNSEEDED   | UNSEEDED   |

D07/D08/D11, 1354/1364 and real-input first-sale acceptance remain gated. No
draft scenarios are integrated yet; any future draft-only rows must remain
labelled DRAFT-ONLY, never posted revenue or completed clinical workflow.

## Evidence and limits

Targeted checks cover happy offline validation, deterministic concurrent pure
calls, input preservation, Restaurant/tenant/branch/owner refusals, schema and
role facts, date/timezone/expiry, capabilities, reference/actor scope, unknown
fields, digest changes, receipt/tombstone/collision refusal, bounded reads,
symlinks, output redaction and unconditional apply rejection.

Initial focused test command `bun test scripts/seed-pharmacy-demo.test.ts`:
**51 passed, 0 failed, exit 0**. Only `.env.example` exists in this checkout;
final commands explicitly disable automatic environment-file loading.
Final focused command `bun --no-env-file test scripts/seed-pharmacy-demo.test.ts`:
**53 passed, 0 failed, exit 0**, including both LAN and staging offline
evidence cases. This supersedes the initial 51-test count.

Final scoped verification commands (all exit 0):

```sh
DEMO_TOOLCHAIN=/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-catering-seed-fixtures/node_modules
"$DEMO_TOOLCHAIN/.bin/tsc" --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types node --typeRoots "$DEMO_TOOLCHAIN/@types" scripts/pharmacy-demo-contract.ts scripts/seed-pharmacy-demo.ts scripts/seed-pharmacy-demo.test.ts
"$DEMO_TOOLCHAIN/.bin/eslint" --no-config-lookup --config "$PAPERCLIP_RUN_SCRATCH_DIR/pharmacy-eslint.config.mjs" scripts/pharmacy-demo-contract.ts scripts/seed-pharmacy-demo.ts scripts/seed-pharmacy-demo.test.ts
"$DEMO_TOOLCHAIN/.bin/prettier" --check scripts/pharmacy-demo-contract.ts scripts/seed-pharmacy-demo.ts scripts/seed-pharmacy-demo.test.ts docs/demo/pharmacy-seed-manifest.md
git diff --check
```

The run-owned ESLint configuration imports the matching sibling's installed
`eslint-config-next/dist/typescript.js` and exports its rule array. It avoids
creating a dependency symlink or writing sibling configuration. TypeScript/lint
produce no diagnostics; Prettier reports all matched files conform. The check
is scoped to this standalone script, not a full application typecheck.

CLI process smoke checks also confirmed the default and `--apply` each exit 2,
emit only the expected refusal JSON (`EVIDENCE_REQUIRED` / `APPLY_DISABLED`),
and leave stderr empty. No failing implementation check or correction pass;
initial absent-dependency/path probes are documented as discovery limitations.

Toolchain: installed Bun 1.3.14; compiler/formatter/linter invoked read-only from
matching sibling `codex/chaichowk-catering-seed-fixtures/node_modules`.
`package.json`, `bun.lock`, and `prisma/schema.prisma` SHA256 values match this
checkout. No runtime Prisma client or generated schema is consumed; no dependency
symlink, install, shared cache write or generated output is needed.
Installed Next environment-variable guide read before implementation.
Codebase Memory CLI indexed this checkout and supplied a focused graph query.
Claude-Mem tools and Ponytail skill were unavailable; no claimed activation.

No database, migrations, builds, browser/server, ports 3217/3218, live seed,
network-effect providers, push, merge, rebase or deployment checks were run.
No live RLS, stock, financial, preservation or database concurrency proof is
claimed. Synthetic test assertions do not prove real onboarding. Independent
technical/source safety review remains with active Codex Desktop. Recovery needs
no database rollback: source removal is sufficient; all business-row writes are 0.

# WHA-1388 integration continuation: blocked on finance helper

Desktop comment `66d4b04d-6ee2-4fc2-93f1-e69f83ea029c` authorized private
composition, not live application. Starting checkout was clean at
`/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/pharmacy-demo-runner`,
branch `codex/pharmacy-demo-runner`, HEAD
`0d5e9de3e2ca4d4942e779138031edbd46b94b90`, parent
`d8747b9e42bb87f603fd34126f2beea5eea39c3b`, tree
`1c8e4ae09fd41f29210b35fe1b2f0f1e27e2a76e`. Product ancestry
`37906386a59700ce4a168e410ca68594baa97c75` verified, exit 0.

Added exactly the six authorized helper source/test files, byte-identical to:

- inventory: `d6f6b68349d556619c28748c48c30db89de4be54`
- finance: `711b631420ca8344f5f42c821274faa3b283f1ff`
- retention: `fc47454b38ba3e1a37ad97b8e59ecc954ed3440e`

The package digest now includes these composition inputs. The shared contract,
root transaction and verifier remain unchanged. Helpers are not yet wired into
the executable. Do not describe this package as integrated or successfully seeded.

**Blocking defect:** [GitHub #101](https://github.com/WhatTheStack1/devfathom-commercial/issues/101)
(`qa`, `pharmacy`, `S2`). Receiving calls `postGoodsReceipt`, `receiveLot`, then
`postReceipt`, whose actual `arrangementFor(2, 1)` result is two sealed packs and
zero loose units. The accepted cash helper refuses zero loose units, even for
UNIT packs. The normal stock service permits a sealed UNIT sale because
`fromSealed % unitsPerPack === 0`. Root's existing pack prerequisite requires
canonical UNIT packs. No fabricated loose balance or unnecessary pack-breaking
workflow was introduced to bypass the mismatch.

Preserved failing check in `scripts/seed-pharmacy-demo.test.ts`:

```sh
bun --no-env-file --conditions=react-server test scripts/seed-pharmacy-demo.test.ts -t 'integrated receiving UNIT stock reaches cash allocation'
```

Result: **0 pass, 1 fail, 57 filtered, exit 1**. Expected
`CASH_ALLOCATION_REACHED`; actual refusal
`UNSEEDED: EXCLUSIVE_PRERECORDED_SYNTHETIC_STOCK`. This is a mocked-read contract
reproduction with the actual arrangement and regulatory kernels. Its in-memory
TEST guard values establish no live clinical authority. The sentinel is the first
read after eligibility, before business writes; this is not a completed-sale or
SQL proof. The failing assertion is intentionally retained, not skipped or changed
to expect the erroneous refusal.

Scoped type/lint/diff checks completed, exit 0 each. The first final Prettier
check flagged this new manifest section (exit 1); one formatting correction
followed, then the final check passed (exit 0).

```sh
node_modules/.bin/prettier --write scripts/seed-pharmacy-demo.test.ts scripts/seed-pharmacy-demo.ts
node_modules/.bin/tsc --noEmit --project "$PAPERCLIP_RUN_SCRATCH_DIR/pharmacy-integration-tsconfig.json"
node_modules/.bin/eslint --no-config-lookup --config "$PAPERCLIP_RUN_SCRATCH_DIR/pharmacy-eslint.config.mjs" scripts/seed-pharmacy-demo.test.ts scripts/seed-pharmacy-demo.ts
git diff --check
```

The scratch TypeScript project extends `scripts/tsconfig.json`, disables
incremental output, includes the root test and its actual imports. Scratch ESLint
uses installed Next TypeScript rules. No dependency installation or helper
formatting. Graph/Claude-Mem tools and Ponytail skill unavailable in this run;
narrow source reads used. Relevant installed Next TypeScript guide read.

No new PostgreSQL cluster or integrated SQL proof was attempted: Desktop's explicit
helper-defect boundary requires routing to the original owner. Existing root
review's 13 PostgreSQL checks remain historical evidence for exact `0d5e9de3`,
not this changed package digest. Preserve its limits: PO-note tamper, no external
operator-file tamper or crash/fsync injection; platform entitlement callback is a
separate transaction. No unchanged characterization suites, builds or services.

Unblock owner: active Codex Desktop routes the finance correction and independent
review, then delivers exact accepted source to WHA-1388. Resume root composition
and the assigned one-cluster integrated proof only after that delivery. Receiving,
cash, reports, replay, rollback and concurrency integration remain unverified.
LAN/staging apply remains disabled; clinical, Rx, controlled, fiscal, provider,
consent, outreach and mature retention coverage remain UNSEEDED/OWNER-INPUT.
No live writes, authentication changes, provisioning, push, merge or deployment.
Source-only recovery needs no database rollback; preserve other workers' files.

## Union re-pin to the restaurant release line (2026-09-24)

The demo package was cherry-picked onto the restaurant release line
(`codex/restaurant-release-20260911` tip `80cd9eb7`) on branch `WHA-1388-pharmacy-union`.
The release line carries **110** migrations, four more than the `37906386` merge-base this
package was pinned against:

```
20260904133000_restaurant_sales_demo
20260905090000_restaurant_demo_reset_append_only_rls
20260905100000_restaurant_demo_reset_delete_rls
20260912053000_organization_ask_fathom_control
```

`pharmacyMigrationManifest()` therefore refused `SCHEMA_SOURCE_MISMATCH` before initdb. The
contract is re-pinned to the union tree, computed with the manifest's own routine:

| pin                 | was (merge-base `37906386`)                                        | now (union tree)                                                   |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| migration count     | 106                                                                | 110                                                                |
| `MIGRATIONS_SHA256` | `c500a70d3ef973afe9a2192421ac0335a1436695f02cc41ab3caab74f28d5024` | `7d333db5ab4b585e11bb396d5834394d76c9617bd8e58515ba9490cb021fe011` |
| `SCHEMA_SHA256`     | `ea8f40a29b95fcba8abfe7a41344402765f1efde5fff9e60f8faccb6a28608a5` | `a1b54cecbe2a34b292496d13a669ef96382c7ec9bdb677e06e2b5084e595a4c0` |

The count is now the single exported constant `MIGRATION_COUNT` in
`scripts/pharmacy-demo-contract.ts`; the four sites that previously hard-coded `106`
(`seed-pharmacy-demo.ts` evidence check and manifest assertion, `seed-pharmacy-demo.test.ts`
fixture, `verify-pharmacy-demo.ts` applied-migration assertion) read it from the contract, so the
pin can no longer drift site by site. `PRODUCT_BASE` is left at `37906386…`: it records the
fork point of this package and is referenced by nothing.

**Every `106` still appearing in the sections above is historical.** Those sections are run
records bound to their own source SHA and package digest and are retained unchanged; they
describe passes against the 106-migration base, not the current pin.

Re-pinning changes `pharmacySourceDigest()`, which covers the contract, the runner, its tests and
this manifest. Evidence retained before this re-pin binds the old digest and is not claimed for the
union line.

## Re-pinned integrated replay on the union line (2026-09-24)

**Result: the schema pin is repaired; the replay defect is unchanged and still red.**

```
TMPDIR=/tmp bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts --integrated
```

Exited **1** on one newly created owned cluster `/private/tmp/wha1388-pg-sXOzFp`
(`stopped: true`). Source SHA `e369609a6b61e2f6b9c81910537bc2fc8e7b73b0`, tree
`84f67877c9e9f1ecee12ed713ffbae938a849c95`, package digest
`07851b5b5551edbb5baa81a604a2db0024ac4348afd020c24bf8f3928f188733`. Totals:
**3 PASS / 1 FAIL; 8 integrated selected, 3 executed, 5 unexecuted, 0 skipped.**

The run's bytes are the committed tree of `e369609a` exactly — the working tree was clean
when it ran — so `07851b5b…` is recomputable from that commit rather than asserted. Appending
this record changes the live `pharmacySourceDigest()`, because the digest covers this file;
that is inherent to the design and is why each run record names its own digest.

What the re-pin bought, and it is the part that was previously unreachable:

- `SCHEMA_SOURCE_MISMATCH` no longer refuses before initdb. The cluster is created, extensions
  are prepared and **all 110 migrations apply**: evidence `normal unchanged migrations`
  `{ count: 110, exit: 0 }`. `ACTUAL_MIGRATIONS_MISMATCH` also passes, so the applied
  `_prisma_migrations` rows match the re-pinned 110-entry checksum manifest.
- The two new `restaurant_demo_reset_*_rls` migrations **pass the FORCE-RLS assertions under the
  restricted runtime role.** Both executed integrated cases record
  `runtimeRole { role: wha1388_runtime, superuser: false, bypassRls: false, forceRls: true }`,
  which is only reachable through `assertSqlRuntime`'s `FORCED_RLS_REQUIRED` check over every
  involved table. No product finding here.
- `integrated default dry-run preserves all rows sequences and operator bytes` — PASS, `writes: 0`.
- `integrated genuine goods receipt cash stock drawer journals receipt and reports` — PASS,
  `writes: 30`, `created: 25`, `retained: 31`, stock 1, 2 journal entries / 6 legs, margin 80,
  change 50, one completed receipt read back through the reports path.

The single FAIL is `integrated original dry-run and apply replay preserve every row sequence and
operator byte`, refusing **`CHANGED_REFERENCE`** at `scripts/seed-pharmacy-demo.ts:1387`
(`failure.txt` retained). This is the WHA-1408 defect described above, not a new regression and
not RLS-related: `receiveLot` fires `pharmacy_inventory_lot_references_pack`, which stamps
`pharmacy_pack_levels."referencedAt"`, so the receipt retains a pre-write `PackLevel` hash and the
first replay after the first integrated apply refuses.

**The union cannot carry the accepted fix, by construction.** The approved Option A correction
(optional `referencesAfter` on `DraftReceipt`, re-observed inside the same transaction, compared via
`requireUnchangedReferences` against `prior.referencesAfter ?? prior.references`) is **uncommitted
working-tree bytes** in `codex/pharmacy-demo-runner` over `79008e4b` — 3 files, +166/−2,
`docs/demo/pharmacy-seed-manifest.md`, `scripts/seed-pharmacy-demo.ts`,
`scripts/seed-pharmacy-demo.test.ts`. It is therefore in no commit in `37906386..79008e4b`, and
`grep -rn 'referencesAfter\|requireUnchangedReferences' scripts/` on this union tree returns nothing.
Cherry-picking the chain ships the known-red baseline. Importing that delta is a separate
authorization; it is not in this scope.

Counts are the same shape as the September 7 record (3 executed, 2 pass, 1 fail, 5 pending), which
is the point: re-pinning moved the failure from "refused before any cluster existed" to "the one
documented replay defect, with 110 migrations and FORCE-RLS proven green on the way there".

Evidence retained outside `/tmp` at
`_gate-evidence/WHA-1388-pharmacy-union-20260924/replay-cluster-sXOzFp/` (`evidence.json`,
`failure.txt`, `migrations.log`, `postgres.log`, six operator histories, stopped `data/`).

## Replay reference baseline correction (2026-09-15, WHA-1388)

Root-only correction of the known integrated replay defect. Owned edit set:
`scripts/seed-pharmacy-demo.ts`, `scripts/seed-pharmacy-demo.test.ts` and this
manifest. No helper, contract, verifier, product, schema, migration, policy or
fixture file was changed.

### Defect

`receiveLot` inserts a `pharmacy_inventory_lots` row; the unchanged product
trigger `pharmacy_inventory_lot_references_pack`
(`prisma/migrations/20260902130000_pharmacy_batch_stock_ledger/migration.sql`)
then stamps `pharmacy_pack_levels."referencedAt"`. `draftReferences` reads that
whole row and `pharmacyScalarHash` covers every scalar, so the receipt retained a
**pre-write** `PackLevel` hash. The first replay after the first integrated apply
re-read the **post-write** row and refused with `CHANGED_REFERENCE`. The guard was
correct; the stored baseline was not. Diagnosis: WHA-1408 comment
`0a2758a7-ea34-4ccc-9155-25bfdde61d9d`, option A.

### Correction

- `DraftReceipt` gains optional `referencesAfter: RetainedRow[]`.
- After `executeIntegrated` and **inside the same owning transaction**, the same two
  readers (`draftReferences`, then `integratedPrerequisites().reference`) run again
  and their result is retained on the receipt.
- The replay comparison moves into exported `requireUnchangedReferences(prior,
observed)`, which compares against `prior.referencesAfter ?? prior.references`.

Invariants preserved. `planDigest` still binds the **pre-apply** `references`, so a
tamper between review and apply is still caught by `REVIEWED_DIGEST_MISMATCH`.
Nothing is excluded from any hash — there is no field or column allowlist — so a
later operator edit to any reference scalar still refuses, including clearing
`referencedAt`, which `pharmacy_pack_conversion_immutable` does not freeze.
Receipts written before this field exists, and every draft-only receipt, carry no
`referencesAfter` and fall back to their original `references` baseline unchanged.

### Focused check (no database, no cluster)

`bun --no-env-file --conditions=react-server test scripts/seed-pharmacy-demo.test.ts`
→ **62 passed, 0 failed**. Four new cases: the product-owned stamp is visible to the
reference hash; replay accepts the retained post-apply observation and rejects the
stale pre-apply one; genuine drift after the stamp still refuses (changed
`unitsPerParent`, cleared `referencedAt`, re-stamped instant); draft-only and
pre-existing receipts keep their original baseline.

Non-vacuity control: with only `prior.referencesAfter ?? prior.references` reverted
to `prior.references` in a scratch copy, the post-apply case fails with exactly
`PharmacyDemoRefusal: CHANGED_REFERENCE` — the retained `Xm9Z5K` failure — and the
file is restored. Mocked row shapes only; the cluster proof is the integrated
verifier case, not this file.

Scoped gates, exit 0 each: scoped `tsc --noEmit`, scoped `eslint`, `prettier
--check`, `git diff --check`.

### Known limit at this revision

The WHA-1437 valuation and WHA-1438 refund components accepted on those issues are
**not** the bytes present in this lane, and importing them is outside this lease's
ownership. See the WHA-1388 evidence comment for the exact blob identities.
