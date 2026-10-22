# Restaurant cash gap follow-up

Date: 2026-10-22  
Source: `docs/rgap-restaurant-cash-20261022.md`

## Verification and issue screening

This follow-up covers the three highest-ranked **High/Medium** findings by user impact: findings 2,
3, and 4. Each finding was reproduced by inspecting the current branch before making changes.

Authoritative GitHub issue screening was not possible in this checkout: no Git remote is configured
and `gh auth status` reports that no GitHub host is authenticated. I searched repository-local issue
references and the history of the affected files; none of these three findings appeared to be tracked.
Accordingly, none was skipped, but the absence of a private open issue cannot be proven from this
environment.

## Changes

### Finding 2 — current drawer ledger and expected cash

**Verified:** the current-drawer helper selected only the session ID, business date, and opening
float, and the POS drawer panel went directly from movement entry to the closing-count form.

**Fixed:** the device-and-branch-scoped current-drawer read now returns the ordered, attributable
movement ledger and derives expected cash with the existing decimal ledger fold. The terminal route
serializes those values, and the POS panel presents expected cash, movement history, and an explicit
refresh action before the closing count.

- `src/lib/restaurant/drawer-sessions.ts:394-425`
- `src/app/api/restaurant/cash/drawer/current/route.ts:7-31`
- `src/components/restaurant/pos/drawer-panel.tsx:396-437`

### Finding 3 — unexplained drawer variance

**Verified:** the close request accepted only the drawer ID and counted cash, and the closing-count
movement was written without a reason even when counted cash differed from the ledger expectation.

**Fixed:** the close contract accepts an optional variance explanation, but the transaction requires
it whenever the exact decimal variance is non-zero and persists it on the append-only
`CLOSING_COUNT` movement. The POS compares integer minor units, reveals a required explanation field
for a variance, and includes it in the idempotent request body. Zero-variance closes do not require a
reason. No threshold-based manager-approval policy was introduced.

- `src/lib/restaurant/checkout-routes.ts:189-196`
- `src/lib/restaurant/drawer-sessions.ts:588-658`
- `src/app/api/restaurant/cash/drawer/close/route.ts:17-25`
- `src/components/restaurant/pos/drawer-panel.tsx:168-205`
- `src/components/restaurant/pos/drawer-panel.tsx:439-478`

### Finding 4 — delivery-fee totals missing from finance history

**Verified:** daily-close persistence and preview included delivery-fee sales and refunds, while the
cash router's list and detail projections omitted both fields and the finance history did not render
them.

**Fixed:** both delivery-fee totals are selected and money-formatted in list and detail responses,
then shown in the correction-chain table and selected-close totals.

- `src/server/routers/restaurant-cash.ts:240-285`
- `src/server/routers/restaurant-cash.ts:292-387`
- `src/components/restaurant/money/money-console.tsx:1558-1597`
- `src/components/restaurant/money/money-console.tsx:1658-1672`

## Behavioural coverage added

- Current-drawer route coverage checks the derived expected cash and attributable opening movement.
- Drawer command coverage proves a non-zero variance is rejected without a reason and that the
  supplied reason is retained on the closing-count movement.
- POS component coverage exercises ledger rendering and the required variance explanation request.
- Cash-router and finance-console coverage exercises delivery-fee sales/refund history.
