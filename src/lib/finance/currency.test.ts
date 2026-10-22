import { describe, expect, it } from 'vitest';

import { moneyLabel, moneyListLabel, sumByCurrency } from './currency';

describe('moneyLabel', () => {
  it('labels PKR amounts in rupees', () => {
    expect(moneyLabel(125000, 'PKR')).toBe('Rs 125,000');
  });

  it('labels USD amounts in dollars', () => {
    expect(moneyLabel(125000, 'USD')).toBe('$125,000');
  });
});

describe('per-currency client totals', () => {
  it('combines like currencies without adding unlike currencies together', () => {
    const totals = sumByCurrency([
      { currency: 'USD', amount: 100 },
      { currency: 'PKR', amount: 100 },
      { currency: 'USD', amount: 25 },
    ]);

    expect(totals).toEqual([
      { currency: 'USD', amount: 125 },
      { currency: 'PKR', amount: 100 },
    ]);
    expect(moneyListLabel(totals)).toBe('$125 · Rs 100');
  });
});
