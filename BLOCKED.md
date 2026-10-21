# Blocked: QA-143 open-bill tax summary

Stopped under the user's instruction to stop after two failed attempts at the same problem.

## Work preserved

Reviewed and preserved the eight pre-existing modified files. The implementation quotes open bills through the tender tax calculation, serializes taxTotal, and displays tax using the existing checkout UI tokens. Added UI regression coverage and expanded the real Postgres acceptance case to cover the settled summary and card with tip.

The full issue was retrieved with `gh issue view 143 --repo WhatTheStack1/devfathom-commercial --json title,body,comments`; there are no comments.

## Two unsuccessful Postgres verification attempts

1. The first run failed during fixture setup because updating an already published tax rule correctly triggers `published tax version is immutable`. Replaced that fixture operation with creation of a dedicated published 15% exclusive CASH/CARD/OTHER profile, matching the reported issue. No database guards were disabled.
2. The second run completed 26 tests successfully but failed the QA-143 acceptance test at `expect(settled.settled).toBe(true)` after the final cash tender. The tender itself returns settled=true, a receipt number, and zero due, but a subsequent summary returns settled=false. This requires further investigation of evaluateOrderSettlement and tax-inclusive accounting. The later card assertions were not reached.

Log: `/tmp/qa143-db.log`. Isolated local database: `qa143_test`, fully migrated with the repository extension-hardening preflight. Tests ran as `qa143_runtime` with NOSUPERUSER and NOBYPASSRLS. FORCE RLS and organization scoping were not changed.

## Checks

- Regression reproduction against original checkout-routes.ts confirmed the reported 970.00 total / 0.00 remaining due and absent tax; restored working implementation immediately afterward.
- `NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`: passed before the final test-fixture adjustment; not rerun after stopping.
- Focused `bun run test`: 3 files, 44 tests passed (checkout UI, checkout serialization, tender posting).
- ESLint on all eight changed source/test files: passed before the final test-fixture adjustment; not rerun after stopping.
- Real Postgres terminal checkout suite: 26 passed, 1 failed on the second attempt.
- Full browser visual QA is incomplete. A temporary Vite harness did not start; no viewport/theme/motion/keyboard screenshots or production build are claimed.

## Handoff

Continue only with user authorization after this required stop. Investigate why a settled exclusive-tax bill makes the order summary remain unsettled, finish the card acceptance case, rerun required checks, and complete feasible visual QA. No PR was created because the stop instruction requires committing, pushing, and exiting with the blocker unresolved. No other branches were checked out or merged.
