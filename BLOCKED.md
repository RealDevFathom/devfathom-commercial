# Blocked: QA #144 audit transaction timeouts

Issue: https://github.com/WhatTheStack1/devfathom-commercial/issues/144
Branch: `fix/qa-144-audit-tx-timeouts`
Requested PR base: `integration/consolidation-20261019`

Stopped under the user's instruction to stop after two failed attempts at the same problem. The real PostgreSQL regression suite failed on both attempts:

1. The pre-commit audit lock reproduction expected PostgreSQL `55P03` but received `23503`: an uncommitted newly inserted actor was invisible to the audit foreign-key check. Two other tests passed, including the 1,201-drawer report batch and restricted-role/FORCE RLS checks.
2. After changing the reproduction to lock a committed actor, fixture setup failed on `restaurant_registered_devices_deviceSecretHash_key`. The fixture uses a constant secret hash while retaining earlier disposable fixtures. No third attempt was made.

## Partial implementation

- Defer ordinary independent audit writes until the owning tenant transaction commits or rolls back, using the existing side-effect scope. Run tenant audit persistence with a one-second acquisition limit and five-second transaction timeout. Keep explicit seed audits inside their actor-creating transaction.
- Stream payment-report drawer evidence in pages of 500 and fold counts without retaining all drawer sessions.
- Add Prisma migration/schema indexes for tenant/branch/date report predicates on closes, drawers, and SOP occurrences. No RLS policies or FORCE RLS settings changed. Audit organizationId continues to come from the session.
- Add unit coverage and an unfinished real Postgres regression suite.

## Checks

- `TMPDIR=/tmp bun install`: PASS; Prisma client generated.
- Read issue comments and full JSON body, root AGENTS.md, and installed Next `after` API documentation before implementation. No UI changes.
- Focused tests: `bun run test src/server/audit.transaction.test.ts src/lib/side-effects/outbox.test.ts src/lib/restaurant/reports.test.ts src/lib/restaurant/financial-comparison.test.ts`: PASS, 74 tests / four files.
- Fresh isolated local PostgreSQL 17 database `qa144_test`: all 152 migrations deployed, including the new indexes. The first deployment required the repository's extension preflight; running `prisma/prepare-extensions.ts`, resolving that failed migration as rolled back, and redeploying succeeded.
- DB equivalent: `QA144_DATABASE_URL=<restricted local role URL> QA144_OWNER_DATABASE_URL=<local fixture owner URL> bun run test tests/qa144-audit-reports.db.test.ts`: FAIL on the two attempts described above. Role `qa144_app` is NOSUPERUSER / NOBYPASSRLS. Owner connection is only for fixture preparation.
- `NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`: first attempt terminated by SIGKILL (exit 137) while another worktree's TypeScript process consumed about 5 GB. No second attempt made before the database stop condition.
- No reliable individual report timings recorded. The first DB run passed the seeded report batch's <5-second assertion, but did not capture its individual timings. The second run never reached measurements. Do not treat the requested timing acceptance as complete.

## Remaining work for a separately authorized continuation

Make deviceSecretHash unique per test fixture and ensure cleanup/repeatability; validate the corrected lock reproduction and after-commit audit persistence; add rollback/audit-failure coverage; run real Postgres tests and record affected report timings; review whether additional report sources need bounded pagination; rerun typecheck; review the complete diff and create the requested PR with `Fixes #144` only after validation succeeds.

No PR opened and no merge performed. This branch contains partial, unverified work and is not ready to merge.
