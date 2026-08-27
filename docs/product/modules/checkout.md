# Checkout, bills, split tender, comps, and refunds

## Requirement

- **IMPLEMENTED** — Checkout cuts bills, supports deterministic splits, line comps, CASH/CARD/OTHER tenders, partial refunds, receipt numbering, and settlement summaries. Evidence: [`src/app/api/restaurant/checkout`](../../../src/app/api/restaurant/checkout), [`src/server/routers/restaurant-bills.ts`](../../../src/server/routers/restaurant-bills.ts), [`tests/restaurant-m5-acceptance.test.ts`](../../../tests/restaurant-m5-acceptance.test.ts).
- **IMPLEMENTED** — Tenders, refunds, and payment events retain auditable histories and money uses decimal storage. Evidence: [`prisma/migrations/20260819120000_restaurant_money/migration.sql`](../../../prisma/migrations/20260819120000_restaurant_money/migration.sql), [`tests/restaurant-m5-governance.test.ts`](../../../tests/restaurant-m5-governance.test.ts).

## Acceptance and boundary

- Odd-cent splits reconcile; privileged comps/refunds enforce co-authorization rules; retries do not double-settle. Evidence: [`tests/restaurant-m5-reconciliation.test.ts`](../../../tests/restaurant-m5-reconciliation.test.ts).
- **IMPLEMENTED BOUNDARY** — `CARD` is operator-confirmed only. No provider/acquirer confirmation. Receipt records exist; physical printing is absent. Evidence: [`src/app/api/restaurant/checkout/tender/route.ts`](../../../src/app/api/restaurant/checkout/tender/route.ts), [`tests/restaurant-m5-acceptance.test.ts`](../../../tests/restaurant-m5-acceptance.test.ts).
- **PLANNED (WHA-243 owner decision)** — Vendor-agnostic terminal core/adapter awaits owner acquirer choice. Online gateways **DEFERRED**. Physical print bridge remains planned.
