/**
 * Regression guard for #623. The defect was architectural (the adapters were
 * tested but had no production callers), so this test deliberately traces the
 * production source and verifies each business write reaches its adapter after
 * the state transition that makes the adapter eligible to post.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

function expectOrdered(text: string, before: string, after: string) {
  expect(text.indexOf(before)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(after)).toBeGreaterThan(text.indexOf(before));
}

describe('pharmacy finance production wiring (#623)', () => {
  it('posts and reverses a GRN after its business status write', () => {
    const text = source('src/lib/pharmacy/goods-receipt.ts');
    expectOrdered(text, "data: { status: 'POSTED', postedAt: input.at }", 'postGoodsReceiptEntry(');
    expectOrdered(text, "status: 'REVERSED'", 'reversePostingForSource(');
  });

  it('posts every approved count line and dispatched transfer line', () => {
    const text = source('src/lib/pharmacy/inventory-operations.ts');
    expectOrdered(text, "data: { status: 'APPROVED'", 'postCountAdjustmentEntry(');
    expectOrdered(text, "data: { status: 'DISPATCHED'", 'postInterbranchTransferEntry(');
    expect(text).toMatch(/for \(const line of count\.lines\)[\s\S]*postCountAdjustmentEntry/);
    expect(text).toMatch(/for \(const line of transfer\.lines\)[\s\S]*postInterbranchTransferEntry/);
  });

  it('posts opening stock and each non-zero opening ledger row', () => {
    const text = source('src/lib/pharmacy/migration/opening-stock.ts');
    expectOrdered(text, 'pharmacyOpeningTotal.create(', 'postOpeningStockEntry(');
    expectOrdered(text, 'pharmacyOpeningLedgerEntry.create(', 'postOpeningLedgerEntry(');
    expect(text).toContain('if (balance.balanceMinor !== BigInt(0))');
  });

  it('keeps all wired mutations inside their existing router transactions', () => {
    const purchasing = source('src/server/routers/pharmacy-purchasing.ts');
    const inventory = source('src/server/routers/pharmacy-inventory.ts');
    expect(purchasing).toMatch(/\$transaction\(\(tx\) =>\s*postGoodsReceipt\(txDb\(tx\)/);
    expect(purchasing).toMatch(/\$transaction\(\(tx\) =>\s*reverseGoodsReceipt\(txDb\(tx\)/);
    expect(inventory).toMatch(/\$transaction\(async \(tx\) =>\s*approveCount\(/);
    expect(inventory).toMatch(/\$transaction\(async \(tx\) =>\s*dispatchTransfer\(/);
  });
});
