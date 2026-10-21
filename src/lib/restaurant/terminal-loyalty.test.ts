/**
 * M9-L2 — unit tests for the POS-terminal loyalty transport glue: the strict schema that
 * makes a client send POINTS rather than money, the branch object-scope guard, the exact
 * Decimal serialisation, the redemption preview (including the no-program degradation), and
 * the domain-error → HTTP mapping — insufficient balance included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { LoyaltyError } from './loyalty';
import {
  getLoyaltySnapshotForBranch,
  loyaltyErrorResponse,
  loyaltyRedeemBody,
  loyaltySnapshotQuery,
  redeemForBranch,
  serializeRedeemResult,
} from './terminal-loyalty';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
    create: vi.fn(),
    update: vi.fn(),
  };
}

function makeDb() {
  const db = {
    loyaltyProgramVersion: model(),
    loyaltyAccount: model(),
    loyaltyPointsEntry: model(),
    restaurantBill: model(),
    restaurantOrder: model(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  return db;
}

let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;
const AT = new Date('2026-08-27T00:00:00.000Z');

beforeEach(() => {
  db = makeDb();
});

/** A bill in `branch_1` with `grandTotal` and the tenders already applied to it. */
function billInBranch(
  grandTotal: string,
  tenders: string[] = [],
  customerId: string | null = 'c1'
) {
  db.restaurantBill.findFirst.mockResolvedValue({
    id: 'bill_1',
    orderId: 'order_1',
    status: 'OPEN',
    grandTotal: new Prisma.Decimal(grandTotal),
    order: { customerId },
    tenders: tenders.map((amount) => ({ amount: new Prisma.Decimal(amount) })),
  });
}

function programWorth(redemptionValue: string) {
  db.loyaltyProgramVersion.findFirst.mockResolvedValue({
    id: 'program_1',
    redemptionValue: new Prisma.Decimal(redemptionValue),
  });
}

function accountWithBalance(points: number) {
  db.loyaltyAccount.findUnique.mockResolvedValue({ id: 'account_1', active: true });
  db.loyaltyPointsEntry.aggregate.mockImplementation(
    async ({ where }: { where: { kind?: string } }) =>
      where.kind === 'REDEEM' ? { _sum: { points: null } } : { _sum: { points } }
  );
}

describe('strict input schemas', () => {
  it('accepts whole positive points and rejects an unknown field', () => {
    expect(
      loyaltyRedeemBody.safeParse({ billId: 'b1', accountId: 'a1', points: 100 }).success
    ).toBe(true);
    expect(
      loyaltyRedeemBody.safeParse({ billId: 'b1', accountId: 'a1', points: 100, branchId: 'br1' })
        .success
    ).toBe(false);
  });

  it('refuses to let a client propose its own discount amount', () => {
    // Value is derived server-side from the program's redemptionValue — money is not an input.
    expect(
      loyaltyRedeemBody.safeParse({ billId: 'b1', accountId: 'a1', points: 100, value: '50.00' })
        .success
    ).toBe(false);
    expect(
      loyaltyRedeemBody.safeParse({ billId: 'b1', accountId: 'a1', amount: '50.00' }).success
    ).toBe(false);
  });

  it('rejects fractional, zero, negative and out-of-range point counts', () => {
    const points = (points: number) =>
      loyaltyRedeemBody.safeParse({ billId: 'b1', accountId: 'a1', points }).success;
    expect(points(1.5)).toBe(false);
    expect(points(0)).toBe(false);
    expect(points(-10)).toBe(false);
    expect(points(2_147_483_648)).toBe(false);
    expect(points(2_147_483_647)).toBe(true);
  });

  it('rejects an unknown snapshot query parameter', () => {
    expect(loyaltySnapshotQuery.safeParse({ billId: 'b1' }).success).toBe(true);
    expect(loyaltySnapshotQuery.safeParse({ billId: 'b1', accountId: 'a1' }).success).toBe(false);
  });
});

describe('getLoyaltySnapshotForBranch (object scope + Decimal)', () => {
  it('answers "not found" for a bill outside the device branch', async () => {
    db.restaurantBill.findFirst.mockResolvedValue(null);
    expect(await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT)).toBeNull();
    expect(db.restaurantBill.findFirst.mock.calls[0][0].where).toEqual({
      id: 'bill_1',
      branchId: 'branch_1',
    });
  });

  it('derives the outstanding balance and caps redeemable points by what the bill still owes', async () => {
    billInBranch('100.00', ['40.00']);
    accountWithBalance(5000);
    programWorth('0.50');

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);

    expect(snapshot?.outstanding).toBe('60');
    expect(snapshot?.redemptionValue).toBe('0.5');
    // 60 outstanding ÷ 0.50 per point = 120 points affordable, well under the 5000 balance.
    expect(snapshot?.maxRedeemablePoints).toBe(120);
    expect(snapshot?.balance).toBe(5000);
  });

  it('caps redeemable points by the balance when the guest cannot cover the bill', async () => {
    billInBranch('100.00');
    accountWithBalance(30);
    programWorth('0.50');

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(snapshot?.maxRedeemablePoints).toBe(30);
  });

  it('floors a fractional affordability rather than rounding a point into existence', async () => {
    billInBranch('10.00');
    accountWithBalance(9999);
    programWorth('0.30');

    // 10 ÷ 0.30 = 33.33… → 33, because 34 points would exceed the bill.
    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(snapshot?.maxRedeemablePoints).toBe(33);
  });

  it('prices the already-redeemed total from the NEGATIVE ledger points', async () => {
    billInBranch('100.00');
    db.loyaltyAccount.findUnique.mockResolvedValue({ id: 'account_1', active: true });
    db.loyaltyPointsEntry.aggregate.mockImplementation(
      async ({ where }: { where: { kind?: string } }) =>
        where.kind === 'REDEEM' ? { _sum: { points: -200 } } : { _sum: { points: 1000 } }
    );
    programWorth('0.25');

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(snapshot?.redeemedValue).toBe('50');
  });

  it('degrades to zero when no loyalty program is configured, instead of failing the panel', async () => {
    billInBranch('100.00');
    accountWithBalance(500);
    db.loyaltyProgramVersion.findFirst.mockResolvedValue(null);

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(snapshot?.redemptionValue).toBe('0');
    expect(snapshot?.maxRedeemablePoints).toBe(0);
    expect(snapshot?.outstanding).toBe('100');
  });

  it('reports no account for a bill with no guest attached, and never a negative maximum', async () => {
    billInBranch('50.00', ['80.00'], null);
    programWorth('0.50');

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(snapshot?.customerId).toBeNull();
    expect(snapshot?.accountId).toBeNull();
    expect(snapshot?.accountActive).toBe(false);
    expect(snapshot?.balance).toBe(0);
    expect(snapshot?.maxRedeemablePoints).toBe(0);
    expect(db.loyaltyAccount.findUnique).not.toHaveBeenCalled();
  });

  it('returns no guest PII — only the ids the redemption call needs', async () => {
    billInBranch('100.00');
    accountWithBalance(500);
    programWorth('0.50');

    const snapshot = await getLoyaltySnapshotForBranch(scoped(), 'bill_1', 'branch_1', AT);
    expect(Object.keys(snapshot ?? {}).sort()).toEqual([
      'accountActive',
      'accountId',
      'balance',
      'billId',
      'billStatus',
      'customerId',
      'maxRedeemablePoints',
      'orderId',
      'outstanding',
      'redeemedValue',
      'redemptionValue',
    ]);
  });
});

describe('redeemForBranch (object scope)', () => {
  it('answers "not found" for a bill outside the device branch and never books an entry', async () => {
    db.restaurantBill.findFirst.mockResolvedValue(null);

    expect(
      await redeemForBranch(scoped(), {
        billId: 'other_branch_bill',
        accountId: 'account_1',
        points: 100,
        branchId: 'branch_1',
        actorId: 'staff_1',
        idempotencyKey: 'key-1',
        at: AT,
      })
    ).toBeNull();
    // The command layer is never entered, so no ledger entry and no bill mutation can occur.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.loyaltyPointsEntry.create).not.toHaveBeenCalled();
  });

  it('delegates an in-branch redemption to the M8 command with the transport-derived actor', async () => {
    db.restaurantBill.findFirst.mockResolvedValue({ id: 'bill_1' });
    db.loyaltyPointsEntry.findFirst.mockResolvedValue(null);
    db.loyaltyAccount.findUnique.mockResolvedValue({
      id: 'account_1',
      customerId: 'c1',
      active: true,
    });
    db.restaurantBill.findUnique.mockResolvedValue({
      id: 'bill_1',
      status: 'OPEN',
      grandTotal: new Prisma.Decimal('100.00'),
      discountTotal: new Prisma.Decimal('0'),
      order: { customerId: 'c1' },
      tenders: [],
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: 1000 } });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      redemptionValue: new Prisma.Decimal('0.50'),
    });
    db.loyaltyPointsEntry.create.mockResolvedValue({ id: 'entry_1' });
    db.restaurantBill.update.mockResolvedValue({});

    const result = await redeemForBranch(scoped(), {
      billId: 'bill_1',
      accountId: 'account_1',
      points: 100,
      branchId: 'branch_1',
      actorId: 'staff_1',
      idempotencyKey: 'key-1',
      at: AT,
    });

    expect(result?.points).toBe(100);
    expect(result?.value.toString()).toBe('50');
    const entry = db.loyaltyPointsEntry.create.mock.calls[0][0].data;
    expect(entry.points).toBe(-100);
    expect(entry.actorId).toBe('staff_1');
    expect(entry.idempotencyKey).toBe('loyalty:redeem:key-1');
  });
});

describe('serializeRedeemResult', () => {
  it('emits the money value as an exact decimal string, never a float', () => {
    expect(
      serializeRedeemResult({
        entryId: 'e1',
        accountId: 'a1',
        billId: 'b1',
        points: 250,
        value: new Prisma.Decimal('12.35'),
        balance: 750,
        replayed: false,
      })
    ).toEqual({
      entryId: 'e1',
      accountId: 'a1',
      billId: 'b1',
      points: 250,
      value: '12.35',
      balance: 750,
      replayed: false,
    });
  });
});

describe('loyaltyErrorResponse', () => {
  const status = (reason: ConstructorParameters<typeof LoyaltyError>[1]) =>
    loyaltyErrorResponse(new LoyaltyError('boom', reason))?.status;

  it('maps insufficient balance and the other cashier-resolvable preconditions onto 409', () => {
    expect(status('INSUFFICIENT_BALANCE')).toBe(409);
    expect(status('REDEMPTION_EXCEEDS_BILL')).toBe(409);
    expect(status('BILL_NOT_OPEN')).toBe(409);
    expect(status('ACCOUNT_BILL_MISMATCH')).toBe(409);
    expect(status('ACCOUNT_INACTIVE')).toBe(409);
    expect(status('PROGRAM_NOT_CONFIGURED')).toBe(409);
    expect(status('IDEMPOTENCY_CONFLICT')).toBe(409);
  });

  it('maps a missing account or bill onto 404 and a malformed value onto 400', () => {
    expect(status('NOT_FOUND')).toBe(404);
    expect(status('INVALID')).toBe(400);
  });

  it('returns null for a non-domain error so the transport answers a generic 500', () => {
    expect(loyaltyErrorResponse(new Error('connection reset'))).toBeNull();
  });

  it('carries the authored domain message and nothing else', async () => {
    const response = loyaltyErrorResponse(
      new LoyaltyError(
        'The loyalty account has insufficient positive balance.',
        'INSUFFICIENT_BALANCE'
      )
    );
    await expect(response?.json()).resolves.toEqual({
      error: 'The loyalty account has insufficient positive balance.',
    });
  });
});
