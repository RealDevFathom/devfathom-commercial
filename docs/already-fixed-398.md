# GitHub issue #398: already fixed

Static verification against the current branch shows that the reported agency-invoice inconsistency is already fixed:

- The invoice list loads each invoice's payments and derives `amountPaid` and `balance` from those payment records (`src/server/routers/finance.ts:188-205`).
- Changing an invoice to `PAID` now runs the status update and payment work in one transaction. It sums existing payments, computes the outstanding amount, and creates a `Manual status update` payment for that amount before the transaction completes (`src/server/routers/finance.ts:487-525`).
- Paid invoices remain in the payment list, where the UI displays their computed paid amount and balance and renders their payment history (`src/app/(app)/finance/finance-content.tsx:1005-1011`, `src/app/(app)/finance/finance-content.tsx:1079-1153`). The payment-entry form is still hidden for a paid invoice, but the recorded balancing payment means that this no longer hides an unpaid balance (`src/app/(app)/finance/finance-content.tsx:1155-1162`).
- A focused router test verifies that marking a partially paid invoice as paid creates a payment for exactly the outstanding balance in the same transaction (`src/server/routers/finance.mark-paid.test.ts:58-91`).

No production code change is needed for issue #398.
