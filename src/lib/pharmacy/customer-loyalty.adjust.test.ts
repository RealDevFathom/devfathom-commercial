import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));

import { lockCustomerConsent } from './consent-writer';
import {
  adjustLoyaltyPoints,
  listLoyaltyRedemptions,
  readLoyaltyLiability,
} from './customer-loyalty';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'manager-a' };

function fixture(balance: number | null = 30) {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    db: {
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }) },
      pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-a' }) },
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn(
          async ({ where }) =>
            created.find(
              (row) => row.idempotencyKey === where.organizationId_idempotencyKey.idempotencyKey
            ) ?? null
        ),
        aggregate: vi.fn().mockResolvedValue({ _sum: { points: balance } }),
        // No lot past expiry: every point in the balance can be spent.
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(async ({ data }) => {
          const row = { id: `adjust-${created.length}`, ...data };
          created.push(row);
          return row;
        }),
      },
    },
  };
}

const adjustment = {
  customerId: 'customer-a',
  reason: '  Missed on receipt 1042 ',
  idempotencyKey: 'key-1',
};

beforeEach(() => vi.clearAllMocks());

describe('DEV-764 manual points adjustment', () => {
  it('appends a signed ADJUSTMENT entry with its reason, under the customer lock', async () => {
    const { db, created } = fixture(30);
    const result = await adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: 25 });
    expect(result).toMatchObject({ balanceBefore: 30, balanceAfter: 55, replayed: false });
    expect(created).toEqual([
      {
        id: 'adjust-0',
        organizationId: 'org-a',
        branchId: 'branch-a',
        customerId: 'customer-a',
        kind: 'ADJUSTMENT',
        points: 25,
        reason: 'Missed on receipt 1042',
        actorId: 'manager-a',
        idempotencyKey: 'loyalty:adjust:key-1',
      },
    ]);
    expect(lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(vi.mocked(lockCustomerConsent).mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyLoyaltyPointsEntry.aggregate.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' },
      _sum: { points: true },
    });
  });

  it('removes points but never below zero', async () => {
    const { db, created } = fixture(30);
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: -30 })
    ).resolves.toMatchObject({ balanceAfter: 0 });
    const short = fixture(30);
    await expect(
      adjustLoyaltyPoints(short.db as never, scope, { ...adjustment, points: -31 })
    ).rejects.toThrow('ADJUSTMENT_EXCEEDS_BALANCE');
    expect(short.created).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it.each([
    { points: 0, reason: 'Valid reason' },
    { points: 1.5, reason: 'Valid reason' },
    { points: 1_000_001, reason: 'Valid reason' },
    { points: 5, reason: '  ab ' },
    { points: 5, reason: 'x'.repeat(501) },
  ])('refuses %j before any read or write', async (input) => {
    const { db, created } = fixture();
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, ...input })
    ).rejects.toThrow('INVALID_ADJUSTMENT');
    expect(db.pharmacyCustomer.findFirst).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('refuses a customer outside this tenant before locking', async () => {
    const { db } = fixture();
    db.pharmacyCustomer.findFirst.mockResolvedValue(null);
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: 5 })
    ).rejects.toThrow('CUSTOMER_NOT_FOUND');
    expect(db.pharmacyCustomer.findFirst).toHaveBeenCalledWith({
      where: { id: 'customer-a', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    expect(lockCustomerConsent).not.toHaveBeenCalled();
  });

  it('records a replay once and refuses the same key with different details', async () => {
    const { db, created } = fixture(30);
    await adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: 5 });
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: 5 })
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: 6 })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(created).toHaveLength(1);
  });
});

describe('DEV-764 liability and redemption history', () => {
  it('values every positive branch balance at the current redemption value', async () => {
    const db = {
      pharmacyLoyaltyPointsEntry: {
        groupBy: vi.fn().mockResolvedValue([
          { branchId: 'branch-b', customerId: 'c1', _sum: { points: 40 } },
          { branchId: 'branch-a', customerId: 'c1', _sum: { points: 100 } },
          { branchId: 'branch-a', customerId: 'c2', _sum: { points: 0 } },
          { branchId: 'branch-a', customerId: 'c3', _sum: { points: -5 } },
        ]),
      },
      pharmacyLoyaltyProgramVersion: {
        findFirst: vi.fn().mockResolvedValue({ id: 'program-3', redemptionValueMinor: 250 }),
      },
    };
    expect(await readLoyaltyLiability(db as never, 'org-a')).toEqual({
      pointValueMinor: 250,
      points: 140,
      customers: 2,
      liabilityMinor: 35_000,
      branches: [
        { branchId: 'branch-a', points: 100, customers: 1, liabilityMinor: 25_000 },
        { branchId: 'branch-b', points: 40, customers: 1, liabilityMinor: 10_000 },
      ],
    });
    expect(db.pharmacyLoyaltyPointsEntry.groupBy).toHaveBeenCalledWith({
      by: ['branchId', 'customerId'],
      where: { organizationId: 'org-a' },
      _sum: { points: true },
    });
  });

  it('values points at PKR 1 each before an owner sets a redemption value', async () => {
    const db = {
      pharmacyLoyaltyPointsEntry: {
        groupBy: vi
          .fn()
          .mockResolvedValue([{ branchId: 'branch-a', customerId: 'c1', _sum: { points: 7 } }]),
      },
      pharmacyLoyaltyProgramVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    expect(await readLoyaltyLiability(db as never, 'org-a')).toMatchObject({
      pointValueMinor: 100,
      liabilityMinor: 700,
    });
  });

  it('lists branch redemptions with their value and the points given back', async () => {
    const db = {
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }) },
      pharmacyLoyaltyPointsEntry: {
        count: vi.fn().mockResolvedValue(2),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'redeem-b',
            points: -20,
            occurredAt: new Date('2026-11-14T10:00:00Z'),
            tenderId: 'tender-b',
            customer: { id: 'c1', displayName: 'Retail customer' },
            sale: { id: 'sale-b', receiptNumber: null, status: 'VOID' },
            tender: { amountMinor: 2_000 },
          },
          {
            id: 'redeem-a',
            points: -5,
            occurredAt: new Date('2026-11-13T10:00:00Z'),
            tenderId: 'tender-a',
            customer: { id: 'c2', displayName: 'Other customer' },
            sale: { id: 'sale-a', receiptNumber: 41, status: 'COMPLETED' },
            tender: { amountMinor: 500 },
          },
        ]),
        groupBy: vi.fn().mockResolvedValue([{ tenderId: 'tender-b', _sum: { points: 20 } }]),
      },
    };
    const result = await listLoyaltyRedemptions(db as never, scope, 1);
    expect(result.redemptions).toEqual([
      expect.objectContaining({
        id: 'redeem-b',
        points: 20,
        amountMinor: 2_000,
        pointsReturned: 20,
        saleVoided: true,
        receiptNumber: null,
      }),
      expect.objectContaining({
        id: 'redeem-a',
        points: 5,
        amountMinor: 500,
        pointsReturned: 0,
        saleVoided: false,
        receiptNumber: 41,
      }),
    ]);
    expect(db.pharmacyLoyaltyPointsEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', branchId: 'branch-a', kind: 'REDEEM' },
      })
    );
    expect(db.pharmacyLoyaltyPointsEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          tenderId: { in: ['tender-b', 'tender-a'] },
          kind: { in: ['REFUND', 'REDEMPTION_RELEASE'] },
        },
      })
    );
  });
});

describe('DEV-764 a removal cannot take points already past expiry', () => {
  it('counts only points that can still be spent', async () => {
    const { db, created } = fixture(30);
    // 20 of the 30 points sit in a lot already past expiry, not yet swept.
    db.pharmacyLoyaltyPointsEntry.count.mockResolvedValue(1);
    Object.assign(db.pharmacyLoyaltyPointsEntry, {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'earn-old',
          kind: 'EARN',
          points: 20,
          saleId: 'sale-old',
          tenderId: null,
          programVersionId: 'program-1',
          reversesEntryId: null,
          expiresAt: new Date(Date.now() - 86_400_000),
          occurredAt: new Date(Date.now() - 40 * 86_400_000),
        },
        {
          id: 'earn-new',
          kind: 'EARN',
          points: 10,
          saleId: 'sale-new',
          tenderId: null,
          programVersionId: 'program-1',
          reversesEntryId: null,
          expiresAt: null,
          occurredAt: new Date(Date.now() - 86_400_000),
        },
      ]),
    });
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: -11 })
    ).rejects.toThrow('ADJUSTMENT_EXCEEDS_BALANCE');
    await expect(
      adjustLoyaltyPoints(db as never, scope, { ...adjustment, points: -10 })
    ).resolves.toMatchObject({ balanceAfter: 20 });
    expect(created).toHaveLength(1);
  });
});
