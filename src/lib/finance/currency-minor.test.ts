import { describe, expect, it } from 'vitest';
import { moneyMinorListLabel } from './currency';

describe('moneyMinorListLabel', () => {
  it('uses the tenant PKR label for an empty revenue total', () => {
    expect(moneyMinorListLabel([], 'PKR')).toBe('Rs 0');
  });

  it('formats integer PKR minor units as major units', () => {
    expect(moneyMinorListLabel([{ currency: 'PKR', amountMinor: 125_050 }])).toBe(
      'Rs 1,250.5'
    );
  });
});
