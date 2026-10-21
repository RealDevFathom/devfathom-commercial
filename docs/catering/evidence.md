# Catering continuation evidence — October 7

Base/parent: `83899072f6f702d490f913faed86bf6430659437`.
Branch: `codex/restaurant-catering-20261007`.
Owned checkout: `task-2/catering-core/owned-repo`; initial working tree clean.
Final SHA/tree and patch are recorded in the sibling `delivery-receipt.md` after commit.

## Verification

From owned-repo:

- `node node_modules/vitest/vitest.mjs run src/server/routers/restaurant-catering.test.ts src/lib/restaurant/catering-operations.test.ts src/lib/restaurant/catering-postgres.test.ts --maxWorkers=1 --no-file-parallelism`: **38 passed, 4 skipped**, two passing files, one skipped. Router 21; operations 17. PostgreSQL 4 skipped because reserved disposable database/fixture variables are absent.
- `NODE_OPTIONS=--max-old-space-size=2048 node docs/catering/typecheck.cjs`: scoped production roots plus repository auth declaration. Final diagnostics recorded in delivery receipt. No full workspace typecheck/build.
- `node node_modules/eslint/bin/eslint.js src/lib/restaurant/catering-operations.ts src/lib/restaurant/catering-operations.test.ts src/lib/restaurant/catering-postgres.test.ts src/server/routers/restaurant-catering.ts src/server/routers/restaurant-catering.test.ts`: final result in receipt.
- `node node_modules/prettier/bin/prettier.cjs --check` on the same five TypeScript files: passed.
- `git diff --check`: passed.
- `node node_modules/prisma/build/index.js validate --schema "$PAPERCLIP_RUN_SCRATCH_DIR/catering-schema.prisma"`: **valid**, Prisma 7.9.1. Scratch schema constructed from unchanged base schema with the two owned fragments; no shared schema overwrite or client regeneration.

First tests exposed outdated actor/frozen-quote fixtures, updated against the new policy. Scratch validation exposed an index-name collision, fixed with explicit names. Scoped typecheck exposed three null-narrowing diagnostics and omitted auth declaration in the command, corrected. Added package test exposed missing shared procedure mapping: fixed with an explicit entitlement gate in this owned router. Final checks follow this single correction pass.

## Evidence limits and review

- Unit/source tests cover capability, package, tenant predicate, branch and actor denial; quote publication/replay/history and stale approval; frozen data despite changed recipes/prices; Decimal missing/estimated costs; actual existing ledger gram→kilogram conversion; READY once under serialized mock transactions; capacity contention under serialized mock transactions; keyed transition replay/conflict; cancellation without automatic stock restoration; capped physical return, waste/no-return and changed replay; propagated late failures.
- Transaction mocks are **not PostgreSQL concurrency or rollback proof**. Four executable PostgreSQL checks assert non-SUPERUSER and non-BYPASSRLS roles, forced RLS, tenant isolation, append-only quote history, same-order approval and rollback of earlier writes after a late CHECK failure. They were prepared, not run. Real concurrent confirmation/consumption/disposition still needs reserved database acceptance.
- Migration SQL was **not executed**, and no listener, browser, full build, provider call, payment, push, merge or deploy occurred. Runtime grants, triggers, FK behavior and DB contention remain integration checks.
- Dependencies reused through local symlinks; no package/lockfile changes or new dependency tree. No recipe-costing.ts, pharmacy, shared router root, inventory implementation, money adapter or UI edits.
- Recipe math correctness still depends on WHA-1320. Money adapter/reconciliation depends on WHA-1213. Source integration and runtime acceptance belong to coordinator/local-board; this patch is a review handoff, not whole-product acceptance.
- Legacy unknown intervals may make capacity UNKNOWN and block confirmations; no invented capacity or historical backfill. Confirmed legacy orders without frozen quotes cannot newly consume inventory. Existing movements remain immutable; historical automatic reversal blocks additional return until reconciliation.
- Forward recovery: keep additive schema/history, fix forward. Reverting to the old router would restore unsafe cancellation semantics and bypass new confirmation guards; do not roll it back independently.
- Self-review performed for lock order, tenant predicates, actor trust, frozen data, exact units, immutable history and failure propagation. No independent reviewer spawned (explicit lane contract); local-board is the requested reviewer.
