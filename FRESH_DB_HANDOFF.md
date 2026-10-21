# Restaurant fresh database initializer — source adaptation

This library adapts the corrected WHA1531 six-file source contract to the frozen Restaurant
production manifest. It supplies no runtime factory, observer, approved baseline, mutation CLI,
credentials, grant execution or database connection. The canonical `bootstrapProduction(tx,input)`
writer remains byte-identical. Actual database/TLS acceptance is still required.

## Exact source and integration

Production base: `/tmp/devfathom-composed-final-20261011`, 1,233 manifest paths, manifest SHA256
`e7ae5ef79fa373354c68be89681541b32cca6142523a3b2a5d299710673ae34e`.
Schema SHA256 `a89e29ead28f7efcdefc9135758ddcfaf888dc2860bcd98b2e38ac5e232d05bd`;
125 unchanged historical SQL migrations; 451-model generated client, 459 verified files.
Fresh manifest exact-byte SHA256 is independently pinned in code to
`4343385168f4b3c3c557266e48a13807589c5022edce2cf706a9047018add482`.
Serialization: schemaSha256 then migrations sorted by name, each name then sha256, two spaces,
UTF-8, LF and final newline. Updating SQL and JSON together fails the independent digest check.

Apply only the accompanying six-file `source.patch` to a separately owned snapshot that matches
that production manifest. Verify all six file hashes and the unchanged canonical writer before
integration. This is a manifest-based snapshot, not a Git descendant; no ancestry is claimed.
No generated files or dependencies belong in the source patch. The original WHA1531 patch and
six input pins are preserved in source-provenance.json; the first pass is archived separately.
Do not run `prisma/bootstrap.ts`: it executes immediately and is not this library's entrypoint.
The existing application bootstrap remains unchanged; this library has no caller until admitted.

## Explicit inputs

`bootstrapFreshDatabase(factory, env, guard, deadlineMs)` is the only intended deployment entry.
`BOOTSTRAP_MODE` must equal `RESTAURANT`; Agency/Pharmacy/omission fail before factory allocation.
The canonical pure mapper requires explicit ORGANIZATION_ID, ORGANIZATION_SLUG,
ORGANIZATION_LEGAL_NAME, ORGANIZATION_DISPLAY_NAME, BOOTSTRAP_PACKAGE_KEY, ADMIN_ID, ADMIN_NAME,
ADMIN_EMAIL, ADMIN_TITLE, PLATFORM_ADMIN_ID, PLATFORM_ADMIN_NAME, PLATFORM_ADMIN_EMAIL.
Both ADMIN_PASSWORD and PLATFORM_ADMIN_PASSWORD must be explicit, at least 12 characters after
trim and at most 72 UTF-8 bytes. They are never emitted. The canonical writer validates distinct
administrator identities and a Restaurant package. Replay validates supplied credentials but
never hashes or stores them. No generated/default credentials or environment loader exists.

DATABASE_URL and APP_DATABASE_URL must have separate migration/runtime identities on the same
host, port and database, explicit credentials and only one `sslmode=verify-full` query parameter.
The runtime username must be `devfathom_app`. FRESH_DATABASE_TARGET confirms host:port/database.
Only the validated runtime URL reaches the private factory; the migration URL is validation-only.
The reviewed endpoint requires exact hostname, port, database, expected TLS server identity and
CA SHA256; there is no provider hostname-suffix inference. The actual CA material and TLS
implementation belong to the reviewed deployment adapter, never to these source receipts.

## Reviewed phase fingerprints

A deployment owner must supply baseline.reviewId, intentSha256 (computed from the normalized
public canonical inputs by freshDatabaseIntentSha256), fingerprintPlanSha256, postureSha256,
and exact INITIAL and COMPLETED operational/catalog digests. No default approval or baseline
learning is implemented. The guard compares copies of the reviewed inputs, before hashing or
catalog writes, and re-observes the COMPLETED state before transaction commit.

The independently reviewed fingerprint plan must partition **all application rows** into:

- Catalog: platform_modules, platform_packages, platform_package_modules, including unrelated
  preexisting catalog rows. INITIAL-to-COMPLETED changes are only the canonical create-only
  baseline modules plus selected Restaurant package/module links; existing rows remain intact.
- Operational: every other application table, including organizations, users, platform_users,
  permissions, departments, brands, deployments and all tenant/business data. INITIAL explicitly
  includes historical `org_devfathom` and its migration-created departments. They stay identical.
  The only initial additions are the requested Restaurant organization in ONBOARDING/isDemo=false,
  its default departments, Restaurant role templates and nested permissions, default brand,
  requested tenant ADMIN and platform SUPER_ADMIN. No deployment, Agency, demo, branch, sale,
  inventory, medicine or other business row is allowed. Historical SQL is unchanged.

Canonical defaults, generated primary IDs, their foreign-key references, timestamps and bcrypt
salts make raw precomputed byte fingerprints impractical. The owner must review a deterministic,
versioned logical encoding: use stable natural identities and consistent reference mappings for
new rows; represent nondeterministic generated timestamps/credential hashes only with narrowly
specified structural checks on the exact bootstrap rows. Include row counts, all stable fields,
all other rows and relationships. Existing rows must not receive these normalizations. Never
exclude whole tables, all tenant rows, or all user fields. The source phase supplies no encoding
implementation and cannot approve one by merely observing the target. If an encoding cannot
prove the stated exact delta, runtime remains blocked.

A legitimate later demotion, deactivation, password rotation, status change, permission change or
entitlement change requires a **separately reviewed COMPLETED snapshot/plan for that exact state**.
It is accepted when the canonical stable identity checks still match. The replay writer returns
without catalog sync, hashing, promotion, reset or repair; the post-observation must match the same
reviewed COMPLETED fingerprint. Unreviewed operational/catalog drift fails. This deliberately
avoids a universal exemption for mutable privilege fields. Changed organization identity or
package assignment still follows the canonical collision refusal. The latest coordinator direction
explicitly prefers these reviewed phase-specific fingerprints.

postureSha256 covers reviewed effective grants, direct-login role properties and memberships,
RLS/FORCE RLS policies, extension ownership/posture and other approved target security state.
The mandatory trusted observer must measure the identical Prisma transaction and prove endpoint,
TLS identity, CA identity, complete table visibility despite RLS, fingerprint plan and posture.
Returning filtered zero-row queries or cached values is not proof. No visibility grant widening
is authorized here; if complete visibility cannot be established, do not execute this library.

## Transaction, cancellation and cleanup

The factory is a reviewed `private-runtime-client-cancel-drain-v1` adapter, not an arbitrary
client/transaction argument. `create(validatedRuntimeUrl, {signal, deadlineAt, endpoint})` allocates
a synchronous private lease and must clean any partial resources if allocation throws. It must
not connect until lease.connect(). The lease owns Prisma and the driver pool, including failed
or pending connection resources. Reusing a shared/global client violates the contract.

The overall deadline is mandatory, 1..330000 ms from runner entry. The factory must enforce it
at connection/driver/commit boundaries, including JavaScript timer delays. One Serializable
transaction uses maxWait <=30000 ms and timeout <=300000 ms, each bounded by remaining time.
The wrapper acquires advisory transaction lock `734219061`, then transaction-local platform and
organization context, then observes current_database/current_user/role flags and the complete
125-row successful migration ledger. Runtime must be LOGIN, NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, with zero memberships. Observer proof follows.
It calls the unchanged canonical writer exactly once. The writer reacquires the same lock
(transaction-reentrant), performs identity checks, and either creates the allowed state or returns
without writes. There is no Pharmacy writer or second lock order. Serializable conflicts reject
without automatic retry; a retry would require a fresh owner invocation and observations.

On timeout/failure, abort signal and cancelAndDrain() must cancel connection/SQL work, prevent
late commit, and settle all owned operations. The runner does not race a detached mutation: it
awaits connection/transaction settlement, awaits cancellation/drain, then awaits close(). No result
escapes cleanup. close() must release both Prisma and the driver pool, even on partial connect or
observer failure. It must be safe alongside cancellation during cleanup. If a broken adapter
never settles, the runner intentionally cannot manufacture a timeout result; it may remain pending.
No real adapter is supplied or claimed safe. Actual cancellation and commit-boundary behavior
require runtime admission. Generic sanitized errors contain no driver text, URL, password or cause.
Cleanup/late failure can happen after a commit, so errors say **outcome requires review**, never
falsely certify rollback. No runtime retry/recovery mutation exists.

## Proposed minimum grant recipe — documentation only

Canonical code uses SELECT and INSERT on these exact tables: platform_modules, platform_packages,
platform_package_modules, organizations, organization_departments, organization_roles,
organization_role_permissions, organization_brands, users, platform_users. Its upserts have empty
updates and do not repair existing rows. Validate the Prisma-emitted SQL in an admitted disposable
run before deciding whether any exact additional privilege is genuinely needed; do not preemptively
grant UPDATE to whole tables. Observer SELECT requirements are a separate complete-visibility design,
not permission for broad DML. The guard needs SELECT on public._prisma_migrations and access to the
required pg_catalog role/membership metadata. Public schema USAGE, transaction-local set_config and
pg_advisory_xact_lock execution must be available under the reviewed policy. No sequence use was
identified in the canonical writes; check actual defaults/SQL during admission.

No ALL-table DML, DELETE, TEMP, TRUNCATE, ownership, BYPASSRLS, membership escalation or grants are
applied/proposed as a shortcut. Local fixture privileges are not production policy. The narrow
writer permissions alone do not establish complete visibility. Review extension posture separately.

## Source verification and remaining admissions

See check-receipts.json for exact commands, statuses and preserved first failures. Pure mocks call
the actual canonical writer and test refusal, replay and orchestration; they are not PostgreSQL,
TLS, RLS, rollback or concurrency evidence. Test fixtures are inert local variables, not deployed
credentials. Scoped compiler roots are only the two initializer TS files and their dependency
closure against the copied 451-model generated client; no whole-app build/typecheck is claimed.
Run the 19 pure tests with the existing repository dependency:
`node --import tsx --test prisma/fresh-database.test.mjs`. The same portable loader runs the
offline plan with `node --import tsx prisma/fresh-database-plan.mjs`; it accepts no arguments
and cannot mutate. Tests create and clean their own unique system temporary directory.

Owner must supply: reviewed private factory with cancellation/settlement/cleanup; actual TLS/CA
and endpoint proof; same-transaction complete-visibility observer; exact fingerprint encoding,
INITIAL/COMPLETED snapshots and security-posture review. Then obtain admitted disposable database
proof of the 125 migrations, real generated-client adapter behavior, narrow grants/FORCE RLS,
rollback on observer/write errors, deadline cancellation, initial/replay concurrency and serialization.
No default runtime fallback, browser/build, provider/cloud connection, migration or grant change ran.
Rollback of this source adaptation: omit the six new files; there are no database effects to undo.
