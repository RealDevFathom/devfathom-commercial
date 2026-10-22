# GitHub issue #397: already fixed

Issue #397 reports that Urdu pharmacy receipts use ASCII digits because the
selected receipt locale is not used when formatting monetary values. The
current code already fixes both parts of that report:

- `src/lib/pharmacy/counter-receipt.ts:166-175` accepts the receipt locale,
  selects `ur-PK-u-nu-arabext` for Urdu, and derives the locale's decimal
  separator with `Intl.NumberFormat`.
- `src/components/pharmacy/counter/counter-receipt-view.tsx:507-512` passes the
  selected locale when formatting line totals and unit prices.
- `src/components/pharmacy/counter/counter-receipt-view.tsx:559-583` also passes
  the selected locale for receipt totals and tender amounts.
- `src/lib/pharmacy/counter-receipt.test.ts:68-70` provides focused regression
  coverage for Urdu extended Arabic-Indic digits and decimal punctuation,
  including a negative amount.

No additional implementation change is required.
