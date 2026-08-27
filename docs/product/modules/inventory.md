# Inventory

## Requirement

- **IMPLEMENTED** — Users manage stock locations/items, append movements, perform counts and transfers, configure low-stock thresholds, and record recipe consumption. Evidence: [`src/server/routers/restaurant-inventory.ts`](../../../src/server/routers/restaurant-inventory.ts), [`src/app/(app)/restaurant/inventory/page.tsx`](../../../src/app/%28app%29/restaurant/inventory/page.tsx), [`prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql`](../../../prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql).

## Acceptance

- Stock movements remain append-only, tenant/branch scoped, and balanced through count/transfer/concurrency cases. Evidence: [`tests/restaurant-m6-acceptance.test.ts`](../../../tests/restaurant-m6-acceptance.test.ts), [`tests/restaurant-m6-governance.test.ts`](../../../tests/restaurant-m6-governance.test.ts).
