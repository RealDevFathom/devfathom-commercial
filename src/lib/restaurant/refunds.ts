import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { assertMoneyDayOpen } from './daily-close';
import {
  appendMovement,
  beginMoneyIdempotent,
  persistCoAuth,
  recordMoneyResult,
  runMoneyTransaction,
  type MoneyActor,
} from './drawer-sessions';
import { reverseLoyaltyForRefund } from './loyalty';
import {
  add,
  allocate,
  compare,
  equals,
  isNegative,
  isZero,
  money,
  roundMoney,
  sub,
  sum,
  ZERO,
} from './money';
import {
  appendPaymentEvent,
  getPaymentProvider,
  type PaymentCapability,
  type PaymentStatus,
} from './payment-adapter';

/**
 * M5-L4 / C7 — refund / reversal against an original tender (`payments:refund`).
 *
 * A refund is a NEW APPEND-ONLY record referencing the original tender (never an
 * edit, C3): it requires a reason + a manager CO-AUTHORIZATION (a second identity,
 * C6) and the command caps Σ(refunds) ≤ the tender amount. Two kinds (C7):
 *
 *   - REFUND         a post-capture return (partial or full). CARD runs the MOCK
 *                    adapter REFUND and moves the payment to REFUNDED / PARTIALLY_
 *                    REFUNDED; CASH posts a CASH_REFUND drawer movement (open drawer
 *                    required).
 *   - VOID_REVERSAL  a SAME-DAY FULL reversal (amount ≡ the whole tender, no prior
 *                    refund). CARD runs the adapter VOID and moves the payment to
 *                    VOIDED; CASH posts a CASH_REFUND movement.
 *
 * The refund posts to the PROCESSING business date (the register's current business
 * date, C6) — a cross-business-date correction lands on TODAY and NEVER mutates a
 * prior day's immutable close (C7/C9). Every command runs in one tenant-scoped
 * transaction with forced RLS (C1), routes money through `money.ts` (C2), and is
 * device-idempotent (C11). Concurrent refunds against the same bill are serialized
 * by a bill-row lock so Σ(refunds) can never overshoot the tender.
 */

export type RefundKind = 'REFUND' | 'VOID_REVERSAL';

export type RefundErrorReason =
  | 'TENDER_NOT_FOUND'
  | 'PAYMENT_NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'REFUND_EXCEEDS_TENDER'
  | 'TIP_REFUND_EXCEEDS_TENDER'
  | 'INVALID_REVERSAL'
  | 'REASON_REQUIRED'
  | 'BILL_NOT_SETTLED'
  | 'DRAWER_NOT_OPEN'
  | 'INVALID';

export class RefundError extends Error {
  constructor(
    message: string,
    readonly reason: RefundErrorReason
  ) {
    super(message);
    this.name = 'RefundError';
  }
}

export type RefundTenderInput = {
  originalTenderId: string;
  amount: Prisma.Decimal | string;
  /** Optional tip refunded alongside the principal (≤ the tender's tip). */
  tipRefundAmount?: Prisma.Decimal | string;
  /** Defaults to REFUND. VOID_REVERSAL is only valid for a same-day FULL reversal. */
  kind?: RefundKind;
  reason: string;
  /** Authenticated device branch; direct engine callers fall back to actor device lookup. */
  branchId?: string;
  /** The manager co-authorizing the refund (must differ from the actor, C6). */
  approvingStaffProfileId: string;
  actor: MoneyActor;
  /** Authoritative server instant; the processing business date derives from it (C6). */
  now?: Date;
};

export type RefundTenderResult = {
  refundId: string;
  originalTenderId: string;
  billId: string;
  kind: RefundKind;
  amount: Prisma.Decimal;
  tipRefundAmount: Prisma.Decimal;
  serviceChargeRefundAmount: Prisma.Decimal;
  deliveryFeeRefundAmount: Prisma.Decimal;
  taxRefundAmount: Prisma.Decimal;
  /** Processing business date (UTC-midnight Date for the `@db.Date` column). */
  businessDate: Date;
  paymentId: string | null;
  drawerSessionId: string | null;
  /** The card payment's resulting normalized status (null for cash/other). */
  paymentStatus: PaymentStatus | null;
  replayed: boolean;
};

type LoadedTender = {
  id: string;
  type: string;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  billId: string;
  businessDate: Date;
  paymentId: string | null;
  bill: {
    branchId: string;
    serviceChargeTotal: Prisma.Decimal;
    deliveryFeeTotal: Prisma.Decimal;
    tenders: { id: string; amount: Prisma.Decimal }[];
  };
};

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new RefundError('A refund requires a non-empty reason.', 'REASON_REQUIRED');
  }
  return trimmed;
}

/**
 * Refund (or reverse) an original tender. See the module doc for the full contract.
 */
export async function refundTender(
  db: ScopedDb,
  input: RefundTenderInput
): Promise<RefundTenderResult> {
  const at = input.now ?? new Date();
  const kind: RefundKind = input.kind ?? 'REFUND';
  return runMoneyTransaction(db, async (tx) => {
    const reason = requireReason(input.reason);
    const amount = money(input.amount);
    if (isZero(amount) || isNegative(amount)) {
      throw new RefundError('A refund amount must be positive.', 'INVALID_AMOUNT');
    }
    const tipRefundAmount =
      input.tipRefundAmount === undefined ? ZERO : money(input.tipRefundAmount);
    if (isNegative(tipRefundAmount)) {
      throw new RefundError('A tip refund must not be negative.', 'INVALID_AMOUNT');
    }

    // This branch-scoped read MUST precede the idempotency-key insert and every other
    // side effect. A tenant-known tender from another branch is the same 404 as an
    // unknown tender and cannot burn a key or write co-auth/payment/drawer rows.
    const branchId = await loadActorBranch(tx, input.actor.deviceId, input.branchId);
    const initialTender = await loadTender(tx, input.originalTenderId, branchId);
    const canonicalBytes = JSON.stringify({
      originalTenderId: initialTender.id,
      amount: amount.toString(),
      tipRefundAmount: tipRefundAmount.toString(),
      kind,
      reason,
      approvingStaffProfileId: input.approvingStaffProfileId,
    });
    const idem = await beginMoneyIdempotent(tx, input.actor, `refund.${kind.toLowerCase()}`, {
      bytes: canonicalBytes,
      hash: createHash('sha256').update(canonicalBytes, 'utf8').digest('hex'),
    });
    if (idem.replay) return replayRefundResult(tx, idem.resultRef, idem.resultPayload);

    // Serialize with settlement and concurrent refunds. Refund authority begins only
    // after settlement, when the tender can no longer be counted toward an open balance.
    // The bill row carries a full RLS policy, so FOR UPDATE is valid.
    const [lockedBill] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM restaurant_bills WHERE id = ${initialTender.billId} FOR UPDATE
    `;
    if (lockedBill?.status !== 'SETTLED') {
      throw new RefundError('Only a SETTLED bill can have a tender refunded.', 'BILL_NOT_SETTLED');
    }

    // The lock may have waited behind the final tender transaction. READ COMMITTED
    // gives each statement a fresh snapshot, so reload every settlement-dependent
    // value now rather than allocating bill-level charges from the pre-lock snapshot.
    const tender = await loadTender(tx, initialTender.id, branchId);

    // Cap: Σ(refunds) ≤ tender amount; Σ(tip refunds) ≤ tender tip.
    const priorRefunds = await tx.restaurantRefund.aggregate({
      where: { originalTenderId: tender.id },
      _sum: { amount: true, tipRefundAmount: true },
    });
    const refundedSoFar = money(priorRefunds._sum.amount ?? ZERO);
    const remainingRefundable = sub(tender.amount, refundedSoFar);
    if (compare(amount, remainingRefundable) > 0) {
      throw new RefundError(
        'The refund exceeds the tender balance available to refund.',
        'REFUND_EXCEEDS_TENDER'
      );
    }
    const tipRefundedSoFar = money(priorRefunds._sum.tipRefundAmount ?? ZERO);
    if (compare(sub(tender.tipAmount, tipRefundedSoFar), tipRefundAmount) < 0) {
      throw new RefundError(
        'The tip refund exceeds the tip available to refund.',
        'TIP_REFUND_EXCEEDS_TENDER'
      );
    }

    const serviceShares = allocate(
      tender.bill.serviceChargeTotal,
      tender.bill.tenders.map((row) => row.amount.mul(100).toNumber())
    );
    const tenderIndex = tender.bill.tenders.findIndex((row) => row.id === tender.id);
    const tenderServiceTotal = serviceShares[tenderIndex] ?? ZERO;
    const priorServiceRefund = money(
      (
        await tx.restaurantRefund.aggregate({
          where: { originalTenderId: tender.id },
          _sum: { serviceChargeRefundAmount: true },
        })
      )._sum.serviceChargeRefundAmount ?? ZERO
    );
    const cumulativePrincipal = add(refundedSoFar, amount);
    const cumulativeService = equals(cumulativePrincipal, tender.amount)
      ? tenderServiceTotal
      : roundMoney(tenderServiceTotal.mul(cumulativePrincipal).div(tender.amount));
    const serviceChargeRefundAmount = sub(cumulativeService, priorServiceRefund);
    const deliveryShares = allocate(
      tender.bill.deliveryFeeTotal,
      tender.bill.tenders.map((row) => row.amount.mul(100).toNumber())
    );
    const tenderDeliveryTotal = deliveryShares[tenderIndex] ?? ZERO;
    const priorDeliveryRefund = money(
      (
        await tx.restaurantRefund.aggregate({
          where: { originalTenderId: tender.id },
          _sum: { deliveryFeeRefundAmount: true },
        })
      )._sum.deliveryFeeRefundAmount ?? ZERO
    );
    const cumulativeDelivery = equals(cumulativePrincipal, tender.amount)
      ? tenderDeliveryTotal
      : roundMoney(tenderDeliveryTotal.mul(cumulativePrincipal).div(tender.amount));
    const deliveryFeeRefundAmount = sub(cumulativeDelivery, priorDeliveryRefund);

    const frozenTaxAllocations = (
      await tx.restaurantTaxTenderAllocationSnapshot.findMany({
        // Refund authority is the exact immutable allocation made for this tender at
        // settlement. Do not discover evidence through any live tax configuration.
        where: {
          billId: tender.billId,
          originalTenderId: tender.id,
          paymentCategory: tender.type as 'CASH' | 'CARD' | 'OTHER',
        },
        select: {
          id: true,
          cents: true,
          snapshotId: true,
          rateBucketSnapshotId: true,
          paymentCategory: true,
          rateBucket: { select: { billLineId: true, unitOrdinal: true } },
          refundAllocations: { select: { cents: true } },
        },
      })
    ).sort((left, right) => {
      const leftLine = left.rateBucket.billLineId ?? '';
      const rightLine = right.rateBucket.billLineId ?? '';
      if (leftLine !== rightLine) return leftLine < rightLine ? -1 : 1;
      const ordinal = (left.rateBucket.unitOrdinal ?? -1) - (right.rateBucket.unitOrdinal ?? -1);
      if (ordinal !== 0) return ordinal;
      if (left.paymentCategory !== right.paymentCategory) {
        return left.paymentCategory < right.paymentCategory ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
    });
    const originalTaxCents = frozenTaxAllocations.map((allocation) => Number(allocation.cents));
    const tenderTaxTotal = originalTaxCents.reduce((total, cents) => total + cents, 0);
    const cumulativeTaxCents = equals(cumulativePrincipal, tender.amount)
      ? tenderTaxTotal
      : new Prisma.Decimal(tenderTaxTotal)
          .mul(cumulativePrincipal)
          .div(tender.amount)
          .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
          .toNumber();
    const cumulativeTaxShares =
      tenderTaxTotal === 0
        ? []
        : allocate(new Prisma.Decimal(cumulativeTaxCents).div(100), originalTaxCents);
    const taxRefundRows = frozenTaxAllocations.map((allocation, index) => {
      const already = sum(allocation.refundAllocations.map((row) => row.cents.toString()));
      const cumulative = cumulativeTaxShares[index]?.mul(100) ?? ZERO;
      return { allocation, cents: cumulative.minus(already).toNumber() };
    });
    if (taxRefundRows.some((row) => row.cents < 0)) {
      throw new RefundError('Frozen tax refund evidence is inconsistent.', 'INVALID');
    }
    const taxRefundAmount = new Prisma.Decimal(
      taxRefundRows.reduce((total, row) => total + row.cents, 0)
    ).div(100);

    // Processing business date (C7): the register's CURRENT business date.
    const branch = await tx.restaurantBranch.findUnique({
      where: { id: tender.bill.branchId },
      select: { timezone: true, businessDayCutoff: true },
    });
    if (!branch) {
      throw new RefundError('The bill branch no longer exists.', 'INVALID');
    }
    const businessDate = businessDateToUtcDate(
      resolveBusinessDate(at, branch.timezone, branch.businessDayCutoff)
    );
    await assertMoneyDayOpen(tx, branchId, businessDate);

    // VOID_REVERSAL is only valid for a same-day FULL reversal with no prior refund.
    if (kind === 'VOID_REVERSAL') {
      const sameDay = businessDate.getTime() === tender.businessDate.getTime();
      const fullAmount = equals(amount, tender.amount) && isZero(refundedSoFar);
      if (!sameDay || !fullAmount) {
        throw new RefundError(
          'A VOID_REVERSAL must be a same-day full reversal with no prior refund; use a REFUND instead.',
          'INVALID_REVERSAL'
        );
      }
    }

    const coAuthorizationId = await persistCoAuth(tx, {
      actingStaffProfileId: input.actor.staffProfileId,
      approvingStaffProfileId: input.approvingStaffProfileId,
      capability: 'payments:refund',
      reason,
      targetType: 'RestaurantTender',
      targetId: tender.id,
      deviceId: input.actor.deviceId,
    });

    // Resolve the channel-specific attachment (open cash drawer / card payment).
    const drawerSessionId =
      tender.type === 'CASH'
        ? await requireOpenDrawer(tx, input.actor, branchId, businessDate)
        : null;
    const paymentId = tender.type === 'CARD' ? tender.paymentId : null;
    if (tender.type === 'CARD' && !paymentId) {
      throw new RefundError('The card tender has no payment to refund.', 'PAYMENT_NOT_FOUND');
    }

    const refund = await tx.restaurantRefund.create({
      data: {
        originalTenderId: tender.id,
        billId: tender.billId,
        amount,
        tipRefundAmount,
        serviceChargeRefundAmount,
        deliveryFeeRefundAmount,
        taxRefundAmount,
        kind,
        businessDate,
        reason,
        coAuthorizationId,
        drawerSessionId,
        paymentId,
        staffProfileId: input.actor.staffProfileId,
        deviceId: input.actor.deviceId,
      },
      select: { id: true },
    });

    await reverseLoyaltyForRefund(tx, { refundId: refund.id, billId: tender.billId, at });

    for (const row of taxRefundRows) {
      if (row.cents === 0) continue;
      await tx.restaurantTaxRefundAllocation.create({
        data: {
          billId: tender.billId,
          refundId: refund.id,
          originalTenderId: tender.id,
          paymentCategory: row.allocation.paymentCategory,
          originalSnapshotId: row.allocation.snapshotId,
          originalRateBucketSnapshotId: row.allocation.rateBucketSnapshotId,
          originalTenderAllocationId: row.allocation.id,
          cents: BigInt(row.cents),
        },
      });
    }

    if (drawerSessionId) {
      // Every cash refund writes exactly one CASH_REFUND drawer movement.
      await appendMovement(tx, {
        drawerSessionId,
        kind: 'CASH_REFUND',
        amount,
        refundId: refund.id,
        staffProfileId: input.actor.staffProfileId,
        deviceId: input.actor.deviceId,
      });
    }

    let paymentStatus: PaymentStatus | null = null;
    if (paymentId) {
      paymentStatus = await applyCardRefund(tx, {
        paymentId,
        kind,
        amount,
        tipRefundAmount,
        tenderAmount: tender.amount,
        refundedSoFar,
        actor: input.actor,
        originalTenderId: tender.id,
      });
    }

    const result: RefundTenderResult = {
      refundId: refund.id,
      originalTenderId: tender.id,
      billId: tender.billId,
      kind,
      amount,
      tipRefundAmount,
      serviceChargeRefundAmount,
      deliveryFeeRefundAmount,
      taxRefundAmount,
      businessDate,
      paymentId,
      drawerSessionId,
      paymentStatus,
      replayed: false,
    };
    await recordMoneyResult(tx, input.actor, refund.id, freezeRefundResult(result));
    return result;
  });
}

async function loadActorBranch(
  tx: ScopedDb,
  deviceId: string,
  expectedBranchId?: string
): Promise<string> {
  const device = await tx.restaurantRegisteredDevice.findFirst({
    where: { id: deviceId, ...(expectedBranchId ? { branchId: expectedBranchId } : {}) },
    select: { branchId: true },
  });
  if (!device) {
    throw new RefundError('The original tender does not exist.', 'TENDER_NOT_FOUND');
  }
  return device.branchId;
}

async function loadTender(tx: ScopedDb, tenderId: string, branchId: string): Promise<LoadedTender> {
  const tender = await tx.restaurantTender.findFirst({
    where: { id: tenderId, bill: { branchId } },
    select: {
      id: true,
      type: true,
      amount: true,
      tipAmount: true,
      billId: true,
      businessDate: true,
      paymentId: true,
      bill: {
        select: {
          branchId: true,
          serviceChargeTotal: true,
          deliveryFeeTotal: true,
          tenders: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, amount: true },
          },
        },
      },
    },
  });
  if (!tender) {
    throw new RefundError('The original tender does not exist.', 'TENDER_NOT_FOUND');
  }
  return tender as LoadedTender;
}

async function requireOpenDrawer(
  tx: ScopedDb,
  actor: MoneyActor,
  branchId: string,
  businessDate: Date
): Promise<string> {
  const drawer = await tx.restaurantDrawerSession.findFirst({
    where: { deviceId: actor.deviceId, branchId, businessDate, status: 'OPEN' },
    select: { id: true },
  });
  if (!drawer) {
    throw new RefundError(
      'This register has no OPEN drawer; open a drawer before refunding cash.',
      'DRAWER_NOT_OPEN'
    );
  }
  return drawer.id;
}

/** Run the MOCK adapter REFUND/VOID against the card payment, append the event, and
 * transition the payment's normalized status. Returns the resulting status. */
async function applyCardRefund(
  tx: ScopedDb,
  input: {
    paymentId: string;
    kind: RefundKind;
    amount: Prisma.Decimal;
    tipRefundAmount: Prisma.Decimal;
    tenderAmount: Prisma.Decimal;
    refundedSoFar: Prisma.Decimal;
    actor: MoneyActor;
    originalTenderId: string;
  }
): Promise<PaymentStatus> {
  const payment = await tx.restaurantPayment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, providerRef: true },
  });
  if (!payment) {
    throw new RefundError('The card payment no longer exists.', 'PAYMENT_NOT_FOUND');
  }

  const capability: PaymentCapability = input.kind === 'VOID_REVERSAL' ? 'VOID' : 'REFUND';
  const provider = getPaymentProvider('MOCK');
  const operationRef = `${input.originalTenderId}:${input.actor.deviceId}:${input.actor.idempotencyKey}`;
  const outcome = provider.execute({
    capability,
    amount: input.amount,
    tipAmount: input.tipRefundAmount,
    operationRef,
    priorRef: payment.providerRef,
  });

  // The normalized payment status: a void → VOIDED; a refund → REFUNDED once the
  // whole captured amount is returned, else PARTIALLY_REFUNDED.
  const nowRefunded = input.refundedSoFar.plus(input.amount);
  const status: PaymentStatus =
    input.kind === 'VOID_REVERSAL'
      ? 'VOIDED'
      : equals(nowRefunded, input.tenderAmount)
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED';

  await appendPaymentEvent(tx, {
    paymentId: payment.id,
    capability: outcome.event.capability,
    eventType: outcome.event.eventType,
    amount: outcome.event.amount,
    providerRef: outcome.event.providerRef,
    payload: outcome.event.payload,
  });
  await tx.restaurantPayment.update({ where: { id: payment.id }, data: { status } });
  return status;
}

async function replayRefundResult(
  tx: ScopedDb,
  resultRef: string | null,
  resultPayload?: Prisma.JsonValue | null
): Promise<RefundTenderResult> {
  const frozen = thawRefundResult(resultPayload);
  if (frozen) return { ...frozen, replayed: true };
  if (!resultRef) {
    throw new RefundError('The idempotent result reference is missing.', 'INVALID');
  }
  const refund = await tx.restaurantRefund.findUnique({
    where: { id: resultRef },
    select: {
      id: true,
      originalTenderId: true,
      billId: true,
      kind: true,
      amount: true,
      tipRefundAmount: true,
      serviceChargeRefundAmount: true,
      deliveryFeeRefundAmount: true,
      taxRefundAmount: true,
      businessDate: true,
      paymentId: true,
      drawerSessionId: true,
      payment: { select: { status: true } },
    },
  });
  if (!refund) {
    throw new RefundError('The replayed refund no longer exists.', 'INVALID');
  }
  return {
    refundId: refund.id,
    originalTenderId: refund.originalTenderId,
    billId: refund.billId,
    kind: refund.kind as RefundKind,
    amount: refund.amount,
    tipRefundAmount: refund.tipRefundAmount,
    serviceChargeRefundAmount: refund.serviceChargeRefundAmount,
    deliveryFeeRefundAmount: refund.deliveryFeeRefundAmount,
    taxRefundAmount: refund.taxRefundAmount,
    businessDate: refund.businessDate,
    paymentId: refund.paymentId,
    drawerSessionId: refund.drawerSessionId,
    paymentStatus: (refund.payment?.status as PaymentStatus | undefined) ?? null,
    replayed: true,
  };
}

type FrozenRefundResult = {
  refundId: string;
  originalTenderId: string;
  billId: string;
  kind: RefundKind;
  amount: string;
  tipRefundAmount: string;
  serviceChargeRefundAmount: string;
  deliveryFeeRefundAmount: string;
  taxRefundAmount: string;
  businessDate: string;
  paymentId: string | null;
  drawerSessionId: string | null;
  paymentStatus: PaymentStatus | null;
};

function freezeRefundResult(result: RefundTenderResult): Prisma.InputJsonValue {
  return {
    refundId: result.refundId,
    originalTenderId: result.originalTenderId,
    billId: result.billId,
    kind: result.kind,
    amount: result.amount.toString(),
    tipRefundAmount: result.tipRefundAmount.toString(),
    serviceChargeRefundAmount: result.serviceChargeRefundAmount.toString(),
    deliveryFeeRefundAmount: result.deliveryFeeRefundAmount.toString(),
    taxRefundAmount: result.taxRefundAmount.toString(),
    businessDate: result.businessDate.toISOString(),
    paymentId: result.paymentId,
    drawerSessionId: result.drawerSessionId,
    paymentStatus: result.paymentStatus,
  } satisfies FrozenRefundResult;
}

function thawRefundResult(payload: Prisma.JsonValue | null | undefined): RefundTenderResult | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Partial<FrozenRefundResult>;
  if (
    typeof row.refundId !== 'string' ||
    typeof row.originalTenderId !== 'string' ||
    typeof row.billId !== 'string' ||
    (row.kind !== 'REFUND' && row.kind !== 'VOID_REVERSAL') ||
    typeof row.amount !== 'string' ||
    typeof row.tipRefundAmount !== 'string' ||
    typeof row.serviceChargeRefundAmount !== 'string' ||
    typeof row.deliveryFeeRefundAmount !== 'string' ||
    typeof row.taxRefundAmount !== 'string' ||
    typeof row.businessDate !== 'string'
  ) {
    return null;
  }
  return {
    refundId: row.refundId,
    originalTenderId: row.originalTenderId,
    billId: row.billId,
    kind: row.kind,
    amount: money(row.amount),
    tipRefundAmount: money(row.tipRefundAmount),
    serviceChargeRefundAmount: money(row.serviceChargeRefundAmount),
    deliveryFeeRefundAmount: money(row.deliveryFeeRefundAmount),
    taxRefundAmount: money(row.taxRefundAmount),
    businessDate: new Date(row.businessDate),
    paymentId: row.paymentId ?? null,
    drawerSessionId: row.drawerSessionId ?? null,
    paymentStatus: row.paymentStatus ?? null,
    replayed: true,
  };
}
