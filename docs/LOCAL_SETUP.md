# Running DevFathom Locally

Last reviewed: 2026-11-02

## Prerequisites

- [Bun](https://bun.sh) `1.4.2`, the version `packageManager` pins (`bun.lock` is lockfile
  version 3, which Bun 1.3 cannot read)
- PostgreSQL
- Git

## 1. Configure the environment

From the project root:

```bash
cp .env.example .env.local
```

Open `.env.local` and replace every placeholder used by your local setup. The minimum values are:

```dotenv
DATABASE_URL=postgresql://devfathom_app:replace-with-local-app-password@localhost:5432/devfathom
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devfathom
SHADOW_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devfathom_shadow

# Used only by prisma/prepare-extensions.ts (step 3). It must authenticate as a
# superuser or an extension-object owner. Locally that is the same superuser URL
# as DATABASE_URL.
EXTENSION_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devfathom

AUTH_SECRET=<random-secret>
AUTH_URL=http://devfathom.localhost:3000
NEXT_PUBLIC_APP_URL=http://devfathom.localhost:3000

PLATFORM_BASE_DOMAIN=localhost
PLATFORM_ENCRYPTION_KEY=<32-byte-base64-or-64-character-hex-key>
PLATFORM_ADMIN_EMAIL=<local-platform-email>
PLATFORM_ADMIN_PASSWORD=<strong-local-password>
# Bearer for platform jobs and POST /api/cron/outbound-effects (intended schedule: every minute).
CRON_SECRET=<random-secret>

DEFAULT_ORGANIZATION_ID=org_devfathom
SEED_PASSWORD=<local-seed-password>
```

Generate local secrets with:

```bash
openssl rand -base64 32
```

Keep `.env.local` private. It is ignored by Git.

### Which values win

Every `prisma` CLI command (through `prisma.config.ts`), `bun run db:seed`, `prisma/seed-demo.ts`,
`prisma/create-admin.ts`, `prisma/reset-admin-password.ts`, and the `platform:jobs`,
`assistant:eval`, `assistant:diag`, and `email:smoke` scripts load environment files through
`prisma/load-env.ts`, with the same precedence as Next.js:

1. a variable already set in the process environment (exported in your shell, or set by CI or a
   container);
2. `.env.local`;
3. `.env`.

A file that does not exist is skipped silently. A value exported in the shell therefore overrides
both files without editing them, for example `MIGRATION_DATABASE_URL=... bun run db:seed`. When no
database URL is set anywhere, these commands stop with a message that names the variables and the
files they searched, instead of failing to connect. The seed accepts `MIGRATION_DATABASE_URL` or
`DATABASE_URL`; the other scripts read `DATABASE_URL`.

`prisma/bootstrap.ts` is production-only and reads the real process environment only.

### Required seed values

- `SEED_PASSWORD` is mandatory. The seed refuses to run without it (it accepts `ADMIN_PASSWORD` as
  a fallback) and assigns it to every seeded `@company.com` tenant user.
- The platform operator needs **both** `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.
  Setting only one of them fails the seed. Leaving both unset leaves any existing operator
  untouched, so a new database then has no account that can sign in to the platform.
- `ADMIN_EMAIL` is optional. When it is set, `ADMIN_PASSWORD` is required too, and the seed creates
  that separate workspace administrator.

## 2. Create the databases

```bash
createdb devfathom
createdb devfathom_shadow
```

If your PostgreSQL username, password, host, or port differs, update the database URLs in
`.env.local`.

The application role and the migration role are different logins:

```sql
-- Run as a superuser. Replace the password before executing.
CREATE ROLE devfathom_app LOGIN PASSWORD 'replace-with-local-app-password'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT, TEMPORARY ON DATABASE devfathom TO devfathom_app;
```

`DATABASE_URL` must use `devfathom_app`. `MIGRATION_DATABASE_URL` is the role that applies
migrations and seed (a local superuser is enough). Prisma CLI and the seed use
`MIGRATION_DATABASE_URL` when it is set, and otherwise fall back to `DATABASE_URL`, resolved with
the precedence in [Which values win](#which-values-win). The running server reads `DATABASE_URL`
only.

`next start` and any production process refuse to boot when that application role is
`SUPERUSER` or `BYPASSRLS`, and when `CLIENT_IP_HEADER`, `TRUSTED_PROXY_CIDRS`, and
`TRUSTED_PROXY_HOPS` are all unset. `bun run dev` does not run either check. IPv4 entries
in `TRUSTED_PROXY_CIDRS` must be plain IPv4, such as `10.0.0.0/8`. `::ffff:` addresses are
unwrapped to IPv4 before the trust check, so a mapped form in that list does not match.
Confirm the application role with:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

Both columns must be `f` on the `DATABASE_URL` connection.

## 3. Install and initialize

```bash
bun install --frozen-lockfile
bun prisma/prepare-extensions.ts
bunx prisma migrate deploy
```

Prisma and the seed take an exported variable first, then `.env.local`, then `.env` (see
[Which values win](#which-values-win)). After migrate, grant the application role access to the
objects the migration role owns:

```sql
GRANT USAGE ON SCHEMA public TO devfathom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devfathom_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devfathom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devfathom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO devfathom_app;
```

`ALTER DEFAULT PRIVILEGES` applies to objects the current user creates later. Run it as the
migration role. Then seed. The seed reads `MIGRATION_DATABASE_URL` when that variable is set,
and it sets the platform-admin tenant setting inside each of its transactions:

```bash
bun run db:seed
```

`bun prisma/prepare-extensions.ts` must run **before** `prisma migrate deploy`. The trusted
`btree_gist` and `pg_trgm` extensions install functions owned by PostgreSQL's extension bootstrap
role, and that role grants `PUBLIC EXECUTE` on them. The hardening step revokes that grant as the
extension administrator (`EXTENSION_ADMIN_DATABASE_URL`). Migration
`20260830120000_btree_gist_public_execute_acl` verifies the revoke and **fails closed** with
PostgreSQL `P0001` if it was skipped, so `migrate deploy` will stop on a fresh database until this
step has run. Bun loads `EXTENSION_ADMIN_DATABASE_URL` from `.env.local`; set it as shown above.

The seed creates the local DevFathom organization, platform operator, modules, users, and demo
data. Platform login uses `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`; tenant login uses
an email printed by the seed and the `SEED_PASSWORD` value.

The seed is safe to re-run. It commits in two transactions:

1. The platform catalog, the DevFathom organization with its departments and roles, the platform
   operator, and the optional `ADMIN_EMAIL` administrator. This is committed first, so a failure in
   the demo data cannot remove the operator. The seed prints `Platform operator created` or
   `Platform operator updated`, or a warning when `PLATFORM_ADMIN_EMAIL` and
   `PLATFORM_ADMIN_PASSWORD` are both unset.
2. The demo users, clients, projects, finance, chat, and meetings. When the demo data is already
   present, a re-run only refreshes the demo users' password from `SEED_PASSWORD` and prints
   `Seed data already present`.

A re-run therefore also applies a changed `SEED_PASSWORD` or `PLATFORM_ADMIN_PASSWORD`. If the seed
reports that the database already contains conflicting seed data, the database holds rows the seed
did not create, and re-running does not help. Rebuild it as described in
[Resetting local data](#resetting-local-data).

Never run `prisma db push`. This project relies on migration-only row-level security and tenant
constraints.

## 4. Start the project

```bash
bun run dev
```

Open:

- Tenant workspace: [http://devfathom.localhost:3000](http://devfathom.localhost:3000)
- Admin panel: [http://admin.localhost:3000/platform](http://admin.localhost:3000/platform)

Stop the server with `Ctrl+C`. Start it again with `bun run dev`.

### First platform sign-in requires authenticator (MFA) enrollment

The first platform sign-in always enrolls an authenticator, regardless of
`PLATFORM_MFA_ENFORCE`. At [http://admin.localhost:3000/platform/login](http://admin.localhost:3000/platform/login):

1. Sign in with `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`. Because no
   authenticator is enrolled yet, the form switches to **Set up authenticator**
   instead of going straight to `/platform`.
2. Click **Set up authenticator**. The page shows a **setup key** (a TOTP
   secret). Add it to any authenticator app (1Password, Google Authenticator,
   Authy, …) as a manually-entered key.
3. Enter the **six-digit code** the app generates and click **Verify
   authenticator**.
4. Save the one-time **recovery codes** shown after verification, then continue.
   You land on `/platform`.

On later sign-ins the same login form asks only for a current six-digit code
from the enrolled authenticator.

## 5. Verify the setup

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Use the RLS verifier only with a disposable test database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/devfathom_rls_test' \
  bun run test:rls
```

Do not point `test:rls` at a database containing data you need.

### Running the database-backed test suites

`bun run test` **skips** the eight suites that need a real PostgreSQL unless `TEST_DATABASE_URL` is
set. They report themselves skipped rather than passing vacuously, so a green run without that
variable has not exercised them.

Five of those suites assert things that are true only because row level security is enforced — that
one tenant cannot see another's rows. PostgreSQL exempts two kinds of role from row level security,
and they are separate attributes: `SUPERUSER`, and `BYPASSRLS`, which defeats policies (including
`FORCE ROW LEVEL SECURITY`) without the role being a superuser. Connected as either, those suites
are no longer testing what they claim to, so they abort in `beforeAll` and name the attribute they
found.

`TEST_DATABASE_URL` for `bun run test` therefore has to name a role holding **neither**. Against a
migrated disposable database:

```sql
-- Replace the placeholder before running. Do not commit a real password.
CREATE ROLE devfathom_test LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO devfathom_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devfathom_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devfathom_test;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devfathom_test;
```

Then run the suites with that role:

```bash
TEST_DATABASE_URL='postgresql://devfathom_test:CHANGE_ME@localhost:5432/devfathom_test_db' \
  bun run test
```

Verify the role is unprivileged with the same query the guard uses — both columns must read `f`:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

`test:rls` above is **different, and is correct on a superuser URL**: it creates its own unprivileged
role with `CREATE ROLE … NOLOGIN` and `SET LOCAL ROLE`s into it, so it never asserts through the
connection role. Do not reuse the superuser URL from that example for `bun run test`.

### Repeat purchasing, RLS, and catering preconditions

These suites fail in `beforeAll` or stay skipped until the database matches the harness they
check. The application runtime role stays `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`. `CREATEROLE`
belongs only to the ephemeral owner that the RLS suites use to create a throwaway role.

Repeat purchasing needs its own migrated database, the fixture, and a SELECT-only role:

```bash
createdb pharmacy_cohort_test
DATABASE_URL='postgresql://postgres@localhost:5432/pharmacy_cohort_test' \
  MIGRATION_DATABASE_URL="$DATABASE_URL" \
  bunx prisma migrate deploy
psql 'postgresql://postgres@localhost:5432/pharmacy_cohort_test' \
  -f src/lib/pharmacy/repeat-purchasing.fixture.sql
```

```sql
CREATE ROLE cohort_runtime LOGIN PASSWORD 'CHANGE_ME'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE pharmacy_cohort_test TO cohort_runtime;
GRANT USAGE ON SCHEMA public TO cohort_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cohort_runtime;
GRANT SELECT ON pharmacy_sales, pharmacy_sale_lines, pharmacy_sale_returns,
  pharmacy_sale_return_lines, pharmacy_refunds TO cohort_runtime;
```

```bash
PHARMACY_REPEAT_PURCHASING_TEST_DATABASE_URL='postgresql://cohort_runtime:CHANGE_ME@localhost:5432/pharmacy_cohort_test' \
  bunx vitest run src/lib/pharmacy/repeat-purchasing.db.test.ts
```

The tax, pharmacy-medicine, delivery, and wallet RLS suites connect as an owner that can
`CREATE ROLE` and a separate runtime that cannot. Point the owner URLs at the CREATEROLE login
and the runtime URLs at `devfathom_test`:

```sql
CREATE ROLE devfathom_test_owner LOGIN PASSWORD 'CHANGE_ME_OWNER'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOINHERIT;
```

```bash
OWNER='postgresql://devfathom_test_owner:CHANGE_ME_OWNER@localhost:5432/devfathom_test_db'
RUNTIME='postgresql://devfathom_test:CHANGE_ME@localhost:5432/devfathom_test_db'
M8_TEST_OWNER_DATABASE_URL="$OWNER" \
PHARMACY_TEST_OWNER_DATABASE_URL="$OWNER" \
DELIVERY_TEST_OWNER_DATABASE_URL="$OWNER" \
WALLET_TEST_OWNER_DATABASE_URL="$OWNER" \
WALLET_TEST_RUNTIME_DATABASE_URL="$RUNTIME" \
TEST_DATABASE_URL="$RUNTIME" \
  bunx vitest run \
    tests/restaurant-tax-core-rls.test.ts \
    tests/pharmacy-medicine-rls.test.ts \
    tests/restaurant-delivery-rls.test.ts \
    tests/restaurant-wallet-rls.test.ts
```

Catering uses a reserved database whose name contains `disposable`, served on port **55675**,
and a pre-created runtime role with no `CREATEROLE`. `CATERING_MONEY_DB_SLOT=reserved` is
required. Seed one organization, branch, and staff profile before the restricted-role file:

```sql
CREATE ROLE catering_runtime LOGIN PASSWORD 'CHANGE_ME'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
-- After migrating devfathom_catering_disposable, as a superuser:
GRANT USAGE ON SCHEMA public TO catering_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO catering_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO catering_runtime;
INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
  VALUES ('org_catering_ci', 'org_catering_ci', 'Catering CI', 'Catering CI', 'ACTIVE', 'SHARED', now(), now());
INSERT INTO restaurant_branches (id, "organizationId", name, timezone, "businessDayCutoff", "updatedAt")
  VALUES ('branch_catering_ci', 'org_catering_ci', 'Kitchen', 'UTC', '00:00', now());
INSERT INTO restaurant_staff_profiles (id, "organizationId", "displayName", "primaryBranchId", "updatedAt")
  VALUES ('staff_catering_ci', 'org_catering_ci', 'Cook', 'branch_catering_ci', now());
```

```bash
SLOT='postgresql://catering_runtime:CHANGE_ME@127.0.0.1:55675/devfathom_catering_disposable'
CATERING_MONEY_DB_SLOT=reserved TEST_DATABASE_URL="$SLOT" DATABASE_URL="$SLOT" \
CATERING_TEST_DATABASE_URL="$SLOT" \
CATERING_TEST_ORG_ID=org_catering_ci \
CATERING_TEST_BRANCH_ID=branch_catering_ci \
CATERING_TEST_STAFF_ID=staff_catering_ci \
  bunx vitest run \
    src/lib/restaurant/catering-money.db.test.ts \
    src/lib/restaurant/catering-runtime.db.test.ts \
    src/lib/restaurant/catering-endpoints.db.test.ts \
    src/lib/restaurant/catering-postgres.test.ts
```

## Common problems

### Port 3000 is already in use

Find the existing process:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Stop that process normally, then run `bun run dev` again.

### PostgreSQL connection fails

Confirm PostgreSQL is running and that `DATABASE_URL` matches the local username, password, port,
and database name.

### Prisma client is missing

```bash
bun run db:generate
```

### Admin login fails

Confirm both `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` were set before running the seed.
The seed prints `Platform operator created` or `Platform operator updated` when they were, and a
warning when both were unset. Run `bun run db:seed` again after correcting them.

### Optional integrations report missing configuration

Realtime, email, file storage, OAuth, AI, and meetings integrations are optional locally. Leave
their values empty in `.env.local` unless you are testing that integration.

### AI providers

AI is off locally until a provider is configured. To try Ask Fathom or growth insights, set one
plain key in `.env.local`, for example `ANTHROPIC_API_KEY=<your key>`, and set
`AI_PROVIDER=auto`; unset means off. Plain keys work only outside production and must never be committed.

To exercise the deployed path, set `ANTHROPIC_API_KEY_SECRET_ID` or `OPENAI_API_KEY_SECRET_ID`
with `AI_SECRETS_REGION`. For Bedrock, set `BEDROCK_REGION=ap-southeast-1`. Both read through an
AWS profile that can reach them. `AF_HAIKU_LOOKUPS` stays `false` unless you are trying Ask Fathom
quick lookups on the small model. Every variable, the fallback order, the caps and the IAM policy
are in [AI providers](./ai-providers.md).

## Resetting local data

This deletes the local database contents and rebuilds them:

```bash
bun run db:reset
```

The script runs `bunx prisma migrate reset && bunx prisma db seed`. `prisma migrate reset` asks for
confirmation, drops the database's `public` schema, and re-applies every migration. Prisma 7 no
longer runs the seed as part of a reset, so the script runs it afterwards with the same
environment.

Use it only when you are certain the configured database is disposable.

Dropping `public` also drops the `btree_gist` and `pg_trgm` extensions installed there. The
re-applied `20260830120000_btree_gist_public_execute_acl` migration then fails with `P0001`, as it
does on a database where `bun prisma/prepare-extensions.ts` was skipped. On a server with the
default `max_locks_per_transaction` the drop itself can fail first, with `out of shared memory`. If
the reset stops at either point, rebuild the database instead: drop and re-create it (step 2), then
run step 3 from `bun prisma/prepare-extensions.ts` through `bun run db:seed`.
