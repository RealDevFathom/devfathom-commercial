# Local setup (summary)

> The full, maintained steps are in [`docs/LOCAL_SETUP.md`](../LOCAL_SETUP.md). This page is the short version. Checked against `develop` at `1906b530`.

## You need

- Bun **1.4.2** (the version `packageManager` pins; older Bun can't read `bun.lock`)
- Node **22.20 or newer** for tooling
- PostgreSQL 16 (local)
- Git

## Steps

1. **Clone and branch.** Clone `RealDevFathom/devfathom-commercial` and branch off `develop`; see [branching.md](branching.md).
2. **Environment.** Copy `.env.example` to `.env.local` and fill in the variables listed in `LOCAL_SETUP.md` §1: the app database URL, the migration and shadow URLs, the auth and platform secrets, the base domain and the seed settings. Generate secrets locally (`openssl rand -base64 32`). **Never commit `.env.local`, and never paste its values into docs, PRs or chat.**
3. **Databases.** Create the main and shadow databases (`createdb …`).
4. **Install and migrate.**
   ```bash
   bun install --frozen-lockfile
   bun prisma/prepare-extensions.ts
   bunx prisma migrate deploy
   ```
   `bun run db:push` is **disabled on purpose**: RLS policies and composite constraints exist only in migrations.
5. **Seed.** `bun run db:seed` (see [migrations-and-seeds.md](migrations-and-seeds.md)).
6. **Run.** `bun run dev`, then open the tenant host printed in `LOCAL_SETUP.md` §4. The first platform sign-in asks you to enrol an authenticator app (MFA).
7. **Check.**
   ```bash
   bun run typecheck && bun run lint && bun run test && bun run build
   ```
   A full typecheck can run out of memory on small machines. Several PRs used `NODE_OPTIONS=--max-old-space-size=12288`.

## Optional integrations

These are off unless configured: AI (`AI_PROVIDER`, unset = disabled), pack-photo reading (`PHARMACY_PACK_OCR_ADAPTER=FIXTURE` for local work), Ably, LiveKit, email, WhatsApp and wallet passes. Missing configuration shows a "not configured" state instead of failing. For AI, prefer `AI_PROVIDER` unset or a fixture locally; `bun run ai:smoke` checks a configured provider. **Never use `AI_PROVIDER=azure`.**

## Common problems

See `LOCAL_SETUP.md`, "Common problems": port 3000 in use, Postgres connection failures, a missing Prisma client (`bun run db:generate`), admin login failures.
