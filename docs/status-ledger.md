# Living status ledger

Last verified: 2026-08-08. Owners are role placeholders until a named owner is assigned. Evidence links are repository paths; they are intentionally not secret-bearing.

| Workstream | Status | Evidence | Owner | Blocker / next gate |
| --- | --- | --- | --- | --- |
| Tenant schema and RLS | **IMPLEMENTED** | `prisma/schema.prisma`; `docs/admin-platform/adr/001-tenant-rls.md`; `scripts/verify-tenant-isolation.ts` | Platform engineering | Re-run against each production database before cutover |
| Platform authentication and control desk | **IMPLEMENTED** | `src/app/platform/`; `docs/admin-platform/identity-access.md` | Platform engineering | Credential rotation and operator policy |
| Manual organization lifecycle | **IMPLEMENTED** | `docs/admin-platform/lifecycle.md`; `src/lib/platform/` | Operations | Approved onboarding/retention policy |
| Catalog, packages, entitlements | **IMPLEMENTED** | `docs/admin-platform/entitlements.md`; `src/lib/module-catalog.ts` | Product + platform | Owner-approved commercial tier mapping |
| Core workspace modules | **IMPLEMENTED** | `src/app/(app)/`; `README.md` | Product engineering | Module-specific acceptance evidence |
| OIDC/SAML/JIT and SCIM | **PARTIAL** | `src/app/api/sso/`; `src/app/api/scim/`; `docs/admin-platform/identity-access.md` | Enterprise engineering | Real customer IdP test and credentials |
| Azure staging | **IMPLEMENTED** | `docs/azure-deployment.md`; `.github/workflows/deploy-staging.yml` | Infrastructure | Maintain separate staging DB and rotate secrets |
| Production cutover | **BLOCKED** | `infra/`; `.github/workflows/promote-production.yml`; `docs/azure-deployment.md` | Infrastructure + release owner | Explicit approval, production resources/RBAC/DNS, migration rehearsal |
| Ask Fathom provider adapter | **PARTIAL** | `src/lib/ai/provider.ts`; `docs/azure-deployment.md` | AI/platform | Provider quota, credit policy, and production observability |
| Email | **PARTIAL** | `src/lib/email/`; `docs/azure-deployment.md` | Platform + operations | Sender/DNS/provider verification; connected inbox design |
| Meetings Wave 1 | **PLANNED / PARTIAL** | `docs/meetings/000-product-scope.md`; `docs/admin-platform/adr/005-self-hosted-meetings.md`; current meeting routes | Meetings owner | Confirm landing PR and release evidence; LiveKit/TURN operations |
| In-house realtime | **FUTURE / PLANNED** | `README.md`; current Ably integration | Realtime owner | Architecture and migration decision |
| Native mobile apps | **FUTURE** | `docs/meetings/000-product-scope.md` | Product | No current web release gate |
| Commercial packaging and pricing | **PLANNED** | `docs/product-pack.md`; `docs/admin-platform/commercial-ledger.md` | Product + sales | Owner decision on prices, limits, support, and credits |

## Release gate

Before a capability is described as shipped, attach the exact PR/commit, test or staging evidence, environment, verification date, and owner. “Code exists” is not sufficient for provider-backed integrations or production operations.
