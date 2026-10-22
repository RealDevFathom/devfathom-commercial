# GitHub issue #408 is already fixed

Static verification against the current branch shows that the reported invoice tax and
discount gaps have already been addressed:

- The create form owns both tax and discount state, calculates
  `subtotal - discount + tax`, rejects a discount above the subtotal, and includes both
  values in the create mutation (`src/app/(app)/finance/invoices-tab.tsx:313-340`).
- The create form renders editable Discount and Tax number inputs and prevents submission
  when the discount exceeds the subtotal
  (`src/app/(app)/finance/invoices-tab.tsx:445-477`,
  `src/app/(app)/finance/invoices-tab.tsx:505-508`).
- The invoice model persists the discount alongside subtotal, tax, and total
  (`prisma/schema.prisma:3386-3390`), and the existing migration adds the non-null column
  with a zero default
  (`prisma/migrations/20261021200000_agency_invoice_discount/migration.sql:1-2`).
- Server-side creation accepts the discount, verifies the client and project belong to the
  active organization, derives line amounts, and calculates authoritative totals rather
  than trusting the totals submitted by the browser
  (`src/server/routers/finance.ts:230-264`,
  `src/server/routers/finance.ts:281-291`).
- The shared totals helper rounds persisted amounts, subtracts the discount before adding
  tax, and rejects discounts above the subtotal
  (`src/lib/finance/invoice-totals.ts:6-27`).
- Existing focused tests cover discount/tax arithmetic, cent rounding, and excessive
  discount rejection (`src/lib/finance/invoice-totals.test.ts:4-31`).
- The print view reads the stored discount and displays subtotal, discount, tax, and total
  (`src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx:52-57`,
  `src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx:194-212`).

No implementation change is needed for issue #408.
