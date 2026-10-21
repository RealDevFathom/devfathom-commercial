import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { getLoyaltySummary } from './loyalty';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
  };
}

function scoped(db: Record<string, Delegate>) {
  return db as unknown as ScopedDb;
}

describe('getLoyaltySummary', () => {
  const db = {
    restaurantCustomer: model(),
    loyaltyPointsEntry: model(),
    loyaltyProgramVersion: model(),
  };

  beforeEach(() => {
    db.restaurantCustomer.findUnique.mockReset().mockResolvedValue(null);
    db.loyaltyPointsEntry.aggregate.mockReset().mockResolvedValue({ _sum: { points: null } });
    db.loyaltyProgramVersion.findFirst.mockReset().mockResolvedValue(null);
  });

  it('returns null when the customer is not in this tenant', async () => {
    await expect(getLoyaltySummary(scoped(db), 'missing')).resolves.toBeNull();
  });

  it('prices an enrolled wallet at the current points-per-PKR program', async () => {
    db.restaurantCustomer.findUnique.mockResolvedValue({
      id: 'customer_1',
      loyaltyAccount: { id: 'account_1', active: true },
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: 128 } });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      earnRate: new Prisma.Decimal('1'),
      redemptionValue: new Prisma.Decimal('0.5'),
    });

    await expect(getLoyaltySummary(scoped(db), 'customer_1')).resolves.toEqual({
      customerId: 'customer_1',
      accountId: 'account_1',
      active: true,
      pointsBalance: 128,
      pointsPerPkr: '1',
      redemptionValuePerPoint: '0.5',
      balancePkr: '64.00',
    });
  });

  it('keeps a zero wallet for a guest who is not enrolled', async () => {
    db.restaurantCustomer.findUnique.mockResolvedValue({
      id: 'customer_1',
      loyaltyAccount: null,
    });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      earnRate: new Prisma.Decimal('1'),
      redemptionValue: new Prisma.Decimal('0.5'),
    });

    await expect(getLoyaltySummary(scoped(db), 'customer_1')).resolves.toEqual({
      customerId: 'customer_1',
      accountId: null,
      active: false,
      pointsBalance: 0,
      pointsPerPkr: '1',
      redemptionValuePerPoint: '0.5',
      balancePkr: '0.00',
    });
    expect(db.loyaltyPointsEntry.aggregate).not.toHaveBeenCalled();
  });

  it('reports a wallet with no earn rate when the tenant has no program', async () => {
    db.restaurantCustomer.findUnique.mockResolvedValue({
      id: 'customer_1',
      loyaltyAccount: { id: 'account_1', active: true },
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: 4 } });

    await expect(getLoyaltySummary(scoped(db), 'customer_1')).resolves.toEqual({
      customerId: 'customer_1',
      accountId: 'account_1',
      active: true,
      pointsBalance: 4,
      pointsPerPkr: null,
      redemptionValuePerPoint: null,
      balancePkr: '0.00',
    });
  });
});
