# GitHub issue #400: already fixed

Issue #400 reported that an agency invoice with no line items could be saved.
The current code already prevents that state at the server boundary:

- `src/server/routers/finance.ts:34-47` defines the shared create-invoice input
  schema and applies `.min(1, 'Invoice must have at least one line item')` to
  `items`.
- `src/server/routers/finance.ts:246-248` passes that schema directly to the
  `createInvoice` procedure, so an empty array is rejected before the mutation
  can persist an invoice.
- `src/server/routers/finance.test.ts:13-19` contains a focused regression test
  that passes `items: []` and verifies schema validation fails.

No additional implementation was ported: the validation and its regression
coverage are already present on the current branch, so changing the invoice
flow again would be redundant.
