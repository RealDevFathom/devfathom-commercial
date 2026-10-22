# GitHub issue #405: already fixed

Static verification against the current code shows that the reported tax-basis mismatch is
already fixed:

- `src/lib/restaurant/tenders.ts:895-905` stores a settled bill's `subtotal` after removing
  inclusive merchandise tax, so day-close gross sales are pre-tax.
- `src/lib/restaurant/daily-close.ts:159-170` calculates `refundTotal` as each refund's gross
  `amount` less `taxRefundAmount`, then subtracts that pre-tax refund total from pre-tax gross
  sales when calculating `netSales`.
- `src/lib/restaurant/daily-close.ts:258-261` loads `taxRefundAmount` with each refund while
  preserving the existing branch-scoped relationship filter (`bill: { branchId }`).
- `src/lib/restaurant/refunds.ts:277-300` derives `taxRefundAmount` from the tender's immutable
  tax-allocation snapshots, including proportional partial-refund allocation.
- `src/lib/restaurant/daily-close.test.ts:118-142` has a focused regression case: a pre-tax
  subtotal of 100.00 and a 55.00 tax-inclusive refund containing 5.00 tax produce both a 50.00
  refund total and 50.00 net sales.

No implementation change or migration is needed for this issue.
