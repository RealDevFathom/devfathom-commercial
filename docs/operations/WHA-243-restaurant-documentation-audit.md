# WHA-243 corrected restaurant documentation audit

Audit base: `ddc0bc9dde9642b63dd02dde869dd35f5564e8b9`; branch: `docs-lane`; worktree: `WHA-DOCS-isolated`.

## Corrected audit

- **IMPLEMENTED (M0)** — Platform enablers exist: baseline tenancy, packages/modules, entitlements, bootstrap, and RLS substrate. Evidence: [`prisma/migrations/20260728000000_baseline/migration.sql`](../../prisma/migrations/20260728000000_baseline/migration.sql), [`src/lib/module-catalog.ts`](../../src/lib/module-catalog.ts), [`tests/production-bootstrap.test.ts`](../../tests/production-bootstrap.test.ts).
- **IMPLEMENTED (M1; WHA-8)** — Restaurant vertical foundation exists: branch/assignment creation, package compatibility, activation preflight, role templates. Evidence: [`prisma/migrations/20260818130000_organization_vertical_foundation/migration.sql`](../../prisma/migrations/20260818130000_organization_vertical_foundation/migration.sql), [`tests/vertical-foundation.test.ts`](../../tests/vertical-foundation.test.ts).
- **IMPLEMENTED (M2; WHA-20–WHA-26)** — Staff/operator/device/terminal trust and back-office surfaces exist. Evidence: [`prisma/migrations/20260818140000_restaurant_staff_operators_devices/migration.sql`](../../prisma/migrations/20260818140000_restaurant_staff_operators_devices/migration.sql), [`src/app/(app)/restaurant/staff/page.tsx`](../../src/app/%28app%29/restaurant/staff/page.tsx), [`tests/restaurant-m2-contract.test.ts`](../../tests/restaurant-m2-contract.test.ts).
- **IMPLEMENTED (M3; WHA-37/WHA-38)** — Catalog, recipes, pricing, menus, publications, availability, and catalog/menu consoles exist. Evidence: [`prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql`](../../prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql), [`src/app/(app)/restaurant/catalog/page.tsx`](../../src/app/%28app%29/restaurant/catalog/page.tsx), [`tests/restaurant-m3-acceptance.test.ts`](../../tests/restaurant-m3-acceptance.test.ts).
- **IMPLEMENTED (M4; WHA-39/WHA-49)** — Floor, order, POS, kitchen/KDS, event/outbox, and acceptance surfaces exist. Evidence: [`prisma/migrations/20260819000000_restaurant_orders_kitchen_floor/migration.sql`](../../prisma/migrations/20260819000000_restaurant_orders_kitchen_floor/migration.sql), [`src/app/(terminal)/pos/page.tsx`](../../src/app/%28terminal%29/pos/page.tsx), [`src/app/(terminal)/kds/page.tsx`](../../src/app/%28terminal%29/kds/page.tsx), [`tests/restaurant-m4-acceptance.test.ts`](../../tests/restaurant-m4-acceptance.test.ts).
- **IMPLEMENTED (M5; WHA-52/WHA-62/WHA-63)** — Bills, tenders, refunds, drawer, receipt, close/correction, and reconciliation surfaces exist; card provider remains MOCK. Evidence: [`prisma/migrations/20260819120000_restaurant_money/migration.sql`](../../prisma/migrations/20260819120000_restaurant_money/migration.sql), [`src/app/(app)/restaurant/money/page.tsx`](../../src/app/%28app%29/restaurant/money/page.tsx), [`tests/restaurant-m5-reconciliation.test.ts`](../../tests/restaurant-m5-reconciliation.test.ts).
- **IMPLEMENTED (M6; WHA-68/WHA-74/WHA-75)** — Inventory ledger, counts, transfers, purchasing, receiving, and consoles exist. Evidence: [`prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql`](../../prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql), [`src/app/(app)/restaurant/inventory/page.tsx`](../../src/app/%28app%29/restaurant/inventory/page.tsx), [`tests/restaurant-m6-acceptance.test.ts`](../../tests/restaurant-m6-acceptance.test.ts).
- **IMPLEMENTED (M7; WHA-79/WHA-88)** — Scheduler, durable outbox/webhook seam, SOP administration/execution, escalation, and notification center exist; external notification channels are stubs. Evidence: [`prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql`](../../prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql), [`src/app/(app)/restaurant/sop/page.tsx`](../../src/app/%28app%29/restaurant/sop/page.tsx), [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts).
- **IMPLEMENTED (M8; WHA-93–WHA-101)** — Customers, consent/privacy, loyalty, insight rollups/reports, and consoles exist; labour analytics are excluded. Evidence: [`prisma/migrations/20260821010000_restaurant_customers_loyalty_insights/migration.sql`](../../prisma/migrations/20260821010000_restaurant_customers_loyalty_insights/migration.sql), [`src/app/(app)/restaurant/loyalty/page.tsx`](../../src/app/%28app%29/restaurant/loyalty/page.tsx), [`src/app/(app)/restaurant/insights/page.tsx`](../../src/app/%28app%29/restaurant/insights/page.tsx), [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts).
- **IMPLEMENTED** — Current meeting media remains JaaS/Jitsi. Evidence: [`src/server/routers/meetings.ts`](../../src/server/routers/meetings.ts), [`src/components/meetings/meeting-call.tsx`](../../src/components/meetings/meeting-call.tsx), [`next.config.ts`](../../next.config.ts).
- **PLANNED (ADR 005)** — LiveKit/TURN remains proposed divergence/replacement, not implemented media runtime. Evidence: [`docs/admin-platform/adr/005-self-hosted-meetings.md`](../admin-platform/adr/005-self-hosted-meetings.md).
- **PLANNED (WHA-243, Lane C)** — Platform-login/onboarding expansion is not closed by existing platform pages.
- **PLANNED (WHA-243, Lane D)** — Broader dashboard work is not closed by implemented M8 operational insights.
- **PLANNED (WHA-243 supervisor boundary)** — No claim is made for OCR, cameras, card auto-confirmation, printing, staff shifts, deeper SOP integrations, real gateways, or real external notification delivery.

## First-wave result

- **IMPLEMENTED (WHA-243)** — Documentation index now links a technical architecture, data model, API map, and this durable audit; evidence: [`docs/README.md`](../README.md), [`docs/restaurant/architecture.md`](../restaurant/architecture.md), [`docs/restaurant/data-model.md`](../restaurant/data-model.md), and [`docs/restaurant/api-surface.md`](../restaurant/api-surface.md).

## Proposed documentation tree

Each entry is **IMPLEMENTED (WHA-243)** unless marked planned.

```text
docs/
├── README.md
├── restaurant/
│   ├── architecture.md
│   ├── data-model.md
│   └── api-surface.md
├── operations/
│   └── WHA-243-restaurant-documentation-audit.md
├── admin-platform/                 # preserved existing reference
├── meetings/                       # preserved existing reference
└── design-system/                  # preserved existing authority
```

- **PLANNED (WHA-243 follow-on wave)** — Add module operator guides only after each guide has code/test evidence and an assigned issue; no placeholder files are created in this wave.
