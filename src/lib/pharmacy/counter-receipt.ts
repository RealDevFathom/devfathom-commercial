/**
 * PH-POS / POS-08 — the counter receipt: thermal and A4, Urdu and English.
 *
 * Pure and database-free. The A4 render and the thermal print job are built
 * from ONE model, so the paper a customer keeps and the roll the printer cuts
 * can never disagree about what was dispensed.
 *
 * The thermal path goes through the existing printing seam (PRD §11) as a
 * `RECEIPT` document — the pharmacy does not get a second print contract.
 *
 * REPRINT IS NOT A SALE. Building a document is a pure read: a receipt number
 * is issued exactly once, by the tender that settles the bill (POS-B), and this
 * module can only ever render a number that already exists. An unsettled sale
 * renders as unissued rather than borrowing the next number.
 */

import { PrintDocumentSchema, type PrintDocument } from '@/lib/restaurant/printing/contract';

import type { PharmacyCashMemo } from './cash-memo';
import type { DispensingLabelSource } from './dispensing-label';

import type { SaleUnitKind } from './counter-pricing';

export type CounterReceiptLocale = 'en' | 'ur';

/** Regulatory identity in force when this receipt's sale completed. */
export type PharmacyReceiptTaxIdentity = { ntn: string | null; strn: string | null };

export type CounterReceiptLine = {
  saleLineId: string;
  /** Absent only for older callers; receipt reads always set this explicitly. */
  identityStatus?: 'ISSUED' | 'UNAVAILABLE';
  /** Descriptive allocation subrows, never additional financial rows. */
  allocations?: {
    allocationId: string;
    inventoryLotId: string;
    batchNumber: string | null;
    expiresAt: string | null;
    canonicalUnits: number;
  }[];
  medicineName: string;
  /** Rendered strength, for example `500 mg`. Null for an unstrengthed item. */
  strength: string | null;
  /** #708: manufacturer as issued; absent/null on receipts issued before it was snapshotted. */
  manufacturer?: string | null;
  presentation: string;
  batchNumber: string;
  /** ISO date of the dispensed batch's expiry. */
  expiresAt: string;
  saleUnit: SaleUnitKind;
  quantity: number;
  canonicalUnits: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
};

export type CounterReceiptTender = {
  tenderId: string;
  type: string;
  amountMinor: number;
  /** Cash handed over before change; absent on legacy/non-cash receipt models. */
  cashReceivedMinor?: number | null;
  changeGivenMinor: number | null;
};

export type CounterReceipt = {
  dispensingLabelSources?: DispensingLabelSource[];
  /** Supplied by settled receipt reads; optional only for legacy in-memory callers. */
  taxIdentity?: PharmacyReceiptTaxIdentity;
  /**
   * #708: set only when the profile in force at completion is for Sindh; the
   * receipt then renders as a Sindh cash memo. Absent or null keeps the
   * standard receipt.
   */
  cashMemo?: PharmacyCashMemo | null;
  /** #708: buyer name frozen on the sale at completion; null for a nameless walk-in. */
  buyerName?: string | null;
  saleId: string;
  /** Null until a tender settles the bill; never minted by a render. */
  receiptNumber: number | null;
  branchName: string;
  businessDate: string | null;
  completedAt: string | null;
  currency: string;
  lines: CounterReceiptLine[];
  tenders: CounterReceiptTender[];
  totals: {
    grossMinor: number;
    discountMinor: number;
    netMinor: number;
    tenderedMinor: number;
    changeMinor: number;
  };
};

type Strings = {
  receipt: string;
  reprint: string;
  unissued: string;
  branch: string;
  date: string;
  medicine: string;
  strength: string;
  batch: string;
  expiry: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  gross: string;
  discount: string;
  net: string;
  tendered: string;
  change: string;
  tenders: string;
  saleUnit: Record<SaleUnitKind, string>;
  noReceiptNumber: string;
};

/**
 * Both languages are checked in as one table so a new receipt field cannot ship
 * with only half its strings, which is how a bilingual receipt quietly becomes
 * a monolingual one.
 */
export const COUNTER_RECEIPT_STRINGS: Readonly<Record<CounterReceiptLocale, Strings>> = {
  en: {
    receipt: 'Receipt',
    reprint: 'Reprint — not a new sale',
    unissued: 'Receipt unissued',
    branch: 'Branch',
    date: 'Date',
    medicine: 'Medicine',
    strength: 'Strength',
    batch: 'Batch',
    expiry: 'Expiry',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    lineTotal: 'Amount',
    gross: 'Gross',
    discount: 'Discount',
    net: 'Total',
    tendered: 'Tendered',
    change: 'Change',
    tenders: 'Payments',
    saleUnit: { PACK: 'pack', STRIP: 'strip', UNIT: 'unit' },
    noReceiptNumber: 'This bill is not settled, so no receipt number has been issued.',
  },
  ur: {
    receipt: 'رسید',
    reprint: 'دوبارہ پرنٹ — نئی فروخت نہیں',
    unissued: 'رسید نمبر جاری نہیں ہوا',
    branch: 'برانچ',
    date: 'تاریخ',
    medicine: 'دوا',
    strength: 'طاقت',
    batch: 'بیچ',
    expiry: 'میعاد',
    quantity: 'مقدار',
    unitPrice: 'فی یونٹ قیمت',
    lineTotal: 'رقم',
    gross: 'کل رقم',
    discount: 'رعایت',
    net: 'قابلِ ادائیگی',
    tendered: 'ادا شدہ',
    change: 'واپسی',
    tenders: 'ادائیگیاں',
    saleUnit: { PACK: 'پیک', STRIP: 'پتّا', UNIT: 'یونٹ' },
    noReceiptNumber: 'یہ بل ادا نہیں ہوا، اس لیے رسید نمبر جاری نہیں ہوا۔',
  },
};

/** Text direction, so the A4 render does not have to re-derive it per locale. */
export const COUNTER_RECEIPT_DIRECTION: Readonly<Record<CounterReceiptLocale, 'ltr' | 'rtl'>> = {
  en: 'ltr',
  ur: 'rtl',
};

/**
 * Minor units as a fixed two-decimal string, computed on integers.
 *
 * Never divides by 100 in floating point: `Math.round(x / 100 * 100)` is how a
 * receipt total starts disagreeing with the ledger by a paisa.
 */
export function formatMinor(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) return '0.00';
  const negative = amountMinor < 0;
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? '-' : ''}${major}.${String(fraction).padStart(2, '0')}`;
}

/** ISO timestamp reduced to the date a receipt prints. */
export function formatReceiptDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

export function receiptTitle(receipt: CounterReceipt, locale: CounterReceiptLocale): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  return receipt.receiptNumber === null
    ? strings.unissued
    : `${strings.receipt} ${receipt.receiptNumber}`;
}

/**
 * The label a single dispensed line prints on (POS-08: medicine, strength,
 * batch and expiry on the label).
 *
 * Clamped to the seam's 160-character line budget by dropping the presentation
 * first — the batch and expiry are the fields a customer or an inspector needs,
 * and they are kept whatever else has to go.
 */
export function receiptLineLabel(line: CounterReceiptLine, locale: CounterReceiptLocale): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const identity = [line.medicineName, line.strength].filter(Boolean).join(' ');
  const tail = [
    `${strings.batch} ${line.batchNumber}`,
    `${strings.expiry} ${formatReceiptDate(line.expiresAt)}`,
    `${line.quantity} ${strings.saleUnit[line.saleUnit]}`,
    formatMinor(line.lineTotalMinor),
  ].join(' · ');

  const full = `${identity} (${line.presentation}) · ${tail}`;
  if (full.length <= 160) return full;

  // Drop the presentation first, then shorten the medicine name. The tail is
  // never cut: an inspector and a customer both need the batch and expiry, and
  // a name clipped to "Panadol Ex…" is still identifiable while a receipt with
  // no expiry on it is not.
  const compact = `${identity} · ${tail}`;
  if (compact.length <= 160) return compact;

  const budget = 160 - (tail.length + 3 + 1);
  return budget > 0 ? `${identity.slice(0, budget)}… · ${tail}` : tail.slice(0, 160);
}

function footerFor(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  reprint: boolean
): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const parts = [
    `${strings.gross} ${formatMinor(receipt.totals.grossMinor)}`,
    `${strings.discount} ${formatMinor(receipt.totals.discountMinor)}`,
    `${strings.net} ${formatMinor(receipt.totals.netMinor)}`,
    `${strings.tendered} ${formatMinor(receipt.totals.tenderedMinor)}`,
    `${strings.change} ${formatMinor(receipt.totals.changeMinor)}`,
  ];
  if (receipt.receiptNumber === null) parts.push(strings.noReceiptNumber);
  if (reprint) parts.push(strings.reprint);
  const footer = parts.join(' · ');
  return footer.length <= 500 ? footer : footer.slice(0, 500);
}

export class PharmacyCounterReceiptError extends Error {
  constructor(readonly reason: 'EMPTY_RECEIPT' | 'INVALID_DOCUMENT') {
    super(reason);
  }
}

/**
 * The thermal print job for this receipt, as a seam `RECEIPT` document.
 *
 * `reprint` only changes the footer. It cannot change the receipt number,
 * because there is nothing here that could issue one.
 */
export function buildCounterReceiptDocument(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  options: { reprint?: boolean } = {}
): PrintDocument {
  if (receipt.lines.length === 0) throw new PharmacyCounterReceiptError('EMPTY_RECEIPT');

  const candidate = {
    type: 'RECEIPT' as const,
    reference: (receipt.receiptNumber === null
      ? `sale:${receipt.saleId}`
      : `receipt:${receipt.receiptNumber}`
    ).slice(0, 80),
    title: `${receiptTitle(receipt, locale)} · ${receipt.branchName}`.slice(0, 80),
    createdAt: new Date(receipt.completedAt ?? new Date().toISOString()).toISOString(),
    // The seam caps a document at 200 lines; a counter bill never reaches that,
    // and truncating silently would print a receipt that under-reports what was
    // dispensed, so an over-long bill is refused rather than trimmed.
    lines: receipt.lines.map((line) => ({
      quantity: line.quantity,
      label: receiptLineLabel(line, locale),
    })),
    footer: footerFor(receipt, locale, options.reprint ?? false),
  };

  const parsed = PrintDocumentSchema.safeParse(candidate);
  if (!parsed.success) throw new PharmacyCounterReceiptError('INVALID_DOCUMENT');
  return parsed.data;
}

/**
 * Totals recomputed from the lines and tenders themselves.
 *
 * The receipt reconciles to what was actually dispensed and collected rather
 * than to a stored summary column, so a receipt can never print a total that
 * the sale lines do not add up to (POS-08 acceptance).
 */
export function counterReceiptTotals(input: {
  lines: readonly Pick<CounterReceiptLine, 'unitPriceMinor' | 'quantity' | 'discountMinor'>[];
  tenders: readonly Pick<
    CounterReceiptTender,
    'type' | 'amountMinor' | 'cashReceivedMinor' | 'changeGivenMinor'
  >[];
}): CounterReceipt['totals'] {
  const grossMinor = input.lines.reduce(
    (total, line) => total + line.unitPriceMinor * line.quantity,
    0
  );
  const discountMinor = input.lines.reduce((total, line) => total + line.discountMinor, 0);
  const tenderedMinor = input.tenders.reduce(
    (total, tender) =>
      total +
      (tender.type === 'CASH' ? (tender.cashReceivedMinor ?? tender.amountMinor) : tender.amountMinor),
    0
  );
  const changeMinor = input.tenders.reduce(
    (total, tender) => total + (tender.changeGivenMinor ?? 0),
    0
  );
  return {
    grossMinor,
    discountMinor,
    netMinor: grossMinor - discountMinor,
    tenderedMinor,
    changeMinor,
  };
}
