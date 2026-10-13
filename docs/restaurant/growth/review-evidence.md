# Restaurant review candidate evidence — WHA-1400

Parent `c42551d84366e448dd4e4a2c0e5a395ee2277ea5`, original exact base
`83899072f6f702d490f913faed86bf6430659437`.
Checkout `growth-restaurant/owned-repo`, branch `codex/restaurant-growth-20261007`.

## Changed files (additive only)

- docs/restaurant/growth/review-handoff.md
- docs/restaurant/growth/review-storage.sql
- docs/restaurant/growth/review-evidence.md
- src/lib/restaurant/growth-review-contract.ts
- src/lib/restaurant/growth-review.ts
- src/lib/restaurant/growth-review.test.ts
- src/lib/restaurant/growth-review.db.test.ts
- src/server/routers/restaurant-growth.ts
- src/components/restaurant/growth/growth-review-panel.tsx
- src/components/restaurant/growth/growth-review-panel.test.tsx
- src/app/(app)/restaurant/growth/actions.ts
- src/app/(app)/restaurant/growth/page.tsx
- tests/e2e/restaurant-growth.config.ts
- tests/e2e/restaurant-growth.spec.ts

Before: aggregate evidence adapter and proposal only. After: Restaurant-only
persistence/review service, SQL fragment, protected router/server-action route,
review UI, focused tests and admission-only DB/browser tests. Default shared
binding remains absent and honest UNAVAILABLE; no real model or campaign result.

## Executed checks

1. `node node_modules/vitest/vitest.mjs run src/lib/restaurant/growth-review.test.ts src/components/restaurant/growth/growth-review-panel.test.tsx --no-cache`
   — exit 0, 2 files / 44 tests passed (35 service, 9 UI).
2. `node node_modules/typescript/bin/tsc --project <run-scratch>/restaurant-review-tsconfig.json --pretty false`
   — exit 0, zero diagnostics. Config extends absolute checkout tsconfig; disables
   incremental; includes all eleven changed TS/TSX files and existing `src/**/*.d.ts`;
   excludes nothing. Imported dependencies checked. No full workspace typecheck.
3. `node node_modules/eslint/bin/eslint.js src/lib/restaurant/growth-review*.ts src/components/restaurant/growth/*.tsx src/server/routers/restaurant-growth.ts 'src/app/(app)/restaurant/growth' tests/e2e/restaurant-growth*.ts`
   — exit 0, zero errors; one warning: `_input` unused in UI test callback line 43.
4. `node node_modules/prettier/bin/prettier.cjs --check` with the same changed
   TS/TSX paths — exit 0, all matched files formatted.
5. `git diff --exit-code c42551d8 -- package.json bun.lock prisma/schema.prisma prisma/migrations src/lib/ai src/lib/pharmacy src/server/routers/_app.ts`
   — exit 0. Protected shared/package/schema surfaces unchanged.
6. `git diff --check` — exit 0. Final staged whitespace check is recorded with the
   commit receipt in the issue handoff.

Initial service run: 28/29, replay fixture fingerprint used pre-parse JSON key
order. Initial scoped tsc: four diagnostics (jest-dom matcher declaration,
zero-argument mock tuple, router vertical narrowing). Single consolidated
correction included canonical parsed actor-bound fingerprint fixture, test types,
vertical narrowing and scoped validation/source-link tightening. Final results above.
Initial separate UI run also passed 9/9. No repeated unchanged financial-core tests.

## Security/source review

Checked explicit tenant and branch predicates, active branch, current capability and
package boundaries; absence of actor/tenant input; strict bounded settings and output;
scoped row lock plus revision/unique-final guards; draft transaction and immutable
SQL/RLS; fixed action refs; no publishing/delivery/provider call; error redaction at
public route; exact-request reconciliation after uncertain UI response. SQL relies
on accepted shared append-only source and the trusted binding contract documented
in review-handoff.md. These are source findings and mock evidence, not SQL proof.

## Skipped and residual risks

- Five restricted PostgreSQL tests prepared, not run. No DB connection/migration.
  Role guard explicitly asserts `rolsuper=false` and `rolbypassrls=false` first.
- Five Playwright cases prepared, not run. No listener, browser, screenshots,
  responsive visual proof, full Studio theme/motion/keyboard matrix or build.
- No configured-model execution, live capture, consent-withdrawal delivery test,
  unknown-no-resend delivery test, genuine posted synthetic receipt reconciliation,
  concurrent DB race proof or real committed transaction rollback proof.
- No generation bridge. Frozen shared validator/storage contract, current-evidence
  lineage, genuine cohort/freshness support and centrally applied SQL still needed.
- Customer consent reader exists; inspected staff notification stubs and webhook
  inbox are not a customer campaign/STOP capture adapter. Narrow proposal delivered.
- Existing financial source/refund adapter at c42551d8 preserved. USD/PKR only;
  current currency is not proof of historical currency. No fabricated denominators.
- No package installation, secrets/private-env reads, provider calls, remote Git,
  push/merge/rebase, other worktree edits, production mutation or deployment.

Paperclip first read failed inside network sandbox (curl exit 7). Authorized read
outside the sandbox succeeded and confirmed the latest comment. No new instruction
superseded the authorized slice. Final artifacts/status are posted via that path.

Reviewer: local-board/coordinator. Candidate source review is requested; integrated
acceptance remains pending. Rollback before integration: omit additive commit.
