# Restaurant API surface map

Audit base: `ddc0bc9dde9642b63dd02dde869dd35f5564e8b9` (WHA-243).

## Back-office tRPC

- **IMPLEMENTED** — All routers below are mounted on the application router in [`src/server/routers/_app.ts`](../../src/server/routers/_app.ts) and served through [`src/app/api/trpc/[trpc]/route.ts`](../../src/app/api/trpc/[trpc]/route.ts).

| Classification | Router | Scope | Evidence |
| --- | --- | --- | --- |
| **IMPLEMENTED (M2; WHA-20–WHA-26)** | `restaurantStaff`, `restaurantDevices` | staff, credentials, devices | [`restaurant-staff.ts`](../../src/server/routers/restaurant-staff.ts), [`restaurant-devices.ts`](../../src/server/routers/restaurant-devices.ts) |
| **IMPLEMENTED (M3; WHA-37)** | `restaurantCatalog`, `restaurantMenus` | catalog, recipes, pricing, menus, publications | [`restaurant-catalog.ts`](../../src/server/routers/restaurant-catalog.ts), [`restaurant-menus.ts`](../../src/server/routers/restaurant-menus.ts) |
| **IMPLEMENTED (M4; WHA-49)** | `restaurantFloor`, `restaurantOrders` | floor/service configuration, order and kitchen reads/commands | [`restaurant-floor.ts`](../../src/server/routers/restaurant-floor.ts), [`restaurant-orders.ts`](../../src/server/routers/restaurant-orders.ts) |
| **IMPLEMENTED (M5; WHA-62)** | `restaurantBills`, `restaurantCash`, `restaurantPayments` | bills, close/drawer reads, payment/refund reads | [`restaurant-bills.ts`](../../src/server/routers/restaurant-bills.ts), [`restaurant-cash.ts`](../../src/server/routers/restaurant-cash.ts), [`restaurant-payments.ts`](../../src/server/routers/restaurant-payments.ts) |
| **IMPLEMENTED (M6; WHA-74)** | `restaurantInventory`, `restaurantPurchasing` | stock/count/transfer, suppliers/PO/receiving | [`restaurant-inventory.ts`](../../src/server/routers/restaurant-inventory.ts), [`restaurant-purchasing.ts`](../../src/server/routers/restaurant-purchasing.ts) |
| **IMPLEMENTED (M7; WHA-88)** | `restaurantJobs`, `restaurantSop`, `restaurantSopExecution`, `restaurantNotifications` | jobs, SOP administration/execution, notification center | [`restaurant-jobs.ts`](../../src/server/routers/restaurant-jobs.ts), [`restaurant-sop.ts`](../../src/server/routers/restaurant-sop.ts), [`restaurant-sop-execution.ts`](../../src/server/routers/restaurant-sop-execution.ts), [`restaurant-notifications.ts`](../../src/server/routers/restaurant-notifications.ts) |
| **IMPLEMENTED (M8; WHA-93–WHA-101)** | `restaurantCustomers`, `restaurantLoyalty`, `restaurantInsights` | customer/privacy, loyalty, operational reports | [`restaurant-customers.ts`](../../src/server/routers/restaurant-customers.ts), [`restaurant-loyalty.ts`](../../src/server/routers/restaurant-loyalty.ts), [`restaurant-insights.ts`](../../src/server/routers/restaurant-insights.ts) |

## Terminal REST

- **IMPLEMENTED (M2; WHA-22/WHA-25)** — `/api/restaurant/terminal/{establish,heartbeat,lock,switch,unlock,co-authorize}` handles device/operator session trust; evidence: [`src/app/api/restaurant/terminal`](../../src/app/api/restaurant/terminal) and [`tests/restaurant-m2-terminal-threats.test.ts`](../../tests/restaurant-m2-terminal-threats.test.ts).
- **IMPLEMENTED (M3/M4; WHA-37/WHA-49)** — `/api/restaurant/orders/{effective-menu,open-orders,detail,open,add-item,hold,fire,mark-served,void,remake,cancel,close,move-table,merge-tables}` exposes POS menu/order operations; evidence: [`src/app/api/restaurant/orders`](../../src/app/api/restaurant/orders) and [`tests/restaurant-m4-acceptance.test.ts`](../../tests/restaurant-m4-acceptance.test.ts).
- **IMPLEMENTED (M4; WHA-49)** — `/api/restaurant/kds/{queue,ack,bump,recall}` exposes durable kitchen queue operations; evidence: [`src/app/api/restaurant/kds`](../../src/app/api/restaurant/kds) and [`tests/restaurant-m4-kitchen-flow.test.ts`](../../tests/restaurant-m4-kitchen-flow.test.ts).
- **IMPLEMENTED (M5; WHA-62)** — `/api/restaurant/checkout/{bill,comp,receipt,refund,summary,tender}` and `/api/restaurant/cash/{drawer,day}/...` expose settlement, drawer, and close commands; provider-backed card processing is MOCK. Evidence: [`src/app/api/restaurant/checkout`](../../src/app/api/restaurant/checkout), [`src/app/api/restaurant/cash`](../../src/app/api/restaurant/cash), and [`tests/restaurant-m5-acceptance.test.ts`](../../tests/restaurant-m5-acceptance.test.ts).
- **IMPLEMENTED (M7; WHA-80/WHA-88)** — `/api/restaurant/webhooks/[source]` persists inbound webhook envelopes with explicit verification state; external provider completion is not implied. Evidence: [`src/app/api/restaurant/webhooks/[source]/route.ts`](../../src/app/api/restaurant/webhooks/[source]/route.ts) and [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts).

## Boundaries

- **PLANNED (WHA-243 supervisor boundary)** — OCR, cameras, printing, card auto-confirmation, staff-shift APIs, deeper SOP integrations, and real payment gateways are not claimed as API capabilities.
- **PLANNED (WHA-243, Lane C)** — Platform-login/onboarding APIs remain separate from this restaurant M0–M8 map.
- **PLANNED (WHA-243, Lane D)** — Broader dashboard APIs remain separate from implemented `restaurantInsights` reports.
