import { describe, expect, it } from 'vitest';
import { PharmacyTenderType } from '@/generated/prisma/client';
import { pharmacyRefundTenderLabel, pharmacyTenderLabel } from './tender-labels';

describe('pharmacy tender names', () => {
  it.each(Object.values(PharmacyTenderType))('gives %s a plain name', (type) => {
    const label = pharmacyTenderLabel(type);
    expect(label).toBeTruthy();
    expect(label).not.toContain('_');
    expect(label).not.toBe(type);
  });

  it('never echoes unknown codes or IDs', () => {
    expect(pharmacyTenderLabel('cmvz0internal')).toBeNull();
    expect(pharmacyTenderLabel(undefined)).toBeNull();
  });

  it('names a drawer refund as cash and otherwise follows the original tender', () => {
    expect(
      pharmacyRefundTenderLabel({ drawerSessionId: 'drawer', originalTender: { type: 'CARD' } })
    ).toBe('Cash');
    expect(
      pharmacyRefundTenderLabel({ drawerSessionId: null, originalTender: { type: 'JAZZCASH' } })
    ).toBe('JazzCash');
  });
});
