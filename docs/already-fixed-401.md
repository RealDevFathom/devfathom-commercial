# GitHub issue #401 is already fixed

Issue #401 reports that the agency finance overview calculated **Outstanding**
from the full totals of `SENT` and `OVERDUE` invoices without deducting partial
payments. The current code already contains the requested correction, so no
production code was changed during this verification.

## File-and-line evidence

- `src/server/routers/finance.ts:848-855` loads open invoices and their payment
  amounts rather than aggregating invoice totals alone.
- `src/server/routers/finance.ts:896-907` subtracts the sum of each invoice's
  payments from its total, clamps an overpaid invoice's balance to zero, and
  aggregates the remaining balances by currency.
- `src/server/routers/finance.ts:918-919` returns the computed outstanding
  balances while retaining the count of open invoices.
- `src/server/routers/finance.summary.test.ts:47-70` is a focused regression
  test proving that partial payments are deducted independently for USD and PKR
  invoices and that only `SENT`/`OVERDUE` invoices are queried.
- `src/server/routers/finance.summary.test.ts:72-81` verifies that an overpaid
  open invoice cannot produce a negative outstanding balance.

The existing implementation therefore addresses both the reported
overstatement and its multi-currency presentation without weakening tenant or
authorization boundaries.
