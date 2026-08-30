import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import {
  appendMovement,
  beginMoneyIdempotent,
  persistCoAuth,
  recordMoneyResult,
  runMoneyTransaction,
  type MoneyActor,
} from './drawer-sessions';
import { reverseLoyaltyForRefund } from './loyalty';
import { add, allocate, compare, equals, isNegative, isZero, money, roundMoney, sub, sum, ZERO } from './money';
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
    const idem = await beginMoneyIdempotent(tx, input.actor, `refund.${kind.toLowerCase()}`);
    if (idem.replay) return replayRefundResult(tx, idem.resultRef);

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

    const tender = await loadTender(tx, input.originalTenderId);

    // Serialize concurrent refunds against this bill so Σ(refunds) cannot overshoot
    // the tender (the bill row carries a full RLS policy, so FOR UPDATE is valid).
    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${tender.billId} FOR UPDATE`;

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
      (await tx.restaurantRefund.aggregate({
        where: { originalTenderId: tender.id },
        _sum: { serviceChargeRefundAmount: true },
      }))._sum.serviceChargeRefundAmount ?? ZERO
    );
    const cumulativePrincipal = add(refundedSoFar, amount);
    const cumulativeService = equals(cumulativePrincipal, tender.amount)
      ? tenderServiceTotal
      : roundMoney(tenderServiceTotal.mul(cumulativePrincipal).div(tender.amount));
    const serviceChargeRefundAmount = sub(cumulativeService, priorServiceRefund);

    const frozenTaxAllocations = await tx.restaurantTaxTenderAllocationSnapshot.findMany({
      where: { originalTenderId: tender.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        cents: true,
        snapshotId: true,
        rateBucketSnapshotId: true,
        paymentCategory: true,
        refundAllocations: { select: { cents: true } },
      },
    });
    const originalTaxCents = frozenTaxAllocations.map((allocation) =>
      Number(allocation.cents)
    );
    const tenderTaxTotal = originalTaxCents.reduce((total, cents) => total + cents, 0);
    const cumulativeTaxCents = equals(cumulativePrincipal, tender.amount)
      ? tenderTaxTotal
      : new Prisma.Decimal(tenderTaxTotal)
          .mul(cumulativePrincipal)
          .div(tender.amount)
          .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
          .toNumber();
    const cumulativeTaxShares =
      tenderTaxTotal === 0 ? [] : allocate(new Prisma.Decimal(cumulativeTaxCents).div(100), originalTaxCents);
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
      tender.type === 'CASH' ? await requireOpenDrawer(tx, input.actor) : null;
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

    await recordMoneyResult(tx, input.actor, refund.id);
    return {
      refundId: refund.id,
      originalTenderId: tender.id,
      billId: tender.billId,
      kind,
      amount,
      tipRefundAmount,
      serviceChargeRefundAmount,
      taxRefundAmount,
      businessDate,
      paymentId,
      drawerSessionId,
      paymentStatus,
      replayed: false,
    };
  });
}

async function loadTender(tx: ScopedDb, tenderId: string): Promise<LoadedTender> {
  const tender = await tx.restaurantTender.findUnique({
    where: { id: tenderId },
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

async function requireOpenDrawer(tx: ScopedDb, actor: MoneyActor): Promise<string> {
  const drawer = await tx.restaurantDrawerSession.findFirst({
    where: { deviceId: actor.deviceId, status: 'OPEN' },
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
  resultRef: string | null
): Promise<RefundTenderResult> {
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
    taxRefundAmount: refund.taxRefundAmount,
    businessDate: refund.businessDate,
    paymentId: refund.paymentId,
    drawerSessionId: refund.drawerSessionId,
    paymentStatus: (refund.payment?.status as PaymentStatus | undefined) ?? null,
    replayed: true,
  };
}
