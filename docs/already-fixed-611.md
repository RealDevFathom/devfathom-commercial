# GitHub issue #611: already fixed

Issue #611 is already resolved in the current code:

- `src/components/restaurant/orders/orders-console.tsx:157-169` submits back-office cancellations through `restaurantOrders.cancel`.
- `src/server/routers/restaurant-orders.ts:153-155` defines a dedicated `orders:void` capability procedure, and `src/server/routers/restaurant-orders.ts:466-486` uses it for `cancel` while retaining the scoped `ctx.db` command path.
- `src/lib/vertical-catalog.ts:998-1011` and `src/lib/vertical-catalog.ts:1044-1055` grant `orders:void` to the General Manager and Branch Manager templates respectively.
- `src/server/routers/restaurant-orders.test.ts:272-290` provides focused negative and positive coverage: `orders:manage` alone is denied, while the exact `orders:void` grant permits cancellation.

No additional production change is needed. The existing implementation aligns the Orders console action with the manager role grants without broadening other order mutations.
