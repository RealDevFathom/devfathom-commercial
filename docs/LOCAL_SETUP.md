# Running DevFathom Locally

Last reviewed: 2026-07-29

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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devfathom
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

If your PostgreSQL username, password, host, or port differs, update both database URLs in
`.env.local`.

## 3. Install and initialize

```bash
bun install --frozen-lockfile
bunx prisma migrate deploy
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
