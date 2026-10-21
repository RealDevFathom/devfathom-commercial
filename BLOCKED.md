# Blocked: PR #178 review-comment retrieval

Stopped under the task's rule to stop after two failed attempts at the same problem.

1. `gh pr view 178 --comments` failed because the personal access token could not access status-check rollup resources.
2. A retry with `gh pr view 178 --comments --json comments` failed because this gh version does not allow combining `--comments` and `--json`.

The CTO verdict at `/workspace/plan/cto-notes/pr178.md` was read. No implementation changes were made. Typecheck and focused tests were not run because the stop rule was triggered before implementation.

A future authorized attempt can retrieve comments with `gh pr view 178 --json comments` (without `--comments`) before continuing the requested DENY precedence, required branchId, and active branch-bound staff checks.
