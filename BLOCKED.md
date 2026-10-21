# BLOCKED — issue #132

Stopped under the task's explicit rule: after two failed attempts at the same problem, write this file, commit and push the current branch, then exit.

Issue: https://github.com/WhatTheStack1/devfathom-commercial/issues/132

## Partial implementation

- Added a Studio manual Create medicine form on `/pharmacy/medicines`. It calls the existing `createMedicine` procedure with unreviewed provenance, no client-supplied organizationId, and `saleable: false`.
- Exposed the existing review/publication and pack setup controls. Moved optional import tools and preserved staged-source review into disclosures, retaining one page H1.
- Added UI regression tests and an in-memory procedure integration test for creation, review, publication, effective pack receiving, and onboarding step 8.
- No server procedure, database, seed, migration, RLS, or unrelated issue changes.

## Repeated problem and exact failures

The new full-flow integration test fixture is incomplete. Two execution attempts failed:

1. `create-medicine.procedure.test.ts`: publication returned FORBIDDEN because the in-memory fixture lacked `user.findUnique`, required by the real ABAC evaluator. Added that fixture delegate.
2. Rerunning that integration test reached publication but failed at `src/server/routers/pharmacy-medicine.ts:1068`: `tx.medicineAlias.create` is absent from the fixture. Per the two-attempt rule, no further fix or rerun was made.

The second failure is a test fixture failure, not evidence that publication succeeds end to end. The implementation must not be represented as complete.

## Actual checks

- `TMPDIR=/tmp bun install`: passed; generated Prisma client. No dependency manifest or lockfile changes.
- Initial affected `bun run test`: could not start workers under system Node 20.19.2; installed undici requires Node >=22.19.0.
- Retried affected suite with temporary npm-cached Node 22 and `--maxWorkers=2`: **8 files passed, 1 failed; 63 tests passed, 1 failed**. Passing files: create-medicine UI, medicine-pack-setup UI and procedure, staged-medicine-review UI, pharmacy-medicine router, pharmacy-medicine connector, onboarding, onboarding-checklist.
- New integration test rerun with Node 22 and `--maxWorkers=1`: **1 test passed, 1 failed**, missing `medicineAlias.create` as above.
- `bun run typecheck`: failed with default 4 GB V8 heap exhaustion. Retried with Node 22 and `NODE_OPTIONS=--max-old-space-size=12288`; still running when the stop rule triggered, so this task's tsc process was terminated. **No successful typecheck.**
- Lint and production build: not run before stop rule triggered.
- Real Postgres: not run; database/RLS/seed unchanged. Integration delegates are in memory.

## Visual QA matrix — not completed

- Canonical design contract and installed Next forms, use-client, and page docs read before implementation.
- Attempt to inspect `http://qa-clifton.localhost:3000/pharmacy/medicines`: connection refused. This worktree has no local environment file or running app server.
- System Chromium was discovered, but no component harness or browser run was completed before the stop rule.
- 375/768/1024/1440 px, light/dark, normal/reduced motion, keyboard/focus/Escape, overflow, UI state visuals, console, screenshots, and tenant Studio parity: **unverified in browser**.
- UI tests cover first-medicine explanation, draft payload, simple-strength validation, preserved errors, permission denial, pending disable, and candidate invalidation. These do not replace visual or signed-in end-to-end QA.

## Resume work needed

Complete the procedure fixture, rerun affected tests and typecheck, run focused lint/build as feasible, and perform the visual QA matrix plus a signed-in medicine-to-pack smoke test. Review partial implementation for correctness before opening a PR against `integration/consolidation-20261019`.

No PR was opened because the stop rule requires exit after commit/push. When ready, its body must contain `Fixes #132`, the issue URL above, and actual test/QA results.
