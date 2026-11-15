import { describe, expect, it } from 'vitest';
import { batchLabel, tenderTypeLabel } from './finance-labels';

describe('finance labels', () => {
  it('names payment methods like the counter receipt', () => {
    expect(tenderTypeLabel('CASH')).toBe('Cash');
    expect(tenderTypeLabel('BANK_TRANSFER')).toBe('Bank transfer');
    expect(tenderTypeLabel('CREDIT')).toBe('Khata');
    expect(tenderTypeLabel('SOMETHING_ELSE')).toBe('Something else');
  });

  it('names batches by medicine and batch number', () => {
    expect(batchLabel({ batchNumber: 'B12', medicineName: 'Panadol' })).toBe('Panadol · batch B12');
    expect(batchLabel({ batchNumber: 'B12' })).toBe('Batch B12');
  });
});
