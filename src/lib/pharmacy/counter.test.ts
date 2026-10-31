import { describe, expect, it, vi } from 'vitest';

import { readCounterCart, renderStrengthValue } from './counter';

it('returns ordered, allowlisted tender rows from the tenant and branch scoped cart', async () => {
  const findFirst = vi.fn().mockResolvedValue({
    id: 'sale-a',
    status: 'OPEN',
    receiptNumber: null,
    lines: [],
    tenders: [
      { id: 'cash-a', type: 'CASH', amountMinor: 60000, actorId: 'private-actor' },
      { id: 'credit-a', type: 'CREDIT', amountMinor: 40000, providerRef: 'private-reference' },
    ],
  });
  const cart = await readCounterCart(
    { pharmacySale: { findFirst } } as never,
    { organizationId: 'org-a', branchId: 'branch-a' },
    'sale-a'
  );
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'sale-a', organizationId: 'org-a', branchId: 'branch-a' },
      include: expect.objectContaining({
        tenders: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      }),
    })
  );
  expect(cart.tenders).toEqual([
    { tenderId: 'cash-a', type: 'CASH', amountMinor: 60000 },
    { tenderId: 'credit-a', type: 'CREDIT', amountMinor: 40000 },
  ]);
  expect(cart.totals.tenderedMinor).toBe(100000);
});

describe('renderStrengthValue (POS-02 strength display)', () => {
  it('never trims a trailing zero that carries magnitude', () => {
    // The defect this guards: a positional trailing-zero trim turns 500 into 5,
    // a hundredfold strength error on the field a pharmacist reads back.
    expect(renderStrengthValue('500')).toBe('500');
    expect(renderStrengthValue('50')).toBe('50');
    expect(renderStrengthValue('1000')).toBe('1000');
    expect(renderStrengthValue(500)).toBe('500');
  });

  it('trims only fractional trailing zeros, as a Decimal renders them', () => {
    expect(renderStrengthValue('500.000000')).toBe('500');
    expect(renderStrengthValue('2.500000')).toBe('2.5');
    expect(renderStrengthValue('0.125000')).toBe('0.125');
    expect(renderStrengthValue('10.00')).toBe('10');
  });

  it('leaves a value with no trailing zeros untouched', () => {
    expect(renderStrengthValue('2.5')).toBe('2.5');
    expect(renderStrengthValue('125')).toBe('125');
  });
});
