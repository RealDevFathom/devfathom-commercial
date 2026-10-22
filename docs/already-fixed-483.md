# GitHub issue #483: already fixed

Issue #483 reports that a pharmacy sale line split across inventory lots uses
the highest lot MRP for every unit. The current code already fixes that defect:

- `src/lib/pharmacy/sales.ts:303-316` accumulates price and ceiling amounts for
  each allocation using `part.units`, so each lot contributes only the units it
  supplied.
- `src/lib/pharmacy/sales.ts:318-324` divides those allocated totals by the
  line's canonical-unit count, rounds down to avoid an integer-minor-unit
  overcharge, and calculates the gross from that weighted unit price.
- `src/lib/pharmacy/reserved-sale.test.ts:189-220` is a focused regression test
  for a three-unit split across 100-minor and 200-minor lots. It expects a
  133-minor weighted unit price (399 minor total) and explicitly rejects the
  former 200-minor highest-lot price.

The fix and regression test are present in commit `f013685702365e11e6be10b53c0fdfffb0e74e0a`,
which follows the issue's cited main commit `16a2a370`. No production code or
additional test changes are needed.
