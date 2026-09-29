import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOptions: null as null | { capability: string },
  mutationOptions: null as null | { capability: string },
}));

vi.mock('@/lib/restaurant/terminal-customers', () => ({
  connectedReadRoute: (options: typeof mocks.readOptions) => {
    mocks.readOptions = options;
    return vi.fn();
  },
  connectedMutationRoute: (options: typeof mocks.mutationOptions) => {
    mocks.mutationOptions = options;
    return vi.fn();
  },
}));
vi.mock('@/lib/restaurant/terminal-loyalty', () => ({
  getLoyaltySnapshotForBranch: vi.fn(),
  loyaltyErrorResponse: vi.fn(),
  loyaltyRedeemBody: {},
  loyaltySnapshotQuery: {},
  redeemForBranch: vi.fn(),
  serializeRedeemResult: vi.fn(),
}));
vi.mock('@/lib/restaurant/terminal-orders', () => ({ invalidBody: vi.fn() }));

await import('./route');

describe('checkout loyalty route capabilities', () => {
  it('lets a cashier with customers:read read the loyalty snapshot', () => {
    expect(mocks.readOptions).toMatchObject({ capability: 'customers:read' });
  });

  it('keeps redemption gated on loyalty:redeem', () => {
    expect(mocks.mutationOptions).toMatchObject({ capability: 'loyalty:redeem' });
  });
});
