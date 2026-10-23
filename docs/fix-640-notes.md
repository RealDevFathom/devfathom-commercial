# Issue #640 — pharmacy marketing AI usage recording

## Evidence

- `src/app/(app)/pharmacy/marketing/action-form.tsx:26-27,53-55` creates one UUID per mounted
  assistance form and submits it with every retry of that form.
- `src/server/routers/pharmacy-marketing.ts:56-64` routes pharmacy marketing access through central
  `can()` in addition to the pharmacy module, owner, tenant lifecycle, and branch checks.
- `src/server/routers/pharmacy-marketing.ts:294-335` validates the UUID, reserves before provider
  work, re-authorizes after provider latency, persists the paid output first, and attempts usage
  recording outside that transaction so accounting failure cannot roll back the output.
- `src/lib/pharmacy/marketing-ai-usage.ts:25-41` makes the charge reservation unique by organization,
  branch, and idempotency key and scopes the replay lookup by the same three values.
- `src/lib/pharmacy/marketing-ai-usage.ts:44-83` stores output and token counts in the durable
  generation outbox, inserts tenant/branch-qualified usage idempotently, suppresses data from logs,
  and replays completed output.
- `prisma/migrations/20261023143017_pharmacy_marketing_ai_usage/migration.sql:1-58` makes organization
  and branch non-null, adds composite foreign keys and non-negative token checks, creates all new
  indexes concurrently, and forces tenant-plus-branch RLS on both tables.
- `src/lib/pharmacy/marketing-ai-usage.test.ts:29-82` covers tenant/branch persistence, retained paid
  output after a usage-write failure, and duplicate-request charge fencing. The migration contract is
  additionally covered at `tests/pharmacy-marketing-ai-usage-migration.test.ts:1-27`, and server-action
  forwarding at `src/app/(app)/pharmacy/marketing/actions.test.ts:124-139`.

## Deliberately unchanged

- No restaurant source was changed.
- The existing sandbox-only WhatsApp delivery path was not altered; this change introduces no live
  sender or provider choice.
- Money and stock paths were not touched.

## Skipped / environment constraints

- Per the issue instructions, dependencies were not installed and no tests, typecheck, formatter, or
  database-backed checks were run (the supplied environment has no database and npm access returns
  403). The focused tests above were added by reasoning from the existing code.
- The required `git fetch origin main && git merge --no-edit origin/main` was attempted first, but
  this checkout has no `origin` remote. HEAD was already the requested base `08a247c1`.
