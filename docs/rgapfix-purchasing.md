# Restaurant purchasing gap fixes — 2026-10-22

## Verification and issue exclusion

The three highest-impact High/Medium findings in
`docs/rgap-restaurant-purchasing-20261022.md` were rechecked against the current branch before
editing. All three were still present:

1. Purchase-order lists and direct order/receipt reads did not resolve the restaurant actor's
   branch authorization.
2. Receipt transactions read and updated a purchase order without an order-level lock.
3. A receipt posted its full delivered quantity to usable inventory even when the operator marked
   goods damaged, expired, or rejected.

No finding was skipped as already fixed. Open-issue exclusion could not be completed: this checkout
has no Git remote and `gh issue list --state open --limit 200 --json number,title,body,url,labels`
reported that GitHub CLI has no authenticated host. Consequently, none of the three findings could
be confirmed as covered by a private open GitHub issue; this is an access limitation, not a claim
that no such issue exists.

## Changes

- **Branch-restricted purchasing reads:** actor resolution now exposes an authorization-derived
  branch scope, unfiltered PO lists apply that scope internally, and direct PO/receipt reads verify
  the record branch before returning details (`src/server/restaurant-actor.ts:13-58`,
  `src/server/routers/restaurant-purchasing.ts:118-125`,
  `src/server/routers/restaurant-purchasing.ts:224-248`,
  `src/lib/restaurant/purchasing.ts:738-754`).
- **Concurrent receipt status:** receiving takes a PostgreSQL `FOR UPDATE` lock on the purchase
  order before reading eligibility or deriving the terminal status, serializing competing receipts
  (`src/lib/restaurant/purchasing.ts:474-490`).
- **Unusable delivery quantities:** receipt lines now distinguish delivered quantity from accepted
  usable quantity. Damaged/expired/rejected discrepancies require that explicit split, only the
  accepted quantity becomes a positive stock movement, and the receiving form captures the usable
  amount (`src/lib/restaurant/purchasing.ts:386-400`,
  `src/lib/restaurant/purchasing.ts:539-555`,
  `src/lib/restaurant/purchasing.ts:580-594`,
  `src/server/routers/restaurant-purchasing.ts:76-97`,
  `src/app/(app)/restaurant/purchasing/page.tsx:433-499`,
  `src/app/(app)/restaurant/purchasing/receiving-form.tsx:25-34`).
- **Behavioral coverage:** router tests exercise assignment-derived list filtering and fail-closed
  direct reads; the database-backed purchasing test verifies that only accepted goods enter usable
  stock and terminal status under concurrent receipts
  (`src/server/routers/restaurant-purchasing.test.ts:196-229`,
  `src/lib/restaurant/purchasing.test.ts:317-383`).

No migration was required.
