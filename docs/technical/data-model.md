# DevFathom canonical data model

Reconciled at `343478dbc75d9ad6863955e23cd7280d5cf0513f` for WHA-243. [`prisma/schema.prisma`](../../prisma/schema.prisma) remains authoritative; this page maps product-wide ownership. See [Restaurant data model](../restaurant/data-model.md) for vertical detail.

## Ownership planes

| Status | Plane | Ownership and evidence |
| --- | --- | --- |
| **IMPLEMENTED** | Agency tenant | `Organization` owns users and workspace records for clients, projects, tasks, finance, meetings, notes, files, configuration, and audit. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`prisma/migrations/20260728000000_baseline/migration.sql`](../../prisma/migrations/20260728000000_baseline/migration.sql), [`tests/agency-onboarding-regression.test.ts`](../../tests/agency-onboarding-regression.test.ts). |
| **IMPLEMENTED** | Control plane | Platform users/sessions, catalog/packages, commercial records, deployments, jobs, lifecycle events, support sessions, and platform audit are seller-owned records. Evidence: [`prisma/migrations/20260728090000_admin_platform_tenancy/migration.sql`](../../prisma/migrations/20260728090000_admin_platform_tenancy/migration.sql), [`src/lib/platform/commands.organization-create.test.ts`](../../src/lib/platform/commands.organization-create.test.ts). |
| **IMPLEMENTED** | Entitlements | Platform modules/packages define catalog defaults; package membership and `OrganizationModule` overrides produce tenant availability and limits. Evidence: [`prisma/migrations/20260818120000_package_module_inheritance_cleanup/migration.sql`](../../prisma/migrations/20260818120000_package_module_inheritance_cleanup/migration.sql), [`src/lib/platform/package-inheritance.db.test.ts`](../../src/lib/platform/package-inheritance.db.test.ts). |
| **IMPLEMENTED (Restaurant M0–M8)** | Restaurant | Organization/brand records own catalog; branches partition operations; milestone records cover trust, menus, service, money, stock, automation, customers, loyalty, and insights. Evidence: [`docs/restaurant/data-model.md`](../restaurant/data-model.md), [`prisma/migrations/20260821010000_restaurant_customers_loyalty_insights/migration.sql`](../../prisma/migrations/20260821010000_restaurant_customers_loyalty_insights/migration.sql), [`tests/restaurant-m8-rls.test.ts`](../../tests/restaurant-m8-rls.test.ts). |

## Isolation and identity

- **IMPLEMENTED** — Tenant tables carry `organizationId`; composite integrity blocks cross-tenant references. Forced RLS uses transaction-local `app.current_organization_id`; control-plane-only tables require platform scope. Evidence: [`prisma/migrations/20260728091000_tenant_composite_integrity/migration.sql`](../../prisma/migrations/20260728091000_tenant_composite_integrity/migration.sql), [`prisma/migrations/20260728092000_row_level_security/migration.sql`](../../prisma/migrations/20260728092000_row_level_security/migration.sql), [`scripts/verify-tenant-isolation.ts`](../../scripts/verify-tenant-isolation.ts).
- **IMPLEMENTED** — Tenant users and tenant recovery state are separate from `PlatformUser`, `PlatformSession`, and platform recovery state. Enterprise SSO/SCIM records stay organization-bound. Evidence: [`prisma/migrations/20260728100000_platform_sessions/migration.sql`](../../prisma/migrations/20260728100000_platform_sessions/migration.sql), [`prisma/migrations/20260728103000_enterprise_sso/migration.sql`](../../prisma/migrations/20260728103000_enterprise_sso/migration.sql), [`src/lib/auth/session-state.test.ts`](../../src/lib/auth/session-state.test.ts).

## Explicit model boundaries

- **IMPLEMENTED (Restaurant M5; WHA-52/WHA-62/WHA-63)** — Money schema stores operator-confirmed `CARD` tender records plus cash/other tenders, payment events, refunds, drawers, receipts, and close/reconciliation history. Evidence: [`prisma/migrations/20260819120000_restaurant_money/migration.sql`](../../prisma/migrations/20260819120000_restaurant_money/migration.sql), [`tests/restaurant-m5-governance.test.ts`](../../tests/restaurant-m5-governance.test.ts).
- **PLANNED (WHA-243 supervisor boundary)** — Provider-backed automatic card confirmation and online gateways are not implemented. OCR remains separate-lane, not integrated; camera capture, printer jobs, staff-shift scheduling, and deeper SOP integration models are also outside current schema claims.
- **PLANNED (WHA-243 Lane C)** — Platform-login/onboarding expansion may require later identity records; current schema does not close Lane C.
- **PLANNED (WHA-243 Lane D)** — Broader dashboard projections remain separate from current agency aggregates and Restaurant M8 operational insights.
