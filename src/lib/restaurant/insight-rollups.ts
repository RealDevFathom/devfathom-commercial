import 'server-only';

import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { foldExpectedCash, type FoldableMovement } from './drawer-sessions';
import { add, multiply, roundMoney, sub, sum, ZERO } from './money';
import { enqueue } from './scheduler';
import type { RestaurantJobHandler } from './job-handlers';

export const INSIGHTS_ROLLUP_DAY_JOB = 'insights.rollupDay';
export const MAX_BACKFILL_CHUNK_DAYS = 90;
export const MAX_BACKFILL_TOTAL_DAYS = 366;

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
  refunds: readonly { amount: Prisma.Decimal }[];
  drawers: readonly RawDrawer[];
}): ReconciledFinancials {
  const settled = input.bills.filter((bill) => bill.status === 'SETTLED');
  const grossSales = sum(settled.map((bill) => bill.subtotal));
  const compTotal = sum(settled.map((bill) => bill.compTotal));
  const discountTotal = sum(settled.map((bill) => bill.discountTotal));
  const cashExpected = sum(input.drawers.map((drawer) => foldExpectedCash(drawer.movements)));
  const cashCounted = sum(input.drawers.map((drawer) => drawer.countedCash ?? ZERO));
  return {
    grossSales,
    netSales: sub(sub(grossSales, compTotal), discountTotal),
    taxTotal: sum(settled.map((bill) => bill.taxTotal)),
    serviceChargeTotal: sum(settled.map((bill) => bill.serviceChargeTotal)),
    tipTotal: sum(input.tenders.map((tender) => tender.tipAmount)),
    compTotal,
    discountTotal,
    refundTotal: sum(input.refunds.map((refund) => refund.amount)),
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

function assertReconciles(close: CloseTip, raw: ReconciledFinancials): void {
  const mismatch = (Object.keys(raw) as Array<keyof ReconciledFinancials>).find(
    (key) => !close[key].equals(raw[key])
  );
  if (mismatch) {
    throw new RollupError(
      `Daily close reconciliation failed for ${mismatch}.`,
      'RECONCILIATION_FAILED'
    );
  }
}

function runRollupTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

/** First instant whose organization-local calendar date is the following day. */
function nextLocalDayBoundary(businessDate: Date, timeZone: string): Date {
  const nextDate = new Date(businessDate);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const target = nextDate.toISOString().slice(0, 10);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new RollupError('Organization timezone is invalid.', 'INVALID');
  }
  const localDate = (milliseconds: number) => {
    const parts = formatter.formatToParts(milliseconds);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  let low = nextDate.getTime() - 36 * 60 * 60 * 1_000;
  let high = nextDate.getTime() + 36 * 60 * 60 * 1_000;
  if (localDate(low) >= target || localDate(high) < target) {
    throw new RollupError('Organization day boundary could not be resolved.', 'INVALID');
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle) < target) low = middle;
    else high = middle;
  }
  return new Date(high);
}

export type RollupDayInput = { branchId: string; businessDate: string; computedAt?: Date };

export async function rollupDay(db: ScopedDb, input: RollupDayInput) {
  const businessDate = businessDateToUtcDate(input.businessDate);
  const computedAt = input.computedAt ?? new Date();
  return runRollupTransaction(db, async (tx) => {
    const branch = await tx.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { organizationId: true },
    });
    if (!branch) throw new RollupError('Restaurant branch not found.', 'INVALID');
    const organization = await tx.organization.findUnique({
      where: { id: branch.organizationId },
      select: { timezone: true },
    });
    if (!organization) throw new RollupError('Restaurant organization not found.', 'INVALID');
    const liabilityCutoff = nextLocalDayBoundary(businessDate, organization.timezone);

    const closes = await tx.restaurantDailyClose.findMany({
      where: { branchId: input.branchId, businessDate },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        supersedesCloseId: true,
        grossSales: true,
        netSales: true,
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
      select: { amount: true },
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
    assertReconciles(close, raw);

    const program = await tx.loyaltyProgramVersion.findFirst({
      where: { effectiveFrom: { lt: liabilityCutoff } },
      orderBy: { effectiveFrom: 'desc' },
      select: { redemptionValue: true },
    });
    const loyaltyEntries = await tx.loyaltyPointsEntry.findMany({
      where: { occurredAt: { lt: liabilityCutoff } },
      select: { accountId: true, points: true },
    });
    const loyaltyLiability = computeLoyaltyLiability(
      loyaltyEntries,
      program?.redemptionValue ?? null
    );
    const liabilityFact = await tx.insightLoyaltyLiabilityRollup.upsert({
      where: {
        organizationId_businessDate: {
          organizationId: branch.organizationId,
          businessDate,
        },
      },
      create: { businessDate, liability: loyaltyLiability, computedAt },
      update: { liability: loyaltyLiability, computedAt },
      select: { id: true },
    });

    const existing = await tx.insightDailyRollup.findFirst({
      where: { branchId: input.branchId, businessDate },
      select: { id: true, sourceDailyCloseId: true, loyaltyLiabilityRollupId: true },
    });
    if (existing?.sourceDailyCloseId === close.id) {
      if (existing.loyaltyLiabilityRollupId !== liabilityFact.id) {
        await tx.insightDailyRollup.update({
          where: { id: existing.id },
          data: { loyaltyLiabilityRollupId: liabilityFact.id },
        });
      }
      return {
        dailyRollupId: existing.id,
        sourceDailyCloseId: close.id,
        itemCount: 0,
        replayed: true,
      };
    }

    const orders = await tx.restaurantOrder.findMany({
      where: { branchId: input.branchId, businessDate, status: 'CLOSED' },
      select: {
        coverCount: true,
        items: {
          where: { status: { not: 'VOIDED' } },
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
        loyaltyLiabilityRollupId: liabilityFact.id,
        orderCount: orders.length,
        coverCount: orders.reduce((total, order) => total + (order.coverCount ?? 0), 0),
        grossSales: close.grossSales,
        netSales: close.netSales,
        compTotal: close.compTotal,
        refundTotal: close.refundTotal,
        voidTotal: close.voidTotal,
        drawerVariance: close.cashVariance,
        loyaltyLiability: ZERO,
        computedAt,
      },
      update: {
        sourceDailyCloseId: close.id,
        loyaltyLiabilityRollupId: liabilityFact.id,
        orderCount: orders.length,
        coverCount: orders.reduce((total, order) => total + (order.coverCount ?? 0), 0),
        grossSales: close.grossSales,
        netSales: close.netSales,
        compTotal: close.compTotal,
        refundTotal: close.refundTotal,
        voidTotal: close.voidTotal,
        drawerVariance: close.cashVariance,
        loyaltyLiability: ZERO,
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
  rebuild?: boolean;
  rebuildGeneration?: number;
}): string {
  const source =
    input.sourceDailyCloseId ??
    (input.rebuild ? `rebuild:${input.rebuildGeneration ?? 1}` : 'initial');
  return `insights.rollupDay:${input.branchId}:${input.businessDate}:${source}`;
}

const TERMINAL_JOB_STATUSES = ['SUCCEEDED', 'FAILED', 'DEAD'] as const;

function isDuplicateEnqueue(error: unknown): boolean {
  return (
    error instanceof Error && (error as Error & { reason?: unknown }).reason === 'DUPLICATE_ENQUEUE'
  );
}

export async function enqueueInsightRollup(
  db: ScopedDb,
  input: {
    branchId: string;
    businessDate: string;
    sourceDailyCloseId?: string;
    rebuild?: boolean;
  }
) {
  const payload = { branchId: input.branchId, businessDate: input.businessDate };
  if (input.rebuild) {
    const prefix = `insights.rollupDay:${input.branchId}:${input.businessDate}:rebuild:`;
    return runRollupTransaction(db, async (tx) => {
      const generationOf = (idempotencyKey: string | null) => {
        const value = Number(idempotencyKey?.slice(prefix.length));
        return Number.isSafeInteger(value) && value > 0 ? value : 0;
      };
      const observed = await tx.restaurantJob.findMany({
        where: { idempotencyKey: { startsWith: prefix } },
      });
      const observedActive = observed.find(
        (job) => !(TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)
      );
      if (observedActive) return { job: observedActive, deduplicated: true };
      const observedGeneration = observed.reduce(
        (latest, job) => Math.max(latest, generationOf(job.idempotencyKey)),
        0
      );

      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${prefix}, 0)) AS acquired
      `);
      if (!lock?.acquired) {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${prefix}, 0))
        `);
      }
      const history = await tx.restaurantJob.findMany({
        where: { idempotencyKey: { startsWith: prefix } },
      });
      const active = history.find(
        (job) => !(TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)
      );
      if (active) return { job: active, deduplicated: true };
      const generation = history.reduce(
        (latest, job) => Math.max(latest, generationOf(job.idempotencyKey)),
        0
      );
      if (!lock?.acquired && generation > observedGeneration) {
        const concurrent = history.find((job) => generationOf(job.idempotencyKey) === generation);
        if (concurrent) return { job: concurrent, deduplicated: true };
      }
      return enqueue(tx, {
        type: INSIGHTS_ROLLUP_DAY_JOB,
        payload,
        idempotencyKey: insightRollupJobKey({
          ...input,
          rebuildGeneration: generation + 1,
        }),
      });
    });
  }
  const idempotencyKey = insightRollupJobKey(input);
  const enqueueInput = {
    type: INSIGHTS_ROLLUP_DAY_JOB,
    payload,
    idempotencyKey,
  };
  try {
    return await enqueue(db, enqueueInput);
  } catch (error) {
    if (!isDuplicateEnqueue(error)) throw error;
    return enqueue(db, enqueueInput);
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
  input: { branchId: string; from: string; to: string }
) {
  const start = businessDateToUtcDate(input.from);
  const end = businessDateToUtcDate(input.to);
  const totalDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (totalDays > MAX_BACKFILL_TOTAL_DAYS) {
    throw new RollupError(
      `Backfill range may contain at most ${MAX_BACKFILL_TOTAL_DAYS} inclusive days.`,
      'INVALID'
    );
  }
  const chunks = chunkBusinessDateRange(input.from, input.to);
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
        rebuild: true,
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
  })
  .strict();

export const rollupDayHandler: RestaurantJobHandler = async ({ db, job }) => {
  const payload = ROLLUP_PAYLOAD.parse(job.payload);
  await rollupDay(db, payload);
};
