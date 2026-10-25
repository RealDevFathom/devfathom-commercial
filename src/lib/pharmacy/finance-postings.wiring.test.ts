import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Regression for #623. These assertions deliberately trace the production
 * services rather than the adapters: an adapter-only test stayed green while
 * stock operations changed inventory without ever invoking it.
 */
describe('pharmacy finance posting production wiring', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('posts and reverses goods receipts in the receiving service', () => {
    const receiving = source('./goods-receipt.ts');
    expect(receiving).toContain('await postGoodsReceiptEntry(db, scope');
    expect(receiving).toContain('await reversePostingForSource(db, scope');
  });

  it('posts approved counts and dispatched transfers in the inventory service', () => {
    const inventory = source('./inventory-operations.ts');
    expect(inventory).toContain('await postCountAdjustmentEntry(db, scope');
    expect(inventory).toContain('await postInterbranchTransferEntry(db, scope');
  });

  it('posts opening stock and opening ledger balances in the migration service', () => {
    const opening = source('./migration/opening-stock.ts');
    expect(opening).toContain('await postOpeningStockEntry(db, scope');
    expect(opening).toContain('await postOpeningLedgerEntry(db, scope');
  });
});
