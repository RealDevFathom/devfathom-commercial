import 'server-only';

import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { buildCoAuthorizationRecord } from './co-authorization';
import { accrueLoyaltyForSettledBill, releaseLoyaltyRedemption } from './loyalty';
import {
  add,
  allocate,
  compare,
  equals,
  money,
  MONEY_SCALE,
  multiply,
  roundMoney,
  sub,
  sum,
  ZERO,
} from './money';
import { allocateReceiptNumber } from './receipt-numbers';
import { consumeReservations } from './promotion-caps';

/**
 * M5-L2 / C4 — the bill (check) command layer.
 *
 * This is the ONLY writer of the bill / bill-line rows. A bill belongs to exactly
 * one order and SNAPSHOTS its charge at cut time from the frozen M4 order-item
 * snapshots (`order-pricing.ts` froze name/unitPrice/quantity/modifier deltas; the
 * tax/service-charge fields carry through structurally at zero until the tax
 * milestone, C4). Every command runs in one tenant-scoped interactive transaction
 * with forced RLS (C1), routes ALL money arithmetic through `money.ts` (C2 — no
 * float, exact Decimal equality), and — for terminal-submitted mutations — enforces
 * a device-scoped idempotency key in the SEPARATE money replay domain
 * (`restaurant_money_idempotency_keys`, C11).
 *
 * The four split kinds (C4 / §11.2):
 *   - NONE       one bill for the whole order, every non-voided item on it.
 *   - BY_ITEM    an explicit item→bill assignment; the union is asserted to be a
 *                complete partition of the non-voided items (every item on exactly
 *                one bill, no unknown/voided/duplicated item).
 *   - BY_SEAT    group the non-voided items by the M4 `seatNumber` seam; items with
 *                no seat form one designated bill.
 *   - FRACTIONAL divide the ORDER TOTAL across integer fraction weights via the
 *                pinned `money.allocate` largest-remainder rule; each bill records
 *                its `roundingAdjustment` (the +cent it received) so Σ(grandTotal)
 *                ≡ the order derived total EXACTLY and deterministically.
 *
 * A bill's `grandTotal = subtotal + taxTotal + serviceChargeTotal + deliveryFeeTotal −
 * compTotal − discountTotal + roundingAdjustment`. The reconciliation invariant the
 * settlement guard and the reconciliation battery both rely on is:
 *
 *   Σ non-void bill grand totals ≡ merchandise − comps − discounts + remaining
 *   bill service + delivery + frozen exclusive tax, compared in integer cents.
 * Inclusive tax is already inside merchandise and is never added a second time.
 *
 * Re-splitting is allowed only while ALL of the order's live bills are OPEN and
 * untendered; afterwards a re-cut is a void-and-recut — the old bills become VOID
 * records (reason + co-authorization) and a fresh set is created (C4). Nothing is
 * ever rewritten in place.
 */

export type BillCommandErrorReason =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_BILLABLE'
  | 'NO_ITEMS'
  | 'BILL_NOT_FOUND'
  | 'BILL_NOT_OPEN'
  | 'LINE_NOT_FOUND'
  | 'ALREADY_COMPED'
  | 'COMP_EXCEEDS_BILL'
  | 'INVALID_SPLIT'
  | 'PARTITION_INCOMPLETE'
  | 'RESPLIT_LOCKED'
  | 'CO_AUTH_REQUIRED'
  | 'REASON_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT';

export class BillCommandError extends Error {
  constructor(
    message: string,
    readonly reason: BillCommandErrorReason
  ) {
    super(message);
    this.name = 'BillCommandError';
  }
}

/** Who/what is issuing a terminal-submitted money command + the device-scoped
 * idempotency key (C11). A replay of the same (deviceId, key) returns the original
 * result and creates nothing. Mirrors the M4 order `CommandActor`, but keys against
 * the SEPARATE money idempotency table. */
export type MoneyCommandActor = {
  staffProfileId: string;
  deviceId: string;
  idempotencyKey: string;
};

/** Order statuses from which a bill may be cut — anything with real items that is
 * not a draft and not already terminal. */
const BILLABLE_STATUSES = new Set([
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
  'PAYMENT_PENDING',
]);

// ── Transaction + idempotency helpers (C11) ──────────────────────────────────

/** Open one tenant-scoped interactive transaction. Mirrors the retype in
 * `orders.ts`: the tenant-db proxy hands the callback a nested `ScopedDb`, which
 * Prisma's overload types as the interactive client. */
function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

type MoneyIdempotencyOutcome = { replay: false } | { replay: true; resultRef: string | null };

async function beginMoneyIdempotent(
  tx: ScopedDb,
  actor: MoneyCommandActor,
  commandType: string
): Promise<MoneyIdempotencyOutcome> {
  const existing = await tx.restaurantMoneyIdempotencyKey.findUnique({
    where: { deviceId_key: { deviceId: actor.deviceId, key: actor.idempotencyKey } },
    select: { resultRef: true },
  });
  if (existing) return { replay: true, resultRef: existing.resultRef };
  await tx.restaurantMoneyIdempotencyKey.create({
    data: { deviceId: actor.deviceId, key: actor.idempotencyKey, commandType },
  });
  return { replay: false };
}

async function recordMoneyIdempotentResult(
  tx: ScopedDb,
  actor: MoneyCommandActor,
  resultRef: string
): Promise<void> {
  await tx.restaurantMoneyIdempotencyKey.update({
    where: { deviceId_key: { deviceId: actor.deviceId, key: actor.idempotencyKey } },
    data: { resultRef },
  });
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new BillCommandError('This command requires a non-empty reason.', 'REASON_REQUIRED');
  }
  return trimmed;
}

async function persistCoAuth(
  tx: ScopedDb,
  request: Parameters<typeof buildCoAuthorizationRecord>[0]
): Promise<string> {
  const record = buildCoAuthorizationRecord(request);
  const row = await tx.restaurantCoAuthorization.create({ data: record, select: { id: true } });
  return row.id;
}

// ── Order + item loading and the derived order total ─────────────────────────

type LoadedBillItem = {
  id: string;
  status: string;
  seatNumber: number | null;
  name: string;
  unitPrice: Prisma.Decimal;
  quantity: number;
  modifiers: { priceDelta: Prisma.Decimal }[];
};

type LoadedBillOrder = {
  id: string;
  branchId: string;
  status: string;
  businessDate: Date;
  serviceChargePolicyVersion?: { id: string; rate: Prisma.Decimal } | null;
  items: LoadedBillItem[];
  deliveryFulfillment?: { deliveryFeeSnapshot: Prisma.Decimal } | null;
};

/** The per-unit charge of an item = its snapshot unit price plus the sum of its
 * modifier deltas (all frozen at add time, C4). */
function itemUnitCharge(item: LoadedBillItem): Prisma.Decimal {
  return add(item.unitPrice, sum(item.modifiers.map((m) => m.priceDelta)));
}

/** The item's contribution to the order total = per-unit charge × quantity. */
function itemLineSubtotal(item: LoadedBillItem): Prisma.Decimal {
  return multiply(itemUnitCharge(item), item.quantity);
}

/**
 * The DERIVED order total: Σ (unitPrice + Σ modifier deltas) × quantity over the
 * non-voided items. There is no stored order total (C3) — this recomputes it from
 * the frozen snapshots, matching `restaurant-orders.ts` `deriveSubtotal` exactly so
 * governance can reconcile bills ↔ order from durable rows. Tax/service-charge are
 * structurally zero in M5, so the subtotal IS the order total.
 */
export function deriveOrderTotal(items: readonly LoadedBillItem[]): Prisma.Decimal {
  return sum(items.map((item) => itemLineSubtotal(item)));
}

async function loadBillOrder(
  tx: ScopedDb,
  orderId: string,
  // Optional only for non-terminal settlement reads; mutation callers must supply branch scope.
  branchId?: string
): Promise<LoadedBillOrder> {
  const order = await tx.restaurantOrder.findFirst({
    where: { id: orderId, ...(branchId ? { branchId } : {}) },
    select: {
      id: true,
      branchId: true,
      status: true,
      businessDate: true,
      serviceChargePolicyVersion: { select: { id: true, rate: true } },
      deliveryFulfillment: { select: { deliveryFeeSnapshot: true } },
      items: {
        orderBy: [{ seatNumber: 'asc' }, { course: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          seatNumber: true,
          name: true,
          unitPrice: true,
          quantity: true,
          modifiers: { select: { priceDelta: true } },
        },
      },
    },
  });
  if (!order) {
    throw new BillCommandError('The order does not exist.', 'ORDER_NOT_FOUND');
  }
  return order as LoadedBillOrder;
}

function nonVoidedItems(order: LoadedBillOrder): LoadedBillItem[] {
  return order.items.filter((i) => i.status !== 'VOIDED');
}

// ── Split planning (pure) ────────────────────────────────────────────────────

export type SplitSpec =
  | { kind: 'NONE' }
  | { kind: 'BY_ITEM'; groups: readonly (readonly string[])[] }
  | { kind: 'BY_SEAT' }
  | { kind: 'FRACTIONAL'; weights: readonly number[] };

/** One line to write on a bill — a frozen snapshot of one order item's charge. */
type PlannedLine = {
  orderItemId: string;
  name: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
};

/** One planned bill: its snapshot totals and (for item-carrying splits) its lines.
 * FRACTIONAL bills carry no lines — they own a fraction of the order total, not
 * specific items — and record the fraction pair + rounding adjustment. */
type PlannedBill = {
  splitKind: 'NONE' | 'BY_ITEM' | 'BY_SEAT' | 'FRACTIONAL';
  fractionNumerator: number | null;
  fractionDenominator: number | null;
  subtotal: Prisma.Decimal;
  serviceChargePolicyVersionId: string | null;
  serviceChargeRate: Prisma.Decimal | null;
  serviceChargeBasis: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  roundingAdjustment: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  lines: PlannedLine[];
};

function lineFor(item: LoadedBillItem): PlannedLine {
  return {
    orderItemId: item.id,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineSubtotal: itemLineSubtotal(item),
    serviceChargeAmount: ZERO,
  };
}

/** An item-carrying bill's snapshot totals: subtotal = Σ line subtotals; no comps
 * or rounding at cut time (comps are applied later via `compLine`). */
function itemBill(
  splitKind: 'NONE' | 'BY_ITEM' | 'BY_SEAT',
  items: readonly LoadedBillItem[]
): PlannedBill {
  const lines = items.map(lineFor);
  const subtotal = sum(lines.map((l) => l.lineSubtotal));
  return {
    splitKind,
    fractionNumerator: null,
    fractionDenominator: null,
    subtotal,
    serviceChargePolicyVersionId: null,
    serviceChargeRate: null,
    serviceChargeBasis: ZERO,
    serviceChargeTotal: ZERO,
    roundingAdjustment: ZERO,
    grandTotal: subtotal,
    lines,
  };
}

/**
 * Plan the bills for an order under a split spec (pure — no I/O). Throws
 * `BillCommandError` on an invalid spec or an incomplete BY_ITEM partition. The
 * output is deterministic: identical input → identical bill order and per-bill
 * cents across runs (a named check).
 */
export function planBills(order: LoadedBillOrder, split: SplitSpec): PlannedBill[] {
  const items = nonVoidedItems(order);
  if (items.length === 0) {
    throw new BillCommandError('The order has no non-voided items to bill.', 'NO_ITEMS');
  }

  if (split.kind === 'FRACTIONAL' && order.serviceChargePolicyVersion) {
    throw new BillCommandError(
      'FRACTIONAL splits are not supported when a service charge is pinned; use NONE, BY_ITEM, or BY_SEAT.',
      'INVALID_SPLIT'
    );
  }
  const planned = (() => {
    switch (split.kind) {
      case 'NONE':
        return [itemBill('NONE', items)];

      case 'BY_ITEM':
        return planByItem(items, split.groups);

      case 'BY_SEAT':
        return planBySeat(items);

      case 'FRACTIONAL':
        return planFractional(items, split.weights);

      default: {
        const exhaustive: never = split;
        throw new BillCommandError(
          `Unknown split kind: ${JSON.stringify(exhaustive)}`,
          'INVALID_SPLIT'
        );
      }
    }
  })();
  const policy = order.serviceChargePolicyVersion;
  if (!policy) return planned;
  const totalBasis = sum(planned.map((bill) => bill.subtotal));
  const totalCharge = roundMoney(multiply(totalBasis, policy.rate));
  const billCharges = allocate(
    totalCharge,
    planned.map((bill) => bill.subtotal.mul(100).toNumber())
  );
  return planned.map((bill, index) => {
    const serviceChargeTotal = billCharges[index]!;
    const lineCharges = allocate(
      serviceChargeTotal,
      bill.lines.map((line) => line.lineSubtotal.mul(100).toNumber())
    );
    return {
      ...bill,
      serviceChargePolicyVersionId: policy.id,
      serviceChargeRate: policy.rate,
      serviceChargeBasis: bill.subtotal,
      serviceChargeTotal,
      grandTotal: add(bill.grandTotal, serviceChargeTotal),
      lines: bill.lines.map((line, lineIndex) => ({
        ...line,
        serviceChargeAmount: lineCharges[lineIndex]!,
      })),
    };
  });
}

function planByItem(
  items: readonly LoadedBillItem[],
  groups: readonly (readonly string[])[]
): PlannedBill[] {
  if (groups.length === 0) {
    throw new BillCommandError('BY_ITEM requires at least one item group.', 'INVALID_SPLIT');
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const bills: PlannedBill[] = [];

  for (const group of groups) {
    if (group.length === 0) {
      throw new BillCommandError('A BY_ITEM bill must contain at least one item.', 'INVALID_SPLIT');
    }
    const groupItems: LoadedBillItem[] = [];
    for (const itemId of group) {
      const item = byId.get(itemId);
      if (!item) {
        throw new BillCommandError(
          `Item ${itemId} is not a billable (non-voided) item on this order.`,
          'PARTITION_INCOMPLETE'
        );
      }
      if (seen.has(itemId)) {
        throw new BillCommandError(
          `Item ${itemId} is assigned to more than one bill.`,
          'PARTITION_INCOMPLETE'
        );
      }
      seen.add(itemId);
      groupItems.push(item);
    }
    bills.push(itemBill('BY_ITEM', groupItems));
  }

  if (seen.size !== items.length) {
    const missing = items.filter((i) => !seen.has(i.id)).map((i) => i.id);
    throw new BillCommandError(
      `Every non-voided item must be assigned to exactly one bill; unassigned: ${missing.join(', ')}.`,
      'PARTITION_INCOMPLETE'
    );
  }
  return bills;
}

function planBySeat(items: readonly LoadedBillItem[]): PlannedBill[] {
  // Group by seatNumber; unseated items (null) form one designated bill placed
  // last. Seats are visited in ascending order so the output is deterministic.
  const seated = new Map<number, LoadedBillItem[]>();
  const unseated: LoadedBillItem[] = [];
  for (const item of items) {
    if (item.seatNumber === null) {
      unseated.push(item);
      continue;
    }
    const bucket = seated.get(item.seatNumber) ?? [];
    bucket.push(item);
    seated.set(item.seatNumber, bucket);
  }

  const bills: PlannedBill[] = [];
  for (const seat of [...seated.keys()].sort((a, b) => a - b)) {
    bills.push(itemBill('BY_SEAT', seated.get(seat)!));
  }
  if (unseated.length > 0) {
    bills.push(itemBill('BY_SEAT', unseated));
  }
  return bills;
}

function planFractional(
  items: readonly LoadedBillItem[],
  weights: readonly number[]
): PlannedBill[] {
  if (weights.length === 0) {
    throw new BillCommandError(
      'FRACTIONAL requires at least one fraction weight.',
      'INVALID_SPLIT'
    );
  }
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight <= 0) {
      throw new BillCommandError(
        `FRACTIONAL weights must be positive integers; got ${weight}.`,
        'INVALID_SPLIT'
      );
    }
  }

  const orderTotal = deriveOrderTotal(items);
  // Authoritative deterministic per-bill amounts (pinned largest-remainder rule,
  // C4). These sum to the order total EXACTLY.
  const shares = allocate(orderTotal, weights);
  // Recover each bill's floor base share so `roundingAdjustment` can record the
  // +cent the largest-remainder rule handed it. The integer-cent floor mirrors
  // `money.allocate`'s own base rule (exact Decimal integer ops, never a float);
  // the authoritative amounts remain `shares` above.
  const totalCents = roundMoney(orderTotal).times(100);
  const weightSum = weights.reduce((acc, w) => acc + w, 0);

  return weights.map((weight, index) => {
    const baseCents = totalCents.times(weight).divToInt(weightSum);
    const base = roundMoney(baseCents.dividedBy(100));
    const grandTotal = shares[index]!;
    return {
      splitKind: 'FRACTIONAL' as const,
      fractionNumerator: weight,
      fractionDenominator: weightSum,
      subtotal: base,
      serviceChargePolicyVersionId: null,
      serviceChargeRate: null,
      serviceChargeBasis: ZERO,
      serviceChargeTotal: ZERO,
      roundingAdjustment: sub(grandTotal, base),
      grandTotal,
      lines: [],
    };
  });
}

// ── cutBills (create / re-cut) ───────────────────────────────────────────────

export type CutBillsInput = {
  orderId: string;
  /** Trusted authenticated terminal branch. */
  branchId: string;
  split: SplitSpec;
  /** Present when re-cutting an order that already has live bills: the reason and
   * the co-authorizing manager for the void-and-recut (C4). */
  recut?: { reason: string; approvingStaffProfileId: string };
  actor: MoneyCommandActor;
};

export type CutBillsResult = {
  orderId: string;
  billIds: string[];
  replayed: boolean;
};

type CutBillsCommand = {
  orderId: string;
  branchId: string;
  split: SplitSpec;
  recut: CutBillsInput['recut'] | null;
  staffProfileId: string;
};

type CutBillsReplay = Pick<CutBillsResult, 'orderId' | 'billIds'> & {
  command: CutBillsCommand;
};

const CUT_RESULT_PREFIX = 'bill.cut:';

/** Persist the immutable result of one cut. Bill IDs cannot be re-derived from the
 * live set: a later re-cut legitimately replaces that set while the original key
 * must continue to answer with the bills its own command created. */
function cutBillsCommand(input: CutBillsInput): CutBillsCommand {
  const split: SplitSpec = (() => {
    switch (input.split.kind) {
      case 'BY_ITEM':
        return { kind: 'BY_ITEM', groups: input.split.groups.map((group) => [...group]) };
      case 'FRACTIONAL':
        return { kind: 'FRACTIONAL', weights: [...input.split.weights] };
      case 'BY_SEAT':
        return { kind: 'BY_SEAT' };
      case 'NONE':
        return { kind: 'NONE' };
    }
  })();
  return {
    orderId: input.orderId,
    branchId: input.branchId,
    split,
    recut: input.recut
      ? {
          reason: input.recut.reason,
          approvingStaffProfileId: input.recut.approvingStaffProfileId,
        }
      : null,
    staffProfileId: input.actor.staffProfileId,
  };
}

function encodeCutResult(result: CutBillsReplay): string {
  return `${CUT_RESULT_PREFIX}${JSON.stringify(result)}`;
}

function decodeCutResult(
  resultRef: string | null,
  requestedCommand: CutBillsCommand
): CutBillsReplay | null {
  if (!resultRef?.startsWith(CUT_RESULT_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      resultRef.slice(CUT_RESULT_PREFIX.length)
    ) as Partial<CutBillsReplay>;
    if (
      typeof decoded.orderId !== 'string' ||
      !Array.isArray(decoded.billIds) ||
      !decoded.billIds.every((id) => typeof id === 'string') ||
      typeof decoded.command !== 'object' ||
      decoded.command === null
    ) {
      throw new Error('invalid cut replay payload');
    }
    if (JSON.stringify(decoded.command) !== JSON.stringify(requestedCommand)) {
      throw new BillCommandError(
        'This idempotency key belongs to a different bill cut.',
        'IDEMPOTENCY_CONFLICT'
      );
    }
    return {
      orderId: decoded.orderId,
      billIds: decoded.billIds,
      command: decoded.command as CutBillsCommand,
    };
  } catch (error) {
    if (error instanceof BillCommandError) throw error;
    throw new BillCommandError('The stored bill cut replay is invalid.', 'IDEMPOTENCY_CONFLICT');
  }
}

/**
 * Cut bill(s) from an order (C4). With no live bills this simply creates the bill
 * set. When the order ALREADY has live bills the caller must pass `recut` (reason +
 * co-authorization): the existing bills are voided as new VOID records and a fresh
 * set is created — a re-split is never an in-place edit. Re-cutting is refused if
 * any live bill is already SETTLED or has any tender (RESPLIT_LOCKED). Idempotent
 * on the actor's device-scoped money key.
 */
export async function cutBills(db: ScopedDb, input: CutBillsInput): Promise<CutBillsResult> {
  return runInTransaction(db, async (tx) => {
    // Authorize the referenced order against the terminal's current branch before
    // consulting idempotency. A device reassigned after the original command must
    // not recover its former branch's order or bill IDs through a replay.
    await tx.$queryRaw`SELECT id FROM restaurant_orders WHERE id = ${input.orderId} AND "branchId" = ${input.branchId} FOR UPDATE`;
    const order = await loadBillOrder(tx, input.orderId, input.branchId);

    const idem = await beginMoneyIdempotent(tx, input.actor, 'bill.cut');
    if (idem.replay) {
      const recorded = decodeCutResult(idem.resultRef, cutBillsCommand(input));
      if (recorded) {
        return { orderId: recorded.orderId, billIds: recorded.billIds, replayed: true };
      }

      // Compatibility for records written before cut results included their bill IDs.
      // The old shape was only the order ID; bind it to that order before consulting
      // the live set so the same device/key can never replay against another order.
      if (idem.resultRef !== input.orderId) {
        throw new BillCommandError(
          'This idempotency key belongs to a different money command or bill cut.',
          'IDEMPOTENCY_CONFLICT'
        );
      }
      const billIds = await liveBillIds(tx, input.orderId, input.branchId);
      return { orderId: input.orderId, billIds, replayed: true };
    }

    // Serialize every cut of this order on a key that exists BEFORE any bill does.
    // Locking the bill ROWS is not enough, because the dangerous row is the one that is
    // not there yet: a concurrent cut can INSERT a bill after this transaction has taken
    // its locks and read its live set, and the `updateMany` that voids "every live bill"
    // would then void a bill this transaction never locked and never compensated — or,
    // on a first cut, two transactions each see no live bills and the order ends up with
    // two independent bill sets billing the same money. The order row is the one thing
    // both cuts must pass through.
    //
    // LOCK ORDER, repo-wide: the order row first, then bill rows ascending by id.
    // `orders.closeOrder` takes this same order row (by UPDATE) before its loyalty earn
    // locks the bills, so a cut and a close of the same order queue instead of deadlock.
    if (!BILLABLE_STATUSES.has(order.status)) {
      throw new BillCommandError(
        `An order in status ${order.status} cannot be billed.`,
        'ORDER_NOT_BILLABLE'
      );
    }

    await handleExistingBills(tx, order, input);

    if (
      !order.deliveryFulfillment &&
      (await tx.restaurantOrder.findUnique({ where: { id: order.id }, select: { channel: true } }))
        ?.channel === 'DELIVERY'
    ) {
      throw new BillCommandError(
        'A delivery fulfillment must be attached before bill cut.',
        'ORDER_NOT_BILLABLE'
      );
    }
    const planned = planBills(order, input.split);
    const feeWeights = planned.map((bill) => bill.grandTotal.mul(100).toNumber());
    const deliveryShares = allocate(
      order.deliveryFulfillment?.deliveryFeeSnapshot ?? ZERO,
      feeWeights.some((weight) => weight > 0) ? feeWeights : planned.map(() => 1)
    );
    const billIds: string[] = [];
    for (const [billIndex, bill] of planned.entries()) {
      const deliveryFeeTotal = deliveryShares[billIndex] ?? ZERO;
      const created = await tx.restaurantBill.create({
        data: {
          orderId: order.id,
          branchId: order.branchId,
          businessDate: order.businessDate,
          status: 'OPEN',
          splitKind: bill.splitKind,
          fractionNumerator: bill.fractionNumerator,
          fractionDenominator: bill.fractionDenominator,
          subtotal: bill.subtotal,
          taxTotal: ZERO,
          serviceChargeTotal: bill.serviceChargeTotal,
          deliveryFeeTotal,
          serviceChargePolicyVersionId: bill.serviceChargePolicyVersionId,
          serviceChargeRate: bill.serviceChargeRate,
          serviceChargeBasis: bill.serviceChargeBasis,
          serviceChargeTaxTreatment: bill.serviceChargePolicyVersionId ? 'NON_TAXABLE' : null,
          compTotal: ZERO,
          roundingAdjustment: bill.roundingAdjustment,
          grandTotal: add(bill.grandTotal, deliveryFeeTotal),
          openerStaffProfileId: input.actor.staffProfileId,
          deviceId: input.actor.deviceId,
          lines: {
            create: bill.lines.map((line) => ({
              orderItemId: line.orderItemId,
              name: line.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineSubtotal: line.lineSubtotal,
              taxAmount: ZERO,
              serviceChargeAmount: line.serviceChargeAmount,
              compAmount: ZERO,
              lineTotal: add(line.lineSubtotal, line.serviceChargeAmount),
            })),
          },
        },
        select: { id: true },
      });
      billIds.push(created.id);
    }

    await recordMoneyIdempotentResult(
      tx,
      input.actor,
      encodeCutResult({
        orderId: order.id,
        billIds,
        command: cutBillsCommand(input),
      })
    );
    return { orderId: order.id, billIds, replayed: false };
  });
}

/** Void the order's existing live bills for a re-cut, asserting the re-split guard
 * (all live bills OPEN + untendered, reason + co-auth supplied). No-op when the
 * order has no live bills yet (the common first-cut path).
 *
 * A voided bill's loyalty redemption is compensated before the void (M8/B4): the
 * REDEEM stays pinned to the bill that is about to become a VOID record, and the
 * fresh bill set is cut at full price — so without a compensating entry the guest's
 * points would stay spent against a bill nobody pays. The release restores the
 * points and rolls the discount back off the voided record, in this transaction. */
async function handleExistingBills(
  tx: ScopedDb,
  order: LoadedBillOrder,
  input: CutBillsInput
): Promise<void> {
  // `cutBills` already holds this order's row, so the live set cannot GROW under us.
  // Lock the live bill rows as well: a concurrent redemption or comp takes the same
  // bill lock (and no order lock), and must not slip a discount onto one of these bills
  // between the guard, the compensation and the void. `ORDER BY id` because this is one
  // of the two places that locks SEVERAL bill rows at once — the order close's loyalty
  // earn is the other — and they must agree on the order or a re-cut racing a close of
  // the same order can deadlock on the second row.
  await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE "orderId" = ${order.id} AND status <> 'VOID' ORDER BY id FOR UPDATE`;
  const live = await tx.restaurantBill.findMany({
    where: { orderId: order.id, status: { not: 'VOID' } },
    select: {
      id: true,
      status: true,
      discountTotal: true,
      grandTotal: true,
      _count: { select: { tenders: true } },
    },
  });
  if (live.length === 0) return;

  if (!input.recut) {
    throw new BillCommandError(
      'The order already has bills; re-splitting requires a recut reason and co-authorization.',
      'RESPLIT_LOCKED'
    );
  }
  const tendered = live.some((b) => b._count.tenders > 0);
  const nonOpen = live.some((b) => b.status !== 'OPEN');
  if (tendered || nonOpen) {
    throw new BillCommandError(
      'The order can no longer be re-split: a bill is already settled or has a tender.',
      'RESPLIT_LOCKED'
    );
  }

  const reason = requireReason(input.recut.reason);
  const coAuthorizationId = await persistCoAuth(tx, {
    actingStaffProfileId: input.actor.staffProfileId,
    approvingStaffProfileId: input.recut.approvingStaffProfileId,
    capability: 'orders:resplit',
    reason,
    targetType: 'RestaurantOrder',
    targetId: order.id,
    deviceId: input.actor.deviceId,
  });

  const at = new Date();
  for (const bill of live) {
    if (compare(bill.discountTotal, ZERO) <= 0) continue;
    const release = await releaseLoyaltyRedemption(tx, {
      billId: bill.id,
      shortfall: null,
      actorId: input.actor.staffProfileId,
      reason: `Loyalty redemption released on void-and-recut of bill ${bill.id}: ${reason}`,
      idempotencyKey: `void:${bill.id}`,
      at,
    });
    // `replayed` ⇒ an earlier run already rolled this discount off the bill; applying
    // the same delta twice would inflate `grandTotal` past the subtotal.
    if (release.replayed || release.points === 0) continue;
    await tx.restaurantBill.update({
      where: { id: bill.id },
      data: {
        discountTotal: sub(bill.discountTotal, release.value),
        grandTotal: add(bill.grandTotal, release.value),
      },
    });
  }

  await tx.restaurantBill.updateMany({
    where: { orderId: order.id, status: { not: 'VOID' } },
    data: { status: 'VOID', voidReason: reason, voidCoAuthorizationId: coAuthorizationId },
  });
}

async function liveBillIds(tx: ScopedDb, orderId: string, branchId: string): Promise<string[]> {
  const rows = await tx.restaurantBill.findMany({
    where: { orderId, branchId, status: { not: 'VOID' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Called inside the order mutation transaction, after the parent order lock.
 * Preserve pinned service allocations on the remaining lines. Paid/fractional bills
 * need the existing reversal/re-cut flow before an item can be voided. */
export async function removeVoidedItemFromBills(tx: ScopedDb, orderId: string, itemId: string) {
  await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE "orderId" = ${orderId} AND status <> 'VOID' ORDER BY id FOR UPDATE`;
  const bills = await tx.restaurantBill.findMany({
    where: { orderId, status: { not: 'VOID' } },
    include: { lines: true, tenders: { select: { id: true }, take: 1 } },
  });
  for (const bill of bills) {
    const line = bill.lines.find((line) => line.orderItemId === itemId);
    if (!line && bill.splitKind !== 'FRACTIONAL') continue;
    if (
      bill.status !== 'OPEN' ||
      bill.tenders.length ||
      bill.splitKind === 'FRACTIONAL' ||
      !bill.taxTotal.isZero()
    ) {
      throw new BillCommandError(
        'Reverse payments and re-cut this bill before voiding an item.',
        'BILL_NOT_OPEN'
      );
    }
    if (!line) continue;
    const grandTotal = bill.grandTotal.minus(line.lineTotal);
    if (grandTotal.isNegative()) {
      throw new BillCommandError(
        'Reverse bill discounts before voiding this item.',
        'COMP_EXCEEDS_BILL'
      );
    }
    const serviceChargeTotal = bill.serviceChargeTotal.minus(line.serviceChargeAmount);
    const serviceChargeBasis =
      bill.serviceChargePolicyVersionId && line.compAmount.isZero()
        ? bill.serviceChargeBasis.minus(line.lineSubtotal)
        : bill.serviceChargeBasis;
    await tx.restaurantBillLine.delete({ where: { id: line.id } });
    await tx.restaurantBill.update({
      where: { id: bill.id },
      data: {
        subtotal: bill.subtotal.minus(line.lineSubtotal),
        compTotal: bill.compTotal.minus(line.compAmount),
        serviceChargeTotal,
        serviceChargeBasis,
        grandTotal,
        ...(serviceChargeBasis.isZero() && serviceChargeTotal.isZero()
          ? {
              serviceChargePolicyVersionId: null,
              serviceChargeRate: null,
              serviceChargeTaxTreatment: null,
            }
          : {}),
      },
    });
  }
}

// ── compLine (comp at zero) ──────────────────────────────────────────────────

export type CompLineInput = {
  billId: string;
  /** Trusted authenticated terminal branch. */
  branchId: string;
  billLineId: string;
  reason: string;
  approvingStaffProfileId: string;
  actor: MoneyCommandActor;
};

/** The release-idempotency key a comp of this line owns. One key per line, so the
 * first call and every replay of it name the same release. */
const compReleaseKey = (billLineId: string) => `comp:${billLineId}`;

/**
 * The comp's OWN idempotency record carries both facts its replay has to answer with:
 * the line it comped, and the exact loyalty discount that call released.
 *
 * The money is PERSISTED here, not re-derived later. What a release frees depends on how
 * much of the same redemption earlier commands had already given back (cumulative
 * rounding — see `loyalty.LoyaltyReleaseResult`), so with a fractional redemption value a
 * release recorded AFTER this comp would move any reconstruction off the ledger by a
 * cent, and the replay would answer with a number the original call never returned.
 * Storing it against the idempotency key makes the replay exact and command-local: it
 * reads one row, written by the call it is replaying, that nothing later can touch.
 *
 * A record written before this field existed is a bare line id with no separator, and is
 * read as a comp that released nothing — which is what those comps did, since the release
 * path did not exist yet.
 */
function encodeCompResult(billLineId: string, releasedDiscount: Prisma.Decimal): string {
  return `${billLineId}|${releasedDiscount.toFixed(MONEY_SCALE)}`;
}

function decodeCompResult(
  resultRef: string | null,
  fallbackLineId: string
): { billLineId: string; releasedDiscount: Prisma.Decimal } {
  const [billLineId, released] = (resultRef ?? '').split('|');
  return {
    billLineId: billLineId || fallbackLineId,
    releasedDiscount: released ? money(released) : ZERO,
  };
}

export type CompLineResult = {
  billLineId: string;
  billId: string;
  /** Loyalty discount handed back because the comp would otherwise overdraw the
   * bill (M8/B3); zero on the ordinary path. The points return to the guest. A
   * replay reports the SAME amount its first run released, not zero — read back from
   * that call's own idempotency record, never re-derived (`encodeCompResult`). */
  releasedDiscount: Prisma.Decimal;
  replayed: boolean;
};

/**
 * Comp a bill line to zero (C4). The line KEEPS its original snapshot unit price and
 * `lineSubtotal`; `compAmount` is set to that subtotal so the effective `lineTotal`
 * nets to zero, and the comp records a reason + manager co-authorization. The bill's
 * `compTotal`/`grandTotal` are recomputed. Only a bill that is still OPEN can be
 * comped. The comp amount flows to the daily close. Idempotent on the money key.
 *
 * A comp and a loyalty redemption both deduct from the SAME bill, so comping a line
 * whose subtotal exceeds what the bill still owes would drive `grandTotal` negative
 * (M8/B3) — and a negative grand total then breaks the earn at order close. The comp
 * wins: whatever it cannot absorb is released from the bill's loyalty discount and
 * the points go back to the guest (`releaseLoyaltyRedemption`), inside this same
 * transaction. `compTotal` and `discountTotal` therefore stay truthful about which
 * deduction actually happened, the identity
 * `subtotal = grandTotal + compTotal + discountTotal` is preserved, and `grandTotal`
 * never goes below zero (also a DB CHECK).
 */
export async function compLine(db: ScopedDb, input: CompLineInput): Promise<CompLineResult> {
  return runInTransaction(db, async (tx) => {
    // Resolve the bill through the terminal's current branch before replay lookup,
    // so reassignment cannot turn an old idempotency key into a cross-branch read.
    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${input.billId} AND "branchId" = ${input.branchId} FOR UPDATE`;
    const bill = await tx.restaurantBill.findFirst({
      where: { id: input.billId, branchId: input.branchId },
      select: {
        id: true,
        status: true,
        compTotal: true,
        discountTotal: true,
        grandTotal: true,
        serviceChargeTotal: true,
        serviceChargeBasis: true,
        serviceChargePolicyVersionId: true,
      },
    });
    if (!bill) {
      throw new BillCommandError('The bill does not exist.', 'BILL_NOT_FOUND');
    }

    const idem = await beginMoneyIdempotent(tx, input.actor, 'bill.comp');
    if (idem.replay) {
      // A replay writes nothing, but it must not report a DIFFERENT comp than the call
      // it replays: `releasedDiscount: 0` on the replay of a comp that released 9.00
      // would tell the caller the guest's points were never given back. The answer comes
      // from the record that call wrote, so it is exactly the number it returned.
      const replayed = decodeCompResult(idem.resultRef, input.billLineId);
      return {
        billLineId: replayed.billLineId,
        billId: input.billId,
        releasedDiscount: replayed.releasedDiscount,
        replayed: true,
      };
    }

    const reason = requireReason(input.reason);
    // Serialize against a concurrent redemption on this bill (which takes the same
    // lock): the clamp below is only sound on a grand total nobody can move under it.
    if (bill.status !== 'OPEN') {
      throw new BillCommandError('Only an OPEN bill can be comped.', 'BILL_NOT_OPEN');
    }

    const line = await tx.restaurantBillLine.findUnique({
      where: { id: input.billLineId },
      select: {
        id: true,
        billId: true,
        lineSubtotal: true,
        compAmount: true,
        serviceChargeAmount: true,
      },
    });
    if (!line || line.billId !== bill.id) {
      throw new BillCommandError('The bill line does not belong to this bill.', 'LINE_NOT_FOUND');
    }
    if (!line.compAmount.isZero()) {
      throw new BillCommandError('The line is already comped.', 'ALREADY_COMPED');
    }

    // What the comp cannot absorb out of the bill's own balance (B3).
    const shortfall = sub(add(line.lineSubtotal, line.serviceChargeAmount), bill.grandTotal);
    let releasedDiscount = ZERO;
    if (compare(shortfall, ZERO) > 0 && compare(bill.discountTotal, ZERO) > 0) {
      const release = await releaseLoyaltyRedemption(tx, {
        billId: bill.id,
        shortfall,
        actorId: input.actor.staffProfileId,
        reason: `Loyalty redemption released to comp bill line ${line.id}: ${reason}`,
        idempotencyKey: compReleaseKey(line.id),
        at: new Date(),
      });
      // A replay here would mean an earlier transaction already rolled this release off
      // the bill — `bill.grandTotal`, read above under the same lock, already reflects
      // it — so this call applies no further delta.
      releasedDiscount = release.replayed ? ZERO : release.value;
    }
    const serviceChargeTotal = sub(bill.serviceChargeTotal, line.serviceChargeAmount);
    const serviceChargeBasis = bill.serviceChargePolicyVersionId
      ? sub(bill.serviceChargeBasis, line.lineSubtotal)
      : ZERO;
    const grandTotal = sub(
      sub(add(bill.grandTotal, releasedDiscount), line.lineSubtotal),
      line.serviceChargeAmount
    );
    if (compare(grandTotal, ZERO) < 0) {
      // The bill carries a deduction this lane cannot release, so the comp would
      // leave a negative grand total. Refuse rather than record an untrue total.
      throw new BillCommandError(
        'The comp exceeds what this bill still owes; reverse its outstanding deductions first.',
        'COMP_EXCEEDS_BILL'
      );
    }

    const coAuthorizationId = await persistCoAuth(tx, {
      actingStaffProfileId: input.actor.staffProfileId,
      approvingStaffProfileId: input.approvingStaffProfileId,
      capability: 'orders:complimentary',
      reason,
      targetType: 'RestaurantBillLine',
      targetId: line.id,
      deviceId: input.actor.deviceId,
    });

    await tx.restaurantBillLine.update({
      where: { id: line.id },
      data: {
        compAmount: line.lineSubtotal,
        serviceChargeAmount: ZERO,
        lineTotal: ZERO,
        compReason: reason,
        compCoAuthorizationId: coAuthorizationId,
      },
    });
    await tx.restaurantBill.update({
      where: { id: bill.id },
      data: {
        serviceChargeTotal,
        serviceChargeBasis,
        ...(serviceChargeBasis.isZero() && serviceChargeTotal.isZero()
          ? {
              serviceChargePolicyVersionId: null,
              serviceChargeRate: null,
              serviceChargeTaxTreatment: null,
            }
          : {}),
        compTotal: add(bill.compTotal, line.lineSubtotal),
        discountTotal: sub(bill.discountTotal, releasedDiscount),
        grandTotal,
      },
    });

    await recordMoneyIdempotentResult(tx, input.actor, encodeCompResult(line.id, releasedDiscount));
    return { billLineId: line.id, billId: bill.id, releasedDiscount, replayed: false };
  }).catch((error: unknown) => {
    const isCheckViolation = (value: unknown, seen = new Set<unknown>()): boolean => {
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      const record = value as Record<string, unknown>;
      return (
        record.code === '23514' ||
        record.originalCode === '23514' ||
        record.sqlState === '23514' ||
        record.code === 'P2004' ||
        [record.cause, record.originalError, ...Object.values(record)].some((child) =>
          isCheckViolation(child, seen)
        )
      );
    };
    if (isCheckViolation(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'The comp could not be applied because the bill totals or service-charge evidence are inconsistent. Refresh the bill and try again.',
        cause: error,
      });
    }
    throw error;
  });
}

// ── settleBill (transition seam, invoked by L4's tender flow) ─────────────────

export type SettleBillInput = {
  billId: string;
  staffProfileId: string;
  deviceId: string;
  /** Server instant of settlement (authoritative, C6). */
  at: Date;
};

export type SettleBillResult = {
  billId: string;
  receiptNumber: number;
  alreadySettled: boolean;
};

/**
 * Flip a bill OPEN → SETTLED and allocate its receipt number (C4/C10). This is the
 * seam L4's tender flow calls, INSIDE that flow's transaction, once coverage is
 * reached — so the receipt is allocated in the same transaction as the final tender
 * and exactly once (a bill already SETTLED is returned as `alreadySettled` without a
 * second allocation). Coverage (Σ tenders ≥ grandTotal) is L4's precondition, not
 * checked here. `tx` is the caller's transaction client.
 */
export async function settleBill(tx: ScopedDb, input: SettleBillInput): Promise<SettleBillResult> {
  const bill = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: { id: true, status: true, branchId: true, businessDate: true, receiptNumber: true },
  });
  if (!bill) {
    throw new BillCommandError('The bill does not exist.', 'BILL_NOT_FOUND');
  }
  if (bill.status === 'SETTLED') {
    return { billId: bill.id, receiptNumber: bill.receiptNumber!, alreadySettled: true };
  }
  if (bill.status !== 'OPEN') {
    throw new BillCommandError('Only an OPEN bill can be settled.', 'BILL_NOT_OPEN');
  }

  const receiptNumber = await allocateReceiptNumber(tx, {
    branchId: bill.branchId,
    businessDate: bill.businessDate,
  });
  await tx.restaurantBill.update({
    where: { id: bill.id },
    data: { status: 'SETTLED', settledAt: input.at, receiptNumber },
  });
  return { billId: bill.id, receiptNumber, alreadySettled: false };
}

export type SettlementBucketEvidence = {
  ruleVersionId: string;
  paymentCategory: string;
  priceMode: 'EXCLUSIVE' | 'INCLUSIVE';
  rate: Prisma.Decimal;
  taxableAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  preDiscountGrossAmount: Prisma.Decimal;
  beforeTaxDiscountAmount: Prisma.Decimal;
  afterTaxDiscountAmount: Prisma.Decimal;
};

export type SettlementLineEvidence = {
  billLineId: string | null;
  sourceOrderItemId?: string;
  taxAmount: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  buckets: readonly (SettlementBucketEvidence & { unitOrdinal: number })[];
};

export type SettlementTaxBucketIdentity = {
  ruleVersionId: string;
  paymentCategory: 'CASH' | 'CARD' | 'OTHER';
} & (
  | { allocationKind: 'MERCHANDISE'; billLineId: string; unitOrdinal: number }
  | {
      allocationKind: 'FRACTIONAL_MERCHANDISE';
      sourceOrderItemId: string;
      unitOrdinal: number;
      billLineId?: never;
    }
  | { allocationKind: 'SERVICE_CHARGE'; billLineId?: never; unitOrdinal?: never }
);

/** Optional v1 seam populated by a later tender writer and read by refund allocation. */
export type SettlementTenderTaxAllocation = {
  originalTenderId: string;
  paymentCategory: 'CASH' | 'CARD' | 'OTHER';
  bucket: SettlementTaxBucketIdentity;
  /** Exact tax amount assigned to this tender, represented as integer minor units. */
  cents: number;
};

export type FinalizeBillSettlementInput = SettleBillInput & {
  organizationId: string;
  transactionReference: string;
  profileVersionId: string;
  currency: string;
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  deliveryFeeTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  roundingAdjustment: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  eligibleNetMerchandise: Prisma.Decimal;
  loyaltyNetGrandTotal: Prisma.Decimal;
  promotionEvaluationId?: string | null;
  promotionEvaluationHash?: string | null;
  lines: readonly SettlementLineEvidence[];
  /** Taxable service charge evidence is frozen separately from merchandise. */
  serviceChargeBuckets: readonly SettlementBucketEvidence[];
  /** Omitted for legacy/v0-compatible callers that do not yet allocate tax by tender. */
  tenderTaxAllocations?: readonly SettlementTenderTaxAllocation[];
  fractionalEvidence?: {
    sourceOrderId: string;
    fractionNumerator: number;
    fractionDenominator: number;
    allocationMethod: 'LARGEST_REMAINDER';
  };
};

export type FinalizeBillSettlementResult = SettleBillResult & {
  snapshotId: string;
  loyaltyEntryId: string | null;
  consumedReservationCount: number;
};

export type FrozenSettlementBucket = SettlementTaxBucketIdentity & {
  id: string;
  taxAmount: Prisma.Decimal;
};

function taxBucketIdentityKey(bucket: SettlementTaxBucketIdentity): string {
  return JSON.stringify([
    bucket.allocationKind,
    bucket.billLineId ?? null,
    'sourceOrderItemId' in bucket ? bucket.sourceOrderItemId : null,
    bucket.unitOrdinal ?? null,
    bucket.ruleVersionId,
    bucket.paymentCategory,
  ]);
}

function exactCents(amount: Prisma.Decimal): number {
  const cents = amount.mul(100);
  const value = cents.toNumber();
  if (!cents.isInteger() || !Number.isSafeInteger(value)) {
    throw new BillCommandError('Tax evidence must use exact integer cents.', 'INVALID_SPLIT');
  }
  return value;
}

/** Validate complete per-bucket and settlement-tax reconciliation before any write. */
export function validateTenderTaxAllocations(
  allocations: readonly SettlementTenderTaxAllocation[],
  buckets: readonly FrozenSettlementBucket[],
  settlementTaxTotal: Prisma.Decimal
): void {
  const bucketsByIdentity = new Map(
    buckets.map((bucket) => [taxBucketIdentityKey(bucket), bucket] as const)
  );
  const allocatedByBucket = new Map<string, number>();
  const facts = new Set<string>();
  let allocatedTotal = 0;

  for (const allocation of allocations) {
    if (
      !allocation.originalTenderId.trim() ||
      !Number.isSafeInteger(allocation.cents) ||
      allocation.cents < 0
    ) {
      throw new BillCommandError(
        'Tender tax allocations require a tender id and non-negative integer cents.',
        'INVALID_SPLIT'
      );
    }
    const bucketKey = taxBucketIdentityKey(allocation.bucket);
    const bucket = bucketsByIdentity.get(bucketKey);
    if (!bucket) {
      throw new BillCommandError(
        'Tender tax allocation references a missing settlement bucket.',
        'INVALID_SPLIT'
      );
    }
    if (allocation.paymentCategory !== bucket.paymentCategory) {
      throw new BillCommandError(
        'Tender tax allocation payment category does not match its bucket.',
        'INVALID_SPLIT'
      );
    }
    const factKey = JSON.stringify([bucket.id, allocation.originalTenderId]);
    if (facts.has(factKey)) {
      throw new BillCommandError(
        'Tender tax allocation contains a duplicate fact.',
        'INVALID_SPLIT'
      );
    }
    facts.add(factKey);
    allocatedByBucket.set(bucket.id, (allocatedByBucket.get(bucket.id) ?? 0) + allocation.cents);
    allocatedTotal += allocation.cents;
  }

  for (const bucket of buckets) {
    if (!allocatedByBucket.has(bucket.id)) {
      throw new BillCommandError(
        'Tender tax allocations must cover every settlement bucket.',
        'INVALID_SPLIT'
      );
    }
    if (allocatedByBucket.get(bucket.id) !== exactCents(bucket.taxAmount)) {
      throw new BillCommandError(
        'Tender tax allocations must reconcile exactly to every settlement bucket.',
        'INVALID_SPLIT'
      );
    }
  }
  if (allocatedTotal !== exactCents(settlementTaxTotal)) {
    throw new BillCommandError(
      'Tender tax allocations must reconcile exactly to settlement tax total.',
      'INVALID_SPLIT'
    );
  }
}

/**
 * Persist the bill-owned pieces of a final checkout in the caller's interactive
 * transaction. No error is caught here: a failure at any write boundary escapes
 * and makes the caller roll back every financial row in the transaction.
 */
export async function finalizeBillSettlement(
  tx: ScopedDb,
  input: FinalizeBillSettlementInput
): Promise<FinalizeBillSettlementResult> {
  const bill = await tx.restaurantBill.findUnique({
    where: { id: input.billId },
    select: {
      id: true,
      status: true,
      branchId: true,
      compTotal: true,
      serviceChargeTotal: true,
      deliveryFeeTotal: true,
      serviceChargePolicyVersionId: true,
      serviceChargeRate: true,
      serviceChargeBasis: true,
      serviceChargeTaxTreatment: true,
      orderId: true,
      splitKind: true,
      fractionNumerator: true,
      fractionDenominator: true,
      lines: { select: { id: true, compAmount: true } },
    },
  });
  if (!bill) throw new BillCommandError('The bill does not exist.', 'BILL_NOT_FOUND');
  if (bill.status !== 'OPEN')
    throw new BillCommandError('Only an OPEN bill can be settled.', 'BILL_NOT_OPEN');

  const fractional = bill.splitKind === 'FRACTIONAL';
  const expectedLineIds = bill.lines.map((line) => line.id).sort();
  const suppliedLineIds = input.lines
    .flatMap((line) => (line.billLineId ? [line.billLineId] : []))
    .sort();
  const invalidFractionalEvidence =
    fractional &&
    (!input.fractionalEvidence ||
      input.fractionalEvidence.sourceOrderId !== bill.orderId ||
      input.fractionalEvidence.fractionNumerator !== bill.fractionNumerator ||
      input.fractionalEvidence.fractionDenominator !== bill.fractionDenominator ||
      input.fractionalEvidence.allocationMethod !== 'LARGEST_REMAINDER' ||
      input.lines.length === 0 ||
      input.lines.some((line) => line.billLineId !== null || !line.sourceOrderItemId));
  if (
    invalidFractionalEvidence ||
    (!fractional &&
      (expectedLineIds.length !== suppliedLineIds.length ||
        expectedLineIds.some((id, index) => id !== suppliedLineIds[index])))
  ) {
    throw new BillCommandError(
      'Settlement evidence must cover every bill line exactly once.',
      'INVALID_SPLIT'
    );
  }
  const lineTotal = sum(input.lines.map((line) => line.lineTotal));
  const lineTaxTotal = sum(input.lines.map((line) => line.taxAmount));
  const lineServiceTotal = sum(input.lines.map((line) => line.serviceChargeAmount));
  const merchandiseBucketTax = sum(
    input.lines.flatMap((line) => line.buckets.map((bucket) => bucket.taxAmount))
  );
  const serviceBucketTax = sum(input.serviceChargeBuckets.map((bucket) => bucket.taxAmount));
  const serviceBucketBasis = sum(
    input.serviceChargeBuckets.map((bucket) =>
      bucket.priceMode === 'INCLUSIVE' ? bucket.grossAmount : bucket.taxableAmount
    )
  );
  const componentTotal = add(
    sub(
      add(
        add(add(input.subtotal, input.taxTotal), input.serviceChargeTotal),
        input.deliveryFeeTotal
      ),
      bill.compTotal
    ),
    sub(input.roundingAdjustment, input.discountTotal)
  );
  if (
    !equals(
      lineTotal,
      sub(sub(input.grandTotal, input.roundingAdjustment), input.deliveryFeeTotal)
    ) ||
    !equals(lineTaxTotal, input.taxTotal) ||
    !equals(lineServiceTotal, input.serviceChargeTotal) ||
    !equals(bill.deliveryFeeTotal, input.deliveryFeeTotal) ||
    (!fractional && !equals(add(merchandiseBucketTax, serviceBucketTax), input.taxTotal)) ||
    !(input.serviceChargeBuckets.length === 0
      ? equals(bill.serviceChargeTotal, input.serviceChargeTotal) &&
        (input.serviceChargeTotal.isZero() ||
          (bill.serviceChargePolicyVersionId !== null &&
            bill.serviceChargeRate !== null &&
            compare(bill.serviceChargeBasis, ZERO) > 0 &&
            bill.serviceChargeTaxTreatment === 'NON_TAXABLE'))
      : equals(serviceBucketBasis, input.serviceChargeTotal)) ||
    !equals(componentTotal, input.grandTotal)
  ) {
    throw new BillCommandError('Settlement totals do not reconcile.', 'INVALID_SPLIT');
  }
  for (const line of input.lines) {
    if (fractional) continue;
    if (
      line.buckets.some((bucket) => !Number.isInteger(bucket.unitOrdinal) || bucket.unitOrdinal < 0)
    ) {
      throw new BillCommandError(
        'Every merchandise bucket requires a non-negative unit ordinal.',
        'INVALID_SPLIT'
      );
    }
    const merchandisePayable = sum(
      line.buckets.map((bucket) => sub(bucket.grossAmount, bucket.afterTaxDiscountAmount))
    );
    const merchandiseTax = sum(line.buckets.map((bucket) => bucket.taxAmount));
    const allocatedServiceTax = sub(line.taxAmount, merchandiseTax);
    if (
      !equals(
        add(add(merchandisePayable, line.serviceChargeAmount), allocatedServiceTax),
        line.lineTotal
      )
    ) {
      throw new BillCommandError('Settlement line buckets do not reconcile.', 'INVALID_SPLIT');
    }
  }

  const frozenBuckets: FrozenSettlementBucket[] = [
    ...input.lines.flatMap((line) =>
      line.buckets.map((bucket) => ({
        id: randomUUID(),
        ...(line.billLineId
          ? { allocationKind: 'MERCHANDISE' as const, billLineId: line.billLineId }
          : {
              allocationKind: 'FRACTIONAL_MERCHANDISE' as const,
              sourceOrderItemId: line.sourceOrderItemId!,
            }),
        unitOrdinal: bucket.unitOrdinal,
        ruleVersionId: bucket.ruleVersionId,
        paymentCategory: bucket.paymentCategory as 'CASH' | 'CARD' | 'OTHER',
        taxAmount: bucket.taxAmount,
      }))
    ),
    ...input.serviceChargeBuckets.map((bucket) => ({
      id: randomUUID(),
      allocationKind: 'SERVICE_CHARGE' as const,
      ruleVersionId: bucket.ruleVersionId,
      paymentCategory: bucket.paymentCategory as 'CASH' | 'CARD' | 'OTHER',
      taxAmount: bucket.taxAmount,
    })),
  ];
  if (input.tenderTaxAllocations !== undefined) {
    validateTenderTaxAllocations(input.tenderTaxAllocations, frozenBuckets, input.taxTotal);
    const tenderFacts = new Map(
      (
        await tx.restaurantTender.findMany({
          where: {
            id: { in: [...new Set(input.tenderTaxAllocations.map((row) => row.originalTenderId))] },
          },
          select: { id: true, billId: true, type: true },
        })
      ).map((tender) => [tender.id, tender] as const)
    );
    if (
      input.tenderTaxAllocations.some((allocation) => {
        const tender = tenderFacts.get(allocation.originalTenderId);
        return (
          !tender || tender.billId !== input.billId || tender.type !== allocation.paymentCategory
        );
      })
    ) {
      throw new BillCommandError(
        'Tender tax allocation must reference a tender on the bill being settled.',
        'INVALID_SPLIT'
      );
    }
  }

  const evidencePayload = {
    version: 1,
    billId: input.billId,
    compTotal: bill.compTotal.toFixed(2),
    discountTotal: input.discountTotal.toFixed(2),
    serviceChargeTotal: input.serviceChargeTotal.toFixed(2),
    ...(input.fractionalEvidence
      ? {
          fractional: {
            ...input.fractionalEvidence,
            lines: input.lines.map((line) => ({
              sourceOrderItemId: line.sourceOrderItemId,
              taxAmount: line.taxAmount.toFixed(2),
              serviceChargeAmount: line.serviceChargeAmount.toFixed(2),
              lineTotal: line.lineTotal.toFixed(2),
            })),
          },
        }
      : {}),
    ...(bill.serviceChargePolicyVersionId
      ? {
          serviceCharge: {
            policyVersionId: bill.serviceChargePolicyVersionId,
            rate: bill.serviceChargeRate?.toString() ?? null,
            basis: bill.serviceChargeBasis.toFixed(2),
            amount: input.serviceChargeTotal.toFixed(2),
            taxTreatment: bill.serviceChargeTaxTreatment,
          },
        }
      : {}),
    roundingAdjustment: input.roundingAdjustment.toFixed(2),
    eligibleNetMerchandise: input.eligibleNetMerchandise.toFixed(2),
    loyaltyNetGrandTotal: input.loyaltyNetGrandTotal.toFixed(2),
    promotionEvaluationId: input.promotionEvaluationId ?? null,
    promotionEvaluationHash: input.promotionEvaluationHash ?? null,
  };
  const snapshots = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "restaurant_tax_transaction_snapshots"
      ("id", "organizationId", "branchId", "billId", "transactionReference", "profileVersionId",
       "currency", "subtotal", "discountTotal", "serviceChargeTotal", "taxTotal",
       "grandTotal", "settledAt", "promotionEvaluationId", "promotionEvaluationHash",
       "evidenceVersion", "evidencePayload")
    VALUES
      (gen_random_uuid()::text, ${input.organizationId}, ${bill.branchId}, ${input.billId},
       ${input.transactionReference}, ${input.profileVersionId}, ${input.currency},
       ${input.subtotal}, ${input.discountTotal}, ${input.serviceChargeTotal}, ${input.taxTotal},
       ${input.grandTotal}, ${input.at}, ${input.promotionEvaluationId ?? null},
       ${input.promotionEvaluationHash ?? null}, 1, ${JSON.stringify(evidencePayload)}::jsonb)
    RETURNING "id"
  `;
  const snapshotId = snapshots[0]?.id;
  if (!snapshotId) throw new Error('Tax settlement snapshot was not created.');

  let frozenBucketIndex = 0;
  for (const line of input.lines) {
    if (line.billLineId) {
      await tx.restaurantBillLine.update({
        where: { id: line.billLineId },
        data: {
          taxAmount: line.taxAmount,
          serviceChargeAmount: line.serviceChargeAmount,
          lineTotal: line.lineTotal,
        },
      });
    }
    for (const bucket of line.buckets) {
      const frozenBucket = frozenBuckets[frozenBucketIndex++];
      if (!frozenBucket) throw new Error('Tax settlement bucket identity was not created.');
      await tx.$executeRaw`
        INSERT INTO "restaurant_tax_rate_bucket_snapshots"
          ("id", "organizationId", "snapshotId", "ruleVersionId", "paymentCategory",
           "priceMode", "rate", "taxableAmount", "taxAmount", "grossAmount",
           "preDiscountGrossAmount", "beforeTaxDiscountAmount", "afterTaxDiscountAmount",
           "evidenceVersion", "allocationKind", "billLineId", "unitOrdinal")
        VALUES
          (${frozenBucket.id}, ${input.organizationId}, ${snapshotId},
           ${bucket.ruleVersionId}, ${bucket.paymentCategory},
           ${bucket.priceMode}::"RestaurantTaxPriceMode", ${bucket.rate},
           ${bucket.taxableAmount}, ${bucket.taxAmount}, ${bucket.grossAmount},
           ${bucket.preDiscountGrossAmount}, ${bucket.beforeTaxDiscountAmount},
           ${bucket.afterTaxDiscountAmount}, 1, ${line.billLineId ? 'MERCHANDISE' : 'FRACTIONAL_MERCHANDISE'}, ${line.billLineId},
           ${bucket.unitOrdinal})
      `;
    }
  }
  for (const bucket of input.serviceChargeBuckets) {
    const frozenBucket = frozenBuckets[frozenBucketIndex++];
    if (!frozenBucket) throw new Error('Tax settlement bucket identity was not created.');
    await tx.$executeRaw`
      INSERT INTO "restaurant_tax_rate_bucket_snapshots"
        ("id", "organizationId", "snapshotId", "ruleVersionId", "paymentCategory",
         "priceMode", "rate", "taxableAmount", "taxAmount", "grossAmount",
         "preDiscountGrossAmount", "beforeTaxDiscountAmount", "afterTaxDiscountAmount",
         "evidenceVersion", "allocationKind", "billLineId", "unitOrdinal")
      VALUES
        (${frozenBucket.id}, ${input.organizationId}, ${snapshotId},
         ${bucket.ruleVersionId}, ${bucket.paymentCategory},
         ${bucket.priceMode}::"RestaurantTaxPriceMode", ${bucket.rate},
         ${bucket.taxableAmount}, ${bucket.taxAmount}, ${bucket.grossAmount},
         ${bucket.preDiscountGrossAmount}, ${bucket.beforeTaxDiscountAmount},
         ${bucket.afterTaxDiscountAmount}, 1, 'SERVICE_CHARGE', NULL, NULL)
    `;
  }
  if (input.tenderTaxAllocations !== undefined) {
    const bucketIds = new Map(
      frozenBuckets.map((bucket) => [taxBucketIdentityKey(bucket), bucket.id] as const)
    );
    for (const allocation of input.tenderTaxAllocations) {
      const rateBucketSnapshotId = bucketIds.get(taxBucketIdentityKey(allocation.bucket));
      if (!rateBucketSnapshotId) throw new Error('Validated tax allocation bucket was not found.');
      await tx.restaurantTaxTenderAllocationSnapshot.create({
        data: {
          id: randomUUID(),
          organizationId: input.organizationId,
          snapshotId,
          billId: input.billId,
          rateBucketSnapshotId,
          originalTenderId: allocation.originalTenderId,
          paymentCategory: allocation.paymentCategory,
          cents: BigInt(allocation.cents),
        },
      });
    }
  }
  await tx.restaurantBill.update({
    where: { id: bill.id },
    data: {
      subtotal: input.subtotal,
      taxTotal: input.taxTotal,
      serviceChargeTotal: input.serviceChargeTotal,
      deliveryFeeTotal: input.deliveryFeeTotal,
      discountTotal: input.discountTotal,
      roundingAdjustment: input.roundingAdjustment,
      grandTotal: input.grandTotal,
    },
  });

  const consumedReservationCount = input.promotionEvaluationId
    ? await consumeReservations(tx, {
        organizationId: input.organizationId,
        evaluationId: input.promotionEvaluationId,
        settledAt: input.at,
      })
    : 0;
  const settled = await settleBill(tx, input);
  const loyalty = await accrueLoyaltyForSettledBill(tx, {
    billId: bill.id,
    netGrandTotal: input.loyaltyNetGrandTotal,
    at: input.at,
  });
  return {
    ...settled,
    snapshotId,
    loyaltyEntryId: loyalty?.id ?? null,
    consumedReservationCount,
  };
}

// ── Settlement predicate (settlement guard + getOrderSettlement read) ─────────

/** Why an order is not yet fully settled (the first failing condition). */
export type OrderSettlementBlocker =
  'NO_BILLS' | 'ITEMS_UNBILLED' | 'BILLS_OPEN' | 'TOTAL_MISMATCH';

export type OrderSettlement = {
  orderId: string;
  settled: boolean;
  blocker: OrderSettlementBlocker | null;
  derivedOrderTotal: Prisma.Decimal;
  /**
   * Sum of live bill grand totals, compared to the derived payable order total.
   */
  accountedTotal: Prisma.Decimal;
  bills: {
    id: string;
    status: string;
    splitKind: string;
    grandTotal: Prisma.Decimal;
    deliveryFeeTotal: Prisma.Decimal;
    compTotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    /** Frozen tax on a SETTLED bill; 0 on an OPEN bill until a tender freezes it. */
    taxTotal: Prisma.Decimal;
    /** Recorded balance; comps/discounts are already included in grandTotal. */
    remainingDue: Prisma.Decimal;
    receiptNumber: number | null;
  }[];
  unbilledItemIds: string[];
};

/**
 * Evaluate whether an order is fully settled (C12). The predicate — consumed by the
 * order close guard (`orders.ts`) and the `getOrderSettlement` read — holds when:
 *   1. the order has at least one live (non-void) bill;
 *   2. for item-carrying splits, every non-voided item is on exactly one live bill
 *      line (FRACTIONAL bills own fractions, not items, so item coverage is proven
 *      by the money identity instead);
 *   3. every live bill is SETTLED (VOID bills are excluded);
 *   4. Live bill grand totals equal merchandise less comps and discounts, plus
 *      remaining allocated service, delivery, and frozen exclusive tax. All sums
 *      and the comparison use integer cents; inclusive tax stays in merchandise.
 */

type SettlementTaxEvidence = {
  taxTotal: Prisma.Decimal;
  buckets: readonly { priceMode: string; taxAmount: Prisma.Decimal }[];
  /** Price modes on the frozen profile. Used only when the snapshot stored no buckets. */
  rulePriceModes: readonly string[];
};

/**
 * Exclusive tax that a settlement added on top of the pre-tax order total.
 * Item bills persist one bucket per rate; their EXCLUSIVE taxAmount values are
 * the additive portion. Fractional bills persist no buckets, so a profile whose
 * rules are uniformly EXCLUSIVE contributes the snapshot tax total, and a
 * uniformly INCLUSIVE (or mixed, bucket-less) profile contributes nothing —
 * inclusive tax is already inside merchandise and must not be added again.
 */
export function exclusiveTaxOutsideOrderTotal(evidence: SettlementTaxEvidence): Prisma.Decimal {
  if (evidence.buckets.length > 0) {
    return sum(
      evidence.buckets
        .filter((bucket) => bucket.priceMode === 'EXCLUSIVE')
        .map((bucket) => bucket.taxAmount)
    );
  }
  const modes = new Set(evidence.rulePriceModes);
  if (modes.size === 1 && modes.has('EXCLUSIVE')) return evidence.taxTotal;
  return ZERO;
}

/** One frozen tax snapshot, including whether a later row reversed it. */
export type SettlementTaxSnapshot = {
  id: string;
  billId: string | null;
  settledAt: Date;
  createdAt: Date;
  reversesSnapshotId: string | null;
  /** Rows whose reversesSnapshotId points at this snapshot. */
  reversals: readonly { id: string }[];
  taxTotal: Prisma.Decimal;
  buckets: readonly { priceMode: string; taxAmount: Prisma.Decimal }[];
  profile: { rules: readonly { priceMode: string }[] };
};

function settlementSnapshotIsNewer(
  candidate: SettlementTaxSnapshot,
  current: SettlementTaxSnapshot
): boolean {
  const settled = candidate.settledAt.getTime() - current.settledAt.getTime();
  if (settled !== 0) return settled > 0;
  const created = candidate.createdAt.getTime() - current.createdAt.getTime();
  if (created !== 0) return created > 0;
  return candidate.id > current.id;
}

/**
 * Exclusive tax per bill. A reversal row is not a freeze, and a
 * snapshot that another row reverses is stale. A reversed freeze plus a later
 * re-freeze would otherwise count the same exclusive tax twice and fail the
 * order identity. Only the latest snapshot that is still in force counts.
 */
export function exclusiveTaxFromSettlementSnapshots(
  snapshots: readonly SettlementTaxSnapshot[]
): Map<string, Prisma.Decimal> {
  const reversedIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.reversesSnapshotId) reversedIds.add(snapshot.reversesSnapshotId);
    if (snapshot.reversals.length > 0) reversedIds.add(snapshot.id);
  }
  const latest = new Map<string, SettlementTaxSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot.billId || snapshot.reversesSnapshotId !== null) continue;
    if (reversedIds.has(snapshot.id)) continue;
    const current = latest.get(snapshot.billId);
    if (!current || settlementSnapshotIsNewer(snapshot, current)) {
      latest.set(snapshot.billId, snapshot);
    }
  }
  const totals = new Map<string, Prisma.Decimal>();
  for (const [billId, snapshot] of latest) {
    totals.set(
      billId,
      exclusiveTaxOutsideOrderTotal({
        taxTotal: snapshot.taxTotal,
        buckets: snapshot.buckets,
        rulePriceModes: snapshot.profile.rules.map((rule) => rule.priceMode),
      })
    );
  }
  return totals;
}

/** Frozen exclusive tax per bill, from the latest snapshot that has not been reversed. */
async function exclusiveTaxByLiveBill(
  tx: ScopedDb,
  billIds: readonly string[]
): Promise<Map<string, Prisma.Decimal>> {
  if (billIds.length === 0) return new Map();
  const snapshots = await tx.restaurantTaxTransactionSnapshot.findMany({
    where: { billId: { in: [...billIds] } },
    select: {
      id: true,
      billId: true,
      settledAt: true,
      createdAt: true,
      reversesSnapshotId: true,
      reversals: { select: { id: true }, take: 1 },
      taxTotal: true,
      buckets: { select: { priceMode: true, taxAmount: true } },
      profile: { select: { rules: { select: { priceMode: true } } } },
    },
  });
  return exclusiveTaxFromSettlementSnapshots(snapshots);
}

export async function evaluateOrderSettlement(
  tx: ScopedDb,
  orderId: string
): Promise<OrderSettlement> {
  const order = await loadBillOrder(tx, orderId);
  const items = nonVoidedItems(order);

  const allBills = await tx.restaurantBill.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      splitKind: true,
      grandTotal: true,
      deliveryFeeTotal: true,
      serviceChargeTotal: true,
      compTotal: true,
      discountTotal: true,
      taxTotal: true,
      receiptNumber: true,
      lines: { select: { orderItemId: true } },
      tenders: { select: { amount: true } },
    },
  });
  const liveBills = allBills.filter((b) => b.status !== 'VOID');
  const exclusiveTaxByBill = await exclusiveTaxByLiveBill(
    tx,
    liveBills.map((bill) => bill.id)
  );
  // Compare payable amounts in integer minor units. Service is already allocated
  // to bills at cut time and reduced by comps; recomputing it on original gross
  // merchandise would restore service the guest no longer owes (and lose split cents).
  const cents = (amount: Prisma.Decimal) => BigInt(exactCents(amount));
  let expectedCents =
    cents(deriveOrderTotal(items)) + cents(order.deliveryFulfillment?.deliveryFeeSnapshot ?? ZERO);
  let accountedCents = BigInt(0);
  for (const bill of liveBills) {
    expectedCents +=
      cents(bill.serviceChargeTotal) +
      cents(exclusiveTaxByBill.get(bill.id) ?? ZERO) -
      cents(bill.compTotal) -
      cents(bill.discountTotal);
    accountedCents += cents(bill.grandTotal);
  }
  const derivedOrderTotal = money(expectedCents.toString()).div(100);
  const accountedTotal = money(accountedCents.toString()).div(100);

  const coveredItemIds = new Set<string>();
  for (const bill of liveBills) {
    for (const line of bill.lines) coveredItemIds.add(line.orderItemId);
  }
  const isFractional = liveBills.length > 0 && liveBills.every((b) => b.splitKind === 'FRACTIONAL');
  const unbilledItemIds = isFractional
    ? []
    : items.filter((i) => !coveredItemIds.has(i.id)).map((i) => i.id);

  const bills = liveBills.map((b) => ({
    id: b.id,
    status: b.status,
    splitKind: b.splitKind,
    grandTotal: b.grandTotal,
    deliveryFeeTotal: b.deliveryFeeTotal,
    compTotal: b.compTotal,
    discountTotal: b.discountTotal,
    taxTotal: b.taxTotal,
    remainingDue:
      b.status === 'SETTLED' ? ZERO : sub(b.grandTotal, sum(b.tenders.map((t) => t.amount))),
    receiptNumber: b.receiptNumber,
  }));

  let blocker: OrderSettlementBlocker | null = null;
  if (liveBills.length === 0) {
    blocker = 'NO_BILLS';
  } else if (unbilledItemIds.length > 0) {
    blocker = 'ITEMS_UNBILLED';
  } else if (liveBills.some((b) => b.status !== 'SETTLED')) {
    blocker = 'BILLS_OPEN';
  } else if (accountedCents !== expectedCents) {
    blocker = 'TOTAL_MISMATCH';
  }

  return {
    orderId,
    settled: blocker === null,
    blocker,
    derivedOrderTotal,
    accountedTotal,
    bills,
    unbilledItemIds,
  };
}
