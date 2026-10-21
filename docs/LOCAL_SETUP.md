# Running DevFathom Locally

Last reviewed: 2026-10-21

## Prerequisites

- [Bun](https://bun.sh) `1.3.14` or compatible
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

AUTH_SECRET=<random-secret>
AUTH_URL=http://devfathom.localhost:3000
NEXT_PUBLIC_APP_URL=http://devfathom.localhost:3000

PLATFORM_BASE_DOMAIN=localhost
PLATFORM_ENCRYPTION_KEY=<32-byte-base64-or-64-character-hex-key>
PLATFORM_ADMIN_EMAIL=<local-platform-email>
PLATFORM_ADMIN_PASSWORD=<strong-local-password>
CRON_SECRET=<random-secret>

DEFAULT_ORGANIZATION_ID=org_devfathom
SEED_PASSWORD=<local-seed-password>
```

Generate local secrets with:

```bash
openssl rand -base64 32
```

Keep `.env.local` private. It is ignored by Git.

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
migrations and seed (a local superuser is enough). Prisma CLI and the seed read
`MIGRATION_DATABASE_URL` from `.env` and `.env.local` when it is set, and otherwise fall
back to `DATABASE_URL`. The running server reads `DATABASE_URL` only.

`next start` and any production process refuse to boot when that application role is
`SUPERUSER` or `BYPASSRLS`, and when `CLIENT_IP_HEADER`, `TRUSTED_PROXY_CIDRS`, and
`TRUSTED_PROXY_HOPS` are all unset. `bun run dev` does not run either check. Confirm the
application role with:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

Both columns must be `f` on the `DATABASE_URL` connection.

## 3. Install and initialize

```bash
bun install --frozen-lockfile
bunx prisma migrate deploy
```

Prisma and the seed load `.env`, then `.env.local`. After migrate, grant the application role
access to the objects the migration role owns:

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
and it sets the platform-admin tenant setting inside its transaction:

```bash
bun run db:seed
```

The seed creates the local DevFathom organization, platform operator, modules, users, and demo
data. Platform login uses `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`; tenant login uses
an email printed by the seed and the `SEED_PASSWORD` value.

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
Run `bun run db:seed` again after correcting them.

### Optional integrations report missing configuration

Realtime, email, file storage, OAuth, AI, and meetings integrations are optional locally. Leave
their values empty in `.env.local` unless you are testing that integration.

## Resetting local data

This deletes the local database contents and rebuilds them:

```bash
bun run db:reset
```

Use it only when you are certain the configured database is disposable.
