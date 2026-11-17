import 'server-only';

import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { foldExpectedCash, type FoldableMovement } from './drawer-sessions';
import { add, multiply, roundMoney, sub, sum, ZERO } from './money';
import { enqueue, SchedulerError } from './scheduler';
import type { RestaurantJobHandler } from './job-handlers-core';

export const INSIGHTS_ROLLUP_DAY_JOB = 'insights.rollupDay';
export const MAX_BACKFILL_CHUNK_DAYS = 90;
export const INSIGHT_PROJECTION_VERSION = 4;

export type RollupErrorReason = 'CLOSE_NOT_FOUND' | 'RECONCILIATION_FAILED' | 'INVALID';

export class RollupError extends Error {
  constructor(
    message: string,
    readonly reason: RollupErrorReason
  ) {
    super(message);
    this.name = 'RollupError';
  }
}

type RawBill = {
  status: 'OPEN' | 'SETTLED' | 'VOID';
  subtotal: Prisma.Decimal;
  deliveryFeeTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
};

type RawDrawer = {
  countedCash: Prisma.Decimal | null;
  movements: FoldableMovement[];
};

export type ReconciledFinancials = {
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  deliveryFeeSales: Prisma.Decimal;
  deliveryFeeRefunds: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  tipTotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
  voidTotal: Prisma.Decimal;
  cashExpected: Prisma.Decimal;
  cashCounted: Prisma.Decimal;
  cashVariance: Prisma.Decimal;
};

export function computeReconciledFinancials(input: {
  bills: readonly RawBill[];
  tenders: readonly { tipAmount: Prisma.Decimal }[];
  refunds: readonly {
    amount: Prisma.Decimal;
    taxRefundAmount: Prisma.Decimal;
    serviceChargeRefundAmount: Prisma.Decimal;
    deliveryFeeRefundAmount: Prisma.Decimal;
    /** Refunded share of a fractional bill's untaxed remainder cent. */
    roundingRefundAmount?: Prisma.Decimal;
  }[];
  drawers: readonly RawDrawer[];
}): ReconciledFinancials {
  const settled = input.bills.filter((bill) => bill.status === 'SETTLED');
  const grossSales = sum(settled.map((bill) => bill.subtotal));
  const compTotal = sum(settled.map((bill) => bill.compTotal));
  const discountTotal = sum(settled.map((bill) => bill.discountTotal));
  const cashExpected = sum(input.drawers.map((drawer) => foldExpectedCash(drawer.movements)));
  const cashCounted = sum(input.drawers.map((drawer) => drawer.countedCash ?? ZERO));
  const refundedTaxTotal = sum(input.refunds.map((refund) => refund.taxRefundAmount));
  const refundedServiceChargeTotal = sum(
    input.refunds.map((refund) => refund.serviceChargeRefundAmount)
  );
  const deliveryFeeRefunds = sum(input.refunds.map((refund) => refund.deliveryFeeRefundAmount));
  const refundTotal = sub(sum(input.refunds.map((refund) => refund.amount)), deliveryFeeRefunds);
  const refundedSales = sum(
    input.refunds.map((refund) =>
      sub(
        sub(
          sub(sub(refund.amount, refund.taxRefundAmount), refund.serviceChargeRefundAmount),
          refund.deliveryFeeRefundAmount
        ),
        refund.roundingRefundAmount ?? ZERO
      )
    )
  );
  return {
    grossSales,
    netSales: sub(sub(sub(grossSales, compTotal), discountTotal), refundedSales),
    deliveryFeeSales: sum(settled.map((bill) => bill.deliveryFeeTotal)),
    deliveryFeeRefunds,
    taxTotal: sub(sum(settled.map((bill) => bill.taxTotal)), refundedTaxTotal),
    serviceChargeTotal: sub(
      sum(settled.map((bill) => bill.serviceChargeTotal)),
      refundedServiceChargeTotal
    ),
    tipTotal: sum(input.tenders.map((tender) => tender.tipAmount)),
    compTotal,
    discountTotal,
    refundTotal,
    voidTotal: sum(
      input.bills.filter((bill) => bill.status === 'VOID').map((bill) => bill.grandTotal)
    ),
    cashExpected,
    cashCounted,
    cashVariance: sub(cashCounted, cashExpected),
  };
}

export type ItemMixInput = {
  productId: string;
  unitPrice: Prisma.Decimal;
  quantity: number;
  modifiers: readonly { priceDelta: Prisma.Decimal }[];
  billLines: readonly { compAmount: Prisma.Decimal }[];
};

export type ItemMixProjection = {
  productId: string;
  quantity: number;
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
};

/** Frozen order-item prices are authoritative; catalog prices are never re-read. */
export function computeItemMix(items: readonly ItemMixInput[]): ItemMixProjection[] {
  const byProduct = new Map<string, ItemMixProjection>();
  for (const item of items) {
    const grossSales = roundMoney(
      multiply(
        add(item.unitPrice, sum(item.modifiers.map((modifier) => modifier.priceDelta))),
        item.quantity
      )
    );
    const compTotal = sum(item.billLines.map((line) => line.compAmount));
    const current = byProduct.get(item.productId) ?? {
      productId: item.productId,
      quantity: 0,
      grossSales: ZERO,
      netSales: ZERO,
      compTotal: ZERO,
    };
    current.quantity += item.quantity;
    current.grossSales = add(current.grossSales, grossSales);
    current.compTotal = add(current.compTotal, compTotal);
    current.netSales = sub(current.grossSales, current.compTotal);
    byProduct.set(item.productId, current);
  }
  return [...byProduct.values()].sort((left, right) =>
    left.productId.localeCompare(right.productId)
  );
}

export function computeLoyaltyLiability(
  entries: readonly { accountId: string; points: number }[],
  redemptionValue: Prisma.Decimal | null
): Prisma.Decimal {
  if (!redemptionValue) return ZERO;
  const balances = new Map<string, number>();
  for (const entry of entries) {
    balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0) + entry.points);
  }
  const positivePoints = [...balances.values()].filter((balance) => balance > 0);
  return roundMoney(multiply(sum(positivePoints), redemptionValue));
}

type LoyaltyLedgerFingerprint = {
  positivePoints: bigint;
  signedPoints: bigint;
};

async function computeLoyaltyLedgerFingerprint(
  db: ScopedDb,
  organizationId: string,
  cutoffAt: Date
): Promise<LoyaltyLedgerFingerprint> {
  const [fingerprint] = await db.$queryRaw<LoyaltyLedgerFingerprint[]>(Prisma.sql`
    WITH account_balances AS (
      SELECT "accountId", SUM(points)::bigint AS balance
      FROM restaurant_loyalty_points_entries
      WHERE "organizationId" = ${organizationId}
        AND "occurredAt" < ${cutoffAt}
      GROUP BY "accountId"
    )
    SELECT
      COALESCE(SUM(GREATEST(balance, 0)), 0)::bigint AS "positivePoints",
      COALESCE(SUM(balance), 0)::bigint AS "signedPoints"
    FROM account_balances
  `);
  if (!fingerprint) {
    throw new RollupError('Loyalty ledger fingerprint query returned no row.', 'INVALID');
  }
  return fingerprint;
}

export function businessDateCutoffUtc(businessDate: string, timeZone: string): Date {
  const date = businessDateToUtcDate(businessDate);
  const desiredWallTime = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1
  );
  let candidate = desiredWallTime;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (let pass = 0; pass < 2; pass++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((value) => value.type === type)?.value);
    const representedAsUtc = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour') % 24,
      part('minute'),
      part('second')
    );
    candidate += desiredWallTime - representedAsUtc;
  }
  return new Date(candidate);
}

type CloseTip = ReconciledFinancials & {
  id: string;
  createdAt: Date;
  supersedesCloseId: string | null;
};

function resolveCloseTip(closes: readonly CloseTip[]): CloseTip | null {
  const superseded = new Set(
    closes.map((close) => close.supersedesCloseId).filter((id): id is string => id !== null)
  );
  return closes.filter((close) => !superseded.has(close.id)).at(-1) ?? null;
}

function assertReconciles(
  close: CloseTip,
  raw: ReconciledFinancials,
  historical: ReconciledFinancials
): void {
  const keys = Object.keys(raw) as Array<keyof ReconciledFinancials>;
  const salesBeforeRefunds = sub(sub(raw.grossSales, raw.compTotal), raw.discountTotal);
  // Immutable closes may use the pre-#405 refund formula. Validate a complete
  // snapshot under either formula, never a mixture of historical/current fields.
  // Pre-WHA-1621 Q1 closes also omitted the net-sales refund deduction.
  if (
    [raw, historical].some((candidate) =>
      keys.every(
        (key) =>
          close[key].equals(candidate[key]) ||
          (key === 'netSales' && close.netSales.equals(salesBeforeRefunds))
      )
    )
  ) {
    return;
  }
  const mismatch = keys.find((key) => !close[key].equals(raw[key]));
  if (mismatch) {
    throw new RollupError(
      `Daily close reconciliation failed for ${mismatch}: close=${close[mismatch].toString()} raw=${raw[mismatch].toString()}.`,
      'RECONCILIATION_FAILED'
    );
  }
}

function runRollupTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

export type RollupDayInput = {
  branchId: string;
  businessDate: string;
  computedAt?: Date;
  force?: boolean;
};

export async function rollupDay(db: ScopedDb, input: RollupDayInput) {
  const businessDate = businessDateToUtcDate(input.businessDate);
  const computedAt = input.computedAt ?? new Date();
  return runRollupTransaction(db, async (tx) => {
    const branch = await tx.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { organizationId: true },
    });
    if (!branch) throw new RollupError('Restaurant branch not found.', 'INVALID');

    const closes = await tx.restaurantDailyClose.findMany({
      where: { branchId: input.branchId, businessDate },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        supersedesCloseId: true,
        grossSales: true,
        netSales: true,
        deliveryFeeSales: true,
        deliveryFeeRefunds: true,
        taxTotal: true,
        serviceChargeTotal: true,
        tipTotal: true,
        compTotal: true,
        discountTotal: true,
        refundTotal: true,
        voidTotal: true,
        cashExpected: true,
        cashCounted: true,
        cashVariance: true,
      },
    });
    const close = resolveCloseTip(closes as CloseTip[]);
    if (!close)
      throw new RollupError('No daily close exists for this branch and date.', 'CLOSE_NOT_FOUND');

    const bills = await tx.restaurantBill.findMany({
      where: { branchId: input.branchId, businessDate },
      select: {
        status: true,
        subtotal: true,
        deliveryFeeTotal: true,
        taxTotal: true,
        serviceChargeTotal: true,
        compTotal: true,
        discountTotal: true,
        grandTotal: true,
      },
    });
    const tenders = await tx.restaurantTender.findMany({
      where: { businessDate, bill: { branchId: input.branchId } },
      select: { tipAmount: true },
    });
    const refunds = await tx.restaurantRefund.findMany({
      where: { businessDate, bill: { branchId: input.branchId } },
      select: {
        amount: true,
        taxRefundAmount: true,
        serviceChargeRefundAmount: true,
        deliveryFeeRefundAmount: true,
        roundingRefundAmount: true,
      },
    });
    const drawers = await tx.restaurantDrawerSession.findMany({
      where: { branchId: input.branchId, businessDate },
      select: { countedCash: true, movements: { select: { kind: true, amount: true } } },
    });
    const raw = computeReconciledFinancials({
      bills: bills as RawBill[],
      tenders,
      refunds,
      drawers: drawers as RawDrawer[],
    });
    const settledBills = bills.filter((bill) => bill.status === 'SETTLED');
    const historicalRefundTotal = sum(refunds.map((refund) => refund.amount));
    assertReconciles(close, raw, {
      ...raw,
      netSales: sub(
        sub(sub(raw.grossSales, raw.compTotal), raw.discountTotal),
        historicalRefundTotal
      ),
      taxTotal: sum(settledBills.map((bill) => bill.taxTotal)),
      serviceChargeTotal: sum(settledBills.map((bill) => bill.serviceChargeTotal)),
      refundTotal: historicalRefundTotal,
    });

    const existing = await tx.insightDailyRollup.findFirst({
      where: { branchId: input.branchId, businessDate },
      select: { id: true, sourceDailyCloseId: true, projectionVersion: true },
    });
    const existingLiability = await tx.insightLoyaltyLiability.findFirst({
      where: { businessDate },
      select: {
        cutoffAt: true,
        programVersionId: true,
        redemptionValue: true,
        positivePoints: true,
        signedPoints: true,
        liability: true,
        projectionVersion: true,
      },
    });
    const orders = await tx.restaurantOrder.findMany({
      where: { branchId: input.branchId, businessDate, status: 'CLOSED' },
      select: {
        coverCount: true,
        items: {
          where: { status: { not: 'VOIDED' }, remakeOfItemId: null },
          select: {
            productId: true,
            unitPrice: true,
            quantity: true,
            modifiers: { select: { priceDelta: true } },
            billLines: {
              where: { bill: { status: 'SETTLED' } },
              select: { compAmount: true },
            },
          },
        },
      },
    });
    const items = computeItemMix(orders.flatMap((order) => order.items) as ItemMixInput[]);
    const existingItems = await tx.insightItemMixRollup.findMany({
      where: { branchId: input.branchId, businessDate },
      select: { sourceDailyCloseId: true, projectionVersion: true },
    });

    const organization = await tx.organization.findUnique({
      where: { id: branch.organizationId },
      select: { timezone: true },
    });
    if (!organization) throw new RollupError('Restaurant organization not found.', 'INVALID');
    const cutoffAt = businessDateCutoffUtc(input.businessDate, organization.timezone);
    const program = await tx.loyaltyProgramVersion.findFirst({
      where: { effectiveFrom: { lt: cutoffAt } },
      orderBy: { effectiveFrom: 'desc' },
      select: { id: true, redemptionValue: true },
    });
    const { positivePoints, signedPoints } = await computeLoyaltyLedgerFingerprint(
      tx,
      branch.organizationId,
      cutoffAt
    );
    const loyaltyLiability = program
      ? roundMoney(multiply(new Prisma.Decimal(positivePoints.toString()), program.redemptionValue))
      : ZERO;
    if (
      !input.force &&
      existing?.sourceDailyCloseId === close.id &&
      existing.projectionVersion === INSIGHT_PROJECTION_VERSION &&
      existingLiability?.projectionVersion === INSIGHT_PROJECTION_VERSION &&
      existingLiability.cutoffAt.getTime() === cutoffAt.getTime() &&
      existingLiability.programVersionId === (program?.id ?? null) &&
      existingLiability.redemptionValue.equals(program?.redemptionValue ?? ZERO) &&
      existingLiability.positivePoints === positivePoints &&
      existingLiability.signedPoints === signedPoints &&
      existingLiability.liability.equals(loyaltyLiability) &&
      existingItems.length === items.length &&
      existingItems.every(
        (item) =>
          item.sourceDailyCloseId === close.id &&
          item.projectionVersion === INSIGHT_PROJECTION_VERSION
      )
    ) {
      return {
        dailyRollupId: existing.id,
        sourceDailyCloseId: close.id,
        itemCount: items.length,
        replayed: true,
      };
    }

    await tx.insightLoyaltyLiability.upsert({
      where: {
        organizationId_businessDate: { organizationId: branch.organizationId, businessDate },
      },
      create: {
        businessDate,
        cutoffAt,
        programVersionId: program?.id ?? null,
        redemptionValue: program?.redemptionValue ?? ZERO,
        positivePoints,
        signedPoints,
        liability: loyaltyLiability,
        projectionVersion: INSIGHT_PROJECTION_VERSION,
        computedAt,
      },
      update: {
        cutoffAt,
        programVersionId: program?.id ?? null,
        redemptionValue: program?.redemptionValue ?? ZERO,
        positivePoints,
        signedPoints,
        liability: loyaltyLiability,
        projectionVersion: INSIGHT_PROJECTION_VERSION,
        computedAt,
      },
    });

    await tx.insightItemMixRollup.deleteMany({
      where: { branchId: input.branchId, businessDate },
    });
    const daily = await tx.insightDailyRollup.upsert({
      where: {
        organizationId_branchId_businessDate: {
          organizationId: branch.organizationId,
          branchId: input.branchId,
          businessDate,
        },
      },
      create: {
        branchId: input.branchId,
        businessDate,
        sourceDailyCloseId: close.id,
        orderCount: orders.length,
        coverCount: orders.reduce((total, order) => total + (order.coverCount ?? 0), 0),
        grossSales: close.grossSales,
        netSales: raw.netSales,
        deliveryFeeSales: close.deliveryFeeSales,
        deliveryFeeRefunds: close.deliveryFeeRefunds,
        compTotal: close.compTotal,
        refundTotal: raw.refundTotal,
        voidTotal: close.voidTotal,
        drawerVariance: close.cashVariance,
        loyaltyLiability: ZERO,
        projectionVersion: INSIGHT_PROJECTION_VERSION,
        computedAt,
      },
      update: {
        sourceDailyCloseId: close.id,
        orderCount: orders.length,
        coverCount: orders.reduce((total, order) => total + (order.coverCount ?? 0), 0),
        grossSales: close.grossSales,
        netSales: raw.netSales,
        deliveryFeeSales: close.deliveryFeeSales,
        deliveryFeeRefunds: close.deliveryFeeRefunds,
        compTotal: close.compTotal,
        refundTotal: raw.refundTotal,
        voidTotal: close.voidTotal,
        drawerVariance: close.cashVariance,
        loyaltyLiability: ZERO,
        projectionVersion: INSIGHT_PROJECTION_VERSION,
        computedAt,
      },
      select: { id: true },
    });
    if (items.length > 0) {
      await tx.insightItemMixRollup.createMany({
        data: items.map((item) => ({
          branchId: input.branchId,
          businessDate,
          productId: item.productId,
          sourceDailyCloseId: close.id,
          quantity: item.quantity,
          grossSales: item.grossSales,
          netSales: item.netSales,
          compTotal: item.compTotal,
          projectionVersion: INSIGHT_PROJECTION_VERSION,
          computedAt,
        })),
      });
    }
    return {
      dailyRollupId: daily.id,
      sourceDailyCloseId: close.id,
      itemCount: items.length,
      replayed: false,
    };
  });
}

export function insightRollupJobKey(input: {
  branchId: string;
  businessDate: string;
  sourceDailyCloseId?: string;
  requestId?: string;
}): string {
  return `insights.rollupDay:${input.branchId}:${input.businessDate}:${input.sourceDailyCloseId ?? `backfill:${input.requestId ?? 'manual'}`}`;
}

export async function enqueueInsightRollup(
  db: ScopedDb,
  input: { branchId: string; businessDate: string; sourceDailyCloseId?: string; requestId?: string }
) {
  const job = {
    type: INSIGHTS_ROLLUP_DAY_JOB,
    payload: {
      branchId: input.branchId,
      businessDate: input.businessDate,
      ...(input.requestId ? { force: true } : {}),
    },
    idempotencyKey: insightRollupJobKey(input),
  } as const;
  try {
    return await enqueue(db, job);
  } catch (error) {
    if (error instanceof SchedulerError && error.reason === 'DUPLICATE_ENQUEUE') {
      return enqueue(db, job);
    }
    throw error;
  }
}

export function chunkBusinessDateRange(from: string, to: string) {
  const start = businessDateToUtcDate(from);
  const end = businessDateToUtcDate(to);
  if (start > end)
    throw new RollupError('Backfill start date must not be after end date.', 'INVALID');
  const chunks: Array<{ from: string; to: string }> = [];
  for (let cursor = start; cursor <= end;) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + MAX_BACKFILL_CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: cursor.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

export async function enqueueInsightBackfill(
  db: ScopedDb,
  input: { branchId: string; from: string; to: string; requestId: string }
) {
  const chunks = chunkBusinessDateRange(input.from, input.to);
  if (chunks.length !== 1) {
    throw new RollupError(
      `Backfill ranges may not exceed ${MAX_BACKFILL_CHUNK_DAYS} days.`,
      'INVALID'
    );
  }
  let enqueued = 0;
  let deduplicated = 0;
  for (const chunk of chunks) {
    for (
      let date = businessDateToUtcDate(chunk.from), end = businessDateToUtcDate(chunk.to);
      date <= end;
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      const result = await enqueueInsightRollup(db, {
        branchId: input.branchId,
        businessDate: date.toISOString().slice(0, 10),
        requestId: input.requestId,
      });
      if (result.deduplicated) deduplicated++;
      else enqueued++;
    }
  }
  return { chunks, enqueued, deduplicated };
}

const ROLLUP_PAYLOAD = z
  .object({
    branchId: z.string().min(1),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    force: z.boolean().optional(),
  })
  .strict();

export const rollupDayHandler: RestaurantJobHandler = async ({ db, job }) => {
  const payload = ROLLUP_PAYLOAD.parse(job.payload);
  await rollupDay(db, payload);
};
