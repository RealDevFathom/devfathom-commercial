# GitHub issue #277 — already fixed

Issue #277 reports that the on-screen restaurant receipt omits the discount row even though the
print facts contain it. Verification against the current code shows that the issue is already
fixed, so no production or test code was changed for this issue.

## File-and-line evidence

- `src/lib/restaurant/checkout-routes.ts:696-703` selects `discountTotal` with the other settled
  bill totals, preserving the value in the branch-scoped receipt query.
- `src/lib/restaurant/checkout-routes.ts:764-773` serializes that value as
  `totals.discountTotal` in the receipt response.
- `src/components/restaurant/pos/receipt-view.tsx:37-46` includes `discountTotal` in the receipt
  totals contract.
- `src/components/restaurant/pos/receipt-view.tsx:153-163` renders a `Discount` row from
  `receipt.totals.discountTotal` between the comp and rounding rows.
- `src/components/restaurant/pos/receipt-view.test.tsx:46-67` supplies a distinct `0.50` discount
  and asserts that both the `Discount` label and its value are visible, providing focused
  regression coverage for the reported omission.

No archive recovery was requested by this issue, and no migration is involved.
