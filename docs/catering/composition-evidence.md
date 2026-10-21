# Catering composition receipt — 2026-10-07

Issue WHA-1294. Owned checkout catering-core/owned-repo, branch codex/restaurant-catering-20261007.
Parent/base: 9bd8c80005daaa4c57f9d8c898285a9baae33136; original core: 83899072f6f702d490f913faed86bf6430659437.

## Reconciliation and source

Preserved tracked patch is 50,016 bytes, SHA256 85ed750b3dcc6e3ab6ce2540070229480ceeab724c6b5bb6001fb6dfd0d26344. All 15 untracked file hashes match the coordinator hold manifest. No reset/replacement of interrupted source.

Accepted recipe source 00a33/c56f6b6f/9fa5 and finance 20da/2219 are composed. Exact finance delta applied with git apply after a successful check. Recipe helper/tests and all three finance implementation/test files match owner regular-file handoffs byte-for-byte. A git-show comparison timed out and was not used as evidence. Recipe engine and finance adapter semantics were not independently changed.

Added terminal-authenticated evidence recording; current-approved payment summary with original receipt quote IDs; explicit approval history; canonical-unit consumed/allocated/remaining quantities and disposition history. Missing original movement or overallocated history fails closed. Legacy automatic reversal reports reconciliation required/null remaining. Caller scope is server-resolved; existing terminal transaction owns rollback and maps errors afterward. Shared terminal-auth/tRPC unchanged.

Composed additive Prisma metadata and finance migration. Fixed inverse approved/confirmed relations to arrays instead of inventing unique SQL constraints. Eighteen relevant FK definitions match saved actual PostgreSQL catalog: fields, referenced fields, mapped names, RESTRICT deletion and NO ACTION updates. SQL RLS/checks/triggers retained. Removed unrelated formatter whitespace edits from existing schema.

Endpoint fixture explicitly supplies legal restaurant band/vertical metadata and uses platformModule variable to satisfy Next lint. Prior interrupted fixture correction remains unaccepted runtime evidence; no runtime success inferred.

Stable exact API: docs/catering/api-handoff.md (also task-root api-handoff.md).

## Verification

Commands from owned-repo unless stated:

- `env -u DATABASE_URL -u TEST_DATABASE_URL node node_modules/vitest/vitest.mjs run --configLoader runner src/lib/restaurant/catering-operations.test.ts src/lib/restaurant/catering-money.test.ts src/server/routers/restaurant-catering.test.ts --cache=false --maxWorkers=1`: 75 passed, one finance source-inspection test failed under jsdom with `TypeError: The URL must be of scheme file`. Catering operations/router: 42 passed. Includes four new canonical-history tests (Decimal allocation, legacy reversal, unavailable source, over-allocation).
- `env -u DATABASE_URL -u TEST_DATABASE_URL node node_modules/vitest/vitest.mjs run --configLoader runner --config docs/restaurant/catering-money/vitest.config.mts src/lib/restaurant/catering-money.test.ts --cache=false`: 34/34 passed in finance's supplied Node environment. No finance source change for that setup failure. Combined unique focused passes: 76.
- `node node_modules/prisma/build/index.js validate`: initially P1012 on two inverse cardinalities; final validation exit 0 after metadata correction. Initial invocation from task root failed MODULE_NOT_FOUND, then correct repository cwd used.
- `node node_modules/prisma/build/index.js generate`: exit 0; generated only owned client. No dependency install/copy.
- Scoped ESLint across operations, finance, route, endpoint/runtime tests and router: one endpoint fixture `@next/next/no-assign-module-variable` error. Renamed variable; targeted endpoint lint rerun exit 0. All other scoped files had no diagnostics.
- Prettier on composer-owned TS/config: final checks pass after formatting the history tests. Accepted finance/recipe files retained byte-exact rather than reformatted.
- `git diff --check`: exit 0. Explicit staged diff check before commit.
- `node docs/catering/typecheck.cjs`: incomplete. Initial check stalled without diagnostics for over four minutes; terminated owned process. A second process inadvertently started after a sandbox-denied termination; both were then stopped with narrow approval. Scoped config now avoids unnecessary whole-repository file enumeration. Final bounded check still timed out after 60 seconds with no diagnostics; no successful typecheck claimed. Log: task-root resume-evidence/typecheck.log.

## Runtime hold and remaining checks

Twelve prior actual restricted-DB service passes are banked, unchanged historical evidence. Four prior endpoint cases failed fixture setup; correction receipt contains only a RUN header, not accepted results.

No DB/build/browser started this run. Port 55675 has no listener; old owned scratch cluster is absent, so there is no reproducible owned cluster to clean. Free disk fell from ~2.7 GiB to ~1.6 GiB, below prior 6.7/8.2 GiB runtime-start observations and 8.4 GiB kickoff. No concrete coordinator clearance received.

Prepared `docs/catering/vitest.runtime.mts` selects only four authenticated endpoint tests and four changed finance lifecycle cases (`rejects terminal`, `refunds revised`). Run with the existing owned harness after coordinator resource clearance; actual roles must remain NOSUPERUSER/NOBYPASSRLS and assertions unchanged. Unchanged green service cases are excluded. Prior failed logs retained.

Unblock owner: local-board/coordinator restores disk-safe resource capacity or supplies concrete clearance for slot 55675, then returns the original owner for targeted endpoint/changed-finance DB proof and the unfinished scoped typecheck. No duplicate owner/job, unrelated cleanup or heavy job is authorized by this receipt.

Source is a reviewable candidate, not integrated runtime acceptance. Risks: unverified endpoint middleware/fixture behavior, changed-finance SQL lifecycle behavior, incomplete scoped typecheck, final UI integration/browser/build still pending. Rollback exposure through endpoint wiring; retain append-only financial/inventory history. No push/merge/deploy/live payments or shared checkout edits.

## Source files

- `docs/catering/api-handoff.md`
- `docs/catering/typecheck.cjs`
- `docs/catering/vitest.runtime.mts`
- `docs/restaurant/catering-money/evidence.prisma`
- `docs/restaurant/catering-money/evidence.sql`
- `docs/restaurant/catering-money/handoff.md`
- `docs/restaurant/catering-money/verification.md`
- `docs/restaurant/catering-money/vitest.config.mts`
- `prisma/migrations/20261007103000_catering_money_evidence/migration.sql`
- `prisma/schema.prisma`
- `src/app/api/restaurant/catering/money/route.ts`
- `src/lib/restaurant/catering-endpoints.db.test.ts`
- `src/lib/restaurant/catering-money-routes.ts`
- `src/lib/restaurant/catering-money.db.test.ts`
- `src/lib/restaurant/catering-money.test.ts`
- `src/lib/restaurant/catering-money.ts`
- `src/lib/restaurant/catering-operations.test.ts`
- `src/lib/restaurant/catering-operations.ts`
- `src/lib/restaurant/catering-runtime.db.test.ts`
- `src/lib/restaurant/recipe-costing.db.test.ts`
- `src/lib/restaurant/recipe-costing.test.ts`
- `src/lib/restaurant/recipe-costing.ts`
- `src/server/routers/restaurant-catering.ts`
- `tests/restaurant-m6-acceptance.test.ts`
