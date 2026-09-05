import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/demo/isolation', () => ({}));
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

import { safeDemoCardAmount } from './seed-history';

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
