# WHA-1350 verification handoff

Ready for WHA-1220 builder 6bc6de9b-2bb2-4738-a071-67caa641fddc. Builder owns targeted tests, commit and cleanup. No tests executed by provisioner.

Base and final HEAD: fe1e3e383c8b966cdb68669ba5366db00fe2320a. Execution branch: WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair. Tracked diff: empty. Target draft: exactly two modified DB tests and one untracked migration; SHA-256 preserved in draft-hashes.json. Migration checksum matches applied record.

Database: wha1350_disposable_test, PostgreSQL 16.15, loopback 127.0.0.1 port 52027. Fresh private mktemp directory; data directory pgdata. Port bind and absence of data directory checked before initdb. Host authentication now SCRAM. This durable work product survives automatic run scratch removal. Writable scratch: /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/.wha1350-verification-9afjzvhz/scratch (0700).

connections.env (0600) exports PHARMACY_TEST_OWNER_DATABASE_URL, OWNER_DATABASE_URL, TEST_DATABASE_URL, WHA1198_TEST_RUNTIME_DATABASE_URL, DATABASE_URL, EXTENSION_ADMIN_DATABASE_URL, WHA1350_ADMIN_DATABASE_URL, SEED_PASSWORD, AUTH_SECRET, PLATFORM_ENCRYPTION_KEY, TMPDIR, WHA1350_ENV_DIR, WHA1350_PGDATA, WHA1350_PGPORT. Never print or commit this file.

Owner and runtime both NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT. Runtime owns no application tables; canonical QA DML/sequence grants only. Cluster bootstrap admin is limited to this disposable cluster; do not use it for tests. Forced RLS verified on pharmacy_branch_regulatory_profiles and pharmacy_onboarding_events.

## Builder commands

Run these in the builder's own authorized session. Provisioner has not modified that worktree. These commands link existing dependencies and the provisioner's separately generated client; they never regenerate a shared client. Stop if either destination already exists and differs.

```sh
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1220-qa-ph-platform-permit-authorized-regulatory-profile-tenant-purge
source /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/.wha1350-verification-9afjzvhz/connections.env
test ! -e node_modules && test ! -L node_modules && ln -s /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/node_modules node_modules
mkdir -p src/generated
test ! -e src/generated/prisma && test ! -L src/generated/prisma && ln -s /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/src/generated/prisma src/generated/prisma
node node_modules/vitest/vitest.mjs run src/lib/platform/jobs.purge.db.test.ts src/server/routers/pharmacy-onboarding.db.test.ts --maxWorkers=1 --no-file-parallelism
```

Avoid bunx/package installation. Existing dependency store: /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1116-compose-the-final-accepted-restaurant-artifacts-into-one-clean-private-candidate/node_modules. Prisma 7.9.1, Vitest 4.1.10, pg 8.22.0, tsx 4.23.1. Vitest CLI execution succeeded. Schema identical between both worktrees; private Prisma client generated successfully in assigned checkout. No shared generated client changed.

## Provisioning evidence

Canonical source: .github/workflows/qa.yml; prisma/prepare-extensions.ts/.sql; prisma/seed.ts; current two DB test environment contracts.

Commands run from assigned checkout (URLs supplied only through sourced environment):

```sh
node node_modules/prisma/build/index.js generate
DATABASE_URL="$OWNER_DATABASE_URL" node --import tsx prisma/prepare-extensions.ts
node node_modules/prisma/build/index.js migrate deploy --config "$WHA1350_ENV_DIR/migration.config.mjs"
# Owner pg.Client: canonical QA runtime GRANT USAGE/schema, SELECT/INSERT/UPDATE/DELETE tables,
# USAGE/SELECT sequences, and matching owner default privileges.
DATABASE_URL="$OWNER_DATABASE_URL" node --import tsx prisma/seed.ts
node node_modules/vitest/vitest.mjs --version
```

All commands exited 0. 104 migrations applied; unsuccessful count 0; includes 20260905080000_pharmacy_regulatory_profile_tenant_purge. Evidence: evidence.json, migrate.log, extensions.log, seed.log, bootstrap.log. Runtime SELECT platform_packages returned zero due to tenant RLS without platform context; seed process exited 0. Application tests, lint, typecheck, full suite, build and browsers omitted: assigned prerequisite only. No push/merge/deploy or existing database connection performed.

Initial discovery: rg unavailable; primary checkout dependencies absent/incomplete. Resolved using existing matching dependency store. No bootstrap or migration failure; no permission widening.

## Cleanup after builder verification

Keep this environment and assigned checkout available until builder finishes. Do not commit generated/credential/database artifacts. Stop only the identity below, then remove its directory. Remove builder symlinks only if they still point to the paths above, before removing provisioner generated assets.

```sh
source /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/.wha1350-verification-9afjzvhz/connections.env
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D "$WHA1350_PGDATA" -m fast -w stop
# After successful stop, remove ONLY this directory:
rm -rf -- /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/.wha1350-verification-9afjzvhz
```

Risk: tests have not yet verified repair correctness. Environment lifetime and dependency store availability must last through builder verification. Cleanup owner: original WHA-1220 builder.

No-wake handoff follows installed paperclipai CLI createOrCommentForAgent: POST comment with resume=false; no separate wakeAgent call.
