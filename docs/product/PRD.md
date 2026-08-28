# DevFathom product requirements

## Product outcome

Give multi-tenant service businesses one governed workspace, with Restaurant as the deepest operational vertical and a seller-operated platform console. Every current claim below is tied to repository evidence; proposals remain explicitly planned.

## Current product

- **IMPLEMENTED** — Organization tenancy, modules, packages, entitlements, lifecycle controls, and forced-RLS foundations support one product with tenant and platform control planes. Evidence: [`src/lib/module-catalog.ts`](../../src/lib/module-catalog.ts), [`prisma/migrations/20260728000000_baseline/migration.sql`](../../prisma/migrations/20260728000000_baseline/migration.sql), [`tests/production-bootstrap.test.ts`](../../tests/production-bootstrap.test.ts).
- **IMPLEMENTED** — Restaurant covers branch setup, staff/device trust, catalog, service, settlement, stock, SOPs, customer/loyalty, and operational insight workflows. Evidence: [`docs/restaurant/architecture.md`](../restaurant/architecture.md), [`tests/vertical-foundation.test.ts`](../../tests/vertical-foundation.test.ts), [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts).
- **IMPLEMENTED** — Meetings currently use Jitsi as a Service/JaaS. Evidence: [`src/server/routers/meetings.ts`](../../src/server/routers/meetings.ts), [`src/components/meetings/meeting-call.tsx`](../../src/components/meetings/meeting-call.tsx), [`next.config.ts`](../../next.config.ts).

## Product acceptance

- Tenant data stays organization-scoped and entitlement-gated; platform operations remain separately authorized.
- Operational money, stock, SOP evidence, and loyalty histories retain auditable ledger/history behavior.
- Capability language never implies external integrations, hardware, certification, or deployment not proved by code and tests.

## Planned decisions and extensions

- **PLANNED (WHA-243 Lane C)** — Complete platform login/onboarding acceptance; existing login files do not close Lane C.
- **PLANNED (WHA-243 Lane D)** — Restaurant dashboard beyond current M8 insight surfaces.
- **IMPLEMENTED** — OCR-assisted menu upload, extraction, human review, and draft catalog import. Evidence: [`menu-import-ocr.md`](menu-import-ocr.md).
- **PLANNED (WHA-212)** — Camera live feed/storage, Hikvision/EZVIZ, Dahua/IMOU, Uniview, and TP-Link presets, both-console setup wizard, plus manual ONVIF/RTSP fallback.
- **PLANNED (WHA-243 owner decision)** — Vendor-agnostic card-terminal core and adapter await owner acquirer choice. Online gateways are **DEFERRED**. Current card tenders are operator-confirmed records only.
- **PLANNED (WHA-243 owner decision)** — Physical print bridge and printer job delivery; current receipt data is not physical printing.
- **PLANNED (WHA-243 owner decision)** — Staff shifts and deeper SOP reporting/scoring; see module boundary.
- **PLANNED (ADR 005)** — LiveKit/TURN is proposed; current meeting runtime remains JaaS/Jitsi. Evidence: [`docs/admin-platform/adr/005-self-hosted-meetings.md`](../admin-platform/adr/005-self-hosted-meetings.md).

## Module requirements

Canonical PRDs: [POS and terminal](pos-terminal.md) · [KDS](kds.md) · [customers and loyalty](customers-loyalty.md) · [SOP](sop.md) · [menu import and OCR](menu-import-ocr.md) · [platform and entitlements](platform-entitlements.md) · [tax](tax.md)

Supporting module notes: [catalog and menus](modules/catalog-menus-publications.md) · [checkout](modules/checkout.md) · [cash and close](modules/cash-day-close.md) · [inventory](modules/inventory.md) · [purchasing](modules/purchasing.md)
