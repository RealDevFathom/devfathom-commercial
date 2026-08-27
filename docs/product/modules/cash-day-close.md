# Cash drawer and day close

## Requirement

- **IMPLEMENTED** — Authorized operators open/close drawers, post movements, preview/close a business day, and append corrections without rewriting a prior close. Evidence: [`src/app/api/restaurant/cash`](../../../src/app/api/restaurant/cash), [`src/server/routers/restaurant-cash.ts`](../../../src/server/routers/restaurant-cash.ts), [`prisma/migrations/20260819120000_restaurant_money/migration.sql`](../../../prisma/migrations/20260819120000_restaurant_money/migration.sql).

## Acceptance

- Expected cash derives from ledger movements; sales, comps, tenders, refunds, tips, and corrections reconcile across business dates. Evidence: [`tests/restaurant-m5-reconciliation.test.ts`](../../../tests/restaurant-m5-reconciliation.test.ts), [`tests/restaurant-m5-acceptance.test.ts`](../../../tests/restaurant-m5-acceptance.test.ts).
