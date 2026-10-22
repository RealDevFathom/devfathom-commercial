# GitHub issue #272 — already fixed

Issue #272 is already fixed on the current branch; no production code or tests were changed.

## Current-code evidence

- `src/lib/restaurant/bills.ts:51-61` documents the settlement identity as
  `grandTotal + compTotal + discountTotal - exclusiveTax`. Adding `compTotal` back preserves the
  pre-comp merchandise (and therefore the order-level service-charge basis), while subtracting
  exclusive tax makes the bill comparable with the pre-tax derived order total.
- `src/lib/restaurant/bills.ts:1753-1761` derives the comparison total from merchandise, the
  order-level service charge, and the delivery fee.
- `src/lib/restaurant/bills.ts:1780-1792` applies that documented identity to every live bill. In
  particular, it adds the comp and discount totals back and subtracts the latest live exclusive-tax
  snapshot before comparing totals.
- `src/lib/restaurant/bills.ts:1817-1835` raises `TOTAL_MISMATCH` only when the resulting accounted
  total differs from the derived order total; equality returns `settled: true`.
- `src/lib/restaurant/bills.test.ts:920-930` exercises a comp that reduces a line total to zero and
  proves that adding the bill's comp total back leaves `accountedTotal` equal to
  `derivedOrderTotal`.
- `src/lib/restaurant/bills.test.ts:231-280` exercises settled exclusive tax (including reversal and
  re-freeze handling) and proves that the order remains settled with the exclusive tax removed
  exactly once from `accountedTotal`.

Together these paths cover both reported failures: the partial-comp case reconciles against the
original merchandise/service-charge total, and the exclusive-tax case excludes tax that is not part
of the derived pre-tax order total.
