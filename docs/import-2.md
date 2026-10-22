# Pharmacy import 2/5 — entities

## Design

This piece extends the existing `PharmacyMigrationSource`, `PharmacyMigrationBatch`,
`PharmacyMigrationRow`, `PharmacyMigrationException` and staged-review route. It does not
introduce another import stack. Live writes are selected by the immutable
`targetModelKey` committer registry. Every ID returned by a committer is written to
`PharmacyMigrationBatchEntity` in the same transaction by the concrete writer; commit
refuses a batch while any open blocking preview exception remains.

Product quantities are normalized to the smallest unit. `10x10` means ten strips of ten
units (100 canonical units per box); one-number pack-size/conversion-factor forms are
also supported. Expiry normalization accepts `MM/YY`, `MM/YYYY` (month end),
`DD-MM-YYYY`, `DD/MM/YYYY`, Tally `YYYYMMDD`, and Excel serials. Invalid dates and
ambiguous conversions are blocking preview errors, never commit-time guesses. Money is
integer minor currency (`BigInt`/paisa).

Product stock enters the existing append-only stock ledger only as `OPENING`, once per
batch/expiry lot. A rollback compensates that movement and never deletes ledger history.
Customer and supplier records and historical sales are manifested as `CREATED`, so
rollback can remove only records created by that batch after reference checks.

Historical invoices live in `pharmacy_imported_sales` with `imported=true` and an
`importBatchId`. The table intentionally has no tender, drawer, daily-close, finance
journal, or tax-return relationship, while its customer/time indexes and analytics query
make it part of churn and win-back baselines. Retroactive loyalty defaults off. Enabling
it is an owner decision recorded append-only in `pharmacy_import_loyalty_decisions`;
awarded points are retained on each historical record.

`pharmacy:data-import` remains enforced through central `can()` for upload, preview,
commit, and rollback. The migration grants the exact capability only to pharmacy system
Owner and Manager templates; an explicit deny continues to win. Capability procedures
audit actions, and the committer boundary requires commit/rollback audit receipts.

## Decisions

- Historical sales are evidence/analytics records rather than synthetic POS sales. This
  makes accidental cash-book, close, finance, and tax posting structurally impossible.
- Imported stock never uses `RECEIPT`; there was no DevFathom purchase receipt.
- Month-only expiry means the last valid UTC day of the stated month.
- Rollback walks the manifest in reverse order and uses compensating stock movements.
- Tenant tables retain the database-generated organization default and forced RLS.

## Follow-ups

- Piece 3 should bind the concrete Prisma writer to mapping/review UI decisions and add
  database integration coverage for transaction rollback and cross-tenant RLS.
- Piece 4 should surface the owner loyalty opt-in with reason capture and show the
  resulting audit receipt before commit.
- Piece 5 should reconcile imported analytics totals with cutover reports and validate
  rollback reference blockers against all post-import operational references.
