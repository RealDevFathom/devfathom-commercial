# GitHub issue #339 is already fixed

Verified against the current code on 2026-10-22. No implementation change is
needed:

- The unidentified-batch branch creates the hold and verification task, then
  calls `postUnidentifiedSaleReturnEntry` before it emits the return event and
  returns (`src/lib/pharmacy/sales.ts:744-786`).
- That posting helper scopes the hold lookup by organization, rejects a branch
  mismatch, and uses a source-specific idempotency key
  (`src/lib/pharmacy/finance-postings.ts:361-384`).
- It calculates the cumulative returned slice across both identified return
  lines and unidentified holds, preserving proportional rounding across partial
  returns (`src/lib/pharmacy/finance-postings.ts:386-398`).
- It posts the required revenue reversal (debit `SALES_REVENUE`, credit
  `SALES_CLEARING`) and reverses any allocated discount, while deliberately not
  touching inventory or cost of goods sold until the batch is identified
  (`src/lib/pharmacy/finance-postings.ts:405-453`).
- Focused coverage verifies the revenue/clearing entry and the absence of
  inventory/COGS entries (`src/lib/pharmacy/finance-postings.returns.test.ts:80-118`),
  including the sub-minor-unit rounding case
  (`src/lib/pharmacy/finance-postings.returns.test.ts:120-175`).
- The journal source kind required for the durable posting is present in the
  existing migration
  (`prisma/migrations/20261021170000_unidentified_return_finance_source/migration.sql:1`).

Therefore the early return cited in the issue no longer skips the financial
posting: an unidentified return reverses revenue immediately, and the tender
refund can clear `SALES_CLEARING` without leaving revenue overstated.
