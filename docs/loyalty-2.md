# Loyalty 2/6 — spend-threshold vouchers

## Design

Checkout completion evaluates the customer's **eligible spend** in integer paisa: the sum of
non-`LOYALTY` tenders actually paid after line discounts and vouchers. Refunds never contribute.
The highest configured threshold at or below that amount issues exactly one voucher. Defaults are
Rs 10,000 → Rs 500 (`1000000` → `50000` paisa) and Rs 20,000 → Rs 1,000
(`2000000` → `100000` paisa).

Rules are tenant-wide JSON on the existing loyalty settings record. The existing owner mutation is
guarded by central `can(..., 'pharmacy:loyalty-manage')`, validates positive safe-integer paisa,
sorts thresholds, rejects duplicates, and stores the complete old/new settings in its audit row.
Voucher rows remain branch-scoped and tenant RLS remains forced. `issuedSaleId` has a tenant-unique
index, so checkout retry returns the prior voucher rather than issuing again.

Issuance runs inside the sale transaction after completion. Receipt reads join the issued voucher
and the existing receipt builders print its code, value, expiry, and minimum next basket. A
transactional `PENDING` pharmacy message-log row is claimed in that same transaction only when the
customer opted in to WhatsApp and the latest WhatsApp `LOYALTY` patient consent is granted and not
revoked. This reuses the existing outbox/provider seam; the production live-send block is unchanged.

## Refund decision

Any posted refund against the qualifying sale voids its voucher while status is `ISSUED`. Redeemed,
expired, and already-void vouchers are immutable. This conservative rule avoids rewarding spend
that was later unwound without attempting ambiguous proportional tier recalculation.

## Follow-ups

- Add a dedicated owner form for editing/reordering tiers once the owner-settings information
  architecture is consolidated; the capability-guarded API contract is ready for it.
- Add SMS to the shared pharmacy messaging provider before offering SMS selection. This increment
  queues WhatsApp only rather than creating a second delivery stack.
- A later voucher increment can add partial-refund tier recalculation if product policy replaces
  the documented any-refund void rule.
