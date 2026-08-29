import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  enabledModules: ['restaurant-loyalty'] as string[],
  identifier: null as null | {
    customerId: string;
    customer: { loyaltyAccount: null | { id: string; active: boolean } };
  },
}));

const db = {
  customerIdentifier: { findFirst: vi.fn(async () => h.identifier) },
  loyaltyPointsEntry: { aggregate: vi.fn(async () => ({ _sum: { points: 240 } })) },
};

vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async () => ({ enabledModules: h.enabledModules }),
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
}));

vi.mock('./checkout-routes', () => ({
  operatorHasCapability: async () => true,
}));

vi.mock('./terminal-auth', () => ({
  withTerminalAuth:
    (handler: (ctx: unknown, request: Request) => Promise<Response>) => (request: Request) =>
      handler(
        {
          organizationId: 'org1',
          device: { branchId: 'branch1' },
          state: { activeStaffProfileId: 'staff1' },
          db,
        },
        request
      ),
}));

vi.mock('./terminal-orders', async (importOriginal) => {
  const original = await importOriginal<typeof import('./terminal-orders')>();
  return {
    ...original,
    requireActingOperator: () => ({ ok: true, staffProfileId: 'staff1' }),
  };
});

import { GET } from '@/app/api/restaurant/orders/customer/by-wallet/route';

const alias = `wla_${'0'.repeat(26)}`;
const request = (code: string) =>
  new Request(`https://tenant.test/api/restaurant/orders/customer/by-wallet?code=${code}`);

beforeEach(() => {
  h.enabledModules = ['restaurant-loyalty'];
  h.identifier = null;
  vi.clearAllMocks();
});

describe('GET by-wallet transport contract', () => {
  it('rejects an unlicensed terminal before alias lookup', async () => {
    h.enabledModules = [];
    const response = await GET(request(`DFW1:${alias}`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'The loyalty module is not enabled for this organization.',
    });
    expect(db.customerIdentifier.findFirst).not.toHaveBeenCalled();
  });

  it('returns the same generic 404 for every unresolved valid alias', async () => {
    const first = await GET(request(`DFW1:${alias}`));
    const second = await GET(request(`DFW1:wla_${'1'.repeat(26)}`));

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.text()).toBe(await second.text());
  });

  it('returns only the redemption-required ids and loyalty facts', async () => {
    h.identifier = {
      customerId: 'c1',
      customer: { loyaltyAccount: { id: 'la1', active: true } },
    };
    const response = await GET(request(`DFW1:${alias}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      customerId: 'c1',
      loyalty: { accountId: 'la1', accountActive: true, balance: 240 },
    });
  });

  it('rejects enrollment URLs before any database lookup', async () => {
    const response = await GET(request(encodeURIComponent(`https://wallet.test/${alias}`)));

    expect(response.status).toBe(400);
    expect(db.customerIdentifier.findFirst).not.toHaveBeenCalled();
  });
});
