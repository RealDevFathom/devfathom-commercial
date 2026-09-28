# Staging release runbook — 2026-09-30

Status: board review required. This is an operator procedure, not evidence that a
release was composed, tested, pushed, or deployed. WHA-1608 performs docs-only work.
Only the board may authorize composition and deployment; commands below are for
that later operation and were not executed by the documentation lane.

## Source and ownership

The board explicitly selected documentation base
`89f39834e7688c7f93dc467b945c980ada708463`, the observed
`WHA-1388-pharmacy-union` tip. The separately observed restaurant base is
`codex/restaurant-release-20260911` at
`215568faf361ee49807c95fe69e00fa71b6565f2`. Its worktree belongs to WHA-1575:
never use or modify it. The documentation worktree is `DOCS-staging-runbook`.

Read these files again at the final composed SHA before release:

- [Deployment workflow](../../.github/workflows/deploy-staging.yml)
- [Azure deployment](../azure-deployment.md)
- [Deploy notes](../../DEPLOY-NOTES.md)
- [Staging parameters](../../infra/staging.bicepparam),
  [environment template](../../infra/environment.bicep),
  [bootstrap script](../../infra/deploy-staging.sh), and
  [OIDC helper](../../infra/configure-github-oidc.sh)
- [Release checklist](../admin-platform/testing-release.md)
- [Composition ledger](composition-ledger-20260928.md)

The Azure guide contains historical deployment claims; they do not certify this
candidate. Never copy historical test counts or image digests into new evidence.

## Compose in a board-owned worktree

1. Check `df -h /`: require at least 8 GiB available after planned install/build.
   Reuse a board-owned candidate worktree if one exists. Never clean, reset,
   stash, restore, or switch another lane's worktree.
2. Record both live branch tips and freeze the selected SHAs in the release
   evidence. Branch names can move after this ledger snapshot.
3. Starting from the restaurant SHA, create `release/staging-20260930` in its own
   worktree. Merge the pinned pharmacy-union SHA there, then only board-selected
   lane tips. Inspect ancestry first to avoid duplicate cherry-picks or merging
   superseded lanes. The ledger is inventory, not an approval list.

```bash
# Board operation only; REPO is an existing source checkout used for Git metadata.
restaurant_sha=$(git -C "$REPO" rev-parse codex/restaurant-release-20260911)
pharmacy_sha=$(git -C "$REPO" rev-parse WHA-1388-pharmacy-union)
git -C "$REPO" worktree add -b release/staging-20260930 "$RELEASE_WORKTREE" "$restaurant_sha"
cd "$RELEASE_WORKTREE"
git merge --no-ff "$pharmacy_sha"
```

Resolve conflicts only in the board candidate with lane-owner review. Record
selected tips, merge commits, omitted/superseded lanes and reasons. Include this
documentation commit explicitly if it is not already in the chosen ancestry.
Any post-gate code change invalidates the evidence for the previous SHA.

## Local Part A — static and build gates

“Part A/B” here groups the checked-in workflow and release-checklist requirements;
the source docs do not define separate scripts bearing those names. Run on the
final composed SHA, with existing approved tooling or board-authorized dependency
installation. The documentation lane does not install dependencies. For long local gates, keep
`caffeinate -dimsu` active and check disk at phase boundaries.

```bash
bun install --frozen-lockfile
bunx prisma generate
bunx next typegen
bun run lint
NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck
bunx prisma validate
# Pass the explicit changed source paths from the complete composition diff:
bunx prettier --check <changed-ts-tsx-css-paths>
NODE_OPTIONS=--max-old-space-size=8192 bun run build
```

Record the composition base used for changed-file formatting, command exit codes,
file/error/warning counts and logs. Do not mass-format legacy files. The workflow
checks source formatting against only the deployed commit's first parent; local
review must cover the complete composed change. Record empty formatting scope
as zero changed source files, not as a test run.

## Local Part B — disposable database, tests and browser gates

Use only a lane-owned disposable PostgreSQL instance bound to `127.0.0.1` on a
free port in **55600–55699**, with separate app and shadow databases. No shared,
staging or production URL is valid for these local gates. Run long commands
under `caffeinate -dimsu`; stop if available disk falls below 5 GiB. Never stop
another lane's server or reuse another lane's database.

Provision an owner role with `LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE` and a
separate runtime role with `LOGIN NOSUPERUSER NOBYPASSRLS`. A disposable extension
administrator may prepare required extensions; it must not become the application
runtime. Confirm role flags through `pg_roles` and record them without passwords.
The CI workflow uses a superuser migration owner on its disposable runner; do not
copy that exception into this Mac lane's owner role.

Configure `OWNER_DATABASE_URL`, `SHADOW_DATABASE_URL`,
`EXTENSION_ADMIN_DATABASE_URL` and `RUNTIME_DATABASE_URL` securely for this lane.
Prepare extensions, deploy migrations, then seed, in that order:

```bash
DATABASE_URL="$OWNER_DATABASE_URL" bunx tsx prisma/prepare-extensions.ts
DATABASE_URL="$OWNER_DATABASE_URL" bunx prisma migrate deploy
DATABASE_URL="$OWNER_DATABASE_URL" bunx prisma db seed
DATABASE_URL="$OWNER_DATABASE_URL" bunx prisma migrate status
```

Apply the reviewed runtime grants after schema creation. Map the database-test
variables listed in `deploy-staging.yml` to this lane: owner variables to its
restricted owner, runtime/test variables to its runtime. These include
`M8_TEST_*`, `WHA910_TEST_*`, `WHA874_TEST_OWNER_DATABASE_URL`, `WHA434_TEST_*`,
`CAMERA_TEST_DATABASE_URL` and `MENU_IMPORT_TEST_DATABASE_URL`.

```bash
export DATABASE_URL="$RUNTIME_DATABASE_URL"
export TEST_DATABASE_URL="$RUNTIME_DATABASE_URL"
export NODE_OPTIONS="--max-old-space-size=8192 --no-experimental-webstorage"
bunx vitest run \
  src/lib/department-provisioning.db.test.ts \
  src/server/restaurant-branch-scope.db.test.ts \
  tests/restaurant-m3-rls.test.ts \
  tests/restaurant-m8-rls.test.ts \
  src/lib/restaurant/sop-execution.test.ts \
  src/lib/restaurant/camera-schema.test.ts \
  tests/restaurant-menu-import-acceptance.db.test.ts \
  --reporter=json --outputFile="$EVIDENCE_DIR/required-db-vitest.json"
bun run test
bun run report:email-collisions
TEST_DATABASE_URL="$OWNER_DATABASE_URL" bun run test:rls
bun run test:e2e
```

Require **zero skipped/pending required DB tests**, not merely a zero process
exit. The isolation script intentionally receives the disposable owner URL,
matching the workflow; ordinary application tests receive the runtime URL.
Record passed/failed/skipped counts for each suite. The issue reports **106
pre-existing Vitest failures** as a baseline: compare identities and counts,
report any delta, and seek the board's release decision. This is not a blanket
waiver: `bun run test` failing still fails the checked-in deployment gate.
Do not claim the candidate deployable while CI remains red.

Run browser smoke on tenant and admin hosts, including restaurant and pharmacy
critical paths selected by the board, and shared-worker smoke from the release
checklist. Save browser reports/screenshots and exact candidate SHA. Distinguish
local results from Azure-only acceptance. Stop the disposable instance after
capturing evidence; never run destructive cleanup on a shared database.

## Board deployment and exact trigger

Before publishing, record the previous healthy **digest URI**, active revision,
app/job configuration and migration compatibility. Resolve actual Azure resource
names from the configured GitHub variables, not copied historical identifiers.
Required variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_ACR_NAME`, `AZURE_STAGING_RESOURCE_GROUP`,
`AZURE_MIGRATION_JOB_NAME`, `AZURE_CONTAINER_APP_NAME`. Credentials stay out of logs.

**Seed preflight:** the workflow's step is named “Migrate and seed staging,” but it
only changes the existing job's image and starts it. At the documentation base,
`infra/staging.bicepparam` has `seedDatabase = false`; `environment.bicep` runs
extension preparation, migration, runtime-role preparation and catalog sync, and
adds seed only when enabled. Inspect the actual job command. If demo seeding is
required, the board must approve a safe explicit strategy; the step name is not
evidence that seeding occurs. Do not rerun the bootstrap infrastructure script
for a routine release or overwrite existing seeded accounts.

With local gates reviewed, the candidate SHA frozen, and board approval:

```bash
# Exactly this ref mapping triggers push.branches: [main]. Never force push.
git push origin refs/heads/release/staging-20260930:refs/heads/main
```

For other dates replace `20260930` with the selected `YYYYMMDD`. Pushing only the
release branch does not trigger the push event. If the update is non-fast-forward
or branch protection rejects it, stop for board reconciliation; never bypass it.
The workflow also exposes `workflow_dispatch`, which is not this release path.

`deploy-staging.yml` serializes staging runs (`cancel-in-progress: false`). Its
`deploy` job requires `gates`: install/generation, lint, typecheck, changed-source
formatting, disposable migrations/seed, required DB suites, full tests, collision
report, isolation, production build and Playwright. Deployment uses OIDC, builds
`linux/amd64`, pushes a `${GITHUB_SHA}` image tag, resolves its ACR digest, runs and
waits for the migration job (up to 90 checks at 10-second intervals), then updates
the app to the **same digest URI**. A failed/stopped/degraded migration aborts.

## Health, post-deploy checks and evidence

```bash
fqdn=$(az containerapp show --resource-group "$AZURE_STAGING_RESOURCE_GROUP" \
  --name "$AZURE_CONTAINER_APP_NAME" --query properties.configuration.ingress.fqdn --output tsv)
curl --fail --show-error --silent --retry 12 --retry-delay 10 "https://$fqdn/api/health"
```

Expect HTTP 200 and `{"status":"ok"}`; capture response/status and time. Also
verify the ready active revision uses the intended digest, then smoke
`staging.devfathom.com` and `admin.staging.devfathom.com`, login/session routing,
and the approved restaurant/pharmacy flows. Health alone does not verify these.
Record workflow URL/run result, source SHA, new and previous digest, migration
execution/result, revision, browser evidence and board decision.

Track these [DEPLOY-NOTES](../../DEPLOY-NOTES.md) items separately; do not mark
them complete from local tests or from a healthy HTTP endpoint:

- **Blob identity:** configure the target storage account and managed identity;
  verify `AZURE_STORAGE_ACCOUNT_NAME`, private Blob access and scoped identity
  permissions (Azure guide names Storage Blob Data Contributor). Preserve session
  and per-channel membership checks. Prove upload, fetch and membership-denied
  paths in Azure staging before production.
- **Sentry/observability:** remains a deploy-gated implementation task. In its
  separately approved lane, add `@sentry/nextjs` (or selected tracker), DSN,
  instrumentation and client/server configuration; report tRPC formatter and
  `/api/v1` `withApiAuth` exceptions using the existing `errorCode`/`path` context;
  configure request metrics and alerting; demonstrate flagged 500 paths appear
  as captured staging events. Protect credentials and sensitive event content.
  This runbook does not install or certify that integration.

## Rollback by previous immutable digest

The board captures a verified healthy digest **before** rollout and checks old
application compatibility with any new schema before reverting. Do not rebuild
an old tag, use `latest`, rerun seed, or assume application rollback undoes data.

```bash
az containerapp revision list -g "$AZURE_STAGING_RESOURCE_GROUP" \
  -n "$AZURE_CONTAINER_APP_NAME" -o table
az containerapp logs show -g "$AZURE_STAGING_RESOURCE_GROUP" \
  -n "$AZURE_CONTAINER_APP_NAME" --type system --tail 100
# PREVIOUS_DIGEST_URI must be the recorded registry/repository@sha256:... URI.
az containerapp update -g "$AZURE_STAGING_RESOURCE_GROUP" \
  -n "$AZURE_CONTAINER_APP_NAME" --image "$PREVIOUS_DIGEST_URI"
```

Confirm the ready revision digest and repeat health and critical smoke checks.
Migrations are forward-only. For a data/schema incident, stop and use the Azure
guide's point-in-time restore to a **new** server, validate it, update the Key Vault
reference and app revision under separate board approval. Retain the old server
through the rollback window. Record incident reason and rollback evidence.

## Documentation verification (WHA-1608)

Docs-only verification on 2026-09-29: two documents, 811 requested-pattern ledger
rows, zero missing branches, 10 valid relative links, 10 required-topic checks
and balanced Markdown fences. The second snapshot comparison found one moving
tip (`PH-DATA-datasets`); the captured ledger remains point-in-time evidence and
must be refreshed by the board before composition. No install, build, database,
application tests, push, merge or deployment was performed in this lane.

Commands and counts are attached to the issue as `documentation-verification.txt`;
`git diff --cached --check` validates the final staged docs. Unknown ownership and
one missing creation reflog remain explicitly labelled in the ledger.
