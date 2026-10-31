import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma, type RestaurantTenderType } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { DailyCloseError } from './daily-close-errors';
import {
  beginMoneyIdempotent,
  foldExpectedCash,
  persistCoAuth,
  recordMoneyResult,
  runMoneyTransaction,
  type FoldableMovement,
  type MoneyActor,
} from './drawer-sessions';
import { sub, sum, ZERO } from './money';
import { enqueueInsightRollup } from './insight-rollups';
import { lockMoneyDay } from './money-day';

export { assertMoneyDayOpen } from './money-day';
export { DailyCloseError, type DailyCloseErrorReason } from './daily-close-errors';

/**
 * M5-L3 / C9 / §11.3 — the IMMUTABLE daily close.
 *
 * A close is a branch × businessDate snapshot that aggregates the day's persisted
 * bills, tenders, refunds and drawer sessions into the §11.3 totals plus a
 * per-tender-type child table. It is DB-enforced append-only (SELECT+INSERT RLS,
 * no updatedAt, C3): once cut it is never edited. A "reopen" is a NEW close row
 * that `supersedesCloseId` the previous one, carrying a reason + manager
 * co-authorization; the chain TIP (the close no other close supersedes) is the
 * authoritative snapshot in every read.
 *
 * Aggregation is pinned so this lane and L6b's independent reconciliation
 * recomputation agree to the cent (both code to the C4–C9 pins, not to each
 * other — see BUILD-ASSUMPTIONS "M5 daily-close aggregation"):
 *   - grossSales   = Σ SETTLED bill.subtotal (menu prices, pre-comp/pre-discount)
 *   - deliveryFeeSales = Σ SETTLED bill.deliveryFeeTotal (non-taxable v1)
 *   - deliveryFeeRefunds = Σ refund.deliveryFeeRefundAmount for processing date
 *   - compTotal    = Σ SETTLED bill.compTotal
 *   - taxTotal / serviceChargeTotal = billed totals minus the corresponding
 *                    refund components processed on this business date
 *   - discountTotal= Σ SETTLED bill.discountTotal
 *   - netSales     = grossSales − compTotal − discountTotal − refunded
 *                    pre-tax sales principal. Tax, service charge and delivery
 *                    fee refund components are not sales principal.
 *   - tipTotal     = Σ tender.tipAmount for the date (== Σ child tipAmount)
 *   - refundTotal  = Σ (refund.amount − refund.deliveryFeeRefundAmount) for the
 *                    PROCESSING date (C7 — cross-date corrections land on the day
 *                    processed, never a prior close). Delivery is reported separately.
 *   - voidTotal    = Σ VOID bill.grandTotal
 *   - cash{Expected,Counted,Variance} = Σ over drawer sessions of the ledger fold
 *                    / counted / (counted − expected)
 *   - per-tender-type totals = Σ tender.{amount,tipAmount} + count grouped by type
 *                    on COLLECTION date, including collections of prior-day bills.
 *                    Sales retain the bill date; collection is not another sale.
 * Every value is Prisma.Decimal (C2). Money never touches a float; equality is
 * exact Decimal string equality.
 */

type BillStatus = 'OPEN' | 'SETTLED' | 'VOID';
type TenderType = 'CASH' | 'CARD' | 'OTHER';
type DrawerStatus = 'OPEN' | 'CLOSED';

/** The tender types a close reports a child total for, in a fixed order so the
 * child rows and any recomputation are deterministic. */
const TENDER_TYPES: readonly TenderType[] = ['CASH', 'CARD', 'OTHER'];

// ── Pure aggregation (C9) ─────────────────────────────────────────────────────

export type AggregateBill = {
  status: BillStatus;
  subtotal: Prisma.Decimal;
  deliveryFeeTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
};
export type AggregateTender = {
  type: TenderType;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
};
export type AggregateRefund = {
  amount: Prisma.Decimal;
  taxRefundAmount: Prisma.Decimal;
  serviceChargeRefundAmount: Prisma.Decimal;
  deliveryFeeRefundAmount: Prisma.Decimal;
};
export type AggregateDrawer = {
  status: DrawerStatus;
  expectedCash: Prisma.Decimal;
  countedCash: Prisma.Decimal | null;
};

export type TenderTypeTotal = {
  tenderType: TenderType;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  count: number;
};

export type CloseTotals = {
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

export type CloseAggregate = CloseTotals & { tenderTotals: TenderTypeTotal[] };

export type AggregateInputs = {
  bills: readonly AggregateBill[];
  tenders: readonly AggregateTender[];
  refunds: readonly AggregateRefund[];
  drawers: readonly AggregateDrawer[];
};

/**
 * Fold the day's raw rows into the close snapshot. PURE and exact (Decimal only) —
 * the single source of the numbers `cutClose`/`correctClose` persist and
 * `closePreview` returns, so a preview and its eventual cut agree by construction.
 */
export function computeCloseAggregate(inputs: AggregateInputs): CloseAggregate {
  const settled = inputs.bills.filter((b) => b.status === 'SETTLED');
  const voided = inputs.bills.filter((b) => b.status === 'VOID');

  const grossSales = sum(settled.map((b) => b.subtotal));
  const deliveryFeeSales = sum(settled.map((b) => b.deliveryFeeTotal));
  const compTotal = sum(settled.map((b) => b.compTotal));
  const billedTaxTotal = sum(settled.map((b) => b.taxTotal));
  const billedServiceChargeTotal = sum(settled.map((b) => b.serviceChargeTotal));
  const discountTotal = sum(settled.map((b) => b.discountTotal));
  const voidTotal = sum(voided.map((b) => b.grandTotal));

  const tipTotal = sum(inputs.tenders.map((t) => t.tipAmount));
  const refundedTaxTotal = sum(inputs.refunds.map((r) => r.taxRefundAmount));
  const refundedServiceChargeTotal = sum(inputs.refunds.map((r) => r.serviceChargeRefundAmount));
  const deliveryFeeRefunds = sum(inputs.refunds.map((r) => r.deliveryFeeRefundAmount));
  const refundTotal = sub(sum(inputs.refunds.map((r) => r.amount)), deliveryFeeRefunds);
  const refundedSales = sum(
    inputs.refunds.map((r) =>
      sub(
        sub(sub(r.amount, r.taxRefundAmount), r.serviceChargeRefundAmount),
        r.deliveryFeeRefundAmount
      )
    )
  );
  const netSales = sub(sub(sub(grossSales, compTotal), discountTotal), refundedSales);
  const taxTotal = sub(billedTaxTotal, refundedTaxTotal);
  const serviceChargeTotal = sub(billedServiceChargeTotal, refundedServiceChargeTotal);

  const cashExpected = sum(inputs.drawers.map((d) => d.expectedCash));
  const cashCounted = sum(inputs.drawers.map((d) => d.countedCash ?? ZERO));
  const cashVariance = sub(cashCounted, cashExpected);

  const tenderTotals: TenderTypeTotal[] = [];
  for (const tenderType of TENDER_TYPES) {
    const rows = inputs.tenders.filter((t) => t.type === tenderType);
    if (rows.length === 0) continue;
    tenderTotals.push({
      tenderType,
      amount: sum(rows.map((t) => t.amount)),
      tipAmount: sum(rows.map((t) => t.tipAmount)),
      count: rows.length,
    });
  }

  return {
    grossSales,
    netSales,
    deliveryFeeSales,
    deliveryFeeRefunds,
    taxTotal,
    serviceChargeTotal,
    tipTotal,
    compTotal,
    discountTotal,
    refundTotal,
    voidTotal,
    cashExpected,
    cashCounted,
    cashVariance,
    tenderTotals,
  };
}

// ── Chain-tip resolution (C9) ─────────────────────────────────────────────────

export type CloseChainNode = { id: string; supersedesCloseId: string | null };

/**
 * Resolve the authoritative TIP of a close chain: the close whose id no sibling
 * supersedes. Returns null for an empty set. A well-formed chain has exactly one
 * tip; if the data is malformed (a fork) the most recent unsuperseded node wins —
 * callers pass rows already ordered by createdAt.
 */
export function resolveChainTip<T extends CloseChainNode>(closes: readonly T[]): T | null {
  if (closes.length === 0) return null;
  const superseded = new Set(
    closes.map((c) => c.supersedesCloseId).filter((id): id is string => id !== null)
  );
  const tips = closes.filter((c) => !superseded.has(c.id));
  if (tips.length === 0) return null;
  return tips[tips.length - 1] ?? null;
}

// ── Row loading (shared by preview / cut / correct) ───────────────────────────

type LoadedInputs = AggregateInputs & {
  openBillCount: number;
  unresolvedOrderCount: number;
  openDrawerCount: number;
};

async function loadCloseInputs(
  db: ScopedDb,
  branchId: string,
  businessDate: Date
): Promise<LoadedInputs> {
  // Sequential (not Promise.all): `db` may be an interactive-transaction client,
  // which does not support concurrent queries.
  const bills = await db.restaurantBill.findMany({
    where: { branchId, businessDate },
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
  const unresolvedOrderCount = await db.restaurantOrder.count({
    where: {
      branchId,
      businessDate,
      status: { in: ['OPEN', 'SENT', 'IN_PREPARATION', 'READY', 'SERVED', 'PAYMENT_PENDING'] },
    },
  });
  const tenders = await db.restaurantTender.findMany({
    where: { businessDate, bill: { branchId } },
    select: { type: true, amount: true, tipAmount: true },
  });
  const refunds = await db.restaurantRefund.findMany({
    where: { businessDate, bill: { branchId } },
    select: {
      amount: true,
      taxRefundAmount: true,
      serviceChargeRefundAmount: true,
      deliveryFeeRefundAmount: true,
    },
  });
  const drawers = await db.restaurantDrawerSession.findMany({
    where: { branchId, businessDate },
    select: {
      status: true,
      countedCash: true,
      movements: { select: { kind: true, amount: true } },
    },
  });

  return {
    bills: bills as AggregateBill[],
    tenders: tenders as AggregateTender[],
    refunds: refunds as AggregateRefund[],
    drawers: drawers.map((d) => ({
      status: d.status as DrawerStatus,
      expectedCash: foldExpectedCash(d.movements as FoldableMovement[]),
      countedCash: d.countedCash,
    })),
    openBillCount: bills.filter((b) => b.status === 'OPEN').length,
    unresolvedOrderCount,
    openDrawerCount: drawers.filter((d) => d.status === 'OPEN').length,
  };
}

// ── Preview (pure aggregation over persisted rows) ────────────────────────────

export type ClosePreviewInput = { branchId: string; businessDate: string };

export type ClosePreview = CloseAggregate & {
  branchId: string;
  businessDate: Date;
  readiness: {
    allBillsResolved: boolean;
    allDrawersClosed: boolean;
    openBillCount: number;
    unresolvedOrderCount: number;
    openDrawerCount: number;
  };
  /** The current chain-tip close for the date, if one has already been cut. */
  existingCloseId: string | null;
};

/**
 * Aggregate the persisted day without writing anything — the register/back-office
 * preview of what a cut would snapshot, plus whether the guards are satisfied and
 * whether a close already exists (in which case a correction, not a cut, is next).
 */
export async function closePreview(db: ScopedDb, input: ClosePreviewInput): Promise<ClosePreview> {
  const businessDate = businessDateToUtcDate(input.businessDate);
  const loaded = await loadCloseInputs(db, input.branchId, businessDate);
  const aggregate = computeCloseAggregate(loaded);
  const existing = await db.restaurantDailyClose.findMany({
    where: { branchId: input.branchId, businessDate },
    orderBy: { createdAt: 'asc' },
    select: { id: true, supersedesCloseId: true },
  });
  return {
    branchId: input.branchId,
    businessDate,
    ...aggregate,
    readiness: {
      allBillsResolved: loaded.openBillCount === 0 && loaded.unresolvedOrderCount === 0,
      allDrawersClosed: loaded.openDrawerCount === 0,
      openBillCount: loaded.openBillCount,
      unresolvedOrderCount: loaded.unresolvedOrderCount,
      openDrawerCount: loaded.openDrawerCount,
    },
    existingCloseId: resolveChainTip(existing)?.id ?? null,
  };
}

// ── Persist a close row + its tender-type children ────────────────────────────

async function persistClose(
  tx: ScopedDb,
  args: {
    branchId: string;
    businessDate: Date;
    aggregate: CloseAggregate;
    cutByStaffProfileId: string;
    deviceId: string | null;
    supersedesCloseId?: string | null;
    correctionReason?: string | null;
    coAuthorizationId?: string | null;
  }
): Promise<string> {
  const { aggregate } = args;
  const close = await tx.restaurantDailyClose.create({
    data: {
      branchId: args.branchId,
      businessDate: args.businessDate,
      supersedesCloseId: args.supersedesCloseId ?? null,
      correctionReason: args.correctionReason ?? null,
      coAuthorizationId: args.coAuthorizationId ?? null,
      cutByStaffProfileId: args.cutByStaffProfileId,
      deviceId: args.deviceId,
      grossSales: aggregate.grossSales,
      netSales: aggregate.netSales,
      deliveryFeeSales: aggregate.deliveryFeeSales,
      deliveryFeeRefunds: aggregate.deliveryFeeRefunds,
      taxTotal: aggregate.taxTotal,
      serviceChargeTotal: aggregate.serviceChargeTotal,
      tipTotal: aggregate.tipTotal,
      compTotal: aggregate.compTotal,
      discountTotal: aggregate.discountTotal,
      refundTotal: aggregate.refundTotal,
      voidTotal: aggregate.voidTotal,
      cashExpected: aggregate.cashExpected,
      cashCounted: aggregate.cashCounted,
      cashVariance: aggregate.cashVariance,
    },
    select: { id: true },
  });
  for (const total of aggregate.tenderTotals) {
    await tx.restaurantDailyCloseTenderTotal.create({
      data: {
        dailyCloseId: close.id,
        tenderType: total.tenderType,
        amount: total.amount,
        tipAmount: total.tipAmount,
        count: total.count,
      },
      select: { id: true },
    });
  }
  return close.id;
}

/** Guard: a close can only be cut/corrected when every bill and billable order
 * for the date is resolved and every drawer session is CLOSED (C9). */
function assertReadyToClose(loaded: LoadedInputs): void {
  if (loaded.openBillCount > 0 || loaded.unresolvedOrderCount > 0) {
    throw new DailyCloseError(
      'The business day has unsettled bills or active orders; resolve them before closing.',
      'UNSETTLED_BILL'
    );
  }
  if (loaded.openDrawerCount > 0) {
    throw new DailyCloseError(
      'The business day has open drawer sessions; close every drawer before closing the day.',
      'OPEN_DRAWER'
    );
  }
}

// ── Cut (first close for a branch × date) ─────────────────────────────────────

export type CutCloseInput = { branchId: string; businessDate: string; actor: MoneyActor };

export type CutCloseResult = {
  dailyCloseId: string;
  totals: CloseTotals;
  tenderTotals: TenderTypeTotal[];
  replayed: boolean;
};

/**
 * Cut the FIRST daily close for a branch × business date. Guards that every bill
 * is SETTLED/VOID and every drawer CLOSED, and that no close already exists for
 * the date (a correction supersedes an existing close instead). Snapshot + tender
 * children are written in ONE transaction; idempotent (`cash:close`).
 */
export async function cutClose(db: ScopedDb, input: CutCloseInput): Promise<CutCloseResult> {
  const businessDate = businessDateToUtcDate(input.businessDate);
  return runMoneyTransaction(db, async (tx) => {
    await lockMoneyDay(tx, input.branchId, input.businessDate);
    const canonical = canonicalClosePayload({
      version: 1,
      branchId: input.branchId,
      businessDate: input.businessDate,
    });
    const idem = await beginMoneyIdempotent(tx, input.actor, 'cash.day_close', canonical);
    if (idem.replay) return decodeFrozenCloseResult(idem.resultPayload);

    const existing = await tx.restaurantDailyClose.count({
      where: { branchId: input.branchId, businessDate },
    });
    if (existing > 0) {
      throw new DailyCloseError(
        'A daily close already exists for this date; use a correction to supersede it.',
        'CLOSE_EXISTS'
      );
    }

    const loaded = await loadCloseInputs(tx, input.branchId, businessDate);
    assertReadyToClose(loaded);
    const aggregate = computeCloseAggregate(loaded);

    const closeId = await persistClose(tx, {
      branchId: input.branchId,
      businessDate,
      aggregate,
      cutByStaffProfileId: input.actor.staffProfileId,
      deviceId: input.actor.deviceId,
    });
    const result = { dailyCloseId: closeId, ...splitAggregate(aggregate), replayed: false };
    await recordMoneyResult(tx, input.actor, closeId, freezeCloseResult(result));
    await enqueueInsightRollup(tx, {
      branchId: input.branchId,
      businessDate: input.businessDate,
      sourceDailyCloseId: closeId,
    });

    return result;
  });
}

// ── Correct (supersede the chain tip) ─────────────────────────────────────────

export type CorrectCloseInput = {
  branchId: string;
  businessDate: string;
  /** The chain tip being superseded (must be the current tip). */
  supersedesCloseId: string;
  reason: string;
  /** The manager co-authorizing the correction (must differ from the actor, C9). */
  approvingStaffProfileId: string;
  actor: MoneyActor;
};

export type CorrectCloseResult = CutCloseResult & { supersedesCloseId: string };

/**
 * Correct a daily close: append a NEW close row that supersedes the current chain
 * tip, re-aggregated from the day's current rows, carrying a reason + manager
 * co-authorization (the durable audit evidence; the REST edge additionally writes
 * the platform audit event). Rejects if there is nothing to correct, if the
 * supplied id is not the current tip, or if the day is no longer coherent
 * (a bill/drawer reopened). Idempotent (`cash:close`).
 */
export async function correctClose(
  db: ScopedDb,
  input: CorrectCloseInput
): Promise<CorrectCloseResult> {
  const businessDate = businessDateToUtcDate(input.businessDate);
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) {
    throw new DailyCloseError('A close correction requires a non-empty reason.', 'REASON_REQUIRED');
  }
  if (!input.approvingStaffProfileId) {
    throw new DailyCloseError(
      'A close correction requires a co-authorizing manager.',
      'CO_AUTH_REQUIRED'
    );
  }

  return runMoneyTransaction(db, async (tx) => {
    await lockMoneyDay(tx, input.branchId, input.businessDate);
    const canonical = canonicalClosePayload({
      version: 1,
      branchId: input.branchId,
      businessDate: input.businessDate,
      supersedesCloseId: input.supersedesCloseId,
      reason,
      approvingStaffProfileId: input.approvingStaffProfileId,
    });
    const idem = await beginMoneyIdempotent(tx, input.actor, 'cash.day_correct', canonical);
    if (idem.replay) return decodeFrozenCorrectCloseResult(idem.resultPayload);

    const chain = await tx.restaurantDailyClose.findMany({
      where: { branchId: input.branchId, businessDate },
      orderBy: { createdAt: 'asc' },
      select: { id: true, supersedesCloseId: true },
    });
    const tip = resolveChainTip(chain);
    if (!tip) {
      throw new DailyCloseError(
        'There is no daily close for this date to correct.',
        'NOTHING_TO_CORRECT'
      );
    }
    if (tip.id !== input.supersedesCloseId) {
      throw new DailyCloseError(
        'The supplied close is not the current chain tip; re-read the close and retry.',
        'NOT_TIP'
      );
    }

    const loaded = await loadCloseInputs(tx, input.branchId, businessDate);
    assertReadyToClose(loaded);
    const aggregate = computeCloseAggregate(loaded);

    const coAuthorizationId = await persistCoAuth(tx, {
      actingStaffProfileId: input.actor.staffProfileId,
      approvingStaffProfileId: input.approvingStaffProfileId,
      capability: 'cash:close',
      reason,
      targetType: 'RestaurantDailyClose',
      targetId: tip.id,
      deviceId: input.actor.deviceId,
    });

    const closeId = await persistClose(tx, {
      branchId: input.branchId,
      businessDate,
      aggregate,
      cutByStaffProfileId: input.actor.staffProfileId,
      deviceId: input.actor.deviceId,
      supersedesCloseId: tip.id,
      correctionReason: reason,
      coAuthorizationId,
    });
    const result = {
      dailyCloseId: closeId,
      ...splitAggregate(aggregate),
      supersedesCloseId: tip.id,
      replayed: false,
    };
    await recordMoneyResult(tx, input.actor, closeId, freezeCloseResult(result));
    await enqueueInsightRollup(tx, {
      branchId: input.branchId,
      businessDate: input.businessDate,
      sourceDailyCloseId: closeId,
    });

    return result;
  });
}

function canonicalClosePayload(value: Record<string, unknown>) {
  const bytes = JSON.stringify(value);
  return { bytes, hash: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

function freezeCloseResult(result: CorrectCloseResult | CutCloseResult): Prisma.InputJsonValue {
  return {
    dailyCloseId: result.dailyCloseId,
    totals: Object.fromEntries(
      Object.entries(result.totals).map(([key, value]) => [key, value.toString()])
    ),
    tenderTotals: result.tenderTotals.map((total) => ({
      tenderType: total.tenderType,
      amount: total.amount.toString(),
      tipAmount: total.tipAmount.toString(),
      count: total.count,
    })),
    ...('supersedesCloseId' in result ? { supersedesCloseId: result.supersedesCloseId } : {}),
  };
}

function decodeFrozenCloseResult(payload: Prisma.JsonValue | null | undefined): CutCloseResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DailyCloseError('The stored daily-close replay result is invalid.', 'INVALID');
  }
  const value = payload as Record<string, unknown>;
  const totals = value.totals as Record<string, string>;
  const tenderTotals = value.tenderTotals as Array<Record<string, unknown>>;
  const decodedTotals = Object.fromEntries(
    Object.entries(totals).map(([key, amount]) => [key, new Prisma.Decimal(amount)])
  ) as Partial<CloseTotals>;
  return {
    dailyCloseId: String(value.dailyCloseId),
    totals: {
      ...decodedTotals,
      // Money command receipts created before WHA-1040 remain replayable. Their
      // immutable close rows also carry migration-default zero snapshots.
      deliveryFeeSales: decodedTotals.deliveryFeeSales ?? ZERO,
      deliveryFeeRefunds: decodedTotals.deliveryFeeRefunds ?? ZERO,
    } as CloseTotals,
    tenderTotals: tenderTotals.map((total) => ({
      tenderType: String(total.tenderType) as RestaurantTenderType,
      amount: new Prisma.Decimal(String(total.amount)),
      tipAmount: new Prisma.Decimal(String(total.tipAmount)),
      count: Number(total.count),
    })),
    replayed: true,
  };
}

function decodeFrozenCorrectCloseResult(
  payload: Prisma.JsonValue | null | undefined
): CorrectCloseResult {
  const result = decodeFrozenCloseResult(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DailyCloseError('The stored daily-close replay result is invalid.', 'INVALID');
  }
  return { ...result, supersedesCloseId: String(payload.supersedesCloseId) };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function splitAggregate(aggregate: CloseAggregate): {
  totals: CloseTotals;
  tenderTotals: TenderTypeTotal[];
} {
  const { tenderTotals, ...totals } = aggregate;
  return { totals, tenderTotals };
}
