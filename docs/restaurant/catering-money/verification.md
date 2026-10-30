# Bounded verification receipt — 2026-10-07

Base/parent: `83899072f6f702d490f913faed86bf6430659437`.
Branch: `codex/restaurant-catering-money-20261007`.
Owned checkout: `/Users/Saad/Documents/Codex/2026-10-06/task-2/catering-money/owned-repo`.

## Executed evidence

- `node_modules/.bin/vitest run --configLoader runner --config docs/restaurant/catering-money/vitest.config.mts`: 1 file passed, **24 tests passed**, 0 skipped, 656 ms. Covers exact amounts/caps, planned versus paid, cash fold, replay identity/conflict, current-quote guard, role/device/actor denials, failure propagation, closed day/drawer, cash refund mapping and prohibited writer source checks. Model delegates are unit doubles, never PostgreSQL/RLS evidence.
- `node_modules/.bin/eslint src/lib/restaurant/catering-money.ts src/lib/restaurant/catering-money.test.ts src/lib/restaurant/catering-money.db.test.ts`: exit 0. Next ESLint emits the missing-pages warning in this sparse checkout; no source lint errors.
- Focused TypeScript project: **exit 0**; adapter plus both tests and imported dependency closure, including the repository's `src/types/next-auth.d.ts`. Uses local source first and read-only banked source fallback for paths omitted by sparse checkout. Exact run from owned task folder: `./owned-repo/node_modules/.bin/tsc -p verification-tsconfig.json --noEmit`. The task-local config is retained outside the candidate; no shared TypeScript configuration changed.
- `git diff --check`: exit 0. Final staged scope review follows before commit.

## Corrections and environment failures

Full worktree checkout failed with `fatal: mmap failed: Operation canceled`. Recovered as a sparse worktree on the same requested base/branch; no shared source was changed. Dependencies and generated Prisma client were read through local symlinks, with no new dependency tree.

An initial test config import failed; corrected to an import-free config. The new service fixture initially used numeric businessDayCutoff=0; corrected to the existing HH:MM contract (`00:00`). Default Vite config bundling attempted a write into the read-only shared node_modules link and failed EPERM; `--configLoader runner` avoids that write. An initial focused type config omitted the repository auth augmentation; added it. Relocating that task-local config then required an explicit local dependency typeRoots path. These were setup/fixture corrections; final results above supersede them.

## Not run / blockers

- Seven prepared real PostgreSQL acceptance tests were **not run**. No slot was reserved and central quote/evidence schema composition is pending. They explicitly assert rolsuper=false and rolbypassrls=false and seed two organizations/three branches. They cover concurrent overpayment/refund, replay/conflict, whole-transaction rollback, tenant/branch/device/capability/currency denial, stale approval, drawer cash, settled-sales exclusion, noncash provenance and RLS/append-only behavior.
- No schema migration, DB listener, provider invocation, browser, full-suite run or production build. Heavy gates were explicitly prohibited for this heartbeat.
- No independent reviewer was spawned or claimed; delegation was prohibited. Candidate is not self-approved.

Unblock owner: local-board/coordinator composes the reviewed catering owner contract plus evidence fragment into an isolated disposable database and reserves a runtime slot. The existing finance owner then runs the prepared PostgreSQL suite and reports actual evidence. Catering owner retains router/quote/fulfillment/cancellation policy; no money endpoint is exposed before composition and review.

Residual risk: SQL fragment and concurrency/RLS/rollback behavior remain unverified against PostgreSQL; router/session integration and final shared schema relation metadata remain outside this candidate. Do not treat successful unit/type/lint checks as release acceptance. Disable future route wiring to roll back exposure; never delete append-only evidence.

## Lifecycle correction — source phase, 2026-10-07

Parent: `20da9e25582528bb8211706c6903ee9c7b9c1bbf`.
Exact changed files: `src/lib/restaurant/catering-money.ts`,
`src/lib/restaurant/catering-money.test.ts`, `src/lib/restaurant/catering-money.db.test.ts`,
`docs/restaurant/catering-money/handoff.md`, and this verification receipt.

Before: new receipts did not read order status; refunds required current approval after edits.
After: new receipts require an allowed nonterminal order and current approval; refunds retain
original same-order/tenant/branch receipt quote, historical approval, currency/source and remaining cap.
Identical successful replay remains before lifecycle checks and after current actor/device/capability checks.
No transaction/idempotency primitives, schema fragments, or shared runtime files changed.

Executed commands:

- `node_modules/.bin/vitest run --configLoader runner --config docs/restaurant/catering-money/vitest.config.mts`: **34 passed**, zero skipped, 728 ms.
- `./owned-repo/node_modules/.bin/tsc -p verification-tsconfig.json --noEmit` (task root): exit 0.
- `node_modules/.bin/eslint src/lib/restaurant/catering-money.ts src/lib/restaurant/catering-money.test.ts src/lib/restaurant/catering-money.db.test.ts`: exit 0; existing sparse-checkout missing-pages warning only.
- `git diff --check`: exit 0.

Initial source test attempt failed before collecting tests because the temporary generated-client
link was absent. Restored the prior read-only shared-client link; checks above passed. Removed
that verification-only link before commit. No dependencies installed.

Added prepared PostgreSQL cases for CANCELLED/CLOSED new receipt rejection with unchanged write
counts, revised DRAFT/CANCELLED refunds, receipt/refund replay, changed-key conflict, remaining cap,
exact persisted quote/original lineage, cross-order original and unapproved history rejection.
These cases are NOT RUN in this lane. Database atomicity/RLS/approval SQL are still runtime risks.

Current runtime and schema owner is the same WHA-1294 composer, agent 7025, exclusive slot 55675.
This supersedes the earlier unreserved-slot / finance-owner runtime handoff above. Composer must
apply the exact follow-up commit after the initial candidate and run the updated restricted-role
suite on the composed schema. No second DB, heavy jobs, shared schema changes, or composer checkout edits.
Independent review remains pending. Roll back exposure via route wiring; retain financial history.
