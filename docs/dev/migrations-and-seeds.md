# Migrations and seeds

> Checked against `develop` at `1906b530`: 211 migrations in `prisma/migrations/`, from `20260728000000_baseline` onwards.

## Migrations

- **Migrations are the only way to change the schema.** `bun run db:push` is deliberately disabled: it would drop the RLS policies and composite constraints that exist only in SQL migrations.
- Create one with `bunx prisma migrate dev --name <what_it_does>`. This needs `MIGRATION_DATABASE_URL` (an owner role) and a shadow database URL. Then **edit the generated SQL** to add what Prisma can't express:
  - `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
  - a tenant policy on `organization_id = current_setting('app.current_organization_id', true)` (copy the style of `20260728092000_row_level_security` and later `*_rls` migrations)
  - append-only rules (refuse UPDATE and DELETE) for evidence tables
  - grants for the runtime role, where the pattern requires them
- Apply with `bunx prisma migrate deploy`. Run `bun prisma/prepare-extensions.ts` first on a fresh database.
- **Never edit a migration that has already merged to `develop`.** Add a new one.
- Migration folder names are timestamps. If two PRs collide, rename yours to a later timestamp before merge.
- After a schema change, run `bun run db:generate` (or `bun run build`), `bun run test:rls`, and the relevant `*.db.test.ts` suites.

## The runtime role

The app must run as a role that is `NOSUPERUSER NOBYPASSRLS` (see `prisma/prepare-runtime-role.ts`). Migrations and seeds use `MIGRATION_DATABASE_URL`. A production process refuses to start as a superuser or with `BYPASSRLS` (`src/lib/db/rls-role.ts`, called from `src/instrumentation-node.ts`).

## Seeds

| Command | What it does |
|---|---|
| `bun run db:seed` (`prisma db seed` → `prisma/seed.ts`) | The base local data set: the internal agency organization, its team members, clients, projects, tasks and sample finance records. It writes through RLS as a platform admin, using the migration role when set. Passwords come from your local env (`SEED_PASSWORD` / `ADMIN_PASSWORD`). **Never commit them.** |
| `bunx tsx prisma/seed-demo.ts` | An additive, idempotent agency demo top-up (tasks, history, notes, documents) so the agency screens look lived-in. |
| `bun run demo:seed` (`prisma/seed-demo/restaurant.ts`) | Restaurant demo data. |
| `prisma/seeds/camera-brand-presets.ts` | Camera brand presets (used by the camera screens). |
| Platform provisioning | Pharmacy tenants aren't seeded. Create them from the platform console, which runs the provisioning jobs: `MAIN` branch, role templates, SOP template grants, and the bootstrap admin with `*` + `pharmacy:safety`. E2E runners (`scripts/run-pharmacy-e2e.ts` and others) provision their own fixtures. |

TODO(confirm): whether staging and production run any seed beyond provisioning.
