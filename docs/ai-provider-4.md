# AI provider spend report and cap alerts (DEV-576)

Originally piece 4 (`feat/ai-provider-4-usage`). It replaced a single Anthropic budget with
per-provider monthly caps for Anthropic, OpenAI and Bedrock. Code: `src/lib/ai/usage.ts`,
`src/components/platform/ai-usage-panel.tsx`, `src/server/routers/platform-ai-usage.ts`.

## Report

- Every figure comes from the platform ledger `ai_provider_usage`, which the router writes for
  each billed attempt. The tenant `ai_usage` table records attribution only. It is never read
  for spend.
- Spend is grouped by provider and tier for the current **Asia/Karachi calendar month**.
  `karachiMonthBounds` in `router.ts` sets the bounds, the same ones routing uses. The bounds
  are UTC instants and the end is exclusive.
- Money is in integer US-dollar minor units. Each aggregate is rounded once in SQL: the
  provider total is rounded from its unrounded sum, not built up from rounded tiers.
- Each provider shows its effective cap, `resolveRoutingSettings(...).capsUsd`. The cap is the
  SuperAdmin value if one is saved, otherwise `AI_<PROVIDER>_MONTHLY_CAP_USD`, otherwise the
  default (USD 190 Anthropic, 190 OpenAI, 300 Bedrock).
- Each provider also shows the percent used and a status:
  - `ok`;
  - `near_cap` at 80% or more;
  - `capped` once spend is at or above the cap. This is the router's exact skip rule, so a zero
    cap is always capped.
- The panel lists every tier with the model it routes to now.
- Only `SUPER_ADMIN` can read the report. It authenticates the platform session itself and never
  trusts the tenant tRPC context.

## Cap alerts

After the router records an attempt, it calls `maybeCreateAIBudgetAlert(provider, now)` as
best-effort work. This call never throws and never fails an AI call or its metering. It logs
only the provider and the error class.

- **80% of the provider's effective cap.**
  - It claims `(provider, YYYY-MM)` in `ai_budget_alert_months`.
  - It writes one `ai_cap_near` row in `platform_notifications` for every active SUPER_ADMIN.
  - The claim and the notifications are written in the same transaction. The primary key makes a
    concurrent second call a no-op. A failed fan-out rolls the claim back, so a later call tries
    again.
- **100% of the cap.**
  - It writes one `ai_cap_reached` notification per active SUPER_ADMIN: "routing skips this
    provider".
  - Each row's id is `ai_cap_reached:<provider>:<month>:<platformUserId>`, so concurrent calls
    write each row once. The migration was not changed for this.
  - A provider that jumps straight past its cap gets only this notice. The claim is still taken.
- **Limitation.** If a SuperAdmin lowers a cap below the current spend, routing skips that
  provider at once. No further attempt is recorded for it, so no alert fires. The panel still
  shows it as `capped`.

## Follow-up

Show `platform_notifications` in the platform shell's notification control once the shared
control-plane inbox exists. Until then the rows are stored as durable unread notifications.
