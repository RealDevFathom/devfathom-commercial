# Technical overview

Status: **IMPLEMENTED** for the core web workspace and shared tenant boundary; individual integrations and release surfaces are marked below.

## Product shape

DevFathom Commercial is a web-based operating hub for agencies and companies. The repository contains an authenticated tenant workspace, a separate seller/platform control desk, organization administration, and API surfaces. The product is organization-scoped: customer data is not a global shared workspace even though the default deployment shares infrastructure.

Evidence: [`README.md`](../README.md), [`src/app/(app)/`](../src/app/(app)/), [`src/app/platform/`](../src/app/platform/), [`prisma/schema.prisma`](../prisma/schema.prisma).

## Runtime topology

```text
Browser
  -> AWS ECS Fargate (Next.js 16 App Router)
       -> NextAuth / tenant and platform session handling
       -> tRPC routers + REST routes + SCIM/SSO routes
       -> Prisma 7 -> RDS PostgreSQL
       -> S3 uploads (when configured; private filesystem locally)
       -> routed AI providers: Anthropic -> OpenAI -> Bedrock (Ask Fathom)
       -> Ably when configured (realtime fallback exists)
       -> self-hosted LiveKit/TURN (future media topology; not live)
```

Staging runs on AWS (ECS Fargate, RDS PostgreSQL and S3 in `ap-southeast-1`); see [`deploy/aws.md`](deploy/aws.md). The AWS production environment is not created yet. `www.devfathom.com` remains the existing marketing site and no public custom domain is attached. See the [status ledger](status-ledger.md).

## Tenancy and security boundary

The database is shared by default, with organization-scoped rows, forced PostgreSQL RLS, and scoped composite references. `withTenantDb` is the application access pattern; platform operations use `withPlatformDb`. Organization activation is manual through the seller control desk. Shared deployment is the default; dedicated environments and custom domains are enterprise work subject to rollout approval.

Evidence: [`admin-platform/architecture-tenancy.md`](admin-platform/architecture-tenancy.md), [`admin-platform/adr/001-tenant-rls.md`](admin-platform/adr/001-tenant-rls.md), [`src/lib/tenancy/scoped-db.ts`](../src/lib/tenancy/scoped-db.ts), [`scripts/verify-tenant-isolation.ts`](../scripts/verify-tenant-isolation.ts).

## API and background work

The application exposes tRPC under `/api/trpc/[trpc]`, a versioned REST surface under `/api/v1`, health at `/api/health`, platform session/control/job routes, SCIM v2, SSO callbacks, file/upload routes, assistant routes, and an Ably token route. The generated API documentation page and REST spec are the best route-level inventory.

Platform jobs are processed through `src/lib/platform/jobs.ts`, the CLI script, and `/api/platform/jobs/process`. Jobs cover provisioning and lifecycle operations; external provider dependencies are not equivalent to local build verification.

Evidence: [`admin-platform/api.md`](admin-platform/api.md), [`src/app/api/`](../src/app/api/), [`src/lib/platform/jobs.ts`](../src/lib/platform/jobs.ts), [`src/app/(app)/api-docs/`](../src/app/(app)/api-docs/).

## Current capability map

| Capability | Status | Evidence / boundary |
| --- | --- | --- |
| Workspace shell, dashboard, projects, clients, notes, team/HR, finance, reviews, settings | **IMPLEMENTED** | `src/app/(app)/` and `README.md`; depth varies by module |
| Organization administration | **IMPLEMENTED** | `src/app/(app)/organization/`, `admin-platform/` docs |
| Manual platform activation, contracts, entitlements, support access, audit | **IMPLEMENTED** | `src/app/platform/`, `src/lib/platform/`, `admin-platform/` docs |
| Tenant RLS and isolation checks | **IMPLEMENTED** | Prisma migrations, `src/lib/tenancy/`, `scripts/verify-tenant-isolation.ts` |
| OIDC/SAML, JIT, SCIM | **PARTIAL** | Routes and contract/build evidence exist; real customer IdP rollout remains required |
| Ask Fathom provider adapter and credits | **PARTIAL** | `src/lib/ai/provider.ts`, assistant routes/tools; provider and quota operations remain environment-dependent |
| Email | **PARTIAL** | Templates and delivery abstraction exist; staging is capture-only and production sender verification is pending |
| Realtime chat | **PARTIAL** | Ably integration with graceful fallback; in-house realtime is planned |
| Meetings schema/reconciliation | **IMPLEMENTED** | PR #23 merged to `main`; staging migration/backfill, seed, deploy, and smoke passed |
| Meetings Wave-1 browser QA | **BLOCKED** | Cowork login/dashboard/responsive checks passed, but `getAll` and both `getUpcoming` queries attendee-filter the admin despite org-wide ADMIN detail/manage authorization; five migrated meetings are undiscoverable |
| Meetings self-hosted LiveKit/TURN | **PLANNED / PARTIAL** | Schema release is verified, but media endpoints are not live and production has not been cut over |
| Native mobile applications | **FUTURE** | Current scope is web; responsive browser use is distinct from native apps |

## Non-goals and operating constraints

- No self-serve SaaS activation or automatic payment processing is represented as shipped.
- No `@devfathom.com` mailbox is provided; connected Gmail, Outlook, and generic IMAP/SMTP are the planned email direction.
- No pricing, SLA, compliance certification, customer, savings, or benchmark claim is publishable without an owner-approved evidence source.
- Production and staging databases must remain separate.
- Planned production hosts are `www.devfathom.com` and `admin.devfathom.com` on one deployment. Currently `www.devfathom.com` remains the GoDaddy marketing site and `admin.devfathom.com` is absent; the apex remains marketing.
- `meet.devfathom.com` and `turn.devfathom.com` are future endpoints, not live services.
- AWS is the deployment platform; see [`deploy/aws.md`](deploy/aws.md). Legacy Vercel SDK/blob code is a partial migration dependency, not deployment guidance.
