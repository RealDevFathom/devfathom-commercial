/**
 * DEV-957 phase 2: an offline cash sale at an enrolled counter, from the bill being built
 * to the command the runtime queues and the receipt shown on screen.
 *
 * Pure and client-safe. Everything comes from the snapshots the runtime installed after
 * verifying them (CATALOG, PRICES, TAX, RULES, LOT_BALANCES) and from the counter's own
 * quota ledger, through `offlineCatalogueRows`, which already leaves out prescription-only,
 * controlled, restricted, high-alert, look-alike and recalled items and any lot this
 * counter holds no quota for. Nothing here decides a rule the server does not check again
 * at replay.
 *
 * MONEY. Every line is priced by `priceFromLot` with the lot's own MED-08 rounding
 * increment, the function the server's `addSaleLine` uses; one offline line draws one
 * lot, so the server's `priceMixedLotAllocation` gives exactly `quantity × unit price`.
 * The total is the integer sum of the lines. The server refuses any other amount
 * (`offline_total_changed`). Cash received comes from `amountInputToMinor`; change is
 * cash received less the total, also integers. No discount, voucher, loyalty, khata,
 * customer or prescription exists offline.
 */
import { browserUuid } from '@/lib/browser-uuid';

import type { CounterCommandInput, CounterMatrixInputs } from './counter-command-queue';
import type {
  CounterDraft,
  CounterDraftLine,
  CounterRuntimeState,
  StoredCounterSnapshot,
} from './counter-offline-runtime';
import { MAX_OFFLINE_DRAFT_LINES } from './counter-offline-runtime';
import type { OfflineSaleRow } from './counter-offline-catalogue';
import { OFFLINE_SALE_SNAPSHOT_KINDS } from './counter-offline-catalogue';
import { saleUnitLabel, type SaleUnitKind, type SaleUnitOption } from './counter-pricing';
import type { CounterReceipt } from './counter-receipt';
import { priceFromLot } from './medicine';

/** The replay schema's ceiling on one line's quantity. */
export const MAX_OFFLINE_LINE_QUANTITY = 1000;

/**
 * The price of one offline line, exactly as the server's `addSaleLine` derives it for a
 * line drawn from this one lot: `priceFromLot` for one sale unit, times the quantity.
 */
export function offlineLinePrice(input: {
  printedMrpMinor: number;
  unitsPerPack: number;
  canonicalUnitsPerSaleUnit: number;
  roundingIncrementMinor: number;
  quantity: number;
}): { unitPriceMinor: number; lineTotalMinor: number } {
  const { unitPriceMinor } = priceFromLot({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.unitsPerPack,
    canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
    roundingIncrementMinor: input.roundingIncrementMinor,
  });
  const lineTotalMinor = unitPriceMinor * input.quantity;
  if (!Number.isSafeInteger(lineTotalMinor)) throw new Error('Offline line total is too large.');
  return { unitPriceMinor, lineTotalMinor };
}

export type OfflineBillLine = {
  line: CounterDraftLine;
  row: OfflineSaleRow;
  option: SaleUnitOption;
  label: string;
  canonicalUnits: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

export type OfflineBill = {
  lines: OfflineBillLine[];
  /** Lines of the stored bill that can no longer be sold offline, in plain words. */
  problems: string[];
  totalMinor: number;
  /** Units each lot of the bill uses, against what this counter still holds. */
  overQuota: Array<{ row: OfflineSaleRow; units: number }>;
};

function bucketKey(input: { inventoryLotId: string; stockLocationId: string }) {
  return `${input.inventoryLotId}:${input.stockLocationId}`;
}

/** The sale unit of a lot a line names, or null when the lot cannot sell it. */
export function offlineSaleUnit(
  row: OfflineSaleRow,
  saleUnit: SaleUnitKind,
  packLevelId: string,
  canonicalUnitsPerSaleUnit: number
): SaleUnitOption | null {
  return (
    row.saleUnits.find(
      (option) =>
        option.kind === saleUnit &&
        option.packLevelId === packLevelId &&
        option.canonicalUnitsPerSaleUnit === canonicalUnitsPerSaleUnit
    ) ?? null
  );
}

/**
 * Read a stored bill against the counter's current offline rows: each line priced from
 * the verified price list, and every line that is no longer sellable offline (the lot's
 * quota is used up, the price list expired, the item was recalled) reported.
 */
export function priceOfflineBill(
  draft: Pick<CounterDraft, 'lines'>,
  rows: readonly OfflineSaleRow[]
): OfflineBill {
  const byBucket = new Map(rows.map((row) => [bucketKey(row), row]));
  const lines: OfflineBillLine[] = [];
  const problems: string[] = [];
  const used = new Map<string, number>();
  for (const line of draft.lines) {
    const row = byBucket.get(bucketKey(line));
    if (!row || row.medicineId !== line.medicineId) {
      problems.push(
        'A medicine on this bill can no longer be sold offline from this counter. Take it off to pay for the rest.'
      );
      continue;
    }
    const option = offlineSaleUnit(
      row,
      line.saleUnit,
      line.packLevelId,
      line.canonicalUnitsPerSaleUnit
    );
    if (!option || row.roundingIncrementMinor === null) {
      problems.push(
        `${row.medicineName} cannot be sold in that unit offline any more. Take it off to pay for the rest.`
      );
      continue;
    }
    const price = offlineLinePrice({
      printedMrpMinor: row.packPriceMinor,
      unitsPerPack: row.unitsPerPack,
      canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
      roundingIncrementMinor: row.roundingIncrementMinor,
      quantity: line.quantity,
    });
    const canonicalUnits = line.quantity * option.canonicalUnitsPerSaleUnit;
    used.set(bucketKey(row), (used.get(bucketKey(row)) ?? 0) + canonicalUnits);
    lines.push({
      line,
      row,
      option,
      label: saleUnitLabel(option, row.dosageForm),
      canonicalUnits,
      ...price,
    });
  }
  const overQuota = [...used.entries()].flatMap(([key, units]) => {
    const row = byBucket.get(key)!;
    return units > row.unitsLeft ? [{ row, units }] : [];
  });
  return {
    lines,
    problems,
    totalMinor: lines.reduce((total, line) => total + line.lineTotalMinor, 0),
    overQuota,
  };
}

/**
 * The bill without the lines `priceOfflineBill` could not price (the lot left the signed
 * list, its quota is gone, or the unit is no longer offered), so the rest can be paid.
 */
export function pruneOfflineDraft(
  draft: CounterDraft,
  rows: readonly OfflineSaleRow[],
  now: Date
): CounterDraft {
  const priced = new Set(priceOfflineBill(draft, rows).lines.map((line) => line.line));
  return {
    ...draft,
    lines: draft.lines.filter((line) => priced.has(line)),
    updatedAt: now.toISOString(),
  };
}

/** Add one sale unit of a lot to a bill: a line of the same lot and unit goes up by one. */
export function addToOfflineDraft(
  draft: CounterDraft,
  row: OfflineSaleRow,
  option: SaleUnitOption,
  now: Date
): CounterDraft {
  const same = draft.lines.findIndex(
    (line) =>
      bucketKey(line) === bucketKey(row) &&
      line.saleUnit === option.kind &&
      line.packLevelId === option.packLevelId &&
      line.canonicalUnitsPerSaleUnit === option.canonicalUnitsPerSaleUnit
  );
  const lines =
    same >= 0
      ? draft.lines.map((line, index) =>
          index === same
            ? { ...line, quantity: Math.min(MAX_OFFLINE_LINE_QUANTITY, line.quantity + 1) }
            : line
        )
      : [
          ...draft.lines,
          {
            inventoryLotId: row.inventoryLotId,
            stockLocationId: row.stockLocationId,
            medicineId: row.medicineId,
            presentationId: row.presentationId,
            packLevelId: option.packLevelId,
            saleUnit: option.kind,
            canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
            quantity: 1,
          },
        ].slice(0, MAX_OFFLINE_DRAFT_LINES);
  return { ...draft, lines, updatedAt: now.toISOString() };
}

/** Set one line's quantity; 0 removes it. */
export function setOfflineDraftQuantity(
  draft: CounterDraft,
  index: number,
  quantity: number,
  now: Date
): CounterDraft {
  const lines =
    quantity <= 0
      ? draft.lines.filter((_, at) => at !== index)
      : draft.lines.map((line, at) =>
          at === index
            ? { ...line, quantity: Math.min(MAX_OFFLINE_LINE_QUANTITY, Math.floor(quantity)) }
            : line
        );
  return { ...draft, lines, updatedAt: now.toISOString() };
}

export function newOfflineDraft(operatorUserId: string | null, now: Date): CounterDraft {
  return { draftId: browserUuid(), operatorUserId, updatedAt: now.toISOString(), lines: [] };
}

export type ComposedOfflineSale =
  | {
      ok: true;
      input: CounterCommandInput;
      matrix: Omit<CounterMatrixInputs, 'snapshots'>;
      totalMinor: number;
      cashReceivedMinor: number;
      changeMinor: number;
      /** Each line's total in bill order: sealed with the sale (hardening 4). */
      lineTotalsMinor: number[];
    }
  | { ok: false; message: string };

function snapshotOf(state: CounterRuntimeState, kind: string): StoredCounterSnapshot | undefined {
  return state.catalog?.snapshots.find((stored) => stored.envelope.kind === kind && stored.verified);
}

/** What the counter says while offline cash selling is switched off (review B1). */
export const OFFLINE_SELLING_OFF_MESSAGE =
  'Offline cash selling is off. It becomes available when sending offline sales to the server is ready; until then this counter checks prices only.';

/**
 * DEV-957 phase 2 (review B1): this counter may take cash offline only when its verified,
 * signed RULES say the owner's switch is on. A price list signed without the switch (or
 * with it off) never sells: the counter works as a price check only.
 */
export function offlineCashSellingOn(state: CounterRuntimeState): boolean {
  const rules = snapshotOf(state, 'RULES')?.payload;
  return (
    !!rules &&
    typeof rules === 'object' &&
    (rules as { offlineCashSelling?: unknown }).offlineCashSelling === true
  );
}

/**
 * The CASH_OTC_SALE command for a bill, with the matrix inputs, or a plain sentence that
 * says why it cannot be taken. Nothing is spent here: the runtime draws the receipt number
 * and debits the quota only when it writes the command (`PharmacyCounterRuntime.enqueue`).
 */
export function composeOfflineCashSale(input: {
  state: CounterRuntimeState;
  rows: readonly OfflineSaleRow[];
  draft: CounterDraft;
  cashReceivedMinor: number;
  nowMs: number;
}): ComposedOfflineSale {
  const { state, draft, nowMs } = input;
  const deviceId = state.queue?.deviceId ?? state.scope.deviceId;
  if (!offlineCashSellingOn(state)) return { ok: false, message: OFFLINE_SELLING_OFF_MESSAGE };
  if (!draft.lines.length) return { ok: false, message: 'Add a medicine to the bill first.' };
  const bill = priceOfflineBill(draft, input.rows);
  if (bill.problems.length) return { ok: false, message: bill.problems[0]! };
  if (bill.overQuota.length) {
    const { row } = bill.overQuota[0]!;
    return {
      ok: false,
      message: `This counter holds only ${row.unitsLeft} unit${row.unitsLeft === 1 ? '' : 's'} of ${row.medicineName} for offline selling. Lower the quantity.`,
    };
  }
  if (bill.lines.some((line) => line.line.quantity > MAX_OFFLINE_LINE_QUANTITY))
    return { ok: false, message: `One line can sell at most ${MAX_OFFLINE_LINE_QUANTITY}.` };
  if (!Number.isSafeInteger(input.cashReceivedMinor) || input.cashReceivedMinor <= 0)
    return { ok: false, message: 'Enter the cash the customer handed over.' };
  if (input.cashReceivedMinor < bill.totalMinor)
    return { ok: false, message: 'The cash received is less than the total. Take the full amount.' };
  const snapshots = OFFLINE_SALE_SNAPSHOT_KINDS.map((kind) => snapshotOf(state, kind));
  if (snapshots.some((snapshot) => !snapshot))
    return {
      ok: false,
      message: 'The signed price list on this computer is incomplete, so offline selling is off.',
    };
  const rules = snapshotOf(state, 'RULES')!;
  return {
    ok: true,
    totalMinor: bill.totalMinor,
    cashReceivedMinor: input.cashReceivedMinor,
    changeMinor: input.cashReceivedMinor - bill.totalMinor,
    lineTotalsMinor: bill.lines.map((line) => line.lineTotalMinor),
    input: {
      deviceId,
      action: 'CASH_OTC_SALE',
      clientOriginAt: new Date(nowMs).toISOString(),
      medicineSale: true,
      buckets: bill.lines.map((line) => ({
        inventoryLotId: line.row.inventoryLotId,
        stockLocationId: line.row.stockLocationId,
        units: line.canonicalUnits,
      })),
      payload: {
        // The queue stamps the lease the number is drawn from and the number itself.
        leasedReceipt: { leaseId: '', envelope: rules.envelope, signature: rules.signature },
        snapshots: snapshots.map((snapshot) => ({
          envelope: snapshot!.envelope,
          signature: snapshot!.signature,
          payload: snapshot!.payload,
        })),
        lines: bill.lines.map((line) => ({
          medicineId: line.line.medicineId,
          presentationId: line.line.presentationId,
          packLevelId: line.line.packLevelId,
          saleUnit: line.line.saleUnit,
          quantity: line.line.quantity,
          canonicalUnitsPerSaleUnit: line.line.canonicalUnitsPerSaleUnit,
          inventoryLotId: line.line.inventoryLotId,
          stockLocationId: line.line.stockLocationId,
        })),
        amountMinor: bill.totalMinor,
        cashReceivedMinor: input.cashReceivedMinor,
      },
    },
    matrix: {
      nowMs,
      cachedCreditRemainingMinor: 0,
      // RULES always signs false (pharmacy-offline.ts); never lifted here either.
      controlledMedicinesPermittedOffline: false,
      originalSaleAvailable: false,
      deviceUsable: state.queue?.replay !== 'STOPPED_REVOKED',
    },
  };
}

/** One plain sentence for each reason the runtime can refuse an offline sale. */
export function offlineSaleRefusal(reason: string): string {
  switch (reason) {
    case 'NO_RECEIPT_NUMBER':
      return 'This counter has used every receipt number it was given, so it cannot take another sale offline. Connect, or ask a manager to prepare it again.';
    case 'QUOTA_EXCEEDED':
      return 'This counter does not hold enough stock of an item on this bill for offline selling. Lower the quantity or take it off.';
    case 'SNAPSHOT_MISSING':
    case 'SNAPSHOT_UNVERIFIED':
      return 'The signed price list on this computer is incomplete, so offline selling is off until the connection returns.';
    case 'SNAPSHOT_EXPIRED':
    case 'SAFETY_LEASE_EXPIRED':
      return 'The signed price list on this computer has expired, so offline selling has stopped. Connect to get a fresh one.';
    case 'BATCH_RECALLED':
      return 'An item on this bill is from a recalled batch and cannot be sold.';
    case 'QUEUE_FULL':
      return 'This counter is holding the most offline sales it may (200), so it cannot take another one offline.';
    case 'SEAL_FAILED':
      return 'This computer could not sign the sale, so nothing was taken. Try again; if it keeps happening, sell online or by hand.';
    case 'SELLING_OFF':
      return OFFLINE_SELLING_OFF_MESSAGE;
    case 'DEVICE_REVOKED':
      return 'This counter was revoked by a manager and can no longer take sales.';
    case 'DEVICE_MISMATCH':
      return 'This bill was started on another counter and cannot be paid here.';
    case 'CONTROLLED_NOT_PERMITTED':
    case 'DENIED_OFFLINE':
      return 'This item cannot be sold offline.';
    default:
      return 'The sale could not be saved on this computer, so nothing was taken. Try again.';
  }
}

/**
 * The receipt shown for an offline sale once it is safely written to this computer, in
 * the same model (and so the same layout and fields) as an online receipt. The number is
 * the one drawn from this counter's leased block; the time is when it was sold.
 */
export function offlineSaleReceipt(input: {
  bill: OfflineBill;
  receiptNumber: number;
  soldAt: string;
  cashReceivedMinor: number;
  counterName: string;
  branchName: string;
  cashierName: string | null;
  commandId: string;
  currency?: string;
}): CounterReceipt {
  const { bill } = input;
  return {
    saleId: input.commandId,
    receiptNumber: input.receiptNumber,
    counterLabel: `Counter ${input.counterName}, sold offline`,
    branchName: input.branchName,
    businessDate: null,
    completedAt: input.soldAt,
    cashierName: input.cashierName,
    currency: input.currency ?? 'PKR',
    lines: bill.lines.map((line, index) => ({
      saleLineId: `${input.commandId}:${index}`,
      identityStatus: 'ISSUED' as const,
      allocations: [
        {
          allocationId: `${input.commandId}:${index}:lot`,
          inventoryLotId: line.row.inventoryLotId,
          batchNumber: line.row.batchNumber,
          expiresAt: line.row.expiresAt,
          canonicalUnits: line.canonicalUnits,
          grossMinor: line.lineTotalMinor,
        },
      ],
      medicineName: line.row.medicineName,
      strength: null,
      presentation: line.row.presentation,
      batchNumber: line.row.batchNumber ?? '',
      expiresAt: line.row.expiresAt,
      saleUnit: line.option.kind,
      quantity: line.line.quantity,
      canonicalUnits: line.canonicalUnits,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: 0,
      lineTotalMinor: line.lineTotalMinor,
    })),
    tenders: [
      {
        tenderId: `${input.commandId}:cash`,
        type: 'CASH',
        amountMinor: bill.totalMinor,
        cashReceivedMinor: input.cashReceivedMinor,
        changeGivenMinor: input.cashReceivedMinor - bill.totalMinor,
      },
    ],
    totals: {
      grossMinor: bill.totalMinor,
      discountMinor: 0,
      netMinor: bill.totalMinor,
      tenderedMinor: bill.totalMinor,
      changeMinor: input.cashReceivedMinor - bill.totalMinor,
    },
  };
}
