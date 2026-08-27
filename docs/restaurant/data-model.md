# Restaurant data model

Audit base: `ddc0bc9dde9642b63dd02dde869dd35f5564e8b9` (WHA-243).

## Ownership and isolation

- **IMPLEMENTED** — `Organization` owns restaurant data; `RestaurantBranch` is the main operational partition, while canonical catalog/menu records remain organization/brand-owned. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`tests/vertical-foundation.test.ts`](../../tests/vertical-foundation.test.ts), and [`tests/restaurant-m3-governance.test.ts`](../../tests/restaurant-m3-governance.test.ts).
- **IMPLEMENTED** — Restaurant milestone migrations enable and force PostgreSQL RLS; milestone RLS tests probe tenant isolation. Evidence: [`prisma/migrations`](../../prisma/migrations) and [`tests`](../../tests).

## Schema groups

| Classification | Group | Main records | Evidence |
| --- | --- | --- | --- |
| **IMPLEMENTED (M1; WHA-8)** | Vertical foundation | organization vertical, branch, branch assignment | [`20260818130000 migration`](../../prisma/migrations/20260818130000_organization_vertical_foundation/migration.sql), [`vertical-foundation.test.ts`](../../tests/vertical-foundation.test.ts) |
| **IMPLEMENTED (M2; WHA-20–WHA-26)** | Workforce trust | staff profile, credential, device, terminal session, co-authorization | [`20260818140000 migration`](../../prisma/migrations/20260818140000_restaurant_staff_operators_devices/migration.sql), [`restaurant-m2-rls.test.ts`](../../tests/restaurant-m2-rls.test.ts) |
| **IMPLEMENTED (M3; WHA-37/WHA-38)** | Catalog/menu | brand, product/variant/modifier, ingredient/recipe version, price-list version, menu/publication/availability | [`20260818160000 migration`](../../prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql), [`restaurant-m3-governance.test.ts`](../../tests/restaurant-m3-governance.test.ts) |
| **IMPLEMENTED (M4; WHA-39/WHA-49)** | Service/fulfilment | floor/table/section, station/routing, order/item/table history, event/outbox/idempotency, kitchen ticket | [`20260819000000 migration`](../../prisma/migrations/20260819000000_restaurant_orders_kitchen_floor/migration.sql), [`restaurant-m4-governance.test.ts`](../../tests/restaurant-m4-governance.test.ts) |
| **IMPLEMENTED (M5; WHA-52/WHA-62)** | Money | bill/line, payment/event, tender/refund, drawer movement, daily close, receipt/idempotency | [`20260819120000 migration`](../../prisma/migrations/20260819120000_restaurant_money/migration.sql), [`restaurant-m5-governance.test.ts`](../../tests/restaurant-m5-governance.test.ts) |
| **IMPLEMENTED (M6; WHA-68/WHA-74)** | Inventory/purchasing | location/item/movement/batch, count, transfer, low-stock rule, supplier, PO/receipt/discrepancy | [`20260819130000 migration`](../../prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql), [`restaurant-m6-governance.test.ts`](../../tests/restaurant-m6-governance.test.ts) |
| **IMPLEMENTED (M7; WHA-79/WHA-88)** | Automation/compliance | job/execution, webhook inbox, SOP template/version/step/assignment/occurrence/evidence/verification/escalation, notification/delivery | [`20260820000000 migration`](../../prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql), [`restaurant-m7-governance.test.ts`](../../tests/restaurant-m7-governance.test.ts) |
| **IMPLEMENTED (M8; WHA-93–WHA-101)** | Customer/loyalty/insights | customer identity/consent/interaction, loyalty program/version/account/ledger, daily insight rollups | [`20260821010000 migration`](../../prisma/migrations/20260821010000_restaurant_customers_loyalty_insights/migration.sql), [`restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts) |

## Integrity boundaries

- **IMPLEMENTED** — Order events, payment events, tenders/refunds, drawer movements, stock movements, job executions, SOP evidence/escalations, and loyalty ledger entries use history/append-only patterns verified by milestone governance tests; evidence: [`tests/restaurant-m4-governance.test.ts`](../../tests/restaurant-m4-governance.test.ts), [`tests/restaurant-m5-governance.test.ts`](../../tests/restaurant-m5-governance.test.ts), [`tests/restaurant-m6-governance.test.ts`](../../tests/restaurant-m6-governance.test.ts), [`tests/restaurant-m7-governance.test.ts`](../../tests/restaurant-m7-governance.test.ts), and [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts).
- **IMPLEMENTED** — Money uses Prisma `Decimal`/PostgreSQL numeric fields; M5 governance rejects floating-point restaurant columns. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma) and [`tests/restaurant-m5-governance.test.ts`](../../tests/restaurant-m5-governance.test.ts).
- **IMPLEMENTED** — M8 insight rollups exclude labour/payroll fields. Evidence: [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts).
- **PLANNED (WHA-243 supervisor boundary)** — OCR/camera-derived records, staff-shift scheduling, printer jobs, and real gateway settlement models are not part of this documented M0–M8 schema contract.
