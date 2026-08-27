# POS, orders, and floor

## Requirement

- **IMPLEMENTED** — Operators can configure floors/tables/sections, open and inspect orders, add items, hold/fire/serve, void/remake/cancel/close, and move or merge tables. Evidence: [`src/server/routers/restaurant-floor.ts`](../../../src/server/routers/restaurant-floor.ts), [`src/app/api/restaurant/orders`](../../../src/app/api/restaurant/orders), [`src/app/(terminal)/pos/page.tsx`](../../../src/app/%28terminal%29/pos/page.tsx).
- **IMPLEMENTED** — Order events, outbox/idempotency records, and table history preserve operational transitions. Evidence: [`prisma/migrations/20260819000000_restaurant_orders_kitchen_floor/migration.sql`](../../../prisma/migrations/20260819000000_restaurant_orders_kitchen_floor/migration.sql), [`tests/restaurant-m4-governance.test.ts`](../../../tests/restaurant-m4-governance.test.ts).

## Acceptance

- Trusted terminal/operator context gates commands; duplicate requests remain idempotent; cross-tenant and invalid state transitions fail. Evidence: [`tests/restaurant-m4-acceptance.test.ts`](../../../tests/restaurant-m4-acceptance.test.ts), [`tests/restaurant-m4-rls.test.ts`](../../../tests/restaurant-m4-rls.test.ts).
