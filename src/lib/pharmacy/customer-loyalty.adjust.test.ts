import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));

import { lockCustomerConsent } from './consent-writer';
import {
  adjustLoyaltyPoints,
  listLoyaltyRedemptions,
  loyaltyAdjustmentDay,
  readLoyaltyLiability,
  restoreRefundedLoyaltyPoints,
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
        // No lot is past expiry and unswept.
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn().mockResolvedValue([]),
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

describe('DEV-764 refund restoration under the customer lock', () => {
  it('locks the customer, then expires at once points restored into a lot already expired', async () => {
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    const created: Record<string, unknown>[] = [];
    const history = [
      {
        id: 'earn-a',
        kind: 'EARN',
        points: 20,
        saleId: 'sale-old',
        tenderId: null,
        programVersionId: 'program-1',
        reversesEntryId: null,
        expiresAt: at(30),
        occurredAt: at(60),
      },
      {
        id: 'redeem-a',
        kind: 'REDEEM',
        points: -20,
        saleId: 'sale-a',
        tenderId: 'points-a',
        programVersionId: null,
        reversesEntryId: null,
        expiresAt: null,
        occurredAt: at(40),
      },
      {
        id: 'expiry-a',
        kind: 'EXPIRY',
        points: 0,
        saleId: null,
        tenderId: null,
        programVersionId: 'program-1',
        reversesEntryId: 'earn-a',
        expiresAt: null,
        occurredAt: at(30),
      },
    ];
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({ points: -20, tender: { amountMinor: 2_000 } }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
        findMany: vi.fn(async () => [
          ...history,
          ...created.map((row) => ({
            saleId: null,
            tenderId: null,
            programVersionId: null,
            reversesEntryId: null,
            expiresAt: null,
            occurredAt: at(0.001),
            ...row,
          })),
        ]),
        create: vi.fn(async ({ data }) => {
          const row = { id: `restore-${created.length}`, ...data };
          created.push(row);
          return row;
        }),
      },
      pharmacyRefund: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 2_000 } }),
      },
    };
    await restoreRefundedLoyaltyPoints(db as never, scope, {
      refundId: 'refund-a',
      tenderId: 'points-a',
      saleId: 'sale-a',
      customerId: 'customer-a',
    });
    expect(lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(vi.mocked(lockCustomerConsent).mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyLoyaltyPointsEntry.create.mock.invocationCallOrder[0]!
    );
    expect(created).toEqual([
      expect.objectContaining({ kind: 'REFUND', points: 20, tenderId: 'points-a' }),
      expect.objectContaining({
        kind: 'EXPIRY',
        points: -20,
        reversesEntryId: 'restore-0',
        idempotencyKey: 'loyalty:expiry:restore-0',
      }),
    ]);
  });
});

describe('DEV-764 liability leaves out points already past expiry', () => {
  it('subtracts points of lots past expiry the sweep has not closed yet', async () => {
    const lot = {
      id: 'earn-old',
      kind: 'EARN',
      points: 30,
      saleId: 'sale-old',
      tenderId: null,
      programVersionId: 'program-1',
      reversesEntryId: null,
      expiresAt: new Date(Date.now() - 86_400_000),
      occurredAt: new Date(Date.now() - 40 * 86_400_000),
    };
    const findMany = vi
      .fn()
      // The customers with a due, unswept lot.
      .mockResolvedValueOnce([{ branchId: 'branch-a', customerId: 'c1' }])
      // That customer's ledger, read to value the expired lot.
      .mockResolvedValueOnce([lot]);
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findMany,
        count: vi.fn().mockResolvedValue(1),
        groupBy: vi.fn().mockResolvedValue([
          { branchId: 'branch-a', customerId: 'c1', _sum: { points: 100 } },
          { branchId: 'branch-a', customerId: 'c2', _sum: { points: 10 } },
        ]),
      },
      pharmacyLoyaltyProgramVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    expect(await readLoyaltyLiability(db as never, 'org-a')).toMatchObject({
      points: 80,
      customers: 2,
      liabilityMinor: 8_000,
    });
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        organizationId: 'org-a',
        kind: { in: ['EARN', 'KHATA_EARN'] },
        closedBy: { none: { kind: 'EXPIRY' } },
      },
      distinct: ['branchId', 'customerId'],
    });
  });
});

describe('DEV-881 manager ceiling applies to the day total per customer', () => {
  // 10:00 on 17 Nov 2026 in Pakistan (05:00 UTC).
  const now = new Date('2026-11-17T05:00:00.000Z');

  /** Ledger whose aggregate reads back the entries this test has written. */
  function ledger(seed: { points: number; occurredAt: Date; customerId?: string }[] = []) {
    const { db, created } = fixture(10_000);
    created.push(
      ...seed.map((row, index) => ({
        id: `seed-${index}`,
        kind: 'ADJUSTMENT',
        organizationId: 'org-a',
        customerId: 'customer-a',
        idempotencyKey: `loyalty:adjust:seed-${index}`,
        ...row,
      }))
    );
    db.pharmacyLoyaltyPointsEntry.create.mockImplementation(async ({ data }) => {
      const row = { id: `adjust-${created.length}`, occurredAt: now, ...data };
      created.push(row);
      return row;
    });
    db.pharmacyLoyaltyPointsEntry.aggregate.mockImplementation(async ({ where }) => {
      if (where.kind !== 'ADJUSTMENT') return { _sum: { points: 10_000 } };
      const rows = created.filter(
        (row) =>
          row.kind === 'ADJUSTMENT' &&
          row.organizationId === where.organizationId &&
          row.customerId === where.customerId &&
          (row.occurredAt as Date) >= where.occurredAt.gte &&
          (row.occurredAt as Date) < where.occurredAt.lt &&
          (where.points.gt !== undefined
            ? (row.points as number) > where.points.gt
            : (row.points as number) < where.points.lt)
      );
      return {
        _sum: {
          points: rows.length ? rows.reduce((sum, row) => sum + (row.points as number), 0) : null,
        },
      };
    });
    return { db, created };
  }
  const grant = (key: string, points: number) => ({ ...adjustment, idempotencyKey: key, points });

  it('refuses a grant split into entries that are each under the ceiling', async () => {
    const { db, created } = ledger();
    const options = { managerLimit: 500, now };
    await adjustLoyaltyPoints(db as never, scope, grant('split-1', 300), options);
    await adjustLoyaltyPoints(db as never, scope, grant('split-2', 200), options);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('split-3', 1), options)
    ).rejects.toThrow('MANAGER_ADJUSTMENT_LIMIT');
    expect(created.map((row) => row.points)).toEqual([300, 200]);
  });

  it('counts removals too, and checks the total after taking the customer lock', async () => {
    const { db, created } = ledger([
      { points: 300, occurredAt: new Date('2026-11-16T19:00:00.000Z') }, // 00:00 PKT today
      { points: -150, occurredAt: now },
    ]);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('after-removal', 51), {
        managerLimit: 500,
        now,
      })
    ).rejects.toThrow('MANAGER_ADJUSTMENT_LIMIT');
    expect(created).toHaveLength(2);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('after-removal-2', 50), {
        managerLimit: 500,
        now,
      })
    ).resolves.toMatchObject({ replayed: false });
    expect(vi.mocked(lockCustomerConsent).mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyLoyaltyPointsEntry.aggregate.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        customerId: 'customer-a',
        kind: 'ADJUSTMENT',
        occurredAt: {
          gte: new Date('2026-11-16T19:00:00.000Z'),
          lt: new Date('2026-11-17T19:00:00.000Z'),
        },
        points: { gt: 0 },
      },
      _sum: { points: true },
    });
  });

  it('records the adjustment on the same day its cap window was checked', async () => {
    // A transaction that started before Pakistan midnight but took the lock after it: the cap is
    // checked against the day of the lock-time instant, so the entry must be stamped with it too.
    const { db, created } = ledger();
    const lateNow = new Date('2026-11-16T19:00:30.000Z'); // 00:00:30 PKT, 17 Nov
    await adjustLoyaltyPoints(db as never, scope, grant('midnight', 100), {
      managerLimit: 500,
      now: lateNow,
    });
    expect(created[0]!.occurredAt).toEqual(lateNow);
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: {
            gte: new Date('2026-11-16T19:00:00.000Z'),
            lt: new Date('2026-11-17T19:00:00.000Z'),
          },
        }),
      })
    );
  });

  it('starts a fresh allowance at midnight Pakistan time', async () => {
    const { db } = ledger([{ points: 500, occurredAt: new Date('2026-11-16T18:59:59.999Z') }]);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('next-day', 500), { managerLimit: 500, now })
    ).resolves.toMatchObject({ replayed: false });
  });

  it('replays a recorded adjustment without counting it against the ceiling again', async () => {
    const { db, created } = ledger();
    const options = { managerLimit: 500, now };
    await adjustLoyaltyPoints(db as never, scope, grant('retry', 500), options);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('retry', 500), options)
    ).resolves.toMatchObject({ replayed: true });
    expect(created).toHaveLength(1);
  });

  it('applies no day total when no manager ceiling is given (the owner)', async () => {
    const { db } = ledger([{ points: 5_000, occurredAt: now }]);
    await expect(
      adjustLoyaltyPoints(db as never, scope, grant('owner', 5_000), { now })
    ).resolves.toMatchObject({ replayed: false });
  });
});

describe('DEV-881 adjustment day', () => {
  it('is the Pakistan calendar day, as a half-open UTC range', () => {
    expect(loyaltyAdjustmentDay(new Date('2026-11-16T19:00:00.000Z'))).toEqual({
      from: new Date('2026-11-16T19:00:00.000Z'),
      to: new Date('2026-11-17T19:00:00.000Z'),
    });
    expect(loyaltyAdjustmentDay(new Date('2026-11-16T18:59:59.999Z')).from).toEqual(
      new Date('2026-11-15T19:00:00.000Z')
    );
  });
});
