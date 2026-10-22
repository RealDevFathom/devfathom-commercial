# GitHub issue #409: already fixed

Issue #409 reported that the agency invoice list always rendered a dollar sign because the row
type omitted the invoice currency and the amount used a hard-coded `$` prefix.

The current code already contains the fix:

- `src/app/(app)/finance/invoices-tab.tsx:26-35` includes `currency: string` in
  `InvoiceRowData`, so each row carries its invoice currency.
- `src/app/(app)/finance/invoices-tab.tsx:224-227` renders the amount with
  `moneyLabel(Number(inv.total), inv.currency)` rather than a hard-coded symbol.
- `src/lib/finance/currency.ts:27-31` maps `PKR` to the `Rs ` prefix and formats other currently
  supported invoice currencies with `$`.

No production code was changed for this issue because the reported defect is not present in the
current checkout.
