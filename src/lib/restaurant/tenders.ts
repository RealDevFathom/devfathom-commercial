import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { settleBill } from './bills';
import {
  appendMovement,
  beginMoneyIdempotent,
  recordMoneyResult,
  runMoneyTransaction,
  type MoneyActor,
} from './drawer-sessions';
import { add, compare, equals, isNegative, isZero, money, sub, sum, ZERO } from './money';
import { appendPaymentEvent, getPaymentProvider } from './payment-adapter';

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
 * outstanding balance — the ONLY over-payment is cash change. When the applied
 * tenders reach the grand total EXACTLY (Decimal equality), the bill is settled and
 * its receipt number allocated in the SAME transaction, EXACTLY ONCE: a bill-row
 * `FOR UPDATE` lock serializes concurrent final tenders, so the loser observes the
 * SETTLED bill and is rejected rather than allocating a second receipt.
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
  status: string;
  grandTotal: Prisma.Decimal;
  branchId: string;
  businessDate: Date;
};

/** The persisted shape of one applied tender, before coverage/settlement. */
type PersistedTender = {
  tenderId: string;
  tipAmount: Prisma.Decimal;
  changeGiven: Prisma.Decimal | null;
  paymentId: string | null;
  drawerSessionId: string | null;
};

/**
 * Apply one tender to a bill and, when coverage is reached, settle it + allocate its
 * receipt — atomically and idempotently. See the module doc for the full contract.
 */
export async function applyTender(db: ScopedDb, input: ApplyTenderInput): Promise<ApplyTenderResult> {
  const at = input.now ?? new Date();
  const commandType = `tender.${input.tender.type.toLowerCase()}`;
  return runMoneyTransaction(db, async (tx) => {
    const idem = await beginMoneyIdempotent(tx, input.actor, commandType);
    if (idem.replay) return replayTenderResult(tx, idem.resultRef);

    // Serialize concurrent tenders on this bill so a receipt is allocated exactly
    // once (C4/C10): the row lock blocks a second final tender until the first
    // commits, after which the loser sees the SETTLED status below and is rejected.
    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${input.billId} FOR UPDATE`;

    const bill = await tx.restaurantBill.findUnique({
      where: { id: input.billId },
      select: { id: true, status: true, grandTotal: true, branchId: true, businessDate: true },
    });
    if (!bill) {
      throw new TenderError('The bill does not exist.', 'BILL_NOT_FOUND');
    }
    if (bill.status !== 'OPEN') {
      throw new TenderError('Only an OPEN bill can be tendered.', 'BILL_NOT_OPEN');
    }

    const amount = money(input.tender.amount);
    if (isZero(amount) || isNegative(amount)) {
      throw new TenderError('A tender amount must be positive.', 'INVALID_AMOUNT');
    }

    const existing = await tx.restaurantTender.findMany({
      where: { billId: bill.id },
      select: { amount: true },
    });
    const alreadyTendered = sum(existing.map((t) => t.amount));
    const outstanding = sub(bill.grandTotal, alreadyTendered);
    // The applied amount may never exceed what is due — the only over-payment is
    // cash change (handled inside the cash path, not against the bill).
    if (compare(amount, outstanding) > 0) {
      throw new TenderError(
        'The tender amount exceeds the bill balance; the only over-payment is cash change.',
        'OVER_TENDER'
      );
    }

    const persisted = await persistTender(tx, bill, input, amount, at);

    const nowTendered = add(alreadyTendered, amount);
    const remainingDue = sub(bill.grandTotal, nowTendered);
    let settled = false;
    let receiptNumber: number | null = null;
    if (equals(nowTendered, bill.grandTotal)) {
      const result = await settleBill(tx, {
        billId: bill.id,
        staffProfileId: input.actor.staffProfileId,
        deviceId: input.actor.deviceId,
        at,
      });
      settled = true;
      receiptNumber = result.receiptNumber;
    }

    await recordMoneyResult(tx, input.actor, persisted.tenderId);
    return {
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
      remainingDue,
      replayed: false,
    };
  });
}

/** Dispatch to the per-type persistence path (all inside the caller's transaction). */
function persistTender(
  tx: ScopedDb,
  bill: BillForTender,
  input: ApplyTenderInput,
  amount: Prisma.Decimal,
  at: Date
): Promise<PersistedTender> {
  switch (input.tender.type) {
    case 'CASH':
      return persistCashTender(tx, bill, input.tender, input.actor, amount);
    case 'CARD':
      return persistCardTender(tx, bill, input.tender, input.actor, amount);
    case 'OTHER':
      return persistOtherTender(tx, bill, input.tender, input.actor, amount);
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
  amount: Prisma.Decimal
): Promise<PersistedTender> {
  const cashReceived = money(tender.cashReceived);
  if (compare(cashReceived, amount) < 0) {
    throw new TenderError('The cash received is less than the tender amount.', 'INSUFFICIENT_CASH');
  }
  const changeGiven = sub(cashReceived, amount);

  const drawer = await tx.restaurantDrawerSession.findFirst({
    where: { deviceId: actor.deviceId, status: 'OPEN' },
    select: { id: true },
  });
  if (!drawer) {
    throw new TenderError(
      'This register has no OPEN drawer; open a drawer before taking cash.',
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
      businessDate: bill.businessDate,
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
  amount: Prisma.Decimal
): Promise<PersistedTender> {
  const tipAmount = tender.tipAmount === undefined ? ZERO : money(tender.tipAmount);
  if (isNegative(tipAmount)) {
    throw new TenderError('A tip amount must not be negative.', 'INVALID_AMOUNT');
  }

  const provider = getPaymentProvider('MOCK');
  const operationRef = `${bill.id}:${actor.deviceId}:${actor.idempotencyKey}`;
  const outcome = provider.execute({ capability: 'SALE', amount, tipAmount, operationRef });
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
      provider: 'MOCK',
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
      businessDate: bill.businessDate,
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
  amount: Prisma.Decimal
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
      businessDate: bill.businessDate,
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
