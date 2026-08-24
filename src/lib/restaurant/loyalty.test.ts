import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  configureLoyaltyProgram,
  earnLoyaltyForClosedOrder,
  enrollLoyaltyAccount,
  loyaltyBalance,
  netEarnableAmount,
  redeemLoyaltyPoints,
  releaseLoyaltyRedemption,
  reverseLoyaltyForRefund,
} from './loyalty';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'created',
      ...data,
    })),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
  };
}

function makeDb() {
  const db = {
    loyaltyProgramVersion: model(),
    loyaltyAccount: model(),
    loyaltyPointsEntry: model(),
    restaurantCustomer: model(),
    restaurantOrder: model(),
    restaurantBill: model(),
    restaurantRefund: model(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  return db;
}

let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;
const AT = new Date('2026-08-21T00:00:00.000Z');

beforeEach(() => {
  db = makeDb();
});

/**
 * Fixture for `earnLoyaltyForClosedOrder`, which reads its bills in two steps: the
 * order carries only the SETTLED bill IDS, then the money and the `refunds` relation
 * are re-read through `restaurantBill.findMany` AFTER the row lock (M8/M2).
 */
function settledOrder(bills: { id: string; grandTotal: string; refunded?: string[] }[]) {
  db.restaurantOrder.findUnique.mockResolvedValue({
    status: 'CLOSED',
    customerId: 'customer_1',
    bills: bills.map((bill) => ({ id: bill.id })),
  });
  db.restaurantBill.findMany.mockResolvedValue(
    bills.map((bill) => ({
      id: bill.id,
      grandTotal: new Prisma.Decimal(bill.grandTotal),
      refunds: (bill.refunded ?? []).map((amount) => ({ amount: new Prisma.Decimal(amount) })),
    }))
  );
  db.loyaltyAccount.findUnique.mockResolvedValue({ id: 'account_1', active: true });
}

/** The raw SQL text of a `$queryRaw` tagged-template call, holes elided. */
const rawSql = (call: unknown[]) => (call[0] as string[]).join('?');

type EntryWhere = {
  kind?: string;
  id?: { in?: string[] };
  idempotencyKey?: { startsWith?: string };
};

/**
 * Route `loyaltyPointsEntry.findMany` by WHAT it asks for rather than by call order,
 * so the release tests state their fixture instead of counting reads:
 *   - `mine`         the entries a release command already wrote, by idempotency key;
 *   - `redemptions`  the bill's REDEEMs, the release candidates;
 *   - `byId`         those REDEEMs re-read by id (the replay pricing path);
 *   - `releases`     every ADJUSTMENT already made against them.
 */
function entryReads(rows: {
  mine?: unknown[];
  redemptions?: unknown[];
  byId?: unknown[];
  releases?: unknown[];
}) {
  db.loyaltyPointsEntry.findMany.mockImplementation(async (args?: { where?: EntryWhere }) => {
    const where = args?.where ?? {};
    if (where.idempotencyKey?.startsWith !== undefined) return rows.mine ?? [];
    if (where.kind === 'REDEEM') return rows.redemptions ?? [];
    if (where.id?.in !== undefined) return rows.byId ?? [];
    return rows.releases ?? [];
  });
}

describe('program versions and account limits', () => {
  it('configures by appending the next immutable version', async () => {
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({ versionNumber: 2 });
    await configureLoyaltyProgram(scoped(), {
      effectiveFrom: AT,
      earnRate: '1.250000',
      redemptionValue: '0.010000',
      expiryDays: 365,
    });
    expect(db.loyaltyProgramVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 3, effectiveFrom: AT, expiryDays: 365 }),
    });
    expect(db.loyaltyProgramVersion.update).not.toHaveBeenCalled();
  });

  it('enforces loyalty.activeCustomers.max before enrollment', async () => {
    db.restaurantCustomer.findUnique.mockResolvedValue({ id: 'customer_1', anonymizedAt: null });
    db.loyaltyAccount.count.mockResolvedValue(2);
    await expect(
      enrollLoyaltyAccount(scoped(), { customerId: 'customer_1', activeCustomersMax: 2 })
    ).rejects.toMatchObject({ reason: 'ACTIVE_CUSTOMER_LIMIT_REACHED' });
    expect(db.loyaltyAccount.create).not.toHaveBeenCalled();
  });
});

describe('append-only ledger', () => {
  it('derives balance as the exact signed whole-points sum', async () => {
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: -7 } });
    await expect(loyaltyBalance(scoped(), 'account_1')).resolves.toBe(-7);
  });

  it('earns floor(bill grand total × rate) once for an active linked account', async () => {
    settledOrder([{ id: 'bill_1', grandTotal: '12.50' }]);
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      earnRate: new Prisma.Decimal('1.2'),
      expiryDays: 30,
    });

    await earnLoyaltyForClosedOrder(scoped(), 'order_1', AT);
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'EARN',
          points: 15,
          billId: 'bill_1',
          idempotencyKey: 'loyalty:earn:bill_1',
        }),
      })
    );

    db.loyaltyPointsEntry.findFirst.mockResolvedValue({
      id: 'earn_1',
      billId: 'bill_1',
      points: 15,
    });
    await earnLoyaltyForClosedOrder(scoped(), 'order_1', AT);
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledTimes(1);
  });

  it('redeems with Decimal math and updates discount/grand total atomically', async () => {
    db.loyaltyAccount.findUnique.mockResolvedValue({
      id: 'account_1',
      customerId: 'customer_1',
      active: true,
    });
    db.restaurantBill.findUnique.mockResolvedValue({
      id: 'bill_1',
      status: 'OPEN',
      grandTotal: new Prisma.Decimal('12.50'),
      discountTotal: new Prisma.Decimal('0'),
      order: { customerId: 'customer_1' },
      tenders: [],
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: 100 } });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      redemptionValue: new Prisma.Decimal('0.01'),
    });

    const result = await redeemLoyaltyPoints(scoped(), {
      accountId: 'account_1',
      billId: 'bill_1',
      points: 25,
      actorId: 'user_1',
      idempotencyKey: 'redeem_1',
      at: AT,
    });
    expect(result.value.toFixed(2)).toBe('0.25');
    expect(result.balance).toBe(75);
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'REDEEM', points: -25, billId: 'bill_1' }),
      })
    );
    expect(db.restaurantBill.update).toHaveBeenCalledWith({
      where: { id: 'bill_1' },
      data: {
        discountTotal: new Prisma.Decimal('0.25'),
        grandTotal: new Prisma.Decimal('12.25'),
      },
    });
  });

  it('pins refund reversal to original earn program and caps cumulative points', async () => {
    db.loyaltyPointsEntry.findFirst.mockResolvedValueOnce({
      id: 'earn_1',
      accountId: 'account_1',
      programVersionId: 'program_1',
      points: 10,
      programVersion: { earnRate: new Prisma.Decimal('0.1') },
    });
    // A 105.00 bill earned floor(10.5) = 10 points; 65.00 has since been refunded,
    // so the ledger must hold floor((105 − 65) × 0.1) = 4 — six reversed in total,
    // three of them already written.
    db.restaurantBill.findUnique.mockResolvedValue({ grandTotal: new Prisma.Decimal('105') });
    db.restaurantRefund.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('65') } });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: -3 } });

    await reverseLoyaltyForRefund(scoped(), { refundId: 'refund_2', billId: 'bill_1', at: AT });
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        programVersionId: 'program_1',
        kind: 'REVERSAL',
        points: -3,
        reversesEntryId: 'earn_1',
      }),
    });
  });
});

// ── M8 correction B (WHA-132) ────────────────────────────────────────────────

describe('earn is net of refunds taken before the close (M2)', () => {
  it('floors at zero and never earns on refunded money', () => {
    expect(netEarnableAmount(new Prisma.Decimal('10'), new Prisma.Decimal('4')).toString()).toBe(
      '6'
    );
    expect(netEarnableAmount(new Prisma.Decimal('10'), new Prisma.Decimal('10')).toString()).toBe(
      '0'
    );
    // A tip-inclusive refund can exceed the bill's own total; the earn floors.
    expect(netEarnableAmount(new Prisma.Decimal('10'), new Prisma.Decimal('12')).toString()).toBe(
      '0'
    );
  });

  it('earns on the net when the refund preceded the close', async () => {
    settledOrder([{ id: 'bill_1', grandTotal: '10.00', refunded: ['4.00'] }]);
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      earnRate: new Prisma.Decimal('1'),
      expiryDays: null,
    });

    await earnLoyaltyForClosedOrder(scoped(), 'order_1', AT);
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'EARN', points: 6 }) })
    );
  });

  it('locks every settled bill in ascending id order BEFORE reading its refunds', async () => {
    settledOrder([
      { id: 'bill_a', grandTotal: '10.00' },
      { id: 'bill_b', grandTotal: '10.00' },
    ]);
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      earnRate: new Prisma.Decimal('1'),
      expiryDays: null,
    });

    await earnLoyaltyForClosedOrder(scoped(), 'order_1', AT);

    // The same row lock `refundTender` takes, so the two commands cannot interleave
    // into an earn on refunded money.
    const locks = db.$queryRaw.mock.calls;
    expect(locks).toHaveLength(2);
    for (const call of locks) {
      expect(rawSql(call)).toBe('SELECT id FROM restaurant_bills WHERE id = ? FOR UPDATE');
    }
    // Ascending id — a deterministic order, so two concurrent closes cannot deadlock.
    expect(locks.map((call) => call[1])).toEqual(['bill_a', 'bill_b']);
    expect(db.restaurantOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          bills: expect.objectContaining({ orderBy: { id: 'asc' } }),
        }),
      })
    );

    // …and the refunds the earn nets out are read only after the last lock is held.
    const lastLock = Math.max(...db.$queryRaw.mock.invocationCallOrder);
    expect(db.restaurantBill.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastLock);
    expect(db.restaurantBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['bill_a', 'bill_b'] } },
        select: expect.objectContaining({ refunds: { select: { amount: true } } }),
      })
    );
  });

  it('takes no lock and earns nothing when the order has no settled bill', async () => {
    settledOrder([]);
    await expect(earnLoyaltyForClosedOrder(scoped(), 'order_1', AT)).resolves.toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.loyaltyPointsEntry.create).not.toHaveBeenCalled();
  });

  it('writes no reversal when the earn already netted the refund', async () => {
    db.loyaltyPointsEntry.findFirst.mockResolvedValueOnce({
      id: 'earn_1',
      accountId: 'account_1',
      programVersionId: 'program_1',
      points: 6,
      programVersion: { earnRate: new Prisma.Decimal('1') },
    });
    db.restaurantBill.findUnique.mockResolvedValue({ grandTotal: new Prisma.Decimal('10.00') });
    db.restaurantRefund.aggregate.mockResolvedValue({
      _sum: { amount: new Prisma.Decimal('4.00') },
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: null } });

    await expect(
      reverseLoyaltyForRefund(scoped(), { refundId: 'refund_1', billId: 'bill_1', at: AT })
    ).resolves.toBeNull();
    expect(db.loyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});

/**
 * The money a release freed. Only the call that WROTE the entries reports one — a
 * replay carries no `value` at all, so reaching for it here is a type error, which is
 * the point: the amount is never re-derived from a ledger later releases can move.
 */
function releasedValue(result: Awaited<ReturnType<typeof releaseLoyaltyRedemption>>) {
  if (result.replayed) throw new Error('a replayed release reports no money, by design');
  return result.value;
}

describe('redemption release (B3/B4)', () => {
  const redemption = {
    id: 'redeem_1',
    accountId: 'account_1',
    points: -360,
    programVersionId: 'program_1',
    programVersion: { redemptionValue: new Prisma.Decimal('0.05') },
  };

  it('releases only the whole points the shortfall needs', async () => {
    entryReads({ redemptions: [redemption] });
    db.restaurantBill.findUnique.mockResolvedValue({
      discountTotal: new Prisma.Decimal('18.00'),
    });

    const result = await releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: new Prisma.Decimal('8.00'),
      actorId: 'staff_1',
      reason: 'comp',
      idempotencyKey: 'comp:line_1',
      at: AT,
    });
    expect(result.points).toBe(160);
    expect(releasedValue(result).toFixed(2)).toBe('8.00');
    expect(result.replayed).toBe(false);
    expect(db.loyaltyPointsEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'ADJUSTMENT',
          points: 160,
          billId: 'bill_1',
          reversesEntryId: 'redeem_1',
          idempotencyKey: 'loyalty:release:comp:line_1:redeem_1',
        }),
      })
    );
  });

  it('never hands back more than the bill still carries', async () => {
    entryReads({ redemptions: [redemption] });
    db.restaurantBill.findUnique.mockResolvedValue({ discountTotal: new Prisma.Decimal('4.00') });

    const result = await releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: null,
      actorId: 'staff_1',
      reason: 'void-and-recut',
      idempotencyKey: 'void:bill_1',
      at: AT,
    });
    expect(result.points).toBe(80);
    expect(releasedValue(result).toFixed(2)).toBe('4.00');
  });

  it('replays its own entries without releasing a second time, and reports no money', async () => {
    const release = { id: 'release_1', points: 160, reversesEntryId: 'redeem_1' };
    entryReads({ mine: [release], byId: [redemption], releases: [release] });

    const result = await releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: new Prisma.Decimal('8.00'),
      actorId: 'staff_1',
      reason: 'comp',
      idempotencyKey: 'comp:line_1',
      at: AT,
    });
    expect(result).toEqual({ points: 160, replayed: true, entryIds: ['release_1'] });
    // No `value`, at all. The money a release freed depends on how much of the same
    // redemption was already given back, so a number re-derived here could differ from
    // the one the original call returned; the caller persists that number instead.
    expect(result).not.toHaveProperty('value');
    expect(db.loyaltyPointsEntry.create).not.toHaveBeenCalled();
  });

  it('decides the replay from its OWN key prefix alone, reading no sibling release', async () => {
    // The guard against re-derivation drift: a replay must not consult the other
    // releases against the same redemption, because those can be written after it.
    const release = { id: 'release_1', points: 160, reversesEntryId: 'redeem_1' };
    entryReads({ mine: [release], byId: [redemption], releases: [release] });

    await releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: new Prisma.Decimal('8.00'),
      actorId: 'staff_1',
      reason: 'comp',
      idempotencyKey: 'comp:line_1',
      at: AT,
    });
    const reads = db.loyaltyPointsEntry.findMany.mock.calls.map(
      (call) => (call[0] as { where?: EntryWhere }).where ?? {}
    );
    expect(reads).toEqual([
      { kind: 'ADJUSTMENT', idempotencyKey: { startsWith: 'loyalty:release:comp:line_1:' } },
    ]);
  });

  it('releases nothing when the bill carries no redemption', async () => {
    entryReads({});
    const result = await releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: new Prisma.Decimal('8.00'),
      actorId: 'staff_1',
      reason: 'comp',
      idempotencyKey: 'comp:line_1',
      at: AT,
    });
    expect(result).toMatchObject({ points: 0, replayed: false, entryIds: [] });
    expect(db.loyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});

describe('redemption release — fractional point values and cumulative rounding', () => {
  /**
   * A redemption priced at 0.0335 per point: two points took 0.07 off the bill
   * (round(0.067)), but the FIRST point alone is worth round(0.0335) = 0.03. So the
   * second point has to be worth 0.07 − 0.03 = 0.04 — more than the first, for the same
   * one point — or the two releases together hand back 0.06 and leave a cent of discount
   * on a bill that no longer carries it.
   *
   * This is exactly why the money is not reconstructible from a release row alone: the
   * same `points: 1` entry is worth 0.03 or 0.04 depending only on what came BEFORE it.
   */
  const redemption = {
    id: 'redeem_1',
    accountId: 'account_1',
    points: -2,
    programVersionId: 'program_1',
    programVersion: { redemptionValue: new Prisma.Decimal('0.0335') },
  };

  const release = (shortfall: string, key: string) =>
    releaseLoyaltyRedemption(scoped(), {
      billId: 'bill_1',
      shortfall: new Prisma.Decimal(shortfall),
      actorId: 'staff_1',
      reason: 'comp',
      idempotencyKey: key,
      at: AT,
    });

  it('prices the first point of a fractional redemption at the rounded-down cent', async () => {
    entryReads({ redemptions: [redemption] });
    db.restaurantBill.findUnique.mockResolvedValue({ discountTotal: new Prisma.Decimal('0.07') });

    const result = await release('0.03', 'comp:line_1');
    expect(result.points).toBe(1);
    expect(releasedValue(result).toFixed(2)).toBe('0.03');
  });

  it('prices the next point off the points already given back, not from zero', async () => {
    entryReads({
      redemptions: [redemption],
      releases: [{ id: 'release_1', points: 1, reversesEntryId: 'redeem_1' }],
    });
    // The bill still carries the 0.04 the first release did not take.
    db.restaurantBill.findUnique.mockResolvedValue({ discountTotal: new Prisma.Decimal('0.04') });

    const result = await release('0.04', 'comp:line_2');
    expect(result.points).toBe(1);
    // 0.04, NOT the 0.03 that pricing this release on its own point count would give:
    // the two releases now sum to exactly the 0.07 the redemption took off the bill.
    expect(releasedValue(result).toFixed(2)).toBe('0.04');
  });
});
