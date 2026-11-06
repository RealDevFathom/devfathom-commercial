[QA][Pharmacy][SEV2] Documented database migrate fails until undocumented extension prep runs
Labels: qa, pharmacy, sev2-major

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Local VM: Bun 1.3.14, PostgreSQL 16, empty database `devfathom`
- Migrate role: `postgres` superuser. Application role `devfathom_app` was created only after migrate and seed succeeded.

## Test case

PH-SET-01

## Steps

1. Create an empty PostgreSQL 16 database.
2. Follow README / `docs/LOCAL_SETUP.md`: `bunx prisma migrate deploy`, then `bun run db:seed`.
3. Do not run `prisma/prepare-extensions.ts` first. That step is not in the documented setup path.

## Expected

The documented commands apply every migration and the seed, including pharmacy packages, on a fresh database.

## Actual

`bunx prisma migrate deploy` stops on migration `20260830120000_btree_gist_public_execute_acl` with PostgreSQL `P0001`: `188 btree_gist functions retain PUBLIC EXECUTE`. The migration hint says to run `prisma/prepare-extensions.ts` with `EXTENSION_ADMIN_DATABASE_URL` first.

After dropping the failed database, running `prisma/prepare-extensions.ts` as the superuser, then `bunx prisma migrate deploy`, 148 migrations applied and `bun run db:seed` completed. Pharmacy packages existed only after that undocumented step.

## Evidence

Setup log in `qa/pharmacy/03-execution-report.md` (section Environment). No screenshot; this fails before the server starts.

## Suggested code area

- `prisma/migrations/20260830120000_btree_gist_public_execute_acl`
- `prisma/prepare-extensions.ts`
- `docs/LOCAL_SETUP.md`
- `README.md`

No fix is proposed here.
