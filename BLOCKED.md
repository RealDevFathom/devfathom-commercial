# Issue #130 — stopped under the two-attempt rule

Work is incomplete and is not ready to merge. No PR was opened.

The previous environment-only blocker was deleted in the first commit, as requested.
Implementation was performed directly in this worktree with Node 22+ on PATH.

## Repeated blocker

The new all-router capability mapping test's lightweight TypeScript program could
not resolve dynamic action expressions on two successive attempts:

1. `pharmacy-finance.ts`: the `action` in a literal tuple `for...of` was unresolved
   with no standard-library definitions.
2. After enabling standard-library definitions, `restaurant-customers.ts` still
   reported an unresolved `action`.

An earlier full-application TypeScript program timed out. Per the user's rule,
work stopped after the two unresolved-action attempts; no further repair was made.

## Current changes

- Canonical colon pharmacy role templates and capability catalogue.
- Shared fail-closed capability matcher for ABAC, restaurant checkout, and pharmacy
  stock-signal drafts; no runtime dot-to-colon normalization.
- Explicit procurement capability on goods-receipt posting.
- Prisma data migration for known legacy role grants and user overrides with DENY
  collision precedence, transaction-local platform context, and FORCE RLS retained.
- Unit, router, and real PostgreSQL migration/RLS regression tests (not all green).

## Validation

- `gh issue view 130 --comments` and the complete issue body were read.
- `bunx prisma migrate deploy`: PASS on isolated local `qa130_test`, cloned from
  the existing local test database; the new migration applied successfully.
- `bun run typecheck`: default heap attempt failed with Node OOM; retry with
  `NODE_OPTIONS=--max-old-space-size=8192` exited 0. The retry began before the
  final test-fixture edits, so final committed sources still need typechecking.
- `bun run test src/lib/abac src/lib/vertical-catalog.test.ts src/server/routers/pharmacy-purchasing.test.ts`:
  172 passed, 1 failed (router mapping unresolved dynamic action).
- Latest focused mapping + dispensing-router run: 17 passed, 1 failed (mapping).
  The actual template-based dispensing and cashier goods-in denial tests passed.
- Real PostgreSQL `bun run test tests/pharmacy-capabilities.db.test.ts`: 1 passed,
  1 failed. Tenant RLS + migrated grant authorization passed. The migration
  assertion expected only the dispense DENY override, but the documented
  dispense alias expansion also produced an expiring safety ALLOW. Review that
  mapping's intended scope before adjusting the assertion; do not blindly bless it.
- `bun run lint` was launched; its final result is recorded below if available.
- Build was not run after the mandatory stop.
- Final bypass/regression review was not completed.

## Next work

Resolve the mapping-test dynamic-expression enumeration without loading the entire
application graph; review migration alias expansion (especially direct overrides),
finish collision/expiry and role-grant coverage, rerun all affected tests and real
Postgres tests, then final typecheck/lint/build and a security regression review.
Only after all required checks pass should a PR be opened against
`integration/consolidation-20261019`, with `Fixes #130`, the issue link, and results.
