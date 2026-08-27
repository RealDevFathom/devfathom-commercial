# Purchasing

## Requirement

- **IMPLEMENTED** — Users manage suppliers, purchase orders, receipts, and discrepancies; receiving posts stock effects. Evidence: [`src/server/routers/restaurant-purchasing.ts`](../../../src/server/routers/restaurant-purchasing.ts), [`src/app/(app)/restaurant/purchasing/page.tsx`](../../../src/app/%28app%29/restaurant/purchasing/page.tsx), [`prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql`](../../../prisma/migrations/20260819130000_restaurant_inventory_purchasing/migration.sql).

## Acceptance

- Receiving is idempotent, discrepancies remain visible, and supplier/PO/receipt data stays tenant-scoped. Evidence: [`tests/restaurant-m6-acceptance.test.ts`](../../../tests/restaurant-m6-acceptance.test.ts), [`tests/restaurant-m6-rls.test.ts`](../../../tests/restaurant-m6-rls.test.ts).
