# GitHub issue #335 is already fixed

Verified against the current checkout implementation on 2026-10-22.

The reported UI path no longer exists:

- `src/components/restaurant/pos/checkout-panel.tsx:680-704` renders only bill-cutting actions
  when an order has unbilled items.
- `src/components/restaurant/pos/checkout-panel.tsx:714-781` renders an open bill's totals,
  tender controls, and guest/loyalty controls. `Comp total` at lines 746-751 is read-only output;
  there is no **Comp** button or comp dialog.
- `src/components/restaurant/pos/checkout-panel.tsx:784-794` contains the checkout footer's only
  action, **Close checkout**.
- `src/components/restaurant/pos/checkout-panel.test.tsx:157-167` already verifies that an empty
  checkout does not invent payment actions.

The former client behavior is also absent at the request boundary: there is no client request to
`/api/restaurant/checkout/comp` under `src/`. The remaining endpoint is server-only and exports
only `POST` (`src/app/api/restaurant/checkout/comp/route.ts:9-20`), so the reported `GET` triggered
by opening a Comp dialog cannot be initiated by the current checkout UI.

Because the Comp control is not rendered for any operator, an operator without
`orders:complimentary` cannot see the enabled button described in the issue. No production or test
code change is needed.
