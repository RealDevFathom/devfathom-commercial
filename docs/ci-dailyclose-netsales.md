# Daily-close net-sales CI correction

## What failed

The insights rollup was the remaining consumer of the pre-#405 daily-close formula. It independently
recomputed net sales by subtracting the full refund amount from pre-tax sales. That makes tax,
service-charge, and delivery-fee refund components reduce sales principal even though those amounts
are reported in their own fields.

This was a code defect rather than a stale assertion. The insights reconciliation test described the
old calculation accurately, so changing only its expected value would have left insight reports out
of agreement with the immutable daily close.

## Resolution

`computeReconciledFinancials` now delegates its financial fold to `computeCloseAggregate`, the same
aggregate used by daily-close preview, cut, and correction. The insights query loads the tax and
service-charge refund components required by that aggregate. Insights therefore no longer owns a
second net-sales or refund-total formula. The projection version advances so existing rollups are
recomputed rather than replayed with stale net sales.

## Worked example

For the regression fixture:

- gross sales are `100.00`, comps are `10.00`, and discounts are `5.00`;
- the refund tender amount is `5.50`, comprising `2.50` sales principal, `1.00` tax, `0.75`
  service charge, and `1.25` delivery fee;
- net sales are `100.00 - 10.00 - 5.00 - 2.50 = 82.50`;
- refund total is `5.50 - 1.25 = 4.25`, because delivery-fee refunds are reported separately;
- net tax is `7.00 - 1.00 = 6.00`, net service charge is `3.00 - 0.75 = 2.25`, and the delivery-fee
  refund remains `1.25`.

The old insights calculation produced `79.50` by subtracting all `5.50` from pre-tax sales. The
principal-only calculation prevents that understatement while preserving each non-principal refund
component in its designated total.
