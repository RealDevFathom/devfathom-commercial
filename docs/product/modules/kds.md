# Kitchen display system

## Requirement

- **IMPLEMENTED** — KDS presents station-routed durable tickets and permits acknowledge, bump, and recall actions. Evidence: [`src/app/(terminal)/kds/page.tsx`](../../../src/app/%28terminal%29/kds/page.tsx), [`src/app/api/restaurant/kds`](../../../src/app/api/restaurant/kds), [`src/server/routers/restaurant-orders.ts`](../../../src/server/routers/restaurant-orders.ts).

## Acceptance

- Ticket routing follows configured stations; commands require terminal trust and preserve durable state under retry/concurrency. Evidence: [`tests/restaurant-m4-kitchen-flow.test.ts`](../../../tests/restaurant-m4-kitchen-flow.test.ts), [`tests/restaurant-m4-acceptance.test.ts`](../../../tests/restaurant-m4-acceptance.test.ts).
