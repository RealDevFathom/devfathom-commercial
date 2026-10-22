# Issue #396 is already fixed

Issue #396 reports that the agency invoice status menu offers transitions that
the server rejects. The current code already resolves that mismatch:

- `src/lib/finance/invoice-status.ts:1-18` defines the canonical invoice
  statuses and one shared transition map. Both the UI and server consume this
  module.
- `src/app/(app)/finance/invoices-tab.tsx:12-15` imports the shared transition
  helper, and `src/app/(app)/finance/invoices-tab.tsx:248-254` renders only the
  destinations returned for the row's current status. For example, `DRAFT`
  offers only `SENT` and `CANCELLED`, not `PAID`.
- `src/server/routers/finance.ts:470-502` validates status updates with the same
  shared status enum and transition helper, so its accepted transitions cannot
  drift from the dropdown's options.
- `src/lib/finance/invoice-status.test.ts:10-39` covers every status's allowed
  destinations, representative rejected transitions (including `DRAFT` to
  `PAID`), no-op exclusion, and completeness of the transition table.

The verification followed the status value through all three layers rather than
comparing two duplicated lists: the row's typed status is passed to the shared
lookup, the selected value is validated by the shared enum, and the mutation
checks the same transition map before its compare-and-set write. Consequently,
every option displayed by the dropdown is accepted from that same prior status;
a concurrent change is reported as a conflict instead of silently overwriting
the newer state (`src/server/routers/finance.ts:514-525`).

This is not a recover-from-archive issue, so there is no archive branch diff or
skipped archive work to report. No additional product-code change is needed for
this issue.
