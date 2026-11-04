> Superseded by [AI providers](./ai-providers.md) (DEV-576). Kept for history; do not follow it.

# AI provider routing and spend tracking (piece 2/5)

## Design

`ai_settings` is a platform singleton (`id = default`) containing the routing mode, monthly Anthropic budget, and cheap/standard/deep model choices for Anthropic and Bedrock. In `Auto`, calls use Anthropic while recorded Anthropic spend is **strictly below** the budget. At or above the budget, they use Bedrock. The accounting month starts at midnight on the first in `Asia/Karachi` (UTC+05:00).

A complete non-streaming call goes through `routeAI`. Anthropic credit/billing errors, HTTP 429, and HTTP 5xx retry once on Bedrock only in `Auto`. `ForceAnthropic` and `ForceBedrock` never fail over. `Disabled` raises `AIUnavailableError('DISABLED')`. A successful attempt is recorded in `ai_usage`; a failed attempt is recorded when the provider reports token usage, which is the evidence that the attempt was billable. Price lookup chooses the latest effective provider/model row, with conservative code defaults when no price row exists.

Settings are cached for 30 seconds. Spend is deliberately not cached, so reaching the budget affects the next call. Concurrent calls close to the threshold may collectively exceed it; reservation/accounting transactions are a follow-up if a hard cap becomes required.

## Security and tenancy

All three tables are platform-scoped. Settings and prices have no organization tenancy. Usage's nullable `organizationId` is attribution data, not an RLS boundary. The migration enables and **forces** RLS, installs a platform-admin-GUC-only policy, and revokes `PUBLIC`, matching the existing platform control-plane pattern. The narrow server-only `spend.ts` module performs every read/write through `withPlatformDb`; callers never receive a database client.

## Provider selector compatibility

Explicit legacy provider selectors keep the legacy path. In particular, `AI_PROVIDER=azure` is untouched: it neither enters this router nor changes model construction/provider options. `AI_PROVIDER=auto` enables routing. An unset selector may also use routing when the platform settings singleton exists. Other explicit selectors continue to use `createAIModel` exactly as before. This piece wires the pharmacy marketing generation path; additional streaming paths require a stream-aware attempt boundary and are a follow-up rather than changing Azure behavior.

## Follow-ups

- Add a platform-admin editor and audit trail for settings/prices.
- Add stream-aware metering/failover for assistant streaming (failover is only safe before response bytes are emitted).
- Replace fallback price constants whenever a model is introduced and seed effective-dated production prices.
- Consider atomic spend reservations if the monthly amount becomes a contractual hard limit.
