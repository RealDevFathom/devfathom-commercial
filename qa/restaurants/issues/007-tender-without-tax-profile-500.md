[QA][Restaurants][SEV2] Tendering without a tax profile returns Internal server error
Labels: qa, restaurants, sev2-major

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, branch Clifton, business date 2026-10-21. At the time of this attempt no tax profile was published for the branch. A profile was published later; this issue is only the pre-profile tender. Executed 2026-10-21.

## Test case

PAY-03, first attempt, before `restaurantTax.publishCustom`.

## Steps

1. Enroll a register, establish a terminal session, and unlock with the owner staff profile.
2. Open an order, add a menu item, fire it, and cut a bill while the branch has no effective tax profile.
3. Open the cash drawer and POST a cash tender for the bill total.
4. Repeat with a card tender on a second bill.

## Expected

The tender is refused with a client error that says the branch has no effective tax profile, so the cashier knows to publish one. The response does not say "Internal server error".

## Actual

Both the cash tender and the card tender returned HTTP 500 `{"error":"Internal server error"}`. The server log was `Terminal session-auth error: Error: Effective tax profile missing` thrown as `TaxProfileResolutionError` from tax settlement inside `loadSettlementContext`. `moneyErrorResponse` maps money, bill, tender, and refund domain errors, and returns null for anything else, so this configuration error becomes the generic 500.

After a profile existed, tenders returned 200 and exposed a separate tax-quote defect (filed separately). This issue is only the missing-profile response.

## Evidence

- `qa/restaurants/evidence/pos-pay.json`: `PAY-03` HTTP 500 `Internal server error` and `PAY-04` HTTP 500 `Internal server error`, after unlock HTTP 200. The order, item, fire, and bill calls in that file succeeded.

## Suspected code

`TaxProfileResolutionError` (`Effective tax profile missing`) in `src/lib/restaurant/tax-calculator.ts`, raised from `loadSettlementContext` in `src/lib/restaurant/tenders.ts`. `moneyErrorResponse` in `src/lib/restaurant/checkout-routes.ts` does not map `TaxConfigurationError` or `TaxProfileResolutionError`. No fix is proposed here.
