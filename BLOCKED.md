# BLOCKED: test suite failed on two attempts

Worktree: `/workspace/wt/fix/sec-next-upgrade`; branch: `fix/sec-next-upgrade`; PR #160.

Stopped under the user's two-failed-attempt rule. No further implementation or test retries were attempted.

## Changes completed

Removed all busboy overrides. Scoped Undici, deepmerge-ts and uuid overrides to their actual consumers while preserving declared majors. Updated Hono 4.12.27 to 4.13.13, clearing its eight medium advisories and one low advisory. Verified Prisma resolves mysql2 3.24.6.

Registry and OSV show no fixed releases within Undici 5, deepmerge-ts 7, or uuid 8. These remain vulnerable; removing the busboy override restores vulnerable busboy 2.1.1 under Undici 5. The PR contains actual before/after audit output and explains this compatibility constraint.

## Check results

- Initial `TMPDIR=/tmp bun install`: passed.
- Post-change `TMPDIR=/tmp bun install`: passed, including Prisma generation.
- First typecheck overlapped Prisma regeneration and failed with TS6053 missing generated files. Retried after generation: `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck` passed (exit 0).
- `TMPDIR=/tmp AUTH_SECRET=<local build-only value> NODE_OPTIONS=--max-old-space-size=6144 bun run build`: passed (exit 0).
- `bun audit`: exit 1; 27 findings (7 high, 17 moderate, 3 low). No clean-audit claim.
- First `bun run test`: exit 1; 9 failed files, 671 passed, 127 skipped; 11 failed tests, 9924 passed, 1409 skipped. Ten failures were test/hook timeouts; the other failure could not find the saved-binding option in print-routing-section.
- Second `bun run test --maxWorkers=2`: again reported failures. Stopped after observing the second failed attempt rather than retrying further. Partial output below; no full-suite pass claimed.

```text
$ vitest run "--maxWorkers=2"

 RUN  v4.1.10 /workspace/wt/fix/sec-next-upgrade

 ❯ src/components/restaurant/catering/catering-console.test.tsx (59 tests | 2 failed) 35786ms
     × preserves failed input; changing a rejected command creates a new key 11052ms
     × rejects freshly changed staff tenant before money transport 432ms
 ❯ src/components/restaurant/pos/order-pad.test.tsx (31 tests | 1 failed) 20628ms
     × ignores a deferred customer response after operator switch 11191ms
 ❯ src/components/restaurant/promotions/promotions-console.test.tsx (30 tests | 1 failed) 72873ms
     × preserves all twenty components and prevents adding a twenty-first 67936ms
[vitest-pool]: Timeout terminating forks worker for test files /workspace/wt/fix/sec-next-upgrade/src/server/routers/restaurant-staff.test.ts.
Not implemented: navigation to another Document
error: script "test" exited with code 143
```

The alternate rules file `/workspace/wt/prompts/_rules.txt` was found and read; this worktree's `prompts/_rules.txt` is absent. Installed Next upgrading guides were read. Only this branch is being committed and pushed; no merge or deployment.
