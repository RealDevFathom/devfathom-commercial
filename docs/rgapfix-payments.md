# Restaurant payments gap fixes — 2026-10-22

## Verification and issue exclusion

The three highest-impact findings in `docs/rgap-restaurant-payments-20261022.md` were checked
against the current branch before editing. All three were still present:

1. `getTerminalConfig` required `restaurant:configure`, while the Money page is a `money:read`
   surface, and that read-only page rendered a terminal-configuration mutation form.
2. Refund rows returned a `paymentId` but offered no control to open that payment's event trail.
3. `RestaurantRefund.deliveryFeeRefundAmount` existed in the schema but was absent from both refund
   read projections and the refund ledger.

I also attempted the required open-issue check with `gh issue list --state open --limit 200`.
GitHub CLI is not authenticated in this environment and the checkout has no configured remote, so
the authoritative issue list could not be queried. A repository search found no local issue
reference covering these findings. Consequently none was skipped, but the open-issue exclusion
cannot be considered definitive.

## Changes

- **Finding 1 — fixed.** Terminal configuration reads now use the same `money:read` capability as
  the rest of reconciliation, while the existing configuration mutation remains protected by
  `restaurant:configure` (`src/server/routers/restaurant-payments.ts:40-65`). The Money terminal tab
  now displays bindings and reconciliation events without exposing a write form
  (`src/components/restaurant/money/money-console.tsx:570-650`).
- **Finding 2 — fixed.** Each refund with a `paymentId` now has a keyboard-accessible event-trail
  action and selected-row state; refunds without one explicitly show that no card trail exists
  (`src/components/restaurant/money/money-console.tsx:1154-1187`).
- **Finding 3 — fixed.** Refund list and payment-detail projections now select and serialize
  `deliveryFeeRefundAmount` through the existing decimal-to-string money path
  (`src/server/routers/restaurant-payments.ts:277-321`,
  `src/server/routers/restaurant-payments.ts:362-421`). The refund ledger now displays service
  charge, delivery fee, and tax separately (`src/components/restaurant/money/money-console.tsx:1140-1171`).

## Behavioural coverage added by inspection

- A router test covers finance-only access to terminal binding reads
  (`src/server/routers/restaurant-payments.test.ts:299-316`).
- Router refund tests cover exact string serialization of delivery-fee refunds in both refund list
  and payment detail responses (`src/server/routers/restaurant-payments.test.ts:155-186`,
  `src/server/routers/restaurant-payments.test.ts:189-264`).
- UI tests cover the terminal tab's read-only boundary and a refund's complete breakdown plus event
  trail action (`src/components/restaurant/money/money-console.test.tsx:481-486`,
  `src/components/restaurant/money/money-console.test.tsx:528-545`).

Per the task's environment constraint, dependencies were not installed and tests were not run.
