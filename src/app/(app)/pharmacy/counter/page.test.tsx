import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/pharmacy/counter/counter-console', () => ({
  PharmacyCounterConsole: () => null,
}));

import PharmacyCounterPage from './page';

describe('PharmacyCounterPage', () => {
  it('passes an unambiguous bill scope to the counter', async () => {
    const result = await PharmacyCounterPage({
      searchParams: Promise.resolve({ branchId: 'branch-a', orderSaleId: 'sale-a' }),
    });

    expect(result.props).toEqual({
      initialBranchId: 'branch-a',
      initialSaleId: 'sale-a',
    });
  });

  it('fails closed for duplicate bill scope parameters', async () => {
    const result = await PharmacyCounterPage({
      searchParams: Promise.resolve({
        branchId: ['branch-allowed', 'branch-denied'],
        orderSaleId: ['sale-allowed', 'sale-denied'],
      }),
    });

    expect(result.props).toEqual({
      initialBranchId: undefined,
      initialSaleId: undefined,
    });
  });
});
