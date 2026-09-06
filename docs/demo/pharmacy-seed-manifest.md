# Pharmacy demo evidence runner — WHA-1388

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
bun --no-env-file scripts/seed-pharmacy-demo.ts --evidence /approved/location/azure.pharmacy-demo.json
# exit 0 only means the supplied offline evidence passed validation

bun --no-env-file scripts/seed-pharmacy-demo.ts --apply
# exit 2: APPLY_DISABLED, before opening any evidence file
```

Neither LAN nor Azure evidence exists in this package. Both require separate,
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

- Target environment `lan`, `azure-staging` or `disposable`, stable non-secret
  target key, exact organization/branch/owner IDs, PHARMACY vertical, PKR currency,
  timezone, business date and explicit scenario instant.
- Matching observed environment/target/organization/branch/currency/timezone,
  active organization and branch, exactly one active ADMIN owner with exact email,
  matching owner ID and existing branch assignment. Owner report capabilities must
  include `reports:operational` and `reports:financial`, matching the established
  financial-report router checks. This does not assert all service capabilities.
- Observed runtime facts `superuser: false`, `bypassRls: false`, `forceRls: true`.
  These are validated fields, not a runtime role assertion against a database.
- Schema SHA256 and 106-migration manifest SHA256 pinned in the contract. The
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

| Function                                                | Source runner coverage                         | Live LAN   | Azure STAGING |
| ------------------------------------------------------- | ---------------------------------------------- | ---------- | ------------- |
| Target/owner/branch/configuration                       | Offline evidence validation only               | Unverified | Unverified    |
| Catalog, medicine, presentation, pack                   | OWNER-INPUT; approved existing references only | UNSEEDED   | UNSEEDED      |
| Purchasing, receiving, stock, transfers, counts         | UNSEEDED; inventory helper not integrated      | UNSEEDED   | UNSEEDED      |
| Sales, returns, tenders, khata                          | UNSEEDED; finance helper not integrated        | UNSEEDED   | UNSEEDED      |
| Journals, settlements, bank reconciliation              | UNSEEDED; no posted financial facts            | UNSEEDED   | UNSEEDED      |
| Operational, financial, growth reports                  | UNSEEDED; no report outputs observed           | UNSEEDED   | UNSEEDED      |
| Loyalty, refills, campaigns                             | UNSEEDED; retention helper not integrated      | UNSEEDED   | UNSEEDED      |
| Prescription, dispensing, controlled drugs              | OWNER-INPUT; no approval impersonation         | UNSEEDED   | UNSEEDED      |
| Safety, recalls, temperatures, regulatory               | OWNER-INPUT; no invented safety state          | UNSEEDED   | UNSEEDED      |
| Providers, catalog crawl, fiscal, email/SMS             | OWNER-INPUT; external effects absent           | UNSEEDED   | UNSEEDED      |
| Hardware, print, branch/receipt permissions, first sale | OWNER-INPUT; separate real-input acceptance    | UNSEEDED   | UNSEEDED      |

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
**53 passed, 0 failed, exit 0**, including both LAN and Azure staging offline
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
