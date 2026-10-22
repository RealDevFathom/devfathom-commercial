import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => mocks);

import { collectTenantCustomerMetrics, runNightlyCustomerMetrics } from './nightly-customer-metrics';

describe('nightly customer metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not aggregate when the tenant has not opted in', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), $executeRaw: vi.fn() };
    await expect(
      collectTenantCustomerMetrics(db as never, {
        organizationId: 'org_a',
        vertical: 'RESTAURANT',
      })
    ).resolves.toBe(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('narrows every eligible organization into its own tenant transaction', async () => {
    mocks.withPlatformDb.mockImplementation((run) =>
      run({
        $queryRaw: vi.fn().mockResolvedValue([
          { organizationId: 'org_a', vertical: 'RESTAURANT' },
          { organizationId: 'org_b', vertical: 'PHARMACY' },
        ]),
      })
    );
    mocks.withTenantDb.mockImplementation(async (id, run) => {
      expect(['org_a', 'org_b']).toContain(id);
      await run({});
      return 1;
    });
    await expect(runNightlyCustomerMetrics()).resolves.toEqual({ tenants: 2, rows: 2 });
    expect(mocks.withTenantDb).toHaveBeenNthCalledWith(1, 'org_a', expect.any(Function), {
      skipDrain: true,
    });
    expect(mocks.withTenantDb).toHaveBeenNthCalledWith(2, 'org_b', expect.any(Function), {
      skipDrain: true,
    });
  });
});
