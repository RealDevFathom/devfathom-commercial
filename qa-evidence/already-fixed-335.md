# Issue #335 — already fixed on main

Issue #335 does not reproduce in the current source on `main`.

## Evidence

- The POS runtime opens `CheckoutPanel` with only the order id, terminal request function,
  connection state, and close callback; it does not expose a complimentary action or capability
  flag (`src/components/restaurant/pos/use-pos-runtime.ts:1055-1064`).
- For an open bill, the checkout UI renders `TenderPad` and `GuestLoyaltySection` only. The sole
  comp-related element is the read-only `Comp total` value; there is no **Comp** button or dialog
  (`src/components/restaurant/pos/checkout-panel.tsx:714-773`).
- The checkout comp route exports `POST` only, so the reported `GET /api/restaurant/checkout/comp`
  request cannot be initiated by the current checkout implementation
  (`src/app/api/restaurant/checkout/comp/route.ts:10-20`).

## Verification

Per the issue instructions for the old environment, verification was static and no tests were run.
Repository searches for the visible `Comp` action, `/api/restaurant/checkout/comp`, and
`orders:complimentary` found no POS client control or request path. Existing occurrences in the
checkout UI are display-only totals. Consequently, an operator without the capability cannot see
the enabled button described by the report because that button is no longer rendered for any
operator.
