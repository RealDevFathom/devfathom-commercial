# GitHub issue #394: already fixed

Issue #394 reported that `PATCH /api/v1/invoices/[id]` could write an invoice status directly and therefore allowed an invalid `DRAFT` to `PAID` transition. The current code already fixes the reported problem, so no production code was changed for this issue.

## Current-code evidence

- `src/app/api/v1/invoices/[id]/route.ts:53-59` validates the requested status with the shared `invoiceStatusTransitionError` contract and returns HTTP 400 when the transition is invalid.
- `src/lib/finance/invoice-status.ts:13-27` defines the permitted transition table and rejects every request to set `PAID`, reserving that state for the payment-recording flow. In particular, `DRAFT` permits only `SENT` or `CANCELLED`.
- `src/app/api/v1/invoices/[id]/route.ts:64-74` performs the accepted change as a compare-and-set against both invoice ID and prior status, returning HTTP 409 if a concurrent transition wins.
- `src/app/api/v1/invoices/[id]/route.test.ts:55-74` contains focused REST regression coverage proving that `PAID` is rejected from every status and that another invalid state-machine transition is rejected without a write.
- `src/app/api/v1/invoices/[id]/route.test.ts:76-95` verifies that an allowed `DRAFT` to `SENT` transition still succeeds and that transition metadata is maintained.

These checks establish that the REST endpoint no longer bypasses the invoice state machine and specifically cannot perform the reported `DRAFT` to `PAID` transition.
