import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { expireAccountLoyaltyPoints } from './loyalty-expiry';
import { add, compare, multiply, roundMoney, sub, sum, ZERO } from './money';

export type LoyaltyErrorReason =
  | 'NOT_FOUND'
  | 'PROGRAM_NOT_CONFIGURED'
  | 'INVALID'
  | 'ACTIVE_CUSTOMER_LIMIT_REACHED'
  | 'ACCOUNT_INACTIVE'
  | 'BILL_NOT_OPEN'
  | 'ACCOUNT_BILL_MISMATCH'
  | 'INSUFFICIENT_BALANCE'
  | 'REDEMPTION_EXCEEDS_BILL'
  | 'IDEMPOTENCY_CONFLICT';

export class LoyaltyError extends Error {
  constructor(
    message: string,
    readonly reason: LoyaltyErrorReason
  ) {
    super(message);
    this.name = 'LoyaltyError';
  }
}

function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function decimal(value: Prisma.Decimal | string, name: string): Prisma.Decimal {
  const result = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  if (!result.isFinite() || result.decimalPlaces() > 6) {
    throw new LoyaltyError(`${name} must be a finite Decimal with at most 6 places.`, 'INVALID');
  }
  return result;
}

function wholePoints(value: Prisma.Decimal): number {
  const points = value.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR);
  if (!points.isInteger() || points.isNegative() || points.greaterThan(2_147_483_647)) {
    throw new LoyaltyError('The calculated points do not fit the whole-points ledger.', 'INVALID');
  }
  return points.toNumber();
}

async function effectiveProgram(tx: ScopedDb, at: Date) {
  const program = await tx.loyaltyProgramVersion.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { versionNumber: 'desc' }],
  });
  if (!program) {
    throw new LoyaltyError(
      'No loyalty program is effective at this time.',
      'PROGRAM_NOT_CONFIGURED'
    );
  }
  return program;
}

export type ConfigureLoyaltyProgramInput = {
  effectiveFrom: Date;
  earnRate: Prisma.Decimal | string;
  redemptionValue: Prisma.Decimal | string;
  expiryDays?: number | null;
};

/** Program versions are append-only. Effective rows are additionally protected by DB trigger. */
export function configureLoyaltyProgram(db: ScopedDb, input: ConfigureLoyaltyProgramInput) {
  return runInTransaction(db, async (tx) => {
    if (Number.isNaN(input.effectiveFrom.getTime())) {
      throw new LoyaltyError('effectiveFrom must be a valid instant.', 'INVALID');
    }
    const earnRate = decimal(input.earnRate, 'earnRate');
    const redemptionValue = decimal(input.redemptionValue, 'redemptionValue');
    if (earnRate.isNegative() || !redemptionValue.isPositive()) {
      throw new LoyaltyError(
        'earnRate must be non-negative and redemptionValue must be positive.',
        'INVALID'
      );
    }
    if (
      input.expiryDays !== undefined &&
      input.expiryDays !== null &&
      (!Number.isInteger(input.expiryDays) || input.expiryDays < 1)
    ) {
      throw new LoyaltyError('expiryDays must be a positive whole number or null.', 'INVALID');
    }

    const latest = await tx.loyaltyProgramVersion.findFirst({
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    return tx.loyaltyProgramVersion.create({
      data: {
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        effectiveFrom: input.effectiveFrom,
        earnRate,
        redemptionValue,
        expiryDays: input.expiryDays ?? null,
      },
    });
  });
}

export function listLoyaltyPrograms(db: ScopedDb, limit = 100) {
  return db.loyaltyProgramVersion.findMany({
    orderBy: [{ effectiveFrom: 'desc' }, { versionNumber: 'desc' }],
    take: limit,
  });
}

export async function getLoyaltyProgram(db: ScopedDb, id: string) {
  const program = await db.loyaltyProgramVersion.findUnique({ where: { id } });
  if (!program) throw new LoyaltyError('The loyalty program version does not exist.', 'NOT_FOUND');
  return program;
}

export async function loyaltyBalance(db: ScopedDb, accountId: string): Promise<number> {
  const aggregate = await db.loyaltyPointsEntry.aggregate({
    where: { accountId },
    _sum: { points: true },
  });
  return aggregate._sum.points ?? 0;
}

export async function listLoyaltyAccounts(
  db: ScopedDb,
  input: { active?: boolean; limit?: number } = {}
) {
  const accounts = await db.loyaltyAccount.findMany({
    where: input.active === undefined ? undefined : { active: input.active },
    orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
    take: input.limit ?? 100,
    include: { customer: { select: { id: true, displayName: true, anonymizedAt: true } } },
  });
  if (accounts.length === 0) return [];
  const balances = await db.loyaltyPointsEntry.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accounts.map((account) => account.id) } },
    _sum: { points: true },
  });
  const byAccount = new Map(balances.map((row) => [row.accountId, row._sum.points ?? 0]));
  return accounts.map((account) => ({ ...account, balance: byAccount.get(account.id) ?? 0 }));
}

export async function getLoyaltyAccount(db: ScopedDb, id: string) {
  const account = await db.loyaltyAccount.findUnique({
    where: { id },
    include: { customer: { select: { id: true, displayName: true, anonymizedAt: true } } },
  });
  if (!account) throw new LoyaltyError('The loyalty account does not exist.', 'NOT_FOUND');
  return { ...account, balance: await loyaltyBalance(db, account.id) };
}

/** Enrollment/reactivation is the single server-side active-account limit seam. */
export function enrollLoyaltyAccount(
  db: ScopedDb,
  input: { customerId: string; activeCustomersMax: number; at?: Date }
) {
  return runInTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = current_setting('app.current_organization_id', true) FOR UPDATE`;
    const existing = await tx.loyaltyAccount.findUnique({
      where: { customerId: input.customerId },
    });
    if (existing?.active) return existing;

    const customer = await tx.restaurantCustomer.findUnique({
      where: { id: input.customerId },
      select: { id: true, anonymizedAt: true },
    });
    if (!customer || customer.anonymizedAt) {
      throw new LoyaltyError('The customer does not exist or is anonymized.', 'NOT_FOUND');
    }
    const activeCount = await tx.loyaltyAccount.count({ where: { active: true } });
    if (input.activeCustomersMax <= 0 || activeCount >= input.activeCustomersMax) {
      throw new LoyaltyError(
        'The active loyalty-customer entitlement limit has been reached.',
        'ACTIVE_CUSTOMER_LIMIT_REACHED'
      );
    }
    const at = input.at ?? new Date();
    return existing
      ? tx.loyaltyAccount.update({
          where: { id: existing.id },
          data: { active: true, enrolledAt: at, deactivatedAt: null },
        })
      : tx.loyaltyAccount.create({ data: { customerId: input.customerId, enrolledAt: at } });
  });
}

export async function listLoyaltyEntries(
  db: ScopedDb,
  input: { accountId?: string; limit?: number } = {}
) {
  return db.loyaltyPointsEntry.findMany({
    where: input.accountId ? { accountId: input.accountId } : undefined,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: input.limit ?? 100,
    include: { programVersion: true },
  });
}

export async function getLoyaltyEntry(db: ScopedDb, id: string) {
  const entry = await db.loyaltyPointsEntry.findUnique({
    where: { id },
    include: { programVersion: true },
  });
  if (!entry) throw new LoyaltyError('The loyalty ledger entry does not exist.', 'NOT_FOUND');
  return entry;
}

/** Called inside order-close transaction after CLOSED is persisted. */
export async function earnLoyaltyForClosedOrder(tx: ScopedDb, orderId: string, at: Date) {
  const order = await tx.restaurantOrder.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      customerId: true,
      bills: {
        where: { status: 'SETTLED' },
        select: { id: true, grandTotal: true },
      },
    },
  });
  if (!order || order.status !== 'CLOSED' || !order.customerId) return [];

  const account = await tx.loyaltyAccount.findUnique({
    where: { customerId: order.customerId },
    select: { id: true, active: true },
  });
  if (!account?.active) return [];
  const program = await effectiveProgram(tx, at);
  const created: { id: string; billId: string | null; points: number }[] = [];
  for (const bill of order.bills) {
    const idempotencyKey = `loyalty:earn:${bill.id}`;
    const prior = await tx.loyaltyPointsEntry.findFirst({
      where: { idempotencyKey },
      select: { id: true, billId: true, points: true },
    });
    if (prior) {
      created.push(prior);
      continue;
    }
    const points = wholePoints(multiply(bill.grandTotal, program.earnRate));
    if (points === 0) continue;
    const expiresAt = program.expiryDays
      ? new Date(at.getTime() + program.expiryDays * 86_400_000)
      : null;
    created.push(
      await tx.loyaltyPointsEntry.create({
        data: {
          accountId: account.id,
          programVersionId: program.id,
          kind: 'EARN',
          points,
          billId: bill.id,
          expiresAt,
          occurredAt: at,
          idempotencyKey,
        },
        select: { id: true, billId: true, points: true },
      })
    );
  }
  return created;
}

export function adjustLoyaltyPoints(
  db: ScopedDb,
  input: {
    accountId: string;
    points: number;
    actorId: string;
    reason: string;
    idempotencyKey: string;
    at?: Date;
  }
) {
  return runInTransaction(db, async (tx) => {
    if (!Number.isInteger(input.points) || input.points === 0) {
      throw new LoyaltyError('An adjustment must be a non-zero whole number of points.', 'INVALID');
    }
    const actorId = input.actorId.trim();
    const reason = input.reason.trim();
    if (!actorId || !reason) {
      throw new LoyaltyError('An adjustment requires an actor and reason.', 'INVALID');
    }
    const idempotencyKey = `loyalty:adjust:${input.idempotencyKey}`;
    const prior = await tx.loyaltyPointsEntry.findFirst({ where: { idempotencyKey } });
    if (prior) {
      if (
        prior.kind !== 'ADJUSTMENT' ||
        prior.accountId !== input.accountId ||
        prior.points !== input.points
      ) {
        throw new LoyaltyError(
          'The idempotency key was already used for another command.',
          'IDEMPOTENCY_CONFLICT'
        );
      }
      return prior;
    }
    const account = await tx.loyaltyAccount.findUnique({ where: { id: input.accountId } });
    if (!account) throw new LoyaltyError('The loyalty account does not exist.', 'NOT_FOUND');
    const at = input.at ?? new Date();
    const program = await effectiveProgram(tx, at);
    return tx.loyaltyPointsEntry.create({
      data: {
        accountId: account.id,
        programVersionId: program.id,
        kind: 'ADJUSTMENT',
        points: input.points,
        actorId,
        reason,
        occurredAt: at,
        idempotencyKey,
      },
    });
  });
}

export type RedeemLoyaltyResult = {
  entryId: string;
  accountId: string;
  billId: string;
  points: number;
  value: Prisma.Decimal;
  balance: number;
  replayed: boolean;
};

export function redeemLoyaltyPoints(
  db: ScopedDb,
  input: {
    accountId: string;
    billId: string;
    points: number;
    actorId: string;
    idempotencyKey: string;
    at?: Date;
  }
): Promise<RedeemLoyaltyResult> {
  return runInTransaction(db, async (tx) => {
    if (!Number.isInteger(input.points) || input.points <= 0) {
      throw new LoyaltyError('Redemption points must be a positive whole number.', 'INVALID');
    }
    const idempotencyKey = `loyalty:redeem:${input.idempotencyKey}`;
    const prior = await tx.loyaltyPointsEntry.findFirst({
      where: { idempotencyKey },
      include: { programVersion: true },
    });
    if (prior) {
      if (
        prior.kind !== 'REDEEM' ||
        prior.accountId !== input.accountId ||
        prior.billId !== input.billId ||
        prior.points !== -input.points
      ) {
        throw new LoyaltyError(
          'The idempotency key was already used for another command.',
          'IDEMPOTENCY_CONFLICT'
        );
      }
      return {
        entryId: prior.id,
        accountId: prior.accountId,
        billId: prior.billId!,
        points: -prior.points,
        value: roundMoney(multiply(-prior.points, prior.programVersion.redemptionValue)),
        balance: await loyaltyBalance(tx, prior.accountId),
        replayed: true,
      };
    }

    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${input.billId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM restaurant_loyalty_accounts WHERE id = ${input.accountId} FOR UPDATE`;
    const at = input.at ?? new Date();
    await expireAccountLoyaltyPoints(tx, input.accountId, at);

    const account = await tx.loyaltyAccount.findUnique({
      where: { id: input.accountId },
      select: { id: true, customerId: true, active: true },
    });
    if (!account) throw new LoyaltyError('The loyalty account does not exist.', 'NOT_FOUND');
    if (!account.active)
      throw new LoyaltyError('The loyalty account is inactive.', 'ACCOUNT_INACTIVE');

    const bill = await tx.restaurantBill.findUnique({
      where: { id: input.billId },
      select: {
        id: true,
        status: true,
        grandTotal: true,
        discountTotal: true,
        order: { select: { customerId: true } },
        tenders: { select: { amount: true } },
      },
    });
    if (!bill) throw new LoyaltyError('The bill does not exist.', 'NOT_FOUND');
    if (bill.status !== 'OPEN') {
      throw new LoyaltyError('Only an OPEN bill can receive loyalty redemption.', 'BILL_NOT_OPEN');
    }
    if (bill.order.customerId !== account.customerId) {
      throw new LoyaltyError(
        'The bill does not belong to this loyalty customer.',
        'ACCOUNT_BILL_MISMATCH'
      );
    }

    const balance = await loyaltyBalance(tx, account.id);
    if (balance <= 0 || input.points > balance) {
      throw new LoyaltyError(
        'The loyalty account has insufficient positive balance.',
        'INSUFFICIENT_BALANCE'
      );
    }
    const program = await effectiveProgram(tx, at);
    const value = roundMoney(multiply(input.points, program.redemptionValue));
    const outstanding = sub(bill.grandTotal, sum(bill.tenders.map((tender) => tender.amount)));
    if (value.isZero() || compare(value, outstanding) > 0) {
      throw new LoyaltyError(
        'The redemption value exceeds the bill balance still outstanding.',
        'REDEMPTION_EXCEEDS_BILL'
      );
    }

    const entry = await tx.loyaltyPointsEntry.create({
      data: {
        accountId: account.id,
        programVersionId: program.id,
        kind: 'REDEEM',
        points: -input.points,
        billId: bill.id,
        actorId: input.actorId,
        occurredAt: at,
        idempotencyKey,
      },
      select: { id: true },
    });
    await tx.restaurantBill.update({
      where: { id: bill.id },
      data: {
        discountTotal: add(bill.discountTotal, value),
        grandTotal: sub(bill.grandTotal, value),
      },
    });
    return {
      entryId: entry.id,
      accountId: account.id,
      billId: bill.id,
      points: input.points,
      value,
      balance: balance - input.points,
      replayed: false,
    };
  });
}

/** Called inside the existing refund transaction after the refund row is appended. */
export async function reverseLoyaltyForRefund(
  tx: ScopedDb,
  input: { refundId: string; billId: string; at: Date }
) {
  const earn = await tx.loyaltyPointsEntry.findFirst({
    where: { billId: input.billId, kind: 'EARN' },
    include: { programVersion: true },
  });
  if (!earn) return null;
  const idempotencyKey = `loyalty:reversal:${input.refundId}`;
  const prior = await tx.loyaltyPointsEntry.findFirst({ where: { idempotencyKey } });
  if (prior) return prior;

  const [refunds, reversals] = await Promise.all([
    tx.restaurantRefund.aggregate({
      where: { billId: input.billId },
      _sum: { amount: true },
    }),
    tx.loyaltyPointsEntry.aggregate({
      where: { reversesEntryId: earn.id, kind: 'REVERSAL' },
      _sum: { points: true },
    }),
  ]);
  const target = Math.min(
    earn.points,
    wholePoints(multiply(refunds._sum.amount ?? ZERO, earn.programVersion.earnRate))
  );
  const alreadyReversed = -(reversals._sum.points ?? 0);
  const points = target - alreadyReversed;
  if (points <= 0) return null;
  return tx.loyaltyPointsEntry.create({
    data: {
      accountId: earn.accountId,
      programVersionId: earn.programVersionId,
      kind: 'REVERSAL',
      points: -points,
      billId: input.billId,
      refundId: input.refundId,
      reversesEntryId: earn.id,
      occurredAt: input.at,
      idempotencyKey,
    },
  });
}
