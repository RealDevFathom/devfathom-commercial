# Handoff log

Last updated: 2026-11-02 (UTC). Branch: `saad/exciting-ramanujan-w973fo` (based on `origin/develop` @ `47518cb`).

## Resume here

- **Item:** DEV-258 (per-organization invoice numbers).
- **Single next action:** wait for the final branch typecheck. Its output goes to the scratchpad as
  `tsc-branch3.txt`; compare it with `tsc-develop.txt` there (the list should be the same 8 errors).
  Then run `NODE_OPTIONS=--max-old-space-size=8192 bun run build`.
- **Then:** open the PR into `develop` (never merge) using the drafted body in the scratchpad
  (`pr-body.md`), and comment on DEV-258 with the PR link.
- **Uncommitted / half-written:** nothing.

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
- `src/lib/finance/invoice-number.db.test.ts` (new) has three cases, all through the real routers inside
  `withTenantDb` as a NOSUPERUSER NOBYPASSRLS role: (1) two orgs each get `INV-<year>-001`, and a duplicate
  within one org still fails with P2002; (2) while a holder transaction keeps one org's lock, two creates
  queue on the advisory lock, a create in a second org is not blocked, and on release the two get
  `-001`/`-002`; (3) six concurrent creates mixing `finance.createInvoice` and
  `clients.generateInvoiceFromContract` produce `-001`..`-006`.
  - It fails on the old code: develop's callers plus the global unique index give 3/3 failures (P2002
    across tenants, no lock queueing, P2002 in the burst).
- Commits:
  - `b11234e`: helper, all four callers, schema, migration, seed scoping, and this log.
  - `deb0c5c`: the DB test.
  - `674d17c`: unit tests. `finance.invoice-money.test.ts` and `api/v1/invoices/route.test.ts` mocks
    now answer the allocation queries and assert the allocated number. New
    `src/lib/finance/invoice-number.test.ts` covers formatting, the lock key, MAX query values, the
    first number of a year, per-org keys and the error outside a tenant. New
    `src/lib/ai/tools/finance.create-invoice.test.ts` checks the assistant allocates and inserts in one
    transaction and never touches the per-operation client.
  - `3cce7e2`: use `BigInt(n)` instead of `4n` literals in three test files. The tsconfig target is
    below ES2020, so `tsc` rejects BigInt literals (TS2737).

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
| Typecheck | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit` (it runs out of memory with the default heap) | 8 errors, the same set as clean `develop`. None are new. A rerun covering the new test files is pending |
| Lint/format | `bunx eslint <changed files>` and `bunx prettier --check <changed files>` | pass |
| Unit tests (affected) | `bunx vitest run src/server/routers/finance src/server/routers/clients src/app/api/v1/invoices src/lib/ai/tools/finance src/lib/ai/tools/finance.create-invoice.test.ts src/lib/finance` | pass (DB suites that need other env vars are skipped) |
| Unit tests (full) | `env -u TEST_DATABASE_URL bunx vitest run --reporter=json --outputFile=<file>`, on the branch and on the `develop` worktree | branch: 12967 passed, 47 failed out of 14762. develop: 12960 passed, 47 failed out of 14752. **The 47 failures are the same tests on both, so none are new.** The branch has 10 more tests: 7 new unit tests that pass and 3 DB cases skipped without `TEST_DATABASE_URL` |
| DB test | `TEST_DATABASE_URL=$U bunx vitest run src/lib/finance/invoice-number.db.test.ts` (admin URL: the suite creates its own restricted role) | 3/3 pass |
| DB test, CI-style | `TEST_DATABASE_URL=postgresql://gate_runtime:gate_runtime@localhost:5432/devfathom_test bunx vitest run src/lib/finance/invoice-number.db.test.ts` | 3/3 pass, fixtures cleaned up |
| Build | `bun run build` | not run yet |

#### Known failures

- Typecheck errors in files this branch does not touch: `src/components/pharmacy/counter/counter-console.test.tsx`,
  `src/lib/ai/tools-routing.test.ts`, `src/lib/ai/tools/restaurant-reports.test.ts`,
  `src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts`, `src/server/routers/pharmacy-inventory.test.ts`,
  `src/server/routers/restaurant-catering.test.ts`. **These also fail on `develop`:** a clean `develop`
  worktree produces the identical error list. No new errors.
- **Full vitest: 47 failing tests across 39 suites, the same set on `develop`. None are new.** They are
  all in areas this branch does not touch:
  - restaurant: recipe migration, tax, daily close, tenders, growth review;
  - pharmacy: reports, baskets, inventory, finance evidence;
  - platform: opportunity conversion and organization create;
  - ABAC capability pins, hotel foundation, vertical foundation;
  - `src/lib/projects/membership-lock.db.test.ts`.

  Several are DB suites that fall back to this container's ambient `DATABASE_URL`
  (`dev@localhost/devfathom`), which does not exist here.

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
