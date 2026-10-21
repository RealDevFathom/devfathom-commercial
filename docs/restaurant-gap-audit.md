# Restaurant gap audit

Read against `improve/ai-growth`, which already contains `integration/consolidation-20261019`.
Loyalty, the kitchen display, offers, and direct delivery are in that history. This audit does not propose rebuilding them.

The only loyalty change on this branch is a read and a receipt line on the existing ledger: `getLoyaltySummary` in `src/lib/restaurant/loyalty.ts`, and the settled-receipt balance in `src/lib/restaurant/checkout-routes.ts`.

## Already present

### Loyalty

Points are earned from PKR spent, redeemed at the register, and stored as a customer wallet.

- Program, account, and append-only points ledger: `LoyaltyProgramVersion`, `LoyaltyAccount`, `LoyaltyPointsEntry` in `prisma/schema.prisma`. `earnRate` is points per currency unit. Settlement earns `floor(net PKR × earnRate)` in `accrueLoyaltyForSettledBill` (`src/lib/restaurant/loyalty.ts`), called from `src/lib/restaurant/bills.ts`.
- Register redemption: `src/lib/restaurant/terminal-loyalty.ts`, `src/app/api/restaurant/checkout/loyalty/route.ts`, `src/components/restaurant/pos/checkout-panel.tsx`.
- Customer wallet: the balance is the sum of the points ledger (`loyaltyBalance` in `src/lib/restaurant/loyalty.ts`). Apple and Google passes show that balance (`src/lib/restaurant/wallet/apple-pass.ts`, `src/lib/restaurant/wallet/google.ts`). Enrollment is `src/app/(public)/wallet/join/[token]/page.tsx`.
- Back office: `src/app/(app)/restaurant/loyalty/page.tsx`, `src/components/restaurant/loyalty/loyalty-console.tsx`, `src/server/routers/restaurant-loyalty.ts`.

The settled receipt did not show that wallet. Customer detail already projects a balance (`loyaltySummary` in `src/lib/restaurant/customers.ts`); the growth module had no `getLoyaltySummary(customerId)`.

### Kitchen display

- Tickets and stations: `RestaurantKitchenTicket`, `RestaurantKitchenTicketItem`, `RestaurantKitchenStation` in `prisma/schema.prisma`.
- Queue, ack, bump, and recall: `src/lib/restaurant/kds.ts`, `src/app/api/restaurant/kds/queue/route.ts`, `src/app/api/restaurant/kds/ack/route.ts`, `src/app/api/restaurant/kds/bump/route.ts`, `src/app/api/restaurant/kds/recall/route.ts`.
- Screen: `src/app/(terminal)/kds/page.tsx`, `src/components/restaurant/kds/kds-board.tsx`.

The display polls durable rows. It does not open a websocket (`src/lib/restaurant/kds.ts`).

### Offers

Published offers are evaluated and consumed when a bill is settled.

- Versions, rules, evaluation snapshots, and cap reservations: `RestaurantPromotion`, `RestaurantPromotionVersion`, `RestaurantPromotionEvaluationSnapshot`, `RestaurantPromotionCapReservation` in `prisma/schema.prisma`.
- Authoring and evaluation: `src/lib/restaurant/promotions.ts`, `src/lib/restaurant/promotion-evaluator.ts`, `src/lib/restaurant/promotion-caps.ts`.
- Settlement consumes the evaluation: `src/lib/restaurant/bills.ts`.
- Screen: `src/app/(app)/restaurant/promotions/page.tsx` (title “Restaurant Offers”), `src/components/restaurant/promotions/promotions-console.tsx`, `src/server/routers/restaurant-promotions.ts`.

### Direct delivery

Staff open a `DELIVERY` order, attach a zone and address, and dispatch it from the kitchen. This is not a guest website.

- Channel: `RestaurantOrderChannel.DELIVERY` in `prisma/schema.prisma`, `src/lib/restaurant/order-channels.ts`.
- Zones, addresses, and the immutable fulfillment: `RestaurantDeliveryZone`, `RestaurantCustomerAddress`, `RestaurantDeliveryFulfillment` in `prisma/schema.prisma`, `src/lib/restaurant/delivery.ts`.
- Register attach: `src/app/api/restaurant/orders/delivery/attach/route.ts`, `src/lib/restaurant/terminal-delivery-orders.ts`.
- Dispatch after the kitchen is ready, prepaid or cash on delivery: `src/lib/restaurant/terminal-delivery-dispatch.ts`, `src/components/restaurant/kds/delivery-board.tsx`, `src/app/api/restaurant/kds/delivery/queue/route.ts`.
- Configuration screen: `src/app/(app)/restaurant/delivery/page.tsx`, `src/components/restaurant/delivery/delivery-console.tsx`.

## Direct online ordering — missing

There is no guest menu, cart, checkout, or online payment. `RestaurantOrder` requires `staffProfileId` and `deviceId` (`prisma/schema.prisma`). The only public restaurant page is wallet enrollment (`src/app/(public)/wallet/join/[token]/page.tsx`).

Dine-in and takeaway are taken on the register (`src/app/(terminal)/pos/page.tsx`, `src/lib/restaurant/terminal-orders.ts`).

## Aggregators (Foodpanda / Careem) — missing

No Foodpanda, Careem, or other marketplace adapter, menu sync, or order ingest exists.

The inbound webhook records an envelope and a stub signature check, then marks the row processed without creating an order (`src/app/api/restaurant/webhooks/[source]/route.ts`, `src/lib/restaurant/webhook-inbox.ts`, `RestaurantWebhookInbox` in `prisma/schema.prisma`).

## QR table ordering — missing

Tables are for staff service. A guest cannot order by scanning a table.

- Floors, tables, sections, and the order link: `RestaurantFloor`, `RestaurantTable`, `RestaurantOrderTable` in `prisma/schema.prisma`.
- Floor editor: `src/app/(app)/restaurant/floor/page.tsx`, `src/components/restaurant/floor/floor-console.tsx`.
- Open, move, and merge: `src/app/api/restaurant/orders/open/route.ts`, `src/app/api/restaurant/orders/move-table/route.ts`, `src/app/api/restaurant/orders/merge-tables/route.ts`.

The QR codes in the product are the loyalty enrollment link and the wallet-pass barcode (`src/lib/restaurant/wallet/enrollment.ts`, `src/lib/restaurant/wallet/apple-pass.ts`). They identify a loyalty account.

## Reservations — missing

There is no table reservation, waitlist, or cover hold. The restaurant plan defers both (`industry-specific-docs/restaurants/restaurant-management-system-plan.md`, decision D23).

Catering is a booked event with a date, headcount, and quote. It is not a dining reservation (`RestaurantCateringOrder` in `prisma/schema.prisma`, `src/app/(app)/restaurant/catering/page.tsx`, `src/lib/restaurant/catering-operations.ts`).

## Recipe inventory — present

- Recipes, versions, lines, and substitutes: `RestaurantRecipe`, `RestaurantRecipeVersion`, `RestaurantRecipeLine`, `RestaurantRecipeLineSubstitute` in `prisma/schema.prisma`.
- Portion cost: `src/lib/restaurant/recipe-costing.ts`.
- Consumption and post-prep waste at order close: `postOrderRecipeConsumption` in `src/lib/restaurant/inventory.ts`, called from `closeOrder` in `src/lib/restaurant/orders.ts`. The ledger reason is `RECIPE_CONSUMPTION` (`src/lib/restaurant/inventory-ledger.ts`).
- On-hand, counts, transfers, and purchasing: `src/lib/restaurant/inventory.ts`, `src/app/(app)/restaurant/inventory/page.tsx`, `src/app/(app)/restaurant/purchasing/page.tsx`.
- Food cost and dish profitability: `src/lib/restaurant/reports.ts`, `src/app/(app)/restaurant/reports/page.tsx`.

Partial:

- Consumption uses the branch's first active stock location (`postOrderRecipeConsumption` in `src/lib/restaurant/inventory.ts`).
- `RestaurantStockBatch` stores lots. Sale consumption does not allocate those lots.
- A product with no active recipe is skipped. Selling it does not require stock.
