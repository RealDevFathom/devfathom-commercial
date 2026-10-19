import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isDemoTenant: vi.fn() }));
vi.mock('@/lib/demo/isolation', () => ({ isDemoTenant: mocks.isDemoTenant }));
vi.mock('@/lib/restaurant/bills', () => ({}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({}));
vi.mock('@/lib/restaurant/daily-close', () => ({}));
vi.mock('@/lib/restaurant/delivery', () => ({}));
vi.mock('@/lib/restaurant/devices', () => ({}));
vi.mock('@/lib/restaurant/drawer-sessions', () => ({}));
vi.mock('@/lib/restaurant/orders', () => ({}));
vi.mock('@/lib/restaurant/refunds', () => ({}));
vi.mock('@/lib/restaurant/tax-publication', () => ({}));
vi.mock('@/lib/restaurant/tenders', () => ({}));
vi.mock('@/server/routers/restaurant-menus', () => ({ restaurantMenusRouter: {} }));

import { safeDemoCardAmount, seedDemoRestaurantHistory } from './seed-history';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import type { DemoRestaurantSeed } from './seed-data';
import type { DemoRestaurantCatalogIds } from './seed-catalog';
import type { DemoRestaurantOperationsIds } from './seed-operations';

describe('history tax fixture tenant guard', () => {
  it.each([
    ['wrong seat', 'org_demo_restaurant_seat_2', true, true],
    ['production organization', 'org_demo_restaurant_seat_1', false, true],
    ['RLS scope does not resolve a demo tenant', 'org_demo_restaurant_seat_1', true, false],
  ])('rejects %s before publishing history', async (_label, id, isDemo, tenantIsDemo) => {
    const findMany = vi.fn();
    const db = { restaurantBranchMenuPublication: { findMany } } as unknown as ScopedDb;
    mocks.isDemoTenant.mockResolvedValue(tenantIsDemo);
    await expect(
      seedDemoRestaurantHistory(
        db,
        { identity: { organizationId: 'org_demo_restaurant_seat_1' } } as DemoRestaurantSeed,
        {} as DemoRestaurantCatalogIds,
        { db, organization: { id, isDemo } } as TRPCContext,
        {
          managerStaffProfileId: 'manager',
          approverStaffProfileId: 'approver',
        } as DemoRestaurantOperationsIds
      )
    ).rejects.toThrow(
      'History fixture tax profiles may only be published for the active demo tenant.'
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('safeDemoCardAmount', () => {
  it('keeps safe card amounts and moves MOCK decline cents to cash', () => {
    expect(safeDemoCardAmount(new Prisma.Decimal('1250.00'))?.toString()).toBe('1250');
    expect(safeDemoCardAmount(new Prisma.Decimal('1250.12'))?.toString()).toBe('1250.12');

    for (const cents of ['13', '51', '54']) {
      expect(safeDemoCardAmount(new Prisma.Decimal(`1250.${cents}`))?.toString()).toBe('1250');
      expect(safeDemoCardAmount(new Prisma.Decimal(`0.${cents}`))).toBeNull();
    }
  });
});
