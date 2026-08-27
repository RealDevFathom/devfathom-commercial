# DevFathom documentation

This directory is the source-backed documentation index for DevFathom Commercial. It describes the current web product, the seller-operated control plane, and the Azure operating model. It does not authorize deployment, commercial promises, or capability claims that are not evidenced in the repository.

## Status vocabulary

Use one status on every capability claim:

- **IMPLEMENTED** — present in the current repository and covered by a cited verification or source path.
- **IN PROGRESS** — an identified implementation workstream is active, but has not yet cleared merge, verification, and deployment gates.
- **PARTIAL** — some code or design exists, but a production dependency, integration, or release gate remains.
- **PLANNED (explicit WHA-243/lane/ADR/commit reference required)** — an accepted design or ADR exists; implementation is not complete.
- **BLOCKED** — work cannot proceed until a named external decision, credential, environment, or owner action exists.
- **FUTURE** — intentionally outside the current web scope or roadmap horizon.

“Complete” in an older document is not sufficient evidence for a production claim; the current status ledger wins when documents disagree.

## Start here

| Audience | Document | Purpose |
| --- | --- | --- |
| Everyone | [Technical overview](technical-overview.md) | Product boundaries, architecture, tenancy, and operating model |
| Developers | [Canonical architecture](technical/architecture.md) | Product-wide runtime, trust, deployment, vertical, and meetings boundaries |
| Developers | [Canonical data model](technical/data-model.md) | Product-wide ownership, tenancy, identity, and entitlement model |
| Developers | [Canonical API surface](technical/api-surface.md) | Product-wide tenant, platform, tRPC, and REST transport map |
| Developers | [Local setup](LOCAL_SETUP.md) | Local environment and verification |
| Operators | [Azure deployment](azure-deployment.md) | Staging, production gate, backups, and rollback |
| Platform team | [Admin platform handbook](admin-platform/README.md) | Control-plane architecture and runbooks |
| Product and sales | [Product and commercial pack](product-pack.md) | ICP, positioning, feature status, packaging, and customer lifecycle |
| Product owners | [Master product PRD](product/PRD.md) | Evidence-backed current scope, acceptance boundaries, and planned decisions |
| Restaurant team | [Restaurant vertical PRD](product/verticals/restaurant/PRD.md) | Lean vertical outcome, acceptance, and explicit non-claims |
| Business owners | [Business documentation](business/positioning-value-proposition.md) | Evidence-safe positioning, packaging, pricing, market research, GTM, support, and compliance decisions |
| Partners and customers | [Pitch-deck source](pitch-deck.md) | Evidence-safe slide narratives and speaker notes |
| Release owners | [Living status ledger](status-ledger.md) | Evidence, blockers, owners, and next gates |
| Documentation owners | [Documentation QA](qa.md) | Link, stale-reference, and consistency checks |

## Technical reference

- Canonical first-wave maps: [architecture](technical/architecture.md), [data model](technical/data-model.md), and [API surface](technical/api-surface.md)
- [Tenant/RLS architecture](admin-platform/architecture-tenancy.md)
- [Identity and access](admin-platform/identity-access.md)
- [Platform control desk](admin-platform/control-plane.md)
- [Platform API inventory](admin-platform/api.md)
- [Data model](admin-platform/data-model.md)
- [Entitlements](admin-platform/entitlements.md)
- [Lifecycle and migration](admin-platform/lifecycle.md)
- [Operations and jobs](admin-platform/operations.md)
- [Runbooks](admin-platform/runbooks.md)
- [Testing and release evidence](admin-platform/testing-release.md)
- [Security threat model](admin-platform/security-threat-model.md)
- [Meetings scope](meetings/000-product-scope.md), [join flow](meetings/004-join-flow.md), and [self-hosted meetings ADR](admin-platform/adr/005-self-hosted-meetings.md)

## Working rules

Documentation changes should cite repository paths and line ranges where practical, distinguish current code from decisions, avoid secret values and customer data, and preserve the web-only boundary. Azure is the deployment platform; no Vercel deployment instructions belong in current operating guidance. Mobile apps are future work; responsive mobile web is part of the current web surface where implemented.

## Business reference

- [Positioning and value proposition](business/positioning-value-proposition.md)
- [Packaging and tiers](business/packaging-tiers.md)
- [Pricing inputs](business/pricing-inputs.md)
- [Pakistan restaurant market context](business/pakistan-restaurant-market-context.md)
- [GTM and onboarding](business/gtm-onboarding.md)
- [Support and SLA outline](business/support-sla.md)
- [Compliance posture](business/compliance-posture.md)

## Restaurant reference

- These pages preserve Restaurant M0–M8 vertical detail. Product-wide canonical boundaries live under [`docs/technical/`](technical/architecture.md).
- **IMPLEMENTED** — [Restaurant technical architecture](restaurant/architecture.md) maps the M0–M8 runtime and trust boundaries to repository evidence.
- **IMPLEMENTED** — [Restaurant data model](restaurant/data-model.md) maps each milestone-owned schema group to its migration and verification evidence.
- **IMPLEMENTED** — [Restaurant API surface](restaurant/api-surface.md) inventories the mounted tRPC and terminal REST transports and states their limits.
- **IMPLEMENTED** — [WHA-243 corrected audit](operations/WHA-243-restaurant-documentation-audit.md) records the base-commit audit, corrected M0–M8 conclusion, planned boundaries, and proposed documentation tree.
- **IMPLEMENTED** — Product module specs: [POS/orders/floor](product/modules/pos-orders-floor.md), [KDS](product/modules/kds.md), [catalog/menus/publications](product/modules/catalog-menus-publications.md), [checkout](product/modules/checkout.md), [cash/day close](product/modules/cash-day-close.md), [inventory](product/modules/inventory.md), [purchasing](product/modules/purchasing.md), [customers/loyalty/insights](product/modules/customers-loyalty-insights.md), [SOP](product/modules/sop.md), [terminal/device registry](product/modules/terminal-device-registry.md), and [platform console](product/modules/platform-console.md).

Last reconciled: 2026-08-27 (WHA-243 correction pass).
