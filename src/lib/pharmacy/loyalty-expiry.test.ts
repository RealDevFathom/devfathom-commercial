import { describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));

import { lockCustomerConsent } from './consent-writer';
import {
  expireCustomerLoyaltyPoints,
  expireStrandedRestoration,
  LOYALTY_EXPIRY_ACTOR,
  planPharmacyLotExpiries,
  pointsPastExpiry,
  strandedRestoredPoints,
  type PharmacyPointsEntryForExpiry,
} from './loyalty-expiry';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const entry = (
  id: string,
  kind: string,
  points: number,
  occurred: number,
  extra: Partial<PharmacyPointsEntryForExpiry> = {}
): PharmacyPointsEntryForExpiry => ({
  id,
  kind,
  points,
  saleId: null,
  tenderId: null,
  programVersionId: 'program-1',
  reversesEntryId: null,
  expiresAt: null,
  occurredAt: day(occurred),
  ...extra,
});

describe('DEV-764 pharmacy points expiry planning', () => {
  it('expires what is left of each due lot after oldest-first spending', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
        entry('earn-b', 'KHATA_EARN', 50, 5, { saleId: 'sale-b', expiresAt: day(35) }),
        entry('redeem', 'REDEEM', -120, 10, { saleId: 'sale-c' }),
      ],
      day(40)
    );
    expect(plan).toEqual([
      { lotId: 'earn-a', programVersionId: 'program-1', points: 0 },
      { lotId: 'earn-b', programVersionId: 'program-1', points: 30 },
    ]);
  });

  it('never expires points given back, nor a lot that is not yet due or never expires', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(60) }),
        entry('earn-b', 'EARN', 40, 2, { saleId: 'sale-b', expiresAt: null }),
        entry('restored', 'REFUND', 10, 3, { saleId: 'sale-c' }),
        entry('released', 'REDEMPTION_RELEASE', 5, 4, { saleId: 'sale-d' }),
        entry('bonus', 'ADJUSTMENT', 25, 5),
      ],
      day(40)
    );
    expect(plan).toEqual([]);
  });

  it('lets an earn reversal consume its own sale lot, not the oldest one', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
        entry('earn-b', 'EARN', 60, 2, { saleId: 'sale-b', expiresAt: day(31) }),
        entry('reverse-b', 'EARN_REVERSAL', -60, 3, { saleId: 'sale-b' }),
      ],
      day(32)
    );
    expect(plan.map((lot) => [lot.lotId, lot.points])).toEqual([
      ['earn-a', 100],
      ['earn-b', 0],
    ]);
  });

  it('lets a khata refund reversal take back its own collection lots, not older earnings', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('old-earn', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(60) }),
        entry('khata-1', 'KHATA_EARN', 60, 2, {
          saleId: 'sale-k',
          tenderId: 'credit-k',
          expiresAt: day(32),
        }),
        entry('khata-2', 'KHATA_EARN', 40, 3, {
          saleId: 'sale-k',
          tenderId: 'credit-k',
          expiresAt: day(33),
        }),
        // A cash earn on the same khata sale must not absorb the khata reversal.
        entry('cash-k', 'EARN', 10, 2, { saleId: 'sale-k', expiresAt: day(32) }),
        entry('reverse-k', 'EARN_REVERSAL', -100, 4, { saleId: 'sale-k', tenderId: 'credit-k' }),
      ],
      day(61)
    );
    expect(plan.map((lot) => [lot.lotId, lot.points])).toEqual([
      ['cash-k', 10],
      ['khata-1', 0],
      ['khata-2', 0],
      ['old-earn', 100],
    ]);
  });

  it('takes a reversal of already-spent points from other lots, never expiring them twice', () => {
    // Earn 100 on A, redeem 100, earn 100 on B, refund A in full: the balance is 0.
    const plan = planPharmacyLotExpiries(
      [
        entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
        entry('redeem', 'REDEEM', -100, 2, { saleId: 'sale-r' }),
        entry('earn-b', 'EARN', 100, 3, { saleId: 'sale-b', expiresAt: day(33) }),
        entry('reverse-a', 'EARN_REVERSAL', -100, 4, { saleId: 'sale-a', tenderId: 'cash-a' }),
      ],
      day(40)
    );
    expect(plan.map((lot) => [lot.lotId, lot.points])).toEqual([
      ['earn-a', 0],
      ['earn-b', 0],
    ]);
  });

  it('never plans a lot that already has its expiry entry', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
        entry('expiry-a', 'EXPIRY', -100, 31, { reversesEntryId: 'earn-a' }),
        entry('earn-b', 'EARN', 10, 2, { saleId: 'sale-b', expiresAt: day(31) }),
        entry('closed-b', 'EXPIRY', 0, 31, { reversesEntryId: 'earn-b' }),
      ],
      day(90)
    );
    expect(plan).toEqual([]);
  });
});

describe('DEV-764 pharmacy points expiry ledger entries', () => {
  it('locks the customer, then appends one EXPIRY entry per due lot, keyed by the lot', async () => {
    const create = vi.fn(async ({ data }) => data);
    const findMany = vi.fn(async () => [
      entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
      entry('earn-b', 'EARN', 20, 2, { saleId: 'sale-b', expiresAt: day(31) }),
      entry('redeem', 'REDEEM', -100, 3, { saleId: 'sale-c' }),
    ]);
    const db = { pharmacyLoyaltyPointsEntry: { findMany, create } };
    const scope = { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' };

    await expect(expireCustomerLoyaltyPoints(db as never, scope, day(40))).resolves.toEqual({
      lots: 2,
      points: 20,
    });
    expect(lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(vi.mocked(lockCustomerConsent).mock.invocationCallOrder[0]).toBeLessThan(
      findMany.mock.invocationCallOrder[0]!
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          customerId: 'customer-a',
          occurredAt: { lte: day(40) },
        },
      })
    );
    expect(create.mock.calls.map(([call]) => call.data)).toEqual([
      expect.objectContaining({
        kind: 'EXPIRY',
        points: 0,
        reversesEntryId: 'earn-a',
        idempotencyKey: 'loyalty:expiry:earn-a',
        actorId: LOYALTY_EXPIRY_ACTOR,
        occurredAt: day(40),
      }),
      expect.objectContaining({
        kind: 'EXPIRY',
        points: -20,
        reversesEntryId: 'earn-b',
        idempotencyKey: 'loyalty:expiry:earn-b',
        branchId: 'branch-a',
        customerId: 'customer-a',
      }),
    ]);
  });
});

describe('DEV-764 points that come back keep their expiry', () => {
  it('returns released points to the lot they were redeemed from, with its expiry date', () => {
    const entries = [
      entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
      entry('redeem', 'REDEEM', -60, 10, { saleId: 'sale-v', tenderId: 'points-v' }),
      entry('release', 'REDEMPTION_RELEASE', 60, 20, { saleId: 'sale-v', tenderId: 'points-v' }),
    ];
    // Without the return, the 60 released points would never expire and only 40 would.
    expect(planPharmacyLotExpiries(entries, day(40))).toEqual([
      { lotId: 'earn-a', programVersionId: 'program-1', points: 100 },
    ]);
    expect(strandedRestoredPoints(entries, 'release', day(40))).toBe(0);
  });

  it('does the same for points restored by a refund of the points tender', () => {
    const entries = [
      entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
      entry('redeem', 'REDEEM', -60, 10, { saleId: 'sale-r', tenderId: 'points-r' }),
      entry('restore', 'REFUND', 25, 20, { saleId: 'sale-r', tenderId: 'points-r' }),
    ];
    expect(planPharmacyLotExpiries(entries, day(40))).toEqual([
      { lotId: 'earn-a', programVersionId: 'program-1', points: 65 },
    ]);
  });

  it('marks points returned into a lot that already expired as stranded, to expire at once', () => {
    const entries = [
      entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
      entry('redeem', 'REDEEM', -60, 10, { saleId: 'sale-v', tenderId: 'points-v' }),
      entry('expiry-a', 'EXPIRY', -40, 31, { reversesEntryId: 'earn-a' }),
      entry('release', 'REDEMPTION_RELEASE', 60, 35, { saleId: 'sale-v', tenderId: 'points-v' }),
    ];
    expect(strandedRestoredPoints(entries, 'release', day(36))).toBe(60);
    expect(planPharmacyLotExpiries(entries, day(36))).toEqual([]);
    const settled = [
      ...entries,
      entry('expiry-r', 'EXPIRY', -60, 35, { reversesEntryId: 'release' }),
    ];
    expect(strandedRestoredPoints(settled, 'release', day(36))).toBe(0);
  });

  it('writes one immediate EXPIRY entry for stranded points, linked to the restoring entry', async () => {
    const create = vi.fn(async ({ data }) => data);
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findMany: vi.fn(async () => [
          entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
          entry('redeem', 'REDEEM', -60, 10, { saleId: 'sale-v', tenderId: 'points-v' }),
          entry('expiry-a', 'EXPIRY', -40, 31, { reversesEntryId: 'earn-a' }),
          entry('release', 'REDEMPTION_RELEASE', 60, 35, {
            saleId: 'sale-v',
            tenderId: 'points-v',
          }),
        ]),
        create,
      },
    };
    const scope = { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' };
    await expireStrandedRestoration(db as never, scope, { id: 'release' }, day(36));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'EXPIRY',
        points: -60,
        reversesEntryId: 'release',
        idempotencyKey: 'loyalty:expiry:release',
        customerId: 'customer-a',
        branchId: 'branch-a',
      }),
    });
  });
});

describe('DEV-764 points past expiry cannot be spent before the sweep runs', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' };

  it('counts what is left of due, unswept lots', async () => {
    const db = {
      pharmacyLoyaltyPointsEntry: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          entry('earn-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(31) }),
          entry('earn-b', 'EARN', 50, 2, { saleId: 'sale-b', expiresAt: day(90) }),
          entry('redeem', 'REDEEM', -30, 3, { saleId: 'sale-r', tenderId: 'points-r' }),
        ]),
      },
    };
    await expect(pointsPastExpiry(db as never, scope, day(40))).resolves.toBe(70);
    expect(db.pharmacyLoyaltyPointsEntry.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        customerId: 'customer-a',
        kind: { in: ['EARN', 'KHATA_EARN'] },
        expiresAt: { lte: day(40) },
        closedBy: { none: { kind: 'EXPIRY' } },
      },
    });
  });

  it('does not read the ledger when no lot is past expiry', async () => {
    const findMany = vi.fn();
    const db = { pharmacyLoyaltyPointsEntry: { count: vi.fn(async () => 0), findMany } };
    await expect(pointsPastExpiry(db as never, scope, day(40))).resolves.toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('DEV-764 a spend between expiry and the sweep conserves points', () => {
  it('never spends an expired lot, so redemptions stop at the unexpired points and the sweep expires the rest', async () => {
    const scope = { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' };
    // Lot A: 100 points, expired on day 10 and not yet swept. Lot B: 50 points, still valid.
    const ledger: PharmacyPointsEntryForExpiry[] = [
      entry('lot-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(10) }),
      entry('lot-b', 'EARN', 50, 2, { saleId: 'sale-b', expiresAt: day(90) }),
    ];
    const db = {
      pharmacyLoyaltyPointsEntry: {
        count: vi.fn(
          async () =>
            ledger.filter(
              (row) =>
                row.kind === 'EARN' &&
                !ledger.some((other) => other.kind === 'EXPIRY' && other.reversesEntryId === row.id)
            ).length
        ),
        findMany: vi.fn(async () => [...ledger]),
      },
    };
    let redeemed = 0;
    for (const [attempt, onDay] of [11, 12, 13].entries()) {
      const balance = ledger.reduce((sum, row) => sum + row.points, 0);
      const spendable = balance - (await pointsPastExpiry(db as never, scope, day(onDay)));
      if (spendable < 50) continue;
      ledger.push(
        entry(`redeem-${attempt}`, 'REDEEM', -50, onDay, {
          saleId: `sale-r${attempt}`,
          tenderId: `points-${attempt}`,
        })
      );
      redeemed += 50;
    }
    // Only lot B's 50 points could be spent; lot A's 100 still expire in full.
    expect(redeemed).toBe(50);
    expect(planPharmacyLotExpiries(ledger, day(14))).toEqual([
      { lotId: 'lot-a', programVersionId: 'program-1', points: 100 },
    ]);
    const balanceAfterSweep = ledger.reduce((sum, row) => sum + row.points, 0) - 100;
    expect(balanceAfterSweep).toBe(0);
  });

  it('lets an earn reversal take back its own lot even after that lot expired', () => {
    const plan = planPharmacyLotExpiries(
      [
        entry('lot-a', 'EARN', 100, 1, { saleId: 'sale-a', expiresAt: day(10) }),
        entry('lot-b', 'EARN', 50, 2, { saleId: 'sale-b', expiresAt: day(90) }),
        entry('reverse-a', 'EARN_REVERSAL', -100, 11, { saleId: 'sale-a', tenderId: 'cash-a' }),
      ],
      day(12)
    );
    // The reversal removed lot A's points; the sweep must not remove them a second time.
    expect(plan).toEqual([{ lotId: 'lot-a', programVersionId: 'program-1', points: 0 }]);
  });
});
