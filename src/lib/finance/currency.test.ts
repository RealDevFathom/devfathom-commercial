import { describe, expect, it } from 'vitest';

import { moneyLabel } from './currency';

describe('moneyLabel', () => {
  it('labels PKR amounts in rupees', () => {
    expect(moneyLabel(125000, 'PKR')).toBe('Rs 125,000');
  });

  it('labels USD amounts in dollars', () => {
    expect(moneyLabel(125000, 'USD')).toBe('$125,000');
  });
});
