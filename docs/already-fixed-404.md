# GitHub issue #404 was already fixed

Issue #404 reports that settling a restaurant bill leaves its order in
`PAYMENT_PENDING` and can leave the table linked to that order. The current code already
fixes both outcomes:

- `src/lib/restaurant/tenders.ts:422-434` finalizes a bill when the applied tender is the
  final payment and, in the same transaction, calls `closeOrderAfterSettlement` for the
  bill's order.
- `src/lib/restaurant/orders.ts:332-346` reloads the order, requires it to be
  `PAYMENT_PENDING`, re-evaluates the complete order settlement, and closes it only when
  every bill is settled.
- `src/lib/restaurant/orders.ts:304-329` performs the close transition, sets `closedAt`,
  deactivates every active order-table link with the same timestamp, records the
  `order.closed` event, and runs the existing loyalty and inventory close effects.
- `src/lib/restaurant/orders-close-time.test.ts:145-180` covers both the fully settled
  path (including order closure, table release, and the close event) and the guard that
  leaves an order open while another bill remains unsettled.

The fix is present in commit `f92450f` (`fix(#404): close restaurant order when payment
covers bill`). No additional production or test change is needed.
