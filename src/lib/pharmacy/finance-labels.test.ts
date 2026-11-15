import { describe, expect, it } from 'vitest';
import { financeSourceLabel, journalEntryTitle, tenderTypeLabel } from './finance-labels';

describe('finance labels', () => {
  it('titles refunds and payments by payment method instead of tender id', () => {
    expect(
      journalEntryTitle({
        sourceKind: 'PHARMACY_REFUND',
        description: 'Refund of tender cmvz1abcdefghijklmnopqrst',
        tenderType: 'CASH',
      })
    ).toBe('Refund · Cash');
    expect(
      journalEntryTitle({
        sourceKind: 'PHARMACY_TENDER',
        description: 'Pharmacy tender cmvz1abcdefghijklmnopqrst',
        tenderType: 'BANK_TRANSFER',
      })
    ).toBe('Payment · Bank transfer');
  });

  it('falls back to the source kind when a stored description is only a raw id', () => {
    expect(
      journalEntryTitle({
        sourceKind: 'PHARMACY_SALE_LINE',
        description: 'Sale line cmvz1abcdefghijklmnopqrst',
      })
    ).toBe('Sale');
    expect(
      journalEntryTitle({
        sourceKind: 'PHARMACY_GOODS_RECEIPT',
        description: 'Goods receipt GRN-7',
      })
    ).toBe('Goods receipt GRN-7');
  });

  it('keeps unknown codes readable', () => {
    expect(financeSourceLabel('PHARMACY_NEW_THING')).toBe('New thing');
    expect(tenderTypeLabel('CREDIT')).toBe('Khata');
    expect(tenderTypeLabel('SOMETHING_ELSE')).toBe('Something else');
  });
});
