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
| Production resource shell | **PARTIAL** | Empty tagged production resource group reported 2026-08-08; `docs/azure-deployment.md` | Infrastructure | No app, DB, Key Vault, storage, AI, secret, deployment, DNS, certificate, or billable resource exists |
| Production OIDC and RBAC | **IMPLEMENTED** | Production-only secretless OIDC identity; scoped production-RG and shared-ACR roles reported 2026-08-08 | Infrastructure | Revalidate before cutover; maintain no staging role |
| GitHub production environment | **IMPLEMENTED** | Seven required Azure variables and `main`-only deployment branch policy reported 2026-08-08 | Infrastructure | Keep values out of docs; revalidate before promotion |
| Production OIDC helper parity | **PARTIAL / BLOCKED** | `infra/configure-github-oidc.sh` still assumes shared principal/policy behavior | Infrastructure + implementation owner | Reconcile helper with separate production identity and `main`-only policy; verify idempotently |
| Production readiness fixes | **IN PROGRESS** | Draft PR #33 is open; patch under test in another worktree; not merged/deployed; audited-main baseline `89f75459` (#24) | Infrastructure + implementation owner | Merge, review, staging verification, and deployment evidence |
| Production template and promotion | **BLOCKED** | `infra/`; `.github/workflows/promote-production.yml`; `docs/azure-deployment.md` | Infrastructure + release owner | Safe bootstrap, email wiring, health smoke, resources, and deployment validation |
| Production cutover | **BLOCKED** | `docs/azure-deployment.md` | Infrastructure + release owner | Readiness fixes complete; isolated resources provisioned; migration/rollback rehearsal and explicit approval |
| Ask Fathom provider adapter | **PARTIAL** | `src/lib/ai/provider.ts`; `docs/azure-deployment.md` | AI/platform | Provider quota, credit policy, and production observability |
| Email | **PARTIAL** | `src/lib/email/`; `docs/azure-deployment.md` | Platform + operations | Sender/DNS/provider verification; connected inbox design |
| Meetings Wave-1 schema/reconciliation | **IMPLEMENTED** | PR #23 merged to `main` at `ac20ca0`; staging build, migration/backfill, seed, deploy, and smoke passed | Meetings owner | Complete application integration and media rollout; do not equate schema release with live media |
| Meetings media product | **PLANNED / PARTIAL** | Meeting scope and ADR; staging release evidence does not prove LiveKit/TURN production | Meetings + infrastructure | Implement and verify media endpoints; keep `meet`/`turn` future until deployed |
| Meetings media endpoints | **FUTURE** | `docs/meetings/000-product-scope.md`; `docs/admin-platform/adr/005-self-hosted-meetings.md` | Meetings + infrastructure | `meet.devfathom.com` and `turn.devfathom.com` are reserved, not live |
| In-house realtime | **FUTURE / PLANNED** | `README.md`; current Ably integration | Realtime owner | Architecture and migration decision |
| Native mobile apps | **FUTURE** | `docs/meetings/000-product-scope.md` | Product | No current web release gate |
| Commercial packaging and pricing | **PLANNED** | `docs/product-pack.md`; `docs/admin-platform/commercial-ledger.md` | Product + sales | Owner decision on prices, limits, support, and credits |

## Release gate

Before a capability is described as shipped, attach the exact PR/commit, test or staging evidence, environment, verification date, and owner. “Code exists” is not sufficient for provider-backed integrations or production operations.
