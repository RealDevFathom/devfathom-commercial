import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { enforceConcurrentRegisterLimit } from './drawer-sessions';
import { enforceMonthlyOrderLimit } from './orders';

function limitDb(counts: number[]) {
  const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]);
  const orderCount = vi.fn().mockImplementation(async () => counts.shift() ?? 0);
  const drawerCount = vi.fn().mockImplementation(async () => counts.shift() ?? 0);
  return {
    db: {
      $queryRaw: queryRaw,
      restaurantOrder: { count: orderCount },
      restaurantDrawerSession: { count: drawerCount },
    } as unknown as ScopedDb,
    queryRaw,
    orderCount,
    drawerCount,
  };
}

type FailClosedCase = {
  limits: Readonly<Record<string, number>>;
  reason: 'LIMIT_UNAVAILABLE' | 'LIMIT_REACHED';
};

const monthlyFailClosedCases: FailClosedCase[] = [
  { limits: {}, reason: 'LIMIT_UNAVAILABLE' },
  { limits: { 'pos.orders.monthly': -1 }, reason: 'LIMIT_UNAVAILABLE' },
  { limits: { 'pos.orders.monthly': 0 }, reason: 'LIMIT_REACHED' },
];

const registerFailClosedCases: FailClosedCase[] = [
  { limits: {}, reason: 'LIMIT_UNAVAILABLE' },
  { limits: { 'pos.concurrentRegisters.max': 1.5 }, reason: 'LIMIT_UNAVAILABLE' },
  { limits: { 'pos.concurrentRegisters.max': 0 }, reason: 'LIMIT_REACHED' },
];

describe('restaurant consuming entitlement limits', () => {
  it.each([
    { used: 1, max: 2, denied: false, label: 'below' },
    { used: 2, max: 2, denied: true, label: 'exact' },
    { used: 3, max: 2, denied: true, label: 'over' },
  ])('enforces monthly orders when usage is $label the ceiling', async ({ used, max, denied }) => {
    const { db, queryRaw, orderCount } = limitDb([used]);
    const check = enforceMonthlyOrderLimit(
      db,
      { organizationId: 'org-a', entitlementLimits: { 'pos.orders.monthly': max } },
      new Date('2026-09-30T00:00:00.000Z')
    );

    if (denied) await expect(check).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    else await expect(check).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledBefore(orderCount);
    expect(orderCount).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        businessDate: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lt: new Date('2026-10-01T00:00:00.000Z'),
        },
      },
    });
  });

  it.each(monthlyFailClosedCases)(
    'fails closed for missing, invalid, and zero monthly limits',
    async ({ limits, reason }) => {
      const { db, queryRaw, orderCount } = limitDb([0]);
      await expect(
        enforceMonthlyOrderLimit(
          db,
          { organizationId: 'org-a', entitlementLimits: limits },
          new Date('2026-10-01T00:00:00.000Z')
        )
      ).rejects.toMatchObject({ reason });
      expect(queryRaw).not.toHaveBeenCalled();
      expect(orderCount).not.toHaveBeenCalled();
    }
  );

  it('counts cancelled orders and every branch by organization and persisted business date', async () => {
    const { db, orderCount } = limitDb([0]);
    await enforceMonthlyOrderLimit(
      db,
      { organizationId: 'org-b', entitlementLimits: { 'pos.orders.monthly': 5 } },
      new Date('2027-01-01T00:00:00.000Z')
    );
    const where = orderCount.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      organizationId: 'org-b',
      businessDate: {
        gte: new Date('2027-01-01T00:00:00.000Z'),
        lt: new Date('2027-02-01T00:00:00.000Z'),
      },
    });
    expect(where).not.toHaveProperty('branchId');
    expect(where).not.toHaveProperty('status');
  });

  it('releases concurrent capacity after close and keeps the count tenant-isolated', async () => {
    const { db, queryRaw, drawerCount } = limitDb([1, 0]);
    const input = {
      organizationId: 'org-a',
      entitlementLimits: { 'pos.concurrentRegisters.max': 1 },
    };
    await expect(enforceConcurrentRegisterLimit(db, input)).rejects.toMatchObject({
      reason: 'LIMIT_REACHED',
    });
    await expect(enforceConcurrentRegisterLimit(db, input)).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(drawerCount).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', status: 'OPEN' },
    });
  });

  it.each(registerFailClosedCases)(
    'fails closed before any register-session write',
    async ({ limits, reason }) => {
      const { db, queryRaw, drawerCount } = limitDb([0]);
      await expect(
        enforceConcurrentRegisterLimit(db, {
          organizationId: 'org-a',
          entitlementLimits: limits,
        })
      ).rejects.toMatchObject({ reason });
      expect(queryRaw).not.toHaveBeenCalled();
      expect(drawerCount).not.toHaveBeenCalled();
    }
  );
});
