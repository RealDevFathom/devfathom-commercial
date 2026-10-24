import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/bills', () => ({ compLine: vi.fn() }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  compBody: {},
  moneyMutationRoute: (configuration: unknown) => configuration,
  requireBillInDeviceBranch: vi.fn(),
  resolveApprover: vi.fn(),
}));

import { POST } from './route';

describe('checkout comp route authorization', () => {
  it('gates the acting operator on orders:complimentary', () => {
    expect(POST).toMatchObject({ capability: 'orders:complimentary' });
  });
});
