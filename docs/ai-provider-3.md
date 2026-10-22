# AI provider piece 3: SuperAdmin settings

## Design

- `aiSettings` is a tRPC router whose procedures authenticate the dedicated platform session and require the exact `SUPER_ADMIN` role. Tenant roles and other platform roles do not confer access.
- Platform AI tables are read and written only through `withPlatformDb`, preserving their forced-RLS boundary. Each mutation places the data change and its `PlatformAuditLog` row in the same transaction.
- Audit rows identify the platform actor, entity, entity id and changed field, and retain structured before/after values. Prices are versioned by provider, model and effective timestamp.
- Decimal values cross the tRPC boundary as strings to avoid floating-point display changes. Inputs accept decimal-like values but enforce finite, positive values no greater than USD 1,000,000. Model identifiers are trimmed and bounded to 200 characters.
- The existing Platform settings page hosts the editor and uses the shared Studio shell, controls, semantic tokens and responsive table conventions. Secrets are neither accepted nor rendered.

## Decisions

- The existing provider and tier vocabulary is deliberately closed: `anthropic` / `bedrock` and `cheap` / `standard` / `deep`.
- A zero monthly budget is rejected rather than treated as a disable switch; `Disabled` mode is the explicit way to disable AI.
- Price upsert uses the existing `(provider, model, effectiveFrom)` key, so a correction updates the matching version while a new effective time creates history.
- The tRPC transport recognizes only the `aiSettings.*` namespace as platform-scoped. The router still performs authorization itself; the transport does not treat platform cookies as tenant identity.

## Follow-ups

- CI should regenerate Prisma artifacts and update `bun.lock` if the base branch's generated client requires it.
- Consider a dedicated platform tRPC endpoint/context if more platform-control routers move from server components or command routes to tRPC.
- Add pagination to model price history if its operational size grows beyond a compact configuration ledger.
