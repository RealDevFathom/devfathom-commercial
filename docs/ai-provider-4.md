# AI provider piece 4: usage and budget alerts

This branch is built in parallel with piece 3 and must be rebased onto that sibling when it lands.
Piece 3 owns the SuperAdmin routing/settings controls; its persisted budget will remain exposed
through `getAiBudgetMinor()`, the only budget seam consumed here.

## Design

- Spend is grouped by provider and tier for the current **Asia/Karachi calendar month**. Boundaries
  are converted to UTC before querying and the end is exclusive.
- Monetary API values are integer US-dollar minor units. Stored high-precision USD is rounded only
  after each provider/tier aggregate, avoiding floating-point values at the UI boundary.
- The usage procedure authenticates with the platform session directly and permits only
  `SUPER_ADMIN`; it never trusts tenant tRPC context.
- At 80% of the Anthropic budget, a unique month claim and notification fan-out to every active
  SuperAdmin happen in one transaction. The primary key makes concurrent attempts idempotent.
- Usage recording launches the alert check as best-effort, non-blocking work. Recording and AI
  responses are never failed by alert delivery.

## Follow-ups after rebase

1. Resolve the piece-3 settings-page composition mechanically, retaining `AIUsagePanel` below its
   controls.
2. Keep piece 3's setting lookup inside `getAiBudgetMinor()` and preserve the environment/default
   fallback for rollout safety.
3. Surface `platform_notifications` in the platform shell notification affordance when that shared
   control-plane inbox is implemented; this migration intentionally stores durable unread rows now.
