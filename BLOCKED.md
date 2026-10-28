# Growth G7 blocked: campaign dependencies absent

The fixed origin/improve/ai-growth-g1 was merged and the old schema blocker removed.
`bun install` and Prisma generation succeeded.

G7 explicitly depends on G6, which depends on G5. Neither implementation exists
in this worktree after merging G1: src/lib/growth contains only flag, metrics,
churn and refill helpers; src/server/routers/growth.ts exports an empty router.
The Campaign schema exists, but the reusable segment materialisation, campaign
lifecycle, budget enforcement, discount redemption and auto-approval logic do not.
File discovery and a separate symbol search confirmed these missing dependencies.

The plan requires dependency order and reuse; implementing these packages here
would rebuild G5/G6 outside the minimal G7 scope. No win-back automation was added.
Merge the completed G5/G6 implementation into the permitted base before rerunning G7.
The existing PR must not be merged as a completed G7 implementation.

Validation: bun install passed; focused growth tests passed (3 files, 29 tests).
Typecheck: NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck passed.
No build or full test suite was run, per the shared-box limits.
