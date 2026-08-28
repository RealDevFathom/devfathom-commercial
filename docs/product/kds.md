# Kitchen display system PRD

## Problem

Kitchen teams need station-specific, durable work queues that recover from refresh/retry and do not leak another branch’s or tenant’s orders.

## Users and roles

- **Kitchen operator:** uses a trusted KDS device bound to exactly one station; ACK, bump, and recall require the terminal/operator capability path. Evidence: [`src/lib/restaurant/kds.ts`](../../src/lib/restaurant/kds.ts), [`src/app/(terminal)/kds/page.tsx`](../../src/app/%28terminal%29/kds/page.tsx).
- **Restaurant admin:** configures stations, routing rules, and KDS device binding through tenant administration. Evidence: [`src/server/routers/restaurant-orders.ts`](../../src/server/routers/restaurant-orders.ts), [`src/server/routers/restaurant-devices.ts`](../../src/server/routers/restaurant-devices.ts).
- **Platform admin:** may control the restaurant POS entitlement but does not operate a station queue; platform and terminal authentication remain distinct. Evidence: [`src/lib/restaurant/terminal-auth.ts`](../../src/lib/restaurant/terminal-auth.ts), [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts).

## Current behaviour

- Product rules outrank category rules; category rules outrank the branch default; priority and station ID break ties deterministically. Unroutable fire fails if no default exists. Evidence: [`src/lib/restaurant/station-routing.ts`](../../src/lib/restaurant/station-routing.ts), [`src/lib/restaurant/station-routing.test.ts`](../../src/lib/restaurant/station-routing.test.ts) — `a product rule outranks a category rule for the same item` and `equal priority breaks deterministically by station id (ascending)`.
- Firing creates durable station tickets/lines with sequential per-station/business-date numbers. The queue derives display status from order-item state. Evidence: [`src/lib/restaurant/kitchen-tickets.ts`](../../src/lib/restaurant/kitchen-tickets.ts), [`src/lib/restaurant/kitchen-tickets.test.ts`](../../src/lib/restaurant/kitchen-tickets.test.ts) — `groups items by resolved station (product rule beats default)` and `numbers tickets sequentially per (station, businessDate)`.
- Queue reads support bounded polling and gap detection. ACK maps to FIRING, bump to PREPARED, and recall to FIRING; server state survives page recovery and repeated commands through the order idempotency domain. Evidence: [`src/lib/restaurant/kds.ts`](../../src/lib/restaurant/kds.ts), [`src/lib/restaurant/kds.test.ts`](../../src/lib/restaurant/kds.test.ts) — `maps ack→FIRING, bump→PREPARED, recall→FIRING`; [`tests/restaurant-m4-kitchen-flow.test.ts`](../../tests/restaurant-m4-kitchen-flow.test.ts) — `replays open/add/fire/bump without creating duplicate rows, events, or tickets`.

## Data model

`RestaurantKitchenStation`, `RestaurantStationRoutingRule`, KDS-flavoured `RestaurantRegisteredDevice.stationId`, `RestaurantKitchenTicket`, ticket lines, order items/events, and order idempotency keys are canonical. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`tests/restaurant-m4-governance.test.ts`](../../tests/restaurant-m4-governance.test.ts) — `enforces one default kitchen station per branch with a partial unique index`.

## API surface

`GET /api/restaurant/kds/queue` and mutations `/ack`, `/bump`, `/recall` use terminal device authentication. Restaurant-admin station/routing management is exposed through the restaurant orders tRPC router. Evidence: [`src/app/api/restaurant/kds`](../../src/app/api/restaurant/kds), [`src/server/routers/restaurant-orders.ts`](../../src/server/routers/restaurant-orders.ts).

## Edge cases and failure modes

- A revoked device is rejected on the next call, including mid-flow; cross-tenant probes cannot see orders. Evidence: [`tests/restaurant-m4-kitchen-flow.test.ts`](../../tests/restaurant-m4-kitchen-flow.test.ts) — `rejects a KDS device immediately when revoked mid-flow`; [`tests/restaurant-m4-acceptance.test.ts`](../../tests/restaurant-m4-acceptance.test.ts) — `hides an order from cross-tenant terminal and KDS route probes`.
- Wrong device role, missing station binding, mismatched station/item, illegal state transition, queue overflow/gap, and absent default station fail explicitly. Evidence: [`src/lib/restaurant/kds.ts`](../../src/lib/restaurant/kds.ts), [`src/lib/restaurant/kitchen-tickets.test.ts`](../../src/lib/restaurant/kitchen-tickets.test.ts) — `throws NO_STATION when an item cannot be routed and there is no default`.

## Gaps

- **NOT IMPLEMENTED:** repository evidence for kitchen printers, audio alert hardware, bump bars, or provider-specific display management.
- **NOT IMPLEMENTED:** a standalone offline KDS mutation queue equivalent to the POS IndexedDB command queue; recovery is server-durable polling/replay. Evidence: [`src/lib/restaurant/pos-command-queue.ts`](../../src/lib/restaurant/pos-command-queue.ts), [`src/app/(terminal)/kds/page.tsx`](../../src/app/%28terminal%29/kds/page.tsx).
