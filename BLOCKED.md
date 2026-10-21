# Blocked: PR #175 typecheck memory limit

Worktree: `/workspace/wt/fix/wa-drug-guard`; branch: `fix/wa-drug-guard`.
Task rules were read from `/workspace/wt/prompts/_rules.txt`, alongside AGENTS.md and `gh pr view 175 --comments`.

Stopping as required after two failed attempts at the same problem:

1. `TMPDIR=/tmp bun run typecheck`: Node exhausted its default approximately 4 GiB heap (SIGABRT).
2. `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=12288 bun run typecheck`: terminated by SIGKILL before reporting a typecheck result. The container reported 16 GiB total RAM and other concurrent workloads. No successful typecheck is claimed.

Completed checks:

- `bun install` succeeded.
- `TMPDIR=/tmp bun run test src/lib/growth src/lib/platform/jobs.purge.db.test.ts src/lib/pharmacy/whatsapp`: 13 files passed, 1 skipped; 200 tests passed, 5 skipped. PostgreSQL purge tests were skipped because the database test environment was unavailable.
- `git diff --check` passed.

Changes implement copy normalization and regression corpus, a single maintained provenance/alias data file, outbound store capability separation, an all-src send-path scan, campaign drain copy validation, and transactionally retained tenant consent evidence with FORCE RLS. Changes remain unverified by typecheck and real PostgreSQL migration/purge tests. No Next.js surface or UI was changed.

Resume in an environment with enough memory, run the required typecheck, then apply migrations to a disposable PostgreSQL test database and run the purge/RLS tests before declaring the security work complete. Review the implemented source enforcement and retained evidence policy as part of that validation.
