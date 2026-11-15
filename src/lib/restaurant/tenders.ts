import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { finalizeBillSettlement, type SettlementTenderTaxAllocation } from './bills';
import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { assertMoneyDayOpen } from './daily-close';
import {
  appendMovement,
  beginMoneyIdempotent,
  MoneyIdempotencyError,
  recordMoneyResult,
  runMoneyTransaction,
  type MoneyActor,
} from './drawer-sessions';
import {
  add,
  compare,
  equals,
  formatMoney,
  isNegative,
  isZero,
  money,
  sub,
  sum,
  ZERO,
} from './money';
import { closeOrderAfterSettlement } from './orders';
import { appendPaymentEvent, getPaymentProvider } from './payment-adapter';
import {
  quoteTaxSettlement,
  splitFractionalMoney,
  splitMoney,
  type PaymentCategory,
  type TaxQuoteResult,
} from './tax-calculator';

/**
 * M5-L4 / C5 / §11.2 — apply a tender to a bill (`payments:collect`).
 *
 * A tender is an APPEND-ONLY payment applied to a bill (`restaurant_tenders`,
 * DB-enforced SELECT+INSERT only, C3). A bill accepts MANY partial tenders; each
 * one is a device-idempotent money command (C11) that runs in ONE tenant-scoped
 * transaction with forced RLS (C1) and routes every amount through `money.ts` (C2 —
 * exact Decimal, no float):
 *
 *   - CASH   records `cashReceived` + `changeGiven` (= cashReceived − amount) and,
 *            in the SAME transaction, posts a net CASH_SALE movement to the device's
 *            OPEN drawer via L3 `appendMovement` (an OPEN drawer for the register is
 *            required). Cash tips are not modelled in M5 (tip is always zero).
 *   - CARD   runs the MOCK adapter SALE (C6): a declined authorization ABORTS the
 *            whole transaction, so a decline leaves NO tender, movement, payment or
 *            receipt (the atomicity named check). An approval persists a
 *            `RestaurantPayment` + its append-only event, then the CARD tender.
 *            `tipAmount` is recorded on both, distinct from any service charge (C5).
 *   - OTHER  a non-cash/non-card seam (gift/voucher/loyalty deferred): amount + tip.
 *
 * OVER-TENDER is rejected — a tender's applied `amount` may never exceed the bill's
 * outstanding balance — the ONLY over-payment is cash change. The amount guard runs
 * AGAINST that outstanding balance (see `classifyTenderAmount`), so a ZERO amount is
 * valid ONLY as the settlement of an already-fully-covered bill — e.g. a fully comped,
 * zero grand-total bill — and is rejected on any bill that still owes a balance. When
 * the applied tenders reach the grand total EXACTLY (Decimal equality), the bill is
 * settled and its receipt number allocated in the SAME transaction, EXACTLY ONCE: a
 * bill-row `FOR UPDATE` lock serializes concurrent final tenders, so the loser observes
 * the SETTLED bill and is rejected rather than allocating a second receipt.
 *
 * Server time is authoritative (C6): the caller passes the settlement instant.
 */

export type TenderType = 'CASH' | 'CARD' | 'OTHER';

export type TenderErrorReason =
  | 'BILL_NOT_FOUND'
  | 'BILL_NOT_OPEN'
  | 'INVALID_AMOUNT'
  | 'OVER_TENDER'
  | 'CASH_TIP_UNSUPPORTED'
  | 'INSUFFICIENT_CASH'
  | 'DRAWER_NOT_OPEN'
  | 'CARD_DECLINED'
  | 'TAX_SETTLEMENT_REPRICE_REQUIRED'
  | 'INVALID';

export class TenderError extends Error {
  constructor(
    message: string,
    readonly reason: TenderErrorReason
  ) {
    super(message);
    this.name = 'TenderError';
  }
}

/** A cash tender: `amount` is applied to the bill; `cashReceived` (≥ amount) yields
 * `changeGiven`. Cash tips are not modelled (M5) — a cash tender carries no tip. */
export type CashTenderSpec = {
  type: 'CASH';
  amount: Prisma.Decimal | string;
  cashReceived: Prisma.Decimal | string;
};

/** A card tender settled through the MOCK adapter SALE path, with an optional tip. */
export type CardTenderSpec = {
  type: 'CARD';
  amount: Prisma.Decimal | string;
  tipAmount?: Prisma.Decimal | string;
  /** Trusted, server-created terminal confirmation. Never accepted by the public
   * checkout route; webhook processing constructs it after auth + reconciliation. */
  terminalConfirmation?: {
    configId: string;
    branchId: string;
    externalEventId: string;
    source: string;
    externalReference: string;
    providerRef: string;
  };
};

/** A non-cash/non-card tender seam, with an optional tip. */
export type OtherTenderSpec = {
  type: 'OTHER';
  amount: Prisma.Decimal | string;
  tipAmount?: Prisma.Decimal | string;
};

export type TenderSpec = CashTenderSpec | CardTenderSpec | OtherTenderSpec;

export type ApplyTenderInput = {
  billId: string;
  tender: TenderSpec;
  actor: MoneyActor;
  /** Authenticated terminal branch. Required at the REST edge. */
  branchId?: string;
  /** Authoritative server instant used at settlement (C6). Defaults to now. */
  now?: Date;
};

export type ApplyTenderResult = {
  tenderId: string;
  billId: string;
  type: TenderType;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  /** Cash change returned to the guest (null for card/other). */
  changeGiven: Prisma.Decimal | null;
  paymentId: string | null;
  drawerSessionId: string | null;
  /** True iff THIS tender brought the bill to full coverage and settled it. On a
   * replay this reflects the bill's current settled state. */
  settled: boolean;
  receiptNumber: number | null;
  /** The bill's outstanding balance AFTER this tender (zero once settled). */
  remainingDue: Prisma.Decimal;
  replayed: boolean;
};

type BillForTender = {
  id: string;
  organizationId: string;
  orderId: string;
  status: string;
  grandTotal: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  deliveryFeeTotal: Prisma.Decimal;
  roundingAdjustment: Prisma.Decimal;
  branchId: string;
  businessDate: Date;
  splitKind: string;
  fractionNumerator: number | null;
  fractionDenominator: number | null;
};

type TenderRow = { id: string; type: TenderType; amount: Prisma.Decimal; createdAt: Date };

type SettlementContext = {
  profileId: string;
  currency: string;
  rules: Map<string, { priceMode: 'EXCLUSIVE' | 'INCLUSIVE'; rate: Prisma.Decimal }>;
  quote: TaxQuoteResult;
  lines: Array<{
    billLineId: string | null;
    sourceOrderItemId?: string;
    unitOrdinal: number;
    comp: Prisma.Decimal;
    beforeTaxDiscount: Prisma.Decimal;
  }>;
  promotionEvaluationId: string | null;
  promotionEvaluationHash: string | null;
};

export function splitCheckoutDiscountAccounting(
  billDiscountTotal: Prisma.Decimal,
  applications: readonly {
    taxTreatment: string | null;
    computedAmount: Prisma.Decimal;
  }[]
): {
  nonPromotionDiscount: Prisma.Decimal;
  beforeTaxPromotion: Prisma.Decimal;
  afterTaxDiscount: Prisma.Decimal;
} {
  if (
    applications.some(
      (row) => row.taxTreatment !== 'BEFORE_TAX' && row.taxTreatment !== 'AFTER_TAX'
    )
  ) {
    throw new TenderError('Applied promotion is missing its tax treatment.', 'INVALID');
  }
  const appliedPromotionTotal = sum(applications.map((row) => row.computedAmount));
  const nonPromotionDiscount = sub(billDiscountTotal, appliedPromotionTotal);
  if (nonPromotionDiscount.isNegative()) {
    throw new TenderError('Promotion accounting exceeds the bill discount total.', 'INVALID');
  }
  return {
    nonPromotionDiscount,
    beforeTaxPromotion: sum(
      applications
        .filter((row) => row.taxTreatment === 'BEFORE_TAX')
        .map((row) => row.computedAmount)
    ),
    afterTaxDiscount: add(
      nonPromotionDiscount,
      sum(
        applications
          .filter((row) => row.taxTreatment === 'AFTER_TAX')
          .map((row) => row.computedAmount)
      )
    ),
  };
}

/** The persisted shape of one applied tender, before coverage/settlement. */
type PersistedTender = {
  tenderId: string;
  tipAmount: Prisma.Decimal;
  changeGiven: Prisma.Decimal | null;
  paymentId: string | null;
  drawerSessionId: string | null;
};

export type TenderAmountVerdict = 'OK' | 'INVALID_AMOUNT' | 'OVER_TENDER';

/** Classify a tender's applied amount against the bill's outstanding balance.
 * A positive amount up to `outstanding` is a normal (possibly final) tender; a
 * ZERO amount is valid ONLY as the settlement of an already fully-covered bill
 * (e.g. a fully comped, zero grand-total bill); negative → INVALID_AMOUNT;
 * amount > outstanding → OVER_TENDER. The guard is amount-vs-outstanding, not
 * tender type. */
export function classifyTenderAmount(
  amount: Prisma.Decimal,
  outstanding: Prisma.Decimal
): TenderAmountVerdict {
  if (isNegative(amount)) return 'INVALID_AMOUNT';
  if (isZero(amount) && !isZero(outstanding)) return 'INVALID_AMOUNT';
  if (compare(amount, outstanding) > 0) return 'OVER_TENDER';
  return 'OK';
}

/**
 * Apply one tender to a bill and, when coverage is reached, settle it + allocate its
 * receipt — atomically and idempotently. See the module doc for the full contract.
 */
export async function applyTender(
  db: ScopedDb,
  input: ApplyTenderInput
): Promise<ApplyTenderResult> {
  return runMoneyTransaction(db, (tx) => applyTenderInTransaction(tx, input));
}

/** Apply a tender using an existing tenant-scoped transaction. Integration seams
 * use this to keep their reconciliation record atomic with the money mutation. */
export async function applyTenderInTransaction(
  tx: ScopedDb,
  input: ApplyTenderInput
): Promise<ApplyTenderResult> {
  const at = input.now ?? new Date();
  const commandType = `tender.${input.tender.type.toLowerCase()}`;
  const canonicalBytes = JSON.stringify({
    version: 1,
    billId: input.billId,
    tender:
      input.tender.type === 'CASH'
        ? {
            type: input.tender.type,
            amount: money(input.tender.amount).toFixed(2),
            cashReceived: money(input.tender.cashReceived).toFixed(2),
          }
        : {
            type: input.tender.type,
            amount: money(input.tender.amount).toFixed(2),
            tipAmount: money(input.tender.tipAmount ?? ZERO).toFixed(2),
            terminalConfirmation:
              input.tender.type === 'CARD'
                ? (input.tender.terminalConfirmation ?? null)
                : undefined,
          },
  });
  const legacy = await tx.restaurantMoneyIdempotencyKey.findUnique({
    where: {
      deviceId_key: { deviceId: input.actor.deviceId, key: input.actor.idempotencyKey },
    },
    select: { commandType: true, canonicalPayloadHash: true, resultPayload: true, resultRef: true },
  });
  if (legacy?.canonicalPayloadHash === null && legacy.resultPayload === null) {
    if (legacy.commandType !== commandType) {
      throw new MoneyIdempotencyError(
        'This idempotency key is already bound to a different canonical money payload.'
      );
    }
    return replayTenderResult(tx, legacy.resultRef);
  }
  const idem = await beginMoneyIdempotent(tx, input.actor, commandType, {
    bytes: canonicalBytes,
    hash: createHash('sha256').update(canonicalBytes, 'utf8').digest('hex'),
  });
  if (idem.replay) {
    if (idem.resultPayload) return decodeFrozenResult(idem.resultPayload);
    return replayTenderResult(tx, idem.resultRef);
  }

  // Match cancellation's deterministic order → bill lock order. Besides serializing
  // final tenders, the order lock prevents a cancellation waiting on this bill from
  // deadlocking with settlement work that must subsequently touch the order.
  const billOwner = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: { orderId: true },
  });
  if (!billOwner) {
    throw new TenderError('The bill does not exist.', 'BILL_NOT_FOUND');
  }
  await tx.$queryRaw`SELECT id FROM restaurant_orders WHERE id = ${billOwner.orderId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${input.billId} FOR UPDATE`;

  const bill = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: {
      id: true,
      organizationId: true,
      orderId: true,
      status: true,
      grandTotal: true,
      subtotal: true,
      compTotal: true,
      discountTotal: true,
      serviceChargeTotal: true,
      deliveryFeeTotal: true,
      roundingAdjustment: true,
      branchId: true,
      businessDate: true,
      splitKind: true,
      fractionNumerator: true,
      fractionDenominator: true,
    },
  });
  if (!bill) {
    throw new TenderError('The bill does not exist.', 'BILL_NOT_FOUND');
  }
  if (input.branchId && bill.branchId !== input.branchId) {
    throw new TenderError('The bill is not available to this terminal.', 'BILL_NOT_FOUND');
  }
  if (bill.status !== 'OPEN') {
    throw new TenderError('Only an OPEN bill can be tendered.', 'BILL_NOT_OPEN');
  }

  const amount = money(input.tender.amount);

  const existing = (await tx.restaurantTender.findMany({
    where: { billId: bill.id },
    select: { id: true, type: true, amount: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })) as TenderRow[];
  const settlement = await loadSettlementContext(tx, bill, existing, input.tender.type, at);
  const outstanding = settlement.quote.remainingDue;
  // Validate the amount AGAINST the outstanding balance so a zero amount is
  // accepted only as the settlement of an already-fully-covered bill (e.g. a
  // fully comped, zero grand-total bill). The applied amount may never exceed
  // what is due — the only over-payment is cash change (handled inside the cash
  // path, not against the bill).
  const verdict = classifyTenderAmount(amount, outstanding);
  if (verdict === 'INVALID_AMOUNT') {
    throw new TenderError('A tender amount must be positive.', 'INVALID_AMOUNT');
  }
  if (verdict === 'OVER_TENDER') {
    throw new TenderError(
      'The tender amount exceeds the current server quote; the only over-payment is cash change.',
      'OVER_TENDER'
    );
  }

  const isFinal = equals(amount, outstanding);
  const device = await tx.restaurantRegisteredDevice.findFirst({
    where: { id: input.actor.deviceId, branchId: bill.branchId, revokedAt: null },
    select: { branch: { select: { timezone: true, businessDayCutoff: true } } },
  });
  if (!device) {
    throw new TenderError('The bill is not available to this terminal.', 'BILL_NOT_FOUND');
  }
  const postingDate = businessDateToUtcDate(
    resolveBusinessDate(at, device.branch.timezone, device.branch.businessDayCutoff)
  );
  // Settlement changes the bill-day sales snapshot; collection changes the posting
  // day's tender totals. Lock both in date order and never mutate a closed snapshot.
  for (const day of [...new Set([bill.businessDate.getTime(), postingDate.getTime()])].sort(
    (a, b) => a - b
  )) {
    await assertMoneyDayOpen(tx, bill.branchId, new Date(day));
  }
  const persisted = await persistTender(tx, bill, input, amount, postingDate);

  const remainingDue = sub(outstanding, amount);
  let settled = false;
  let receiptNumber: number | null = null;
  if (isFinal) {
    const result = await finalizeTaxSettlement(
      tx,
      bill,
      input,
      at,
      existing,
      persisted.tenderId,
      settlement
    );
    settled = true;
    receiptNumber = result.receiptNumber;
    await closeOrderAfterSettlement(tx, bill.orderId, input.actor, at);
  }

  if (input.tender.type === 'CARD' && input.tender.terminalConfirmation) {
    const terminal = input.tender.terminalConfirmation;
    await tx.restaurantTerminalReconciliation.create({
      data: {
        configId: terminal.configId,
        branchId: terminal.branchId,
        externalEventId: terminal.externalEventId,
        source: terminal.source,
        eventStatus: 'APPROVED',
        externalReference: terminal.externalReference,
        amount,
        tipAmount: persisted.tipAmount,
        billId: bill.id,
        paymentId: persisted.paymentId,
        tenderId: persisted.tenderId,
        outcome: 'APPLIED',
      },
    });
  }

  const result: ApplyTenderResult = {
    tenderId: persisted.tenderId,
    billId: bill.id,
    type: input.tender.type,
    amount,
    tipAmount: persisted.tipAmount,
    changeGiven: persisted.changeGiven,
    paymentId: persisted.paymentId,
    drawerSessionId: persisted.drawerSessionId,
    settled,
    receiptNumber,
    remainingDue: isFinal ? ZERO : remainingDue,
    replayed: false,
  };
  await recordMoneyResult(tx, input.actor, persisted.tenderId, encodeFrozenResult(result), at);
  return result;
}

/**
 * Compute the live, tax-inclusive settlement quote for an OPEN bill exactly as a
 * CASH tender would — WITHOUT applying anything (QA-143). The stored open-bill
 * `grandTotal` is pre-tax and its `taxTotal` is 0 until settlement (tax is only
 * frozen once a tender's payment category is known), so the register summary read
 * must recompute here to disclose tax and a `remainingDue` that actually settles
 * the bill rather than the pre-tax total.
 *
 * CASH is used as the proposed category because that is the TenderPad default; any
 * PRIOR tenders keep their own category weighting, so a summary taken after a
 * partial tender reports the true remaining tax rather than 0.00. Returns null when
 * the bill is missing, not OPEN, or its tax cannot be quoted (e.g. no effective
 * profile) — the caller then falls back to the stored totals.
 */
export async function quoteOpenBillSettlement(
  tx: ScopedDb,
  billId: string,
  at: Date
): Promise<TaxQuoteResult | null> {
  const bill = await tx.restaurantBill.findUnique({
    where: { id: billId },
    select: {
      id: true,
      organizationId: true,
      orderId: true,
      status: true,
      grandTotal: true,
      subtotal: true,
      compTotal: true,
      discountTotal: true,
      serviceChargeTotal: true,
      deliveryFeeTotal: true,
      roundingAdjustment: true,
      branchId: true,
      businessDate: true,
      splitKind: true,
      fractionNumerator: true,
      fractionDenominator: true,
    },
  });
  if (!bill || bill.status !== 'OPEN') return null;
  const existing = (await tx.restaurantTender.findMany({
    where: { billId: bill.id },
    select: { id: true, type: true, amount: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })) as TenderRow[];
  try {
    const settlement = await loadSettlementContext(tx, bill, existing, 'CASH', at);
    return settlement.quote;
  } catch (err) {
    if (err instanceof TenderError) return null;
    throw err;
  }
}

async function loadSettlementContext(
  tx: ScopedDb,
  bill: BillForTender,
  priorTenders: TenderRow[],
  proposedTenderType: TenderType,
  at: Date
): Promise<SettlementContext> {
  const effectiveWindow = {
    effectiveFrom: { lte: at },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
  };
  const profiles = await tx.restaurantTaxProfileVersion.findMany({
    where: { branchId: bill.branchId, status: 'PUBLISHED', ...effectiveWindow },
    select: {
      id: true,
      effectiveFrom: true,
      effectiveTo: true,
      status: true,
      approvalReference: true,
      approvedAt: true,
      rules: {
        where: { status: 'PUBLISHED', ...effectiveWindow },
        select: {
          id: true,
          profileVersionId: true,
          paymentCategory: true,
          priceMode: true,
          rate: true,
          effectiveFrom: true,
          effectiveTo: true,
          status: true,
          approvalReference: true,
          approvedAt: true,
          officialSource: { select: { expiresAt: true } },
        },
      },
    },
  });
  const organization = await tx.organization.findUnique({
    where: { id: bill.organizationId },
    select: { currency: true },
  });
  if (!organization) throw new TenderError('The bill organization is unavailable.', 'INVALID');
  const billLines = await tx.restaurantBillLine.findMany({
    where: { billId: bill.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      orderItemId: true,
      quantity: true,
      unitPrice: true,
      compAmount: true,
      orderItem: { select: { modifiers: { select: { priceDelta: true } } } },
    },
  });
  const fractionalItems =
    bill.splitKind === 'FRACTIONAL'
      ? await tx.restaurantOrderItem.findMany({
          where: {
            orderId: bill.orderId,
            status: { not: 'VOIDED' },
            remakeOfItemId: null,
          },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            modifiers: { select: { priceDelta: true } },
          },
        })
      : [];
  const fractionalBills =
    bill.splitKind === 'FRACTIONAL'
      ? await tx.restaurantBill.findMany({
          where: { orderId: bill.orderId, status: { not: 'VOID' }, splitKind: 'FRACTIONAL' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, fractionNumerator: true },
        })
      : [];
  const fractionalIndex = fractionalBills.findIndex((candidate) => candidate.id === bill.id);
  const fractionalWeights = fractionalBills.map((candidate) => candidate.fractionNumerator ?? 0);
  const applications = await tx.restaurantPromotionBillApplicationSnapshot.findMany({
    where: { billId: bill.id, reversesBillApplicationId: null },
    orderBy: [{ applicationOrdinal: 'asc' }, { id: 'asc' }],
    select: {
      evaluationId: true,
      taxTreatment: true,
      computedAmount: true,
      evaluation: { select: { outputHash: true, currency: true } },
      application: {
        select: {
          allocations: { select: { orderItemId: true, unitOrdinal: true, allocatedAmount: true } },
        },
      },
    },
  });
  const evaluationIds = [...new Set(applications.map((row) => row.evaluationId))];
  if (evaluationIds.length > 1) {
    throw new TenderError('Conflicting promotion evidence cannot be settled.', 'INVALID');
  }
  const discounts = new Map<string, Prisma.Decimal>();
  // Accepted promotions are already reflected in the open bill's discountTotal.
  // Preserve only its non-promotion remainder here, then rebuild promotion
  // accounting from immutable application snapshots without double counting.
  const discountAccounting = splitCheckoutDiscountAccounting(bill.discountTotal, applications);
  const afterTaxDiscount = discountAccounting.afterTaxDiscount;
  for (const row of applications) {
    if (row.taxTreatment === 'AFTER_TAX') continue;
    for (const allocation of row.application.allocations) {
      const key = `${allocation.orderItemId}:${allocation.unitOrdinal}`;
      discounts.set(key, add(discounts.get(key) ?? ZERO, allocation.allocatedAmount));
    }
  }

  const lines: SettlementContext['lines'] = [];
  const evidenceLines =
    bill.splitKind === 'FRACTIONAL'
      ? fractionalItems.map((line) => ({
          id: line.id,
          orderItemId: line.id,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          compAmount: ZERO,
          modifiers: line.modifiers,
        }))
      : billLines.map((line) => ({
          id: line.id,
          orderItemId: line.orderItemId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          compAmount: line.compAmount,
          modifiers: line.orderItem.modifiers,
        }));
  const quoteLines = evidenceLines.flatMap((line) => {
    const modifiers = sum(line.modifiers.map((modifier) => modifier.priceDelta));
    const comps =
      line.quantity > 0
        ? splitFractionalMoney(
            line.compAmount,
            Array.from({ length: line.quantity }, () => '1')
          )
        : [];
    return Array.from({ length: line.quantity }, (_, unitOrdinal) => {
      const beforeTaxDiscount = discounts.get(`${line.orderItemId}:${unitOrdinal}`) ?? ZERO;
      const comp = comps[unitOrdinal] ?? ZERO;
      lines.push({
        billLineId: bill.splitKind === 'FRACTIONAL' ? null : line.id,
        ...(bill.splitKind === 'FRACTIONAL' ? { sourceOrderItemId: line.id } : {}),
        unitOrdinal,
        comp,
        beforeTaxDiscount,
      });
      const unitPrice =
        bill.splitKind === 'FRACTIONAL'
          ? splitMoney(line.unitPrice.plus(modifiers), fractionalWeights.map(String))[
              fractionalIndex
            ]!
          : line.unitPrice;
      return {
        id: `${line.id}:${unitOrdinal}`,
        unitPrice,
        quantity: 1,
        modifierTotal: bill.splitKind === 'FRACTIONAL' ? ZERO : modifiers,
        comp,
        beforeTaxDiscount,
      };
    });
  });
  const merchandiseBasis = sum(
    quoteLines.map((line) =>
      line.unitPrice.plus(line.modifierTotal).minus(line.comp).minus(line.beforeTaxDiscount)
    )
  );
  // Bill cutting freezes the order-pinned service policy, basis, rate, and resulting
  // charge. Settlement must consume that evidence rather than repricing the charge
  // against whichever policy happens to be effective when payment is collected.
  const serviceAmount = formatMoney(bill.serviceChargeTotal);
  const taxablePriorTenders = allocateTaxableTenderPrincipals(priorTenders, merchandiseBasis);
  // Principal already returned by a refund is no longer retained by the bill, so it
  // must not count toward settlement; otherwise a bill could settle short.
  const refundedPrincipal = money(
    (
      await tx.restaurantRefund.aggregate({
        where: { billId: bill.id },
        _sum: { amount: true },
      })
    )._sum.amount ?? ZERO
  );
  const taxableQuote = quoteTaxSettlement({
    lines: quoteLines,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      effectiveFrom: profile.effectiveFrom,
      effectiveTo: profile.effectiveTo,
      status: profile.status,
      approvalReference: profile.approvalReference,
      approvedAt: profile.approvedAt,
    })),
    rules: profiles.flatMap((profile) =>
      profile.rules.map((rule) => ({ ...rule, sourceExpiresAt: rule.officialSource.expiresAt }))
    ),
    at,
    proposedTenderType,
    priorTenderWeights: taxablePriorTenders,
    acceptedPrincipal: sub(sum(priorTenders.map((tender) => tender.amount)), refundedPrincipal),
    afterTaxDiscount,
    serviceCharge: { amount: serviceAmount, taxable: false },
    roundingAdjustment: bill.roundingAdjustment,
  });
  const acceptedPrincipal = taxableQuote.acceptedPrincipal;
  const grandTotal = add(taxableQuote.grandTotal, bill.deliveryFeeTotal);
  const quote: TaxQuoteResult = {
    ...taxableQuote,
    acceptedPrincipal,
    grandTotal,
    remainingDue: sub(grandTotal, acceptedPrincipal),
  };
  const profile = profiles.find(
    (candidate) =>
      candidate.effectiveFrom <= at && (!candidate.effectiveTo || at < candidate.effectiveTo)
  );
  if (!profile) throw new TenderError('No effective tax profile is available.', 'INVALID');
  return {
    profileId: profile.id,
    currency: organization.currency,
    rules: new Map(
      profiles.flatMap((candidate) =>
        candidate.rules.map(
          (rule) => [rule.id, { priceMode: rule.priceMode, rate: rule.rate }] as const
        )
      )
    ),
    quote,
    lines,
    promotionEvaluationId: evaluationIds[0] ?? null,
    promotionEvaluationHash: applications[0]?.evaluation.outputHash ?? null,
  };
}

/** Limit tax-allocation weights to category-neutral merchandise consideration.
 * A prior tender may also cover non-taxable delivery/service amounts, so its full
 * accepted principal remains part of the bill balance but must not be reinterpreted
 * using the newly proposed tender category's gross merchandise total. */
export function allocateTaxableTenderPrincipals(
  priorTenders: ReadonlyArray<Pick<TenderRow, 'type' | 'amount'>>,
  merchandiseConsideration: Prisma.Decimal
): Array<{ tenderType: TenderType; principal: Prisma.Decimal }> {
  let remainingMerchandise = merchandiseConsideration;
  return priorTenders.map((tender) => {
    const principal = Prisma.Decimal.min(tender.amount, remainingMerchandise);
    remainingMerchandise = Prisma.Decimal.max(ZERO, sub(remainingMerchandise, principal));
    return { tenderType: tender.type, principal };
  });
}

async function finalizeTaxSettlement(
  tx: ScopedDb,
  bill: BillForTender,
  input: ApplyTenderInput,
  at: Date,
  priorTenders: TenderRow[],
  finalTenderId: string,
  settlement: SettlementContext
) {
  const quoteLines = settlement.quote.lines;
  const lineIds = [
    ...new Set(settlement.lines.map((line) => line.billLineId ?? line.sourceOrderItemId!)),
  ];
  const afterTaxByLine = allocateAcross(
    settlement.quote.afterTaxDiscount,
    lineIds.map((id) =>
      sum(
        quoteLines
          .filter(
            (_, index) =>
              (settlement.lines[index]!.billLineId ??
                settlement.lines[index]!.sourceOrderItemId) === id
          )
          .map((line) => line.gross)
      )
    )
  );
  const serviceByLine = allocateAcross(
    settlement.quote.serviceChargePayable,
    lineIds.map((id) =>
      sum(
        quoteLines
          .filter(
            (_, index) =>
              (settlement.lines[index]!.billLineId ??
                settlement.lines[index]!.sourceOrderItemId) === id
          )
          .map((line) => line.gross)
      )
    )
  );
  const lines = lineIds.map((evidenceLineId, lineIndex) => {
    const units = quoteLines
      .map((line, index) => ({ line, identity: settlement.lines[index]! }))
      .filter(
        (unit) => (unit.identity.billLineId ?? unit.identity.sourceOrderItemId) === evidenceLineId
      );
    const merchandiseTax = sum(units.map((unit) => unit.line.tax));
    const merchandiseGross = sum(units.map((unit) => unit.line.gross));
    const bucketDiscounts = allocateAcross(
      afterTaxByLine[lineIndex] ?? ZERO,
      units.flatMap((unit) => unit.line.buckets.map((bucket) => bucket.gross))
    );
    let bucketIndex = 0;
    return {
      billLineId: bill.splitKind === 'FRACTIONAL' ? null : evidenceLineId,
      ...(bill.splitKind === 'FRACTIONAL' ? { sourceOrderItemId: evidenceLineId } : {}),
      taxAmount: merchandiseTax,
      serviceChargeAmount: serviceByLine[lineIndex] ?? ZERO,
      lineTotal: sub(
        add(merchandiseGross, serviceByLine[lineIndex] ?? ZERO),
        afterTaxByLine[lineIndex] ?? ZERO
      ),
      buckets: units.flatMap((unit) =>
        (bill.splitKind === 'FRACTIONAL' ? [] : unit.line.buckets).map((bucket) => ({
          unitOrdinal: unit.identity.unitOrdinal,
          ruleVersionId: bucket.ruleId,
          paymentCategory: bucket.category,
          priceMode: requireRule(settlement, bucket.ruleId).priceMode,
          rate: requireRule(settlement, bucket.ruleId).rate,
          taxableAmount: bucket.net,
          taxAmount: bucket.tax,
          grossAmount: bucket.gross,
          preDiscountGrossAmount: add(
            add(bucket.consideration, unit.identity.comp),
            unit.identity.beforeTaxDiscount
          ),
          beforeTaxDiscountAmount: unit.identity.beforeTaxDiscount,
          afterTaxDiscountAmount: bucketDiscounts[bucketIndex++] ?? ZERO,
        }))
      ),
    };
  });
  const tenderTaxAllocations =
    bill.splitKind === 'FRACTIONAL'
      ? undefined
      : allocateTenderTax(
          [
            ...priorTenders,
            {
              id: finalTenderId,
              type: input.tender.type,
              amount: money(input.tender.amount),
              createdAt: at,
            },
          ],
          settlement,
          lines
        );
  const inclusiveMerchandiseTax = sum(
    settlement.quote.lines.flatMap((line) =>
      line.buckets
        .filter((bucket) => requireRule(settlement, bucket.ruleId).priceMode === 'INCLUSIVE')
        .map((bucket) => bucket.tax)
    )
  );
  return finalizeBillSettlement(tx, {
    billId: bill.id,
    organizationId: bill.organizationId,
    staffProfileId: input.actor.staffProfileId,
    deviceId: input.actor.deviceId,
    at,
    transactionReference: `bill:${bill.id}:settlement:v1`,
    profileVersionId: settlement.profileId,
    currency: settlement.currency,
    subtotal: sub(bill.subtotal, inclusiveMerchandiseTax),
    discountTotal: add(
      sum(settlement.lines.map((line) => line.beforeTaxDiscount)),
      settlement.quote.afterTaxDiscount
    ),
    serviceChargeTotal: settlement.quote.serviceChargePayable,
    deliveryFeeTotal: bill.deliveryFeeTotal,
    taxTotal: settlement.quote.tax,
    roundingAdjustment: settlement.quote.roundingAdjustment,
    grandTotal: settlement.quote.grandTotal,
    eligibleNetMerchandise: settlement.quote.net,
    loyaltyNetGrandTotal: settlement.quote.net,
    promotionEvaluationId: settlement.promotionEvaluationId,
    promotionEvaluationHash: settlement.promotionEvaluationHash,
    lines,
    serviceChargeBuckets: [],
    tenderTaxAllocations,
    ...(bill.splitKind === 'FRACTIONAL'
      ? {
          fractionalEvidence: {
            sourceOrderId: bill.orderId,
            fractionNumerator: bill.fractionNumerator!,
            fractionDenominator: bill.fractionDenominator!,
            allocationMethod: 'LARGEST_REMAINDER' as const,
          },
        }
      : {}),
  });
}

function allocateAcross(total: Prisma.Decimal, weights: Prisma.Decimal[]): Prisma.Decimal[] {
  if (isZero(total)) return weights.map(() => ZERO);
  const positive = weights
    .map((weight, index) => ({ weight, index }))
    .filter(({ weight }) => compare(weight, ZERO) > 0);
  if (positive.length === 0)
    throw new TenderError('Settlement allocation has no positive basis.', 'INVALID');
  const values = splitMoney(
    total,
    positive.map(({ weight }) => weight)
  );
  return weights.map(
    (_, index) => values[positive.findIndex((entry) => entry.index === index)] ?? ZERO
  );
}

/** Deterministically assign one frozen bucket's exact cents to its original
 * tenders. Exported as a pure acceptance seam for refund-reconciliation tests. */
export function allocateTenderTaxCents(
  taxAmount: Prisma.Decimal,
  owners: readonly { tenderId: string; principal: Prisma.Decimal }[]
): Array<{ originalTenderId: string; cents: number }> {
  if (owners.length === 0) {
    throw new TenderError('A frozen tax bucket requires an original tender.', 'INVALID');
  }
  const shares = allocateAcross(
    taxAmount,
    owners.map((owner) => owner.principal)
  );
  return owners.map((owner, index) => ({
    originalTenderId: owner.tenderId,
    cents: shares[index]!.mul(100).toNumber(),
  }));
}

function requireRule(
  settlement: SettlementContext,
  ruleId: string
): { priceMode: 'EXCLUSIVE' | 'INCLUSIVE'; rate: Prisma.Decimal } {
  const rule = settlement.rules.get(ruleId);
  if (!rule) throw new TenderError('The selected tax rule is unavailable.', 'INVALID');
  return rule;
}

function allocateTenderTax(
  tenders: TenderRow[],
  settlement: SettlementContext,
  lines: Array<{
    billLineId: string | null;
    sourceOrderItemId?: string;
    buckets: Array<{
      unitOrdinal: number;
      ruleVersionId: string;
      paymentCategory: string;
      taxAmount: Prisma.Decimal;
    }>;
  }>
): SettlementTenderTaxAllocation[] {
  const remainingByCategory = new Map<
    PaymentCategory,
    Array<{ id: string; weight: Prisma.Decimal }>
  >();
  let merchandiseRemaining = sum(settlement.quote.lines.map((line) => line.consideration));
  for (const tender of tenders) {
    const weight = Prisma.Decimal.min(tender.amount, merchandiseRemaining);
    merchandiseRemaining = sub(merchandiseRemaining, weight);
    if (compare(weight, ZERO) <= 0) continue;
    const rows = remainingByCategory.get(tender.type) ?? [];
    rows.push({ id: tender.id, weight });
    remainingByCategory.set(tender.type, rows);
  }
  return lines.flatMap((line) =>
    line.buckets.flatMap((bucket) => {
      const category = bucket.paymentCategory as PaymentCategory;
      const owners = remainingByCategory.get(category) ?? [];
      const shares = allocateTenderTaxCents(
        bucket.taxAmount,
        owners.map((owner) => ({ tenderId: owner.id, principal: owner.weight }))
      );
      return shares.map((share) => ({
        originalTenderId: share.originalTenderId,
        paymentCategory: category,
        bucket: {
          ...(line.billLineId
            ? { allocationKind: 'MERCHANDISE' as const, billLineId: line.billLineId }
            : {
                allocationKind: 'FRACTIONAL_MERCHANDISE' as const,
                sourceOrderItemId: line.sourceOrderItemId!,
              }),
          unitOrdinal: bucket.unitOrdinal,
          ruleVersionId: bucket.ruleVersionId,
          paymentCategory: category,
        },
        cents: share.cents,
      }));
    })
  );
}

function encodeFrozenResult(result: ApplyTenderResult): Prisma.InputJsonValue {
  return {
    ...result,
    amount: result.amount.toFixed(2),
    tipAmount: result.tipAmount.toFixed(2),
    changeGiven: result.changeGiven?.toFixed(2) ?? null,
    remainingDue: result.remainingDue.toFixed(2),
  };
}

function decodeFrozenResult(payload: Prisma.JsonValue): ApplyTenderResult {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TenderError('The frozen tender replay payload is invalid.', 'INVALID');
  }
  const value = payload as Record<string, Prisma.JsonValue>;
  return {
    tenderId: String(value.tenderId),
    billId: String(value.billId),
    type: String(value.type) as TenderType,
    amount: money(String(value.amount)),
    tipAmount: money(String(value.tipAmount)),
    changeGiven: value.changeGiven === null ? null : money(String(value.changeGiven)),
    paymentId: value.paymentId === null ? null : String(value.paymentId),
    drawerSessionId: value.drawerSessionId === null ? null : String(value.drawerSessionId),
    settled: value.settled === true,
    receiptNumber: value.receiptNumber === null ? null : Number(value.receiptNumber),
    remainingDue: money(String(value.remainingDue)),
    replayed: true,
  };
}

/** Dispatch to the per-type persistence path (all inside the caller's transaction). */
function persistTender(
  tx: ScopedDb,
  bill: BillForTender,
  input: ApplyTenderInput,
  amount: Prisma.Decimal,
  postingDate: Date
): Promise<PersistedTender> {
  switch (input.tender.type) {
    case 'CASH':
      return persistCashTender(tx, bill, input.tender, input.actor, amount, postingDate);
    case 'CARD':
      return persistCardTender(tx, bill, input.tender, input.actor, amount, postingDate);
    case 'OTHER':
      return persistOtherTender(tx, bill, input.tender, input.actor, amount, postingDate);
    default: {
      const exhaustive: never = input.tender;
      throw new TenderError(`Unknown tender type: ${JSON.stringify(exhaustive)}`, 'INVALID');
    }
  }
}

async function persistCashTender(
  tx: ScopedDb,
  bill: BillForTender,
  tender: CashTenderSpec,
  actor: MoneyActor,
  amount: Prisma.Decimal,
  postingDate: Date
): Promise<PersistedTender> {
  const cashReceived = money(tender.cashReceived);
  if (compare(cashReceived, amount) < 0) {
    throw new TenderError('The cash received is less than the tender amount.', 'INSUFFICIENT_CASH');
  }
  const changeGiven = sub(cashReceived, amount);

  const drawer = await tx.restaurantDrawerSession.findFirst({
    where: {
      deviceId: actor.deviceId,
      branchId: bill.branchId,
      businessDate: postingDate,
      status: 'OPEN',
    },
    select: { id: true },
  });
  if (!drawer) {
    throw new TenderError(
      'This register has no OPEN drawer for the current business day; open one before taking cash.',
      'DRAWER_NOT_OPEN'
    );
  }

  const created = await tx.restaurantTender.create({
    data: {
      billId: bill.id,
      type: 'CASH',
      amount,
      tipAmount: ZERO,
      cashReceived,
      changeGiven,
      drawerSessionId: drawer.id,
      businessDate: postingDate,
      staffProfileId: actor.staffProfileId,
      deviceId: actor.deviceId,
    },
    select: { id: true },
  });

  // The net cash retained (amount = cashReceived − change) is the CASH_SALE movement.
  await appendMovement(tx, {
    drawerSessionId: drawer.id,
    kind: 'CASH_SALE',
    amount,
    tenderId: created.id,
    staffProfileId: actor.staffProfileId,
    deviceId: actor.deviceId,
  });

  return {
    tenderId: created.id,
    tipAmount: ZERO,
    changeGiven,
    paymentId: null,
    drawerSessionId: drawer.id,
  };
}

async function persistCardTender(
  tx: ScopedDb,
  bill: BillForTender,
  tender: CardTenderSpec,
  actor: MoneyActor,
  amount: Prisma.Decimal,
  postingDate: Date
): Promise<PersistedTender> {
  const tipAmount = tender.tipAmount === undefined ? ZERO : money(tender.tipAmount);
  if (isNegative(tipAmount)) {
    throw new TenderError('A tip amount must not be negative.', 'INVALID_AMOUNT');
  }

  const operationRef = `${bill.id}:${actor.deviceId}:${actor.idempotencyKey}`;
  const outcome = tender.terminalConfirmation
    ? {
        approved: true,
        status: 'CAPTURED' as const,
        providerRef: tender.terminalConfirmation.providerRef,
        declineCode: null,
        event: {
          capability: 'SALE' as const,
          eventType: 'TERMINAL_APPROVED',
          amount,
          providerRef: tender.terminalConfirmation.providerRef,
          payload: {
            provider: 'TERMINAL',
            externalEventId: tender.terminalConfirmation.externalEventId,
          },
        },
      }
    : getPaymentProvider('MOCK').execute({ capability: 'SALE', amount, tipAmount, operationRef });
  if (!outcome.approved) {
    // Abort the whole transaction: a decline leaves no tender/movement/payment/receipt.
    throw new TenderError(
      `The card sale was declined (${outcome.declineCode ?? 'DECLINED'}).`,
      'CARD_DECLINED'
    );
  }

  const payment = await tx.restaurantPayment.create({
    data: {
      billId: bill.id,
      provider: tender.terminalConfirmation ? 'TERMINAL' : 'MOCK',
      capability: 'SALE',
      status: outcome.status,
      amount,
      tipAmount,
      providerRef: outcome.providerRef,
      staffProfileId: actor.staffProfileId,
      deviceId: actor.deviceId,
    },
    select: { id: true },
  });
  await appendPaymentEvent(tx, {
    paymentId: payment.id,
    capability: outcome.event.capability,
    eventType: outcome.event.eventType,
    amount: outcome.event.amount,
    providerRef: outcome.event.providerRef,
    payload: outcome.event.payload,
  });

  const created = await tx.restaurantTender.create({
    data: {
      billId: bill.id,
      type: 'CARD',
      amount,
      tipAmount,
      paymentId: payment.id,
      businessDate: postingDate,
      staffProfileId: actor.staffProfileId,
      deviceId: actor.deviceId,
    },
    select: { id: true },
  });

  return {
    tenderId: created.id,
    tipAmount,
    changeGiven: null,
    paymentId: payment.id,
    drawerSessionId: null,
  };
}

async function persistOtherTender(
  tx: ScopedDb,
  bill: BillForTender,
  tender: OtherTenderSpec,
  actor: MoneyActor,
  amount: Prisma.Decimal,
  postingDate: Date
): Promise<PersistedTender> {
  const tipAmount = tender.tipAmount === undefined ? ZERO : money(tender.tipAmount);
  if (isNegative(tipAmount)) {
    throw new TenderError('A tip amount must not be negative.', 'INVALID_AMOUNT');
  }
  const created = await tx.restaurantTender.create({
    data: {
      billId: bill.id,
      type: 'OTHER',
      amount,
      tipAmount,
      businessDate: postingDate,
      staffProfileId: actor.staffProfileId,
      deviceId: actor.deviceId,
    },
    select: { id: true },
  });
  return {
    tenderId: created.id,
    tipAmount,
    changeGiven: null,
    paymentId: null,
    drawerSessionId: null,
  };
}

/** Reconstruct the result of a previously-applied tender for an idempotent replay:
 * the original tender is re-read and the bill's current coverage/settled state is
 * reported (a replay creates nothing). */
async function replayTenderResult(
  tx: ScopedDb,
  resultRef: string | null
): Promise<ApplyTenderResult> {
  if (!resultRef) {
    throw new TenderError('The idempotent result reference is missing.', 'INVALID');
  }
  const tender = await tx.restaurantTender.findUnique({
    where: { id: resultRef },
    select: {
      id: true,
      billId: true,
      type: true,
      amount: true,
      tipAmount: true,
      changeGiven: true,
      paymentId: true,
      drawerSessionId: true,
      bill: { select: { grandTotal: true, status: true, receiptNumber: true } },
    },
  });
  if (!tender) {
    throw new TenderError('The replayed tender no longer exists.', 'INVALID');
  }
  const agg = await tx.restaurantTender.aggregate({
    where: { billId: tender.billId },
    _sum: { amount: true },
  });
  const nowTendered = money(agg._sum.amount ?? ZERO);
  return {
    tenderId: tender.id,
    billId: tender.billId,
    type: tender.type as TenderType,
    amount: tender.amount,
    tipAmount: tender.tipAmount,
    changeGiven: tender.changeGiven,
    paymentId: tender.paymentId,
    drawerSessionId: tender.drawerSessionId,
    settled: tender.bill.status === 'SETTLED',
    receiptNumber: tender.bill.receiptNumber,
    remainingDue: sub(tender.bill.grandTotal, nowTendered),
    replayed: true,
  };
}
