# Developer onboarding

> **Audience:** new engineers and coding agents joining DevFathom.
> **Based on:** `origin/main` @ `16a2a370` (2026-10-22). PR #468 is not reflected yet.
> **Step-by-step setup lives in [`docs/LOCAL_SETUP.md`](../LOCAL_SETUP.md)** (last reviewed 2026-10-21). It is current and exact, so this page does not repeat its commands. Use this page for the overview, the "why", and where things are.

This page takes you from a fresh clone to a running app with a migrated, seeded database and a passing test run. To understand what you are running, read [architecture.md](./architecture.md) next.

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Bun | **1.4.2** | Pinned as `packageManager` in `package.json`. Use Bun, not npm, pnpm or yarn. |
| PostgreSQL | **16** (CI uses `postgres:16`; staging RDS is 16.12) | Required. Tenant isolation relies on Postgres Row-Level Security (RLS). |
| Git | any recent version | |
| Python 3 | TODO(confirm): version | Needed only for the `tests/aws-*_test.py` checks (see [testing.md](./testing.md)). |

There is no Postgres service in Docker Compose. Run Postgres 16 yourself.

## 2. Setup at a glance

Follow [LOCAL_SETUP.md](../LOCAL_SETUP.md) for the exact commands. In summary:

1. `bun install --frozen-lockfile`. The `postinstall` step runs `prisma generate`, which writes the client to `src/generated/prisma`. Never edit that directory; regenerate with `bun run db:generate`.
2. Copy `.env.example` to **`.env.local`** (ignored by Git) and fill in local values. LOCAL_SETUP lists the minimum variables. **Never commit env files or paste real values into docs, PRs, issues or chat.**
3. Create the database and shadow database, plus a separate **application role** that is `NOSUPERUSER NOBYPASSRLS`. The app connects with `DATABASE_URL` as that role; migrations and seeds use `MIGRATION_DATABASE_URL`. A production server refuses to start if the app role can bypass RLS. Follow LOCAL_SETUP's role creation and grants for local development. The deployment helper `prisma/prepare-runtime-role.ts` instead expects **`DATABASE_URL` to be the migration/admin connection** and **`APP_DATABASE_URL` to be the `devfathom_app` connection** to the same server and database; its connect grant is hard-coded to the `devfathom` database. Run it only with that command's environment configured as in [the AWS deployment guide](../deploy/aws.md), after `migrate deploy`. Keep the running app's `DATABASE_URL` on the restricted role.
4. Run `bun prisma/prepare-extensions.ts` **before** migrating. A later migration fails closed if this was skipped.
5. Apply migrations with `bunx prisma migrate deploy` (164 migrations as of `16a2a370`), then grant the app role access as LOCAL_SETUP shows.
6. Seed with `bun run db:seed`.
7. `bun run dev`. The tenant workspace runs at `http://devfathom.localhost:3000` and the platform admin at `http://admin.localhost:3000/platform`. The first platform sign-in enrols an authenticator app.

## 3. Database: migrations, not `db:push`

> ⚠️ **`bun run db:push` is deliberately disabled.** It just prints an error and exits. Do not re-enable it or run `prisma db push` directly.

**Why:** RLS policies and composite constraints are defined **only in SQL migrations**, not in `schema.prisma`. `db push` syncs the schema file and skips the migrations, so you would get a database with no RLS and cross-tenant leaks would go unnoticed. See [architecture.md § Multi-tenancy](./architecture.md#multi-tenancy-and-rls).

| Command | What it actually runs |
|---|---|
| `bun run db:migrate` | `prisma migrate dev`: create and apply a migration while changing the schema |
| `bunx prisma migrate deploy` | Apply existing migrations (used in LOCAL_SETUP for a fresh setup) |
| `bun run db:seed` | `prisma db seed` → `prisma/seed.ts` |
| `bun run db:reset` | `prisma migrate reset`. **Destroys local data.** |
| `bun run db:studio` | Prisma Studio |
| `bun run db:generate` | Regenerate the Prisma client |
| `bun run db:push` | **Disabled.** |

### Changing the schema

1. Edit `prisma/schema.prisma`.
2. Create the migration without applying it: `bunx prisma migrate dev --create-only --name <short-name>`. **If you add a tenant-scoped model, edit the generated SQL to add its RLS policy before applying it.** Prisma will not generate it. Copy the pattern from `prisma/migrations/20260728092000_row_level_security/migration.sql` (the base RLS setup) or a per-module example such as `prisma/migrations/20260818160000_restaurant_brands_catalog_menus/`.
3. Apply the completed migration with `bun run db:migrate`. Add or extend RLS and migration tests (see [testing.md](./testing.md)).

For a brand-new shared database, see the fresh-database pipeline in `prisma/FRESH_DATABASE_ADAPTER.md` and the root `FRESH_DB_HANDOFF.md`. TODO(confirm): which is current, and whether they move into `docs/`.

## 4. Seed data per vertical

| Seed | Purpose | How to run |
|---|---|---|
| `prisma/seed.ts` | Local organization, platform operator, modules, users and demo data | `bun run db:seed` |
| `prisma/seed-demo/restaurant.ts` | Restaurant demo | `bun run demo:seed` |
| `scripts/seed-pharmacy-demo.ts` | Pharmacy demo | No package script. TODO(confirm): how to run it |
| `scripts/seed-pharmacy-e2e.ts` | Pharmacy E2E fixtures (`pharmacy-counter-e2e` demo org) | Used by the pharmacy E2E runner. TODO(confirm): standalone usage |
| `scripts/seed-agency-e2e.ts` | Agency E2E fixtures | Used by the agency E2E runner. TODO(confirm): standalone usage |

`prisma/seeds/` holds seed helpers (currently camera brand presets).

**Admin users.** `prisma/platform-admin.ts`, `prisma/staging-admin.ts`, `prisma/create-admin.ts` and `prisma/reset-admin-password.ts` exist. TODO(confirm): usage. **Never write any login, password or token into docs, code comments, PRs or screenshots.**

## 5. Other scripts

| Command | Purpose |
|---|---|
| `bun run build` / `bun run start` | Production build / standalone server (`scripts/start-standalone.mjs`) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint 9 on `src/` |
| `bun run format` / `bun run format:check` | Prettier on `src/` |
| `bun run platform:jobs` | Process platform background jobs |
| `bun run restaurant:jobs` | Restaurant background jobs |
| `bun run restaurant:print-bridge` | Restaurant print bridge |
| `bun run assistant:eval` / `assistant:diag` | Assistant evaluation and diagnostics |
| `bun run email:smoke` | Email smoke test |

TODO(confirm): whether background jobs must run for any core flow to work locally.

## 6. Verify your setup

```bash
bun run typecheck
bun run lint
bun run test       # Vitest. Use the package script, not `bun test` (Bun's own runner)
bun run build
```

- Most database-backed Vitest suites require `TEST_DATABASE_URL` with a role that is neither `SUPERUSER` nor `BYPASSRLS`; some require additional suite-specific URLs. A run with skipped suites has not verified them. See [testing.md](./testing.md) and LOCAL_SETUP.
- `bun run test:rls` runs the tenant-isolation verifier. Point it only at a **disposable, migrated and seeded** database via `TEST_DATABASE_URL`, using a setup connection that can create and grant roles and `SET ROLE`. The verifier creates its own restricted role for the isolation probes; the app's restricted runtime connection is not sufficient.

## 7. Before your first PR

- Read [contributing.md](./contributing.md). Normal code and docs PRs go to `develop` through review, and nobody pushes directly to `develop`, `staging` or `main`.
- Read [auth-and-roles.md](./auth-and-roles.md) before touching anything in pharmacy dispensing, safety or catalogue review.
- Coding agents: also read `AGENTS.md` / `CLAUDE.md` at the repo root.

## Scope notes

- **Hotel** code (models and routers) still exists but is **out of scope**. It was removed from the MVP and is not documented.
- **Azure** is deprecated. Never deploy to Azure. See [contributing.md](./contributing.md#deployment-azure-is-deprecated).
