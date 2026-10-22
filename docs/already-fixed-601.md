# GitHub issue #601: already fixed

Issue #601 was already fixed in the current checkout by commit `aab4bbc`.
No additional production-code change is required.

## Code evidence

- `src/server/routers/finance.ts:230-252` keeps `getInvoiceById` behind
  `adminProcedure`, returns `null` before looking up issuer details when the
  invoice is not visible, and loads only the current workspace's `legalName`,
  `displayName`, and logo using `workspaceId(ctx)`.
- `src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx:104-119`
  renders that issuer's logo, legal name (falling back to its display name),
  and distinct display name. The former hard-coded `DevFathom` seller and
  `hub.devfathom.com` text are no longer present in the invoice header.
- `src/server/routers/finance.invoice-issuer.test.ts:58-80` verifies that the
  issuer lookup uses the authenticated workspace, selects only the required
  branding fields, returns those fields, and does not fetch issuer information
  for a missing or invisible invoice.

No archive branch recovery applies to this issue: it is not a
"Recover work from archive/..." issue.
