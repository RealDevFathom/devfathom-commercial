import { describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));

import { lockCustomerConsent } from './consent-writer';
import {
  expireCustomerLoyaltyPoints,
  LOYALTY_EXPIRY_ACTOR,
  planPharmacyLotExpiries,
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
