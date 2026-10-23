# Fix #623 — pharmacy journal production wiring

## Evidence

- Goods-receipt posting changes the receipt to `POSTED`, then invokes
  `postGoodsReceiptEntry` with the same scoped transaction handle
  (`src/lib/pharmacy/goods-receipt.ts:335-358`). Receipt reversal similarly
  changes the business status and invokes the additive journal reversal before
  returning (`src/lib/pharmacy/goods-receipt.ts:508-523`).
- Count approval writes all stock adjustments, marks the count `APPROVED`, and
  posts each count line before returning (`src/lib/pharmacy/inventory-operations.ts:119-155`).
- Transfer dispatch writes the stock movements, marks the transfer
  `DISPATCHED`, and posts every transfer line before returning
  (`src/lib/pharmacy/inventory-operations.ts:351-414`).
- Opening-stock posting creates its authoritative opening total and immediately
  journals any positive valuation (`src/lib/pharmacy/migration/opening-stock.ts:415-432`).
  Opening-ledger balances are now created individually and each non-zero row is
  journalled before the next row, all through the caller's single database
  handle (`src/lib/pharmacy/migration/opening-stock.ts:446-486`).
- The live GRN/reversal and count/dispatch procedures already wrap these domain
  functions in interactive transactions
  (`src/server/routers/pharmacy-purchasing.ts:1153-1161`,
  `src/server/routers/pharmacy-purchasing.ts:1200-1207`,
  `src/server/routers/pharmacy-inventory.ts:1006-1015`, and
  `src/server/routers/pharmacy-inventory.ts:1119-1128`). Consequently a journal
  failure rolls back the associated inventory/status write.
- Journal adapter idempotency remains derived from source kind plus immutable
  source row id (`src/lib/pharmacy/finance-postings.ts:45-48`, with adapter uses
  at `src/lib/pharmacy/finance-postings.ts:150-151`, `:605-606`, `:678-679`,
  `:836-837`, `:874-875`, and reversal at `:912`).
- The regression suite traces every production call and its transaction wrapper
  (`src/lib/pharmacy/finance-postings-wiring.test.ts:1-50`).

## Deliberately unchanged

- No authorization surface was added or bypassed. Existing router capability
  procedures and central `can()`-backed policy remain the mutation gates.
- No tenant or branch identifiers come from the new calls; every adapter gets
  the existing session-derived scope and scoped database handle.
- No WhatsApp or other outbound messaging path was changed.
- No schema change was necessary, so no migration was added.

## Checks skipped by request

Per the task constraint (Bun 1.2.14, no database, npm returning 403), dependency
installation and all test/typecheck/lint commands were intentionally not run.
Only repository-local static checks (`git diff --check` and source inspection)
were performed. The requested initial fetch/merge was attempted, but this
checkout has no configured `origin`; the current `HEAD` was already `08a247c1`.
