# Handoff log

Last updated: 2026-11-02 (UTC). Branch: `saad/exciting-ramanujan-w973fo` (based on `origin/develop` @ `47518cb`).

## Resume here

- **Item:** DEV-258 (per-organization invoice numbers).
- **Single next action:** write `src/lib/finance/invoice-number.db.test.ts`, the Postgres test run as a
  NOSUPERUSER NOBYPASSRLS role. Copy the role setup from `src/server/routers/notes.concurrency.db.test.ts`
  (`beforeAll`). Cases: (1) two orgs each get `INV-<year>-001` from `financeRouter.createInvoice` run
  inside `withTenantDb`; (2) two concurrent creates in one org get distinct numbers (hold the org's lock
  with `allocateInvoiceNumber` in a blocker `withTenantDb`, wait for 2 sessions with
  `wait_event = 'advisory'` in `pg_stat_activity`, release, assert `-001`/`-002`); (3) a burst mixing
  `finance.createInvoice` and `clients.generateInvoiceFromContract` stays one gapless sequence.
- **Then:** fix the unit-test mocks that still stub `invoice.count` (they now need `$transaction` and
  `$queryRaw`): `src/server/routers/finance.invoice-money.test.ts`, `src/app/api/v1/invoices/route.test.ts`.
  Add `src/lib/finance/invoice-number.test.ts` (lock key, MAX query, formatting, error outside tenant).
- **Uncommitted / half-written:** nothing. Everything so far is in the commit listed below.

## Items

### DEV-258: agency invoice numbers collide across tenants and under concurrency

- Linear: https://linear.app/devfathom/issue/DEV-258/qasev2-agency-invoices-invoice-number-comes-from-a-non-atomic-count1
- GitHub issue: https://github.com/RealDevFathom/devfathom-commercial/issues/441
- Branch: `saad/exciting-ramanujan-w973fo`
- PR: not opened yet. It will target `develop`.
- Status: **in progress**

#### Done so far

- `src/lib/finance/invoice-number.ts` (new):
  - `allocateInvoiceNumber(tx, now?)` reads the tenant from `app.current_organization_id` (the same
    setting RLS and the `organizationId` column default use). It takes
    `pg_advisory_xact_lock(hashtextextended('invoice-number:<org>', 0))`, then in a SEPARATE statement
    reads `MAX` of the numeric suffix of `INV-<year>-<n>` for that org and returns the next number.
    The separate statement is needed because under READ COMMITTED it takes a fresh snapshot after the
    lock wait. MAX (not COUNT) stays ahead of existing numbers after a deletion.
  - `createWithNextInvoiceNumber(db, (tx, invoiceNumber) => tx.invoice.create(...))` runs the allocation
    and the insert in one `$transaction`. Inside a request transaction (tRPC, REST) the scoped db reuses
    the request transaction; the assistant's per-operation `createTenantDb` opens a new one.
- All four creators use it: `finance.createInvoice` (`src/server/routers/finance.ts`),
  `clients.generateInvoiceFromContract` (`src/server/routers/clients.ts`), `POST /api/v1/invoices`
  (`src/app/api/v1/invoices/route.ts`), and the assistant `createInvoice` tool (`src/lib/ai/tools/finance.ts`).
- `prisma/schema.prisma`: `invoiceNumber` loses `@unique`; `Invoice` gains
  `@@unique([organizationId, invoiceNumber])`.
- Migration `prisma/migrations/20261102000000_invoice_number_per_organization/migration.sql`: creates
  `invoices_organizationId_invoiceNumber_key` first, then drops `invoices_invoiceNumber_key`.
- `prisma/seed.ts`: the sentinel `findUnique` uses `organizationId_invoiceNumber` with `org_devfathom`
  (this is what the DEV-258 QA comment asked for). `prisma/seed-demo.ts`: the sentinel count is scoped
  to `org_devfathom`.
- Commits: see `git log origin/develop..HEAD` (the first checkpoint commit adds this file with the code).

#### Checks (rerun commands and latest results)

Local disposable DB (Postgres 16 in this container, started with `pg_ctlcluster 16 main start`):
`postgresql://qa_admin:qa_admin@localhost:5432/devfathom_test` (superuser). A restricted
`gate_runtime` role exists there too (password `gate_runtime`). These are local throwaway credentials,
not real secrets.

| Check | Command | Latest result |
| --- | --- | --- |
| Prisma client | `bunx prisma generate` | pass |
| Migrations | `EXTENSION_ADMIN_DATABASE_URL=$U DATABASE_URL=$U MIGRATION_DATABASE_URL=$U bun prisma/prepare-extensions.ts && DATABASE_URL=$U MIGRATION_DATABASE_URL=$U bunx prisma migrate deploy` | pass, new migration applied |
| Schema vs migrations | `DATABASE_URL=$U bunx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, compared before and after | identical. All remaining drift existed before (migration-only constraints) |
| Seed | `SEED_PASSWORD=... DATABASE_URL=$U MIGRATION_DATABASE_URL=$U bunx prisma db seed`, run twice | pass. The second run takes the "already present" sentinel path |
| Typecheck | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit` (it runs out of memory with the default heap) | running. The errors seen so far are only in files this branch does not touch (see Known failures) |
| Lint | `bunx eslint <changed files>` | not run yet |
| Unit tests | `bunx vitest run src/server/routers/finance src/app/api/v1/invoices src/lib/ai/tools/finance src/lib/finance` | not run yet. Expected to fail until the `invoice.count` mocks are updated |
| DB test | `TEST_DATABASE_URL=$U bunx vitest run src/lib/finance/invoice-number.db.test.ts` | not written yet |
| Build | `bun run build` | not run yet |

#### Known failures

- Typecheck errors in files this branch does not touch: `src/components/pharmacy/counter/counter-console.test.tsx`,
  `src/lib/ai/tools-routing.test.ts`, `src/lib/ai/tools/restaurant-reports.test.ts`,
  `src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts`, `src/server/routers/pharmacy-inventory.test.ts`,
  `src/server/routers/restaurant-catering.test.ts`. Still to confirm against `develop` with the same command.

#### Decisions and open questions

- **Advisory lock instead of a counter table.** It needs no new table, RLS policy, grants or backfill, a
  rolled-back create does not use up a number, and the sequence cannot drift from the real invoices.
  The DEV-258 history shows an earlier counter-table attempt (`fix/followup-399*`) that never reached
  `develop`.
- **Tenant taken from the transaction setting, not a parameter.** The lock, the read and the inserted row
  then cannot disagree about the organization. Allocation throws outside a tenant transaction.
- **Lock key is per organization, not per organization and year.** That is simpler, and creates within
  one organization serialize briefly anyway.
- **`@@index([organizationId])` kept on `Invoice`.** The new composite unique index makes it redundant,
  but removing it is out of scope.
- Commit messages carry no Co-Authored-By lines and no model names, per your instruction.
