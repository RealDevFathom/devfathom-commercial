import { describe, expect, it } from 'vitest';

import { loyaltyReceiptLines } from './loyalty-receipt';

describe('loyaltyReceiptLines', () => {
  it('omits the wallet when the bill has no customer', () => {
    expect(loyaltyReceiptLines(null)).toEqual([]);
    expect(loyaltyReceiptLines(undefined)).toEqual([]);
  });

  it('prints the wallet balance and points earned on this sale', () => {
    expect(
      loyaltyReceiptLines({
        pointsBalance: 128,
        pointsEarned: 12,
        pointsPerPkr: '1',
        balancePkr: '64.00',
      })
    ).toEqual(['Loyalty balance 128 points / PKR 64.00', 'Loyalty earned 12 points']);
  });

  it('prints a zero balance without an earn line', () => {
    expect(
      loyaltyReceiptLines({
        pointsBalance: 0,
        pointsEarned: 0,
        pointsPerPkr: '1',
        balancePkr: '0.00',
      })
    ).toEqual(['Loyalty balance 0 points / PKR 0.00']);
  });
});
