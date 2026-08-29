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

/**
 * The single program version in force at `at` — the latest one whose `effectiveFrom`
 * has already passed. Exported so the POS read model can price a redemption preview
 * off exactly the version `redeemLoyaltyPoints` will book against, instead of forking
 * a second "which program applies" rule.
 */
export async function effectiveProgram(tx: ScopedDb, at: Date) {
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

/**
 * The money a bill may still earn on: its grand total NET of every refund already
 * booked against it, floored at zero.
 *
 * A bill can be SETTLED and refunded while its order still sits in PAYMENT_PENDING,
 * so the close may run after the refund. Netting here is what keeps the M8 rule
 * "no points are earned on refunded money" true regardless of which side of the
 * close the refund lands on; `reverseLoyaltyForRefund` re-derives the same target
 * for refunds that arrive after the earn, so the two paths never double-count.
 */
export function netEarnableAmount(
  grandTotal: Prisma.Decimal,
  refunded: Prisma.Decimal
): Prisma.Decimal {
  const net = sub(grandTotal, refunded);
  return compare(net, ZERO) > 0 ? net : ZERO;
}

/**
 * Called inside order-close transaction after CLOSED is persisted.
 *
 * SERIALIZATION (M8/M2). The earn and a refund on the same bill both decide how many
 * points the guest keeps, from state the other one writes — so they must not run
 * concurrently. Without a lock they can interleave into a double credit: `refundTender`
 * locks the bill, appends its refund and asks `reverseLoyaltyForRefund` for a reversal,
 * which correctly finds no EARN yet; the close, reading refunds unlocked, sees no
 * refund either and writes the FULL earn; both commit and the guest has earned on
 * refunded money with nothing to reverse it.
 *
 * The fix is to make this function take the SAME `restaurant_bills` row lock
 * `refundTender` takes (bill by bill, ascending id — the order `bills.ts` uses for the
 * re-cut's multi-bill lock too, so neither can deadlock the other) BEFORE it reads the
 * refunds it nets out, and to hold it until the close commits. That leaves exactly two
 * orderings, both correct:
 *
 *   - the close acquires first — the refund blocks until the EARN is committed and
 *     visible, so `reverseLoyaltyForRefund` reverses it;
 *   - the refund acquires first — the close blocks, and the `findMany` below (a new
 *     statement, hence a fresh READ COMMITTED snapshot taken after the wait) sees the
 *     committed refund and earns on the net.
 *
 * Under an isolation level above READ COMMITTED the blocked side aborts with a
 * serialization failure instead of proceeding on a stale snapshot — also safe.
 */
export async function earnLoyaltyForClosedOrder(tx: ScopedDb, orderId: string, at: Date) {
  const order = await tx.restaurantOrder.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      customerId: true,
      bills: { where: { status: 'SETTLED' }, orderBy: { id: 'asc' }, select: { id: true } },
    },
  });
  if (!order || order.status !== 'CLOSED' || !order.customerId) return [];

  const account = await tx.loyaltyAccount.findUnique({
    where: { customerId: order.customerId },
    select: { id: true, active: true },
  });
  if (!account?.active) return [];

  const billIds = order.bills.map((bill) => bill.id);
  if (billIds.length === 0) return [];
  for (const billId of billIds) {
    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${billId} FOR UPDATE`;
  }
  // Read AFTER the lock, never before: this is the snapshot the earn is computed on.
  const bills = await tx.restaurantBill.findMany({
    where: { id: { in: billIds } },
    orderBy: { id: 'asc' },
    select: { id: true, grandTotal: true, refunds: { select: { amount: true } } },
  });

  const program = await effectiveProgram(tx, at);
  const created: { id: string; billId: string | null; points: number }[] = [];
  for (const bill of bills) {
    const idempotencyKey = `loyalty:earn:${bill.id}`;
    const prior = await tx.loyaltyPointsEntry.findFirst({
      where: { idempotencyKey },
      select: { id: true, billId: true, points: true },
    });
    if (prior) {
      created.push(prior);
      continue;
    }
    const earnable = netEarnableAmount(bill.grandTotal, sum(bill.refunds.map((r) => r.amount)));
    const points = wholePoints(multiply(earnable, program.earnRate));
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

/**
 * Append the loyalty earn for one successfully settled bill using the eligible
 * merchandise basis frozen by settlement. The caller owns the transaction: this
 * function deliberately does not open one, so the earn cannot survive a rollback
 * of the tax snapshot, bill totals, promotion consumption, tender, or receipt.
 *
 * The idempotency key is shared with the legacy order-close path. During rollout,
 * whichever path reaches the bill first owns the single EARN row and the other is
 * an exact no-op.
 */
export async function accrueLoyaltyForSettledBill(
  tx: ScopedDb,
  input: { billId: string; eligibleNetMerchandise: Prisma.Decimal; at: Date }
) {
  const bill = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: { order: { select: { customerId: true } } },
  });
  const customerId = bill?.order.customerId;
  if (!customerId) return null;

  const account = await tx.loyaltyAccount.findUnique({
    where: { customerId },
    select: { id: true, active: true },
  });
  if (!account?.active) return null;

  const idempotencyKey = `loyalty:earn:${input.billId}`;
  const prior = await tx.loyaltyPointsEntry.findFirst({
    where: { idempotencyKey },
    select: { id: true, billId: true, points: true },
  });
  if (prior) return prior;

  const eligible = money(input.eligibleNetMerchandise);
  if (eligible.isNegative()) {
    throw new LoyaltyError('Settlement loyalty basis cannot be negative.', 'INVALID');
  }
  const program = await effectiveProgram(tx, input.at);
  const points = wholePoints(multiply(eligible, program.earnRate));
  if (points === 0) return null;

  const expiresAt = program.expiryDays
    ? new Date(input.at.getTime() + program.expiryDays * 86_400_000)
    : null;
  return tx.loyaltyPointsEntry.create({
    data: {
      accountId: account.id,
      programVersionId: program.id,
      kind: 'EARN',
      points,
      billId: input.billId,
      expiresAt,
      occurredAt: input.at,
      idempotencyKey,
    },
    select: { id: true, billId: true, points: true },
  });
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
  // No EARN yet: the refund precedes the order close, and the close nets it out of
  // the earn itself (`netEarnableAmount`). Nothing to reverse.
  if (!earn) return null;
  const idempotencyKey = `loyalty:reversal:${input.refundId}`;
  const prior = await tx.loyaltyPointsEntry.findFirst({ where: { idempotencyKey } });
  if (prior) return prior;

  const [bill, refunds, reversals] = await Promise.all([
    tx.restaurantBill.findUnique({
      where: { id: input.billId },
      select: { grandTotal: true },
    }),
    tx.restaurantRefund.aggregate({
      where: { billId: input.billId },
      _sum: { amount: true },
    }),
    tx.loyaltyPointsEntry.aggregate({
      where: { reversesEntryId: earn.id, kind: 'REVERSAL' },
      _sum: { points: true },
    }),
  ]);
  if (!bill) throw new LoyaltyError('The refunded bill does not exist.', 'NOT_FOUND');

  // Target the SAME ledger identity the close used — points on the bill must always
  // equal the whole points earnable on its net-of-refunds total. Deriving the
  // reversal from that identity (rather than from Σ refunds alone) is what keeps a
  // pre-close refund, which the earn already netted out, from being charged twice.
  const earnable = netEarnableAmount(bill.grandTotal, refunds._sum.amount ?? ZERO);
  const target = earn.points - wholePoints(multiply(earnable, earn.programVersion.earnRate));
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

// ── Redemption release (comp / void-and-recut compensation) ──────────────────

/**
 * What one release command wrote. `entryIds` empty ⇒ it released nothing.
 *
 * A REPLAY deliberately carries no money. The value a release frees is not a function
 * of that release alone: cumulative rounding makes it
 * `round((before + take) × v) − round(before × v)`, where `before` is how many points of
 * the same redemption EARLIER commands had already given back. Answering for the money
 * after the fact therefore means reconstructing `before` out of the ledger — and with a
 * fractional redemption value a release that lands AFTER this one shifts that
 * reconstruction by a cent, so the "replay" would report a number the original call
 * never returned. No column repairs the ordering either: `occurredAt` is caller-supplied
 * and `createdAt` is transaction START time, so a transaction that began earlier can
 * commit later.
 *
 * The money is therefore returned exactly once, by the call that actually wrote the
 * entries, and a caller that must answer for it on its OWN replay persists it with its
 * own idempotency record — `bills.compLine` does exactly that. The union shape is what
 * enforces it: there is no `value` to read off a replay.
 */
export type LoyaltyReleaseResult =
  | {
      replayed: false;
      /** Discount money freed by THIS call; the caller MUST apply it to the bill. */
      value: Prisma.Decimal;
      /** Whole points restored to the account. */
      points: number;
      entryIds: string[];
    }
  | { replayed: true; points: number; entryIds: string[] };

const nothingReleased = (): LoyaltyReleaseResult => ({
  replayed: false,
  value: ZERO,
  points: 0,
  entryIds: [],
});

/** The money a release of `take` further points frees, given `before` points of this
 * redemption were already released. Rounding is applied to the CUMULATIVE released
 * points so a sequence of partial releases sums to exactly the value the redemption
 * originally took off the bill — never a cent more. */
function releasedValueDelta(before: number, take: number, redemptionValue: Prisma.Decimal) {
  return sub(
    roundMoney(multiply(before + take, redemptionValue)),
    roundMoney(multiply(before, redemptionValue))
  );
}

function releaseKeyPrefix(idempotencyKey: string) {
  return `loyalty:release:${idempotencyKey}:`;
}

/**
 * Give back loyalty redemption a bill can no longer carry, and restore the points.
 *
 * Two lifecycle events strand a guest's spent points against a bill they will never
 * pay: comping the line the redemption was applied to (the discount would push
 * `grandTotal` below zero), and a void-and-recut that leaves the REDEEM pinned to a
 * VOID bill while a fresh, undiscounted bill is issued. Both are compensated here —
 * append-only, inside the caller's transaction, so the bill mutation and the ledger
 * entry commit or roll back together.
 *
 * The compensation is a positive `ADJUSTMENT` linked to the REDEEM it releases
 * (`reversesEntryId`): the M8 ledger CHECK reserves `REVERSAL` for a negative,
 * refund-bound entry, and giving points BACK is the opposite direction. Redemptions
 * are consumed FIFO and only as far as `shortfall` requires, so a comp releases the
 * minimum that keeps `grandTotal >= 0` and the guest keeps the rest.
 *
 * Returns the money released — the caller subtracts it from `discountTotal` and adds
 * it back to `grandTotal`, which preserves
 * `subtotal = grandTotal + compTotal + discountTotal`.
 */
export async function releaseLoyaltyRedemption(
  tx: ScopedDb,
  input: {
    billId: string;
    /** Money that must be freed; `null` releases the whole remaining redemption. */
    shortfall: Prisma.Decimal | null;
    actorId: string;
    reason: string;
    /** Command-unique suffix. One entry per released redemption keys off it. */
    idempotencyKey: string;
    at: Date;
  }
): Promise<LoyaltyReleaseResult> {
  const actorId = input.actorId.trim();
  const reason = input.reason.trim();
  if (!actorId || !reason) {
    throw new LoyaltyError('A redemption release requires an actor and reason.', 'INVALID');
  }

  // A replay of THIS command: it already wrote its entries, so write nothing more.
  // COMMAND-LOCAL by construction — the only rows consulted are the ones this command's
  // own key prefix owns, never a neighbouring release against the same redemption, so
  // the answer cannot drift as the ledger grows underneath it.
  const keyPrefix = releaseKeyPrefix(input.idempotencyKey);
  const mine = await tx.loyaltyPointsEntry.findMany({
    where: { kind: 'ADJUSTMENT', idempotencyKey: { startsWith: keyPrefix } },
    select: { id: true, points: true },
  });
  if (mine.length > 0) {
    return {
      replayed: true,
      points: mine.reduce((total, row) => total + row.points, 0),
      entryIds: mine.map((row) => row.id),
    };
  }

  const redemptions = await tx.loyaltyPointsEntry.findMany({
    where: { billId: input.billId, kind: 'REDEEM' },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      accountId: true,
      points: true,
      programVersionId: true,
      programVersion: { select: { redemptionValue: true } },
    },
  });
  if (redemptions.length === 0) return nothingReleased();

  const releases = await tx.loyaltyPointsEntry.findMany({
    where: {
      kind: 'ADJUSTMENT',
      reversesEntryId: { in: redemptions.map((entry) => entry.id) },
    },
    select: { id: true, points: true, reversesEntryId: true },
  });

  const bill = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: { discountTotal: true },
  });
  if (!bill) throw new LoyaltyError('The bill does not exist.', 'NOT_FOUND');
  // Never hand back more than the bill still carries: `discountTotal` is the exact
  // sum of what the redemptions took off it, and it may not go negative (DB CHECK).
  const requested = input.shortfall ?? bill.discountTotal;
  const needed = compare(requested, bill.discountTotal) > 0 ? bill.discountTotal : requested;
  if (compare(needed, ZERO) <= 0) return nothingReleased();

  let value = ZERO;
  let points = 0;
  const entryIds: string[] = [];
  for (const redemption of redemptions) {
    if (compare(value, needed) >= 0) break;
    const before = releases
      .filter((row) => row.reversesEntryId === redemption.id)
      .reduce((total, row) => total + row.points, 0);
    const remaining = -redemption.points - before;
    if (remaining <= 0) continue;

    const redemptionValue = redemption.programVersion.redemptionValue;
    const outstanding = sub(needed, value);
    // The whole points whose value covers what is still outstanding. When cumulative
    // rounding leaves the estimate a cent short, release this redemption in full and
    // let the next one (if any) close the gap.
    const estimate = outstanding
      .dividedBy(redemptionValue)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL)
      .toNumber();
    let take = Math.min(remaining, Math.max(1, Number.isFinite(estimate) ? estimate : remaining));
    if (compare(releasedValueDelta(before, take, redemptionValue), outstanding) < 0) {
      take = remaining;
    }

    const entry = await tx.loyaltyPointsEntry.create({
      data: {
        accountId: redemption.accountId,
        programVersionId: redemption.programVersionId,
        kind: 'ADJUSTMENT',
        points: take,
        billId: input.billId,
        reversesEntryId: redemption.id,
        actorId,
        reason,
        occurredAt: input.at,
        idempotencyKey: `${keyPrefix}${redemption.id}`,
      },
      select: { id: true },
    });
    entryIds.push(entry.id);
    value = add(value, releasedValueDelta(before, take, redemptionValue));
    points += take;
  }
  return { replayed: false, value, points, entryIds };
}
