# GitHub issue #419: already fixed

Verified against the current code at `4c371ef` on 2026-10-22. The reported hard-coded
seller header is no longer present, so no implementation change is required.

## File-and-line evidence

- `src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx:26-27` loads the invoice
  through `finance.getInvoiceById` for the print / Save as PDF view.
- `src/server/routers/finance.ts:209-229` resolves that invoice's issuer with
  `readInvoiceIssuer(ctx.db, workspaceId(ctx))` and includes the result in the response.
- `src/lib/finance/invoice-issuer.ts:24-40` reads the authenticated tenant's legal name,
  invoice address, and invoice tax ID and maps them to the invoice issuer.
- `src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx:103-115` renders the returned
  issuer name, address, and tax ID in the printed invoice header. It does not contain the
  reported `DevFathom` / `hub.devfathom.com` seller header.
- `src/lib/finance/invoice-issuer.test.ts:4-23` focuses the tenant-identity mapping test on
  the legal name, invoice address, invoice tax ID, and organization-scoped lookup.
- `tests/agency-invoice-issuer-contract.test.ts:17-25` guards the print contract by requiring
  all three agency identity fields and rejecting the old `hub.devfathom.com` branding.

The issue is not an `archive/...` recovery issue, so there is no archive branch diff or
skipped archive work to report.
