import { formatKarachiDateTime } from './karachi-time';
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

import type { DispensingLabelSource } from './dispensing-label';
import { isNoExpiryDate } from './product-class';

import type { SaleUnitKind } from './counter-pricing';

export type CounterReceiptLocale = 'en' | 'ur';

/** Regulatory identity in force when this receipt's sale completed. */
export type PharmacyReceiptTaxIdentity = {
  address?: string | null;
  phone?: string | null;
  licenceNumber?: string | null;
  ntn: string | null;
  strn: string | null;
  /** #708: regulatory facts the Sindh cash memo prints; absent on older callers. */
  provinceCode?: string | null;
  /** ISO dates of the drug-sale licence in force at completion. */
  licenceValidFrom?: string | null;
  licenceValidTo?: string | null;
  /** Qualified person (pharmacist) registration number, optional on the memo. */
  pharmacistRegistration?: string | null;
};

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
    grossMinor?: number | null;
  }[];
  medicineName: string;
  /** #708: manufacturer snapshotted at completion; null when not recorded. */
  manufacturer?: string | null;
  /** Rendered strength, for example `500 mg`. Null for an unstrengthed item. */
  strength: string | null;
  presentation: string;
  batchNumber: string;
  /** ISO date of the dispensed batch's expiry. */
  expiresAt: string;
  saleUnit: SaleUnitKind;
  quantity: number;
  canonicalUnits: number;
  unitPriceMinor: number;
  discountMinor: number;
  tierDiscountMinor?: number;
  tierName?: string | null;
  /** #727: the promotion name frozen on the line when it was priced; never the live rule. */
  promotionName?: string | null;
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
  cashMemoIdentity?: PharmacyReceiptTaxIdentity | null;
  saleId: string;
  /** Null until a tender settles the bill; never minted by a render. */
  receiptNumber: number | null;
  /** Names the counter that issued the number; numbers restart per counter. */
  counterLabel?: string | null;
  branchName: string;
  businessDate: string | null;
  completedAt: string | null;
  cashierName?: string | null;
  /** #708: buyer named at completion (typed at tender, or the sale's customer/patient). */
  buyerName?: string | null;
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
  /** QA-3: printed in place of an expiry date for a non-drug item with none. */
  noExpiry: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  gross: string;
  discount: string;
  tierDiscount: string;
  promotion: string;
  net: string;
  tendered: string;
  change: string;
  tenders: string;
  invoice: string;
  cashier: string;
  licence: string;
  phone: string;
  cashMemo: string;
  manufacturer: string;
  buyer: string;
  licenceValid: string;
  licenceValidTo: string;
  pharmacistRegistration: string;
  signature: string;
  notRecorded: string;
  tenderName: Record<string, string>;
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
    noExpiry: 'No expiry',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    lineTotal: 'Amount',
    gross: 'Gross',
    discount: 'Discount',
    tierDiscount: 'Prepaid tier discount',
    promotion: 'Promotion',
    net: 'Total',
    tendered: 'Tendered',
    change: 'Change',
    tenders: 'Payments',
    invoice: 'Receipt',
    cashier: 'Cashier',
    licence: 'Drug-sale licence',
    phone: 'Phone',
    cashMemo: 'Sindh cash memo',
    manufacturer: 'Manufacturer',
    buyer: 'Buyer',
    licenceValid: 'valid',
    licenceValidTo: 'to',
    pharmacistRegistration: 'Pharmacist registration',
    signature: 'Signature of qualified person',
    notRecorded: 'Not recorded',
    tenderName: {
      CASH: 'Cash',
      CARD: 'Card',
      BANK_TRANSFER: 'Bank transfer',
      CREDIT: 'Khata',
      KHATA: 'Khata',
      WALLET: 'Wallet',
      LOYALTY: 'Loyalty points',
      RAAST: 'Raast',
      JAZZCASH: 'JazzCash',
      EASYPAISA: 'Easypaisa',
    },
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
    noExpiry: 'کوئی میعاد نہیں',
    quantity: 'مقدار',
    unitPrice: 'فی یونٹ قیمت',
    lineTotal: 'رقم',
    gross: 'کل رقم',
    discount: 'رعایت',
    tierDiscount: 'پری پیڈ درجے کی رعایت',
    promotion: 'پروموشن',
    net: 'قابلِ ادائیگی',
    tendered: 'ادا شدہ',
    change: 'واپسی',
    tenders: 'ادائیگیاں',
    invoice: 'رسید',
    cashier: 'کیشیئر',
    licence: 'ادویات فروشی لائسنس',
    phone: 'فون',
    cashMemo: 'سندھ کیش میمو',
    manufacturer: 'تیار کنندہ',
    buyer: 'خریدار',
    licenceValid: 'کارآمد',
    licenceValidTo: 'تا',
    pharmacistRegistration: 'فارماسسٹ رجسٹریشن',
    signature: 'مستند شخص کے دستخط',
    notRecorded: 'درج نہیں',
    tenderName: {
      CASH: 'نقد',
      CARD: 'کارڈ',
      BANK_TRANSFER: 'بینک منتقلی',
      CREDIT: 'کھاتہ',
      KHATA: 'کھاتہ',
      WALLET: 'والٹ',
      LOYALTY: 'وفاداری پوائنٹس',
      RAAST: 'راست',
      JAZZCASH: 'جاز کیش',
      EASYPAISA: 'ایزی پیسہ',
    },
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
export function formatMinor(amountMinor: number, locale: CounterReceiptLocale = 'en'): string {
  if (!Number.isSafeInteger(amountMinor)) return localizeReceiptNumber('0.00', locale);
  const negative = amountMinor < 0;
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return localizeReceiptNumber(
    `${negative ? '-' : ''}${major}.${String(fraction).padStart(2, '0')}`,
    locale
  );
}

/** Extended Arabic-Indic digits (U+06F0–U+06F9), the digit set Urdu uses. */
const URDU_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
/** Arabic decimal separator (U+066B), CLDR's decimal for `ur-u-nu-arabext`. */
const URDU_DECIMAL_SEPARATOR = '٫';

/**
 * An already-computed ASCII receipt number rendered in the locale's digits.
 *
 * Deliberately a character mapping rather than `Intl.NumberFormat`: the amount
 * is computed once on integers, and the glyphs must not depend on the ICU data
 * a given browser or Node build ships (bidi marks, grouping, a missing
 * numbering system). English stays byte-for-byte unchanged.
 */
export function localizeReceiptNumber(value: string, locale: CounterReceiptLocale): string {
  if (locale !== 'ur') return value;
  return value.replace(/[0-9.]/g, (char) =>
    char === '.' ? URDU_DECIMAL_SEPARATOR : URDU_DIGITS[Number(char)]!
  );
}

/** ISO timestamp reduced to the date a receipt prints. */
export function formatReceiptDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

/**
 * QA-3 — a dispensed batch's expiry as a receipt prints it. A non-drug item
 * stocked without an expiry is stored on a far-future marker date; it prints
 * as having no expiry, never as 9998-12-31.
 */
export function formatReceiptExpiry(
  value: string | null,
  locale: CounterReceiptLocale = 'en'
): string {
  return isNoExpiryDate(value)
    ? COUNTER_RECEIPT_STRINGS[locale].noExpiry
    : formatReceiptDate(value);
}

/** The compact "Exp 2027-01-31" a counter screen shows, or "No expiry" (QA-3). */
export function formatShortExpiry(value: string | null): string {
  return isNoExpiryDate(value)
    ? COUNTER_RECEIPT_STRINGS.en.noExpiry
    : `Exp ${formatReceiptDate(value)}`;
}

export function receiptTitle(receipt: CounterReceipt, locale: CounterReceiptLocale): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  if (receipt.receiptNumber === null) return strings.unissued;
  const base = `${strings.receipt} ${receipt.receiptNumber}`;
  return receipt.counterLabel ? `${base} · ${receipt.counterLabel}` : base;
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
    isNoExpiryDate(line.expiresAt)
      ? strings.noExpiry
      : `${strings.expiry} ${formatReceiptDate(line.expiresAt)}`,
    `${line.quantity} ${strings.saleUnit[line.saleUnit]}`,
    formatMinor(line.lineTotalMinor, locale),
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

/** #727: descriptive savings only; the discount is already inside the line total. */
export function receiptPromotionLabel(
  line: Pick<CounterReceiptLine, 'promotionName' | 'discountMinor' | 'tierDiscountMinor'>,
  locale: CounterReceiptLocale
): string | null {
  if (!line.promotionName || line.discountMinor <= 0) return null;
  const label = `${COUNTER_RECEIPT_STRINGS[locale].promotion}: ${line.promotionName} (-${formatMinor(line.discountMinor - (line.tierDiscountMinor ?? 0), locale)})`;
  return label.length <= 160 ? label : label.slice(0, 160);
}

function footerFor(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  reprint: boolean
): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const parts = [
    `${strings.gross} ${formatMinor(receipt.totals.grossMinor, locale)}`,
    `${strings.discount} ${formatMinor(receipt.totals.discountMinor, locale)}`,
    ...receiptTierLines(receipt, locale),
    `${strings.net} ${formatMinor(receipt.totals.netMinor, locale)}`,
    `${strings.tendered} ${formatMinor(receipt.totals.tenderedMinor, locale)}`,
    `${strings.change} ${formatMinor(receipt.totals.changeMinor, locale)}`,
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

/** Sum recorded cash only; legacy receipts may not retain the amount handed over. */
export function receiptCashReceived(tenders: CounterReceipt['tenders']): number | null {
  const cash = tenders.filter((tender) => tender.type === 'CASH');
  for (const tender of cash) {
    if (
      tender.cashReceivedMinor != null &&
      (!Number.isSafeInteger(tender.cashReceivedMinor) || tender.cashReceivedMinor < 0)
    ) {
      throw new Error('Receipt cash received is invalid.');
    }
  }
  if (!cash.length || cash.some((tender) => tender.cashReceivedMinor == null)) return null;
  const total = cash.reduce((sum, tender) => sum + tender.cashReceivedMinor!, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Receipt cash received is invalid.');
  return total;
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
    lines: receipt.lines.flatMap((line) => {
      const promotion = receiptPromotionLabel(line, locale);
      return [
        { quantity: line.quantity, label: receiptLineLabel(line, locale) },
        ...(promotion ? [{ quantity: 1, label: promotion }] : []),
      ];
    }),
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
  lines: readonly Pick<CounterReceiptLine, 'lineTotalMinor' | 'discountMinor'>[];
  tenders: readonly Pick<
    CounterReceiptTender,
    'type' | 'amountMinor' | 'cashReceivedMinor' | 'changeGivenMinor'
  >[];
}): CounterReceipt['totals'] {
  const grossMinor = input.lines.reduce(
    (total, line) => total + line.lineTotalMinor + line.discountMinor,
    0
  );
  const discountMinor = input.lines.reduce((total, line) => total + line.discountMinor, 0);
  const tenderedMinor = input.tenders.reduce(
    (total, tender) =>
      total +
      (tender.type === 'CASH'
        ? (tender.cashReceivedMinor ?? tender.amountMinor)
        : tender.amountMinor),
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

/** Completion wall time on customer paper; the accounting business date stays separate. */
export function formatReceiptIssuedAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : formatKarachiDateTime(date);
}

/** Separate informational savings lines; already included in total discounts. */
export function receiptTierLines(
  receipt: Pick<CounterReceipt, 'lines'>,
  locale: CounterReceiptLocale
) {
  const tiers = new Map<string, number>();
  for (const line of receipt.lines)
    if (line.tierName && line.tierDiscountMinor)
      tiers.set(line.tierName, (tiers.get(line.tierName) ?? 0) + line.tierDiscountMinor);
  return [...tiers].map(
    ([name, minor]) =>
      `${COUNTER_RECEIPT_STRINGS[locale].tierDiscount} · ${name}: -${formatMinor(minor, locale)}`
  );
}

/**
 * #708: whether a province code is Sindh, compared without the `PK-` prefix or
 * case, as the regulatory profile form compares provinces.
 */
export function isSindhCashMemoProvince(code: string | null | undefined): boolean {
  return (
    typeof code === 'string' &&
    ['SD', 'SINDH'].includes(code.trim().toUpperCase().replace(/^PK-/, ''))
  );
}

/** Blank rule the buyer or qualified person completes by hand on paper. */
export const CASH_MEMO_BLANK = '________________';

export type CounterReceiptCashMemo = {
  title: string;
  buyer: string;
  /** The licence with its validity, then the optional pharmacist registration. */
  licence: string[];
  signature: string;
};

/**
 * #708 — Sindh Drugs Rules r.18 cash memo facts, or null outside Sindh.
 *
 * The mode is not an operator toggle: it follows the regulatory profile that
 * was in force when the sale completed, so a reprint from history prints the
 * same memo and a Punjab branch's receipt is unchanged. Missing facts print
 * as "not recorded" or a blank to be completed by hand, never invented.
 */
export function counterReceiptCashMemo(
  receipt: Pick<CounterReceipt, 'buyerName' | 'cashMemoIdentity'>,
  identity: PharmacyReceiptTaxIdentity | null | undefined,
  locale: CounterReceiptLocale
): CounterReceiptCashMemo | null {
  if (receipt.cashMemoIdentity !== undefined) identity = receipt.cashMemoIdentity;
  if (!isSindhCashMemoProvince(identity?.provinceCode)) return null;
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const licenceNumber = identity?.licenceNumber?.trim() || strings.notRecorded;
  const from = identity?.licenceValidFrom ? formatReceiptDate(identity.licenceValidFrom) : null;
  const to = identity?.licenceValidTo ? formatReceiptDate(identity.licenceValidTo) : null;
  const validity =
    from && to
      ? ` (${strings.licenceValid} ${from} ${strings.licenceValidTo} ${to})`
      : to
        ? ` (${strings.licenceValid} ${strings.licenceValidTo} ${to})`
        : '';
  const pharmacist = identity?.pharmacistRegistration?.trim();
  return {
    title: strings.cashMemo,
    buyer: `${strings.buyer}: ${receipt.buyerName?.trim() || CASH_MEMO_BLANK}`,
    licence: [
      `${strings.licence}: ${licenceNumber}${validity}`,
      ...(pharmacist ? [`${strings.pharmacistRegistration}: ${pharmacist}`] : []),
    ],
    signature: `${strings.signature}: ${CASH_MEMO_BLANK}`,
  };
}

/** The per-line manufacturer fact a cash memo adds; r.18 asks for it on every line. */
export function cashMemoManufacturer(
  line: Pick<CounterReceiptLine, 'manufacturer' | 'identityStatus'>,
  locale: CounterReceiptLocale
): string {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const manufacturer = line.identityStatus === 'ISSUED' ? line.manufacturer?.trim() : null;
  return `${strings.manufacturer}: ${manufacturer || strings.notRecorded}`;
}
