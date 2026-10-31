/**
 * #708 — the Sindh cash memo receipt template (Sindh Drugs Rules r.18).
 *
 * The Sindh rules require a detailed cash memo for every sale. Each line shows
 * medicine, strength, manufacturer, batch, expiry, quantity, unit price and
 * total. The header carries the licence number and its validity, plus the
 * pharmacist registration where it is on file. The memo carries the buyer's
 * name and a "Signature of qualified person" line.
 *
 * The template is not a setting someone can forget to turn on. It applies
 * whenever the regulatory profile in force when the sale completed is for
 * Sindh. Its header facts are frozen in the issued receipt snapshot, so a
 * backdated profile update cannot change a reprint. Branches in other provinces
 * keep the standard receipt unchanged.
 *
 * This module has no runtime database or server imports, so the counter view
 * can import its strings and line rendering.
 */

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { receiptTextSchema } from '@/lib/receipts/configuration';

import {
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  type CounterReceipt,
  type CounterReceiptLine,
  type CounterReceiptLocale,
} from './counter-receipt';

/** ISO 3166-2 code the regulatory profile stores for Sindh. */
export const SINDH_PROVINCE_CODE = 'PK-SD';

export const CASH_MEMO_BUYER_NAME_MAX = 120;

/** Licence header facts from the profile in force when the sale completed. */
export type PharmacyCashMemo = {
  template: 'SINDH_CASH_MEMO';
  /** Null when the profile is an onboarding placeholder: a placeholder number is never printed. */
  licenceNumber: string | null;
  /** ISO dates. */
  licenceValidFrom: string | null;
  licenceValidTo: string | null;
  /** Optional on the memo; null when not on file. */
  pharmacistRegistration: string | null;
};

type CashMemoStrings = {
  title: string;
  licence: string;
  licenceMissing: string;
  validity: string;
  validityTo: string;
  pharmacist: string;
  buyer: string;
  manufacturer: string;
  unavailable: string;
  signature: string;
};

/**
 * Both languages live in one table, like `COUNTER_RECEIPT_STRINGS`. The English
 * strings are printable ASCII so the ESC/POS path can print them.
 */
export const CASH_MEMO_STRINGS: Readonly<Record<CounterReceiptLocale, CashMemoStrings>> = {
  en: {
    title: 'Cash memo - Sindh Drugs Rules r.18',
    licence: 'Drug sale licence',
    licenceMissing: 'Licence not on file',
    validity: 'Valid',
    validityTo: 'to',
    pharmacist: 'Pharmacist reg.',
    buyer: 'Buyer',
    manufacturer: 'Manufacturer',
    unavailable: 'Unavailable',
    signature: 'Signature of qualified person',
  },
  ur: {
    title: 'کیش میمو — سندھ ڈرگز رولز، قاعدہ 18',
    licence: 'ڈرگ سیل لائسنس',
    licenceMissing: 'لائسنس ریکارڈ میں موجود نہیں',
    validity: 'مؤثر مدت',
    validityTo: 'تا',
    pharmacist: 'فارماسسٹ رجسٹریشن',
    buyer: 'خریدار',
    manufacturer: 'تیار کنندہ',
    unavailable: 'دستیاب نہیں',
    signature: 'مستند شخص کے دستخط',
  },
};

/**
 * Characters the shared receipt text schema refuses (controls, bidi overrides,
 * lone surrogates). A buyer name is printed verbatim, so these never get in.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\p{Cs}]/u;
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_ALL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\p{Cs}]/gu;

/** Normalize catalog/profile text before freezing it, using the printers' validator. */
export function normalizeCashMemoText(raw: string | null | undefined, max = 200): string | null {
  const value = (raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE_ALL, '')
    .trim()
    .slice(0, max)
    // Truncation must not leave half of a supplementary Unicode character.
    .replace(UNPRINTABLE_ALL, '')
    .trim();
  return receiptTextSchema(max).parse(value) || null;
}

/** Blank to fill by hand: a nameless walk-in memo still has a buyer field. */
const BLANK = '________________';

export type CashMemoSeparator = ' · ' | ' | ';

/** True when this receipt renders as a Sindh cash memo. */
export function isCashMemo<T extends Pick<CounterReceipt, 'cashMemo'>>(
  receipt: T
): receipt is T & { cashMemo: PharmacyCashMemo } {
  return receipt.cashMemo?.template === 'SINDH_CASH_MEMO';
}

/** Header rows: title, licence, validity, optional pharmacist, buyer. Empty when not a memo. */
export function cashMemoHeaderLines(
  receipt: Pick<CounterReceipt, 'cashMemo' | 'buyerName'>,
  locale: CounterReceiptLocale
): string[] {
  if (!isCashMemo(receipt)) return [];
  const memo = receipt.cashMemo;
  const text = CASH_MEMO_STRINGS[locale];
  const validity =
    memo.licenceValidFrom && memo.licenceValidTo
      ? `${text.validity}: ${formatReceiptDate(memo.licenceValidFrom)} ${text.validityTo} ${formatReceiptDate(memo.licenceValidTo)}`
      : `${text.validity}: ${text.unavailable}`;
  return [
    text.title,
    memo.licenceNumber ? `${text.licence}: ${memo.licenceNumber}` : text.licenceMissing,
    validity,
    ...(memo.pharmacistRegistration
      ? [`${text.pharmacist}: ${memo.pharmacistRegistration}`]
      : []),
    `${text.buyer}: ${receipt.buyerName?.trim() || BLANK}`,
  ];
}

/**
 * The extra per-line rows a memo needs beyond the standard receipt: strength
 * and manufacturer, then labelled quantity and unit price. The standard rows
 * already show the medicine, batch, expiry and line total.
 */
export function cashMemoLineRows(
  line: CounterReceiptLine,
  locale: CounterReceiptLocale,
  separator: CashMemoSeparator = ' · '
): string[] {
  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const text = CASH_MEMO_STRINGS[locale];
  const issued = line.identityStatus === 'ISSUED';
  // The ESC/POS separator means ASCII-only output, so its dash is ASCII too.
  const none = separator === ' | ' ? '-' : '—';
  const strength = issued && line.strength ? line.strength : none;
  const manufacturer = issued && line.manufacturer ? line.manufacturer : text.unavailable;
  return [
    `${strings.strength}: ${strength}${separator}${text.manufacturer}: ${manufacturer}`,
    `${strings.quantity}: ${line.quantity} ${strings.saleUnit[line.saleUnit]}${separator}${strings.unitPrice}: ${formatMinor(line.unitPriceMinor)}`,
  ];
}

/** The signature row printed at the foot of every memo. */
export function cashMemoSignatureLine(locale: CounterReceiptLocale): string {
  return `${CASH_MEMO_STRINGS[locale].signature}: ${BLANK}`;
}

export class PharmacyCashMemoError extends Error {
  constructor(readonly reason: 'INVALID_BUYER_NAME' | 'BUYER_NAME_REQUIRED' | 'SALE_NOT_OPEN') {
    super(reason);
    this.name = 'PharmacyCashMemoError';
  }
}

/**
 * Trimmed, single-spaced buyer name, or null for "no name". Control characters
 * are refused: the name is printed verbatim on paper and in an ESC/POS job.
 */
export function normalizeBuyerName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (value.length > CASH_MEMO_BUYER_NAME_MAX || UNPRINTABLE.test(value)) {
    throw new PharmacyCashMemoError('INVALID_BUYER_NAME');
  }
  return value;
}

type CashMemoDb = Pick<ScopedDb, 'branchRegulatoryProfile'>;
type BranchScope = { organizationId: string; branchId: string };

/**
 * The cash memo header for a sale completed at `at`, or null when the profile
 * in force then is not for Sindh. A Punjab (or unprofiled) branch gets null and
 * so keeps the standard receipt.
 */
export async function readPharmacyCashMemo(
  db: CashMemoDb,
  scope: BranchScope,
  at: Date
): Promise<PharmacyCashMemo | null> {
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    select: {
      provinceCode: true,
      isPlaceholder: true,
      licenceNumber: true,
      licenceValidFrom: true,
      licenceValidTo: true,
      qualifiedPersonRegistration: true,
    },
  });
  if (!profile || profile.provinceCode !== SINDH_PROVINCE_CODE) return null;
  // An onboarding placeholder holds stand-in values; printing them would be a false licence.
  if (profile.isPlaceholder) {
    return {
      template: 'SINDH_CASH_MEMO',
      licenceNumber: null,
      licenceValidFrom: null,
      licenceValidTo: null,
      pharmacistRegistration: null,
    };
  }
  return {
    template: 'SINDH_CASH_MEMO',
    licenceNumber: normalizeCashMemoText(profile.licenceNumber),
    licenceValidFrom: profile.licenceValidFrom.toISOString(),
    licenceValidTo: profile.licenceValidTo.toISOString(),
    pharmacistRegistration: normalizeCashMemoText(profile.qualifiedPersonRegistration),
  };
}

type PolicyDb = Pick<ScopedDb, 'branchRegulatoryProfile' | 'pharmacyBranch'>;

/** Whether a sale tendered now prints a cash memo, and whether the owner requires a buyer name. */
export async function readPharmacyCashMemoPolicy(db: PolicyDb, scope: BranchScope, at: Date) {
  const [memo, branch] = await Promise.all([
    readPharmacyCashMemo(db, scope, at),
    db.pharmacyBranch.findFirst({
      where: { id: scope.branchId, organizationId: scope.organizationId },
      select: { cashMemoBuyerNameRequired: true },
    }),
  ]);
  return {
    cashMemo: memo !== null,
    buyerNameRequired: branch?.cashMemoBuyerNameRequired === true,
  };
}

/**
 * The buyer name to freeze on the sale at completion: the name typed at the
 * counter, else the linked customer's display name. Null for a nameless walk-in.
 */
export async function resolveCompletionBuyerName(
  db: Pick<ScopedDb, 'pharmacyCustomer'>,
  scope: BranchScope,
  sale: { buyerName: string | null; customerId: string | null }
): Promise<string | null> {
  const typed = normalizeBuyerName(sale.buyerName);
  if (typed) return typed;
  if (!sale.customerId) return null;
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, id: sale.customerId },
    select: { displayName: true },
  });
  return normalizeCashMemoText(customer?.displayName, CASH_MEMO_BUYER_NAME_MAX);
}

/**
 * Owner policy: on a Sindh branch that requires a buyer name, a nameless sale
 * cannot be settled. Walk-ins without a name stay allowed by default.
 */
export async function assertCashMemoBuyerName(
  db: PolicyDb & Pick<ScopedDb, 'pharmacyCustomer'>,
  scope: BranchScope,
  sale: { buyerName: string | null; customerId: string | null },
  at: Date
): Promise<void> {
  // Validate the actual printable name, including a linked customer's fallback.
  if (await resolveCompletionBuyerName(db, scope, sale)) return;
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId },
    select: { cashMemoBuyerNameRequired: true },
  });
  if (branch?.cashMemoBuyerNameRequired !== true) return;
  if ((await readPharmacyCashMemo(db, scope, at)) === null) return;
  throw new PharmacyCashMemoError('BUYER_NAME_REQUIRED');
}

/** Set or clear the buyer name on an OPEN, unnumbered sale. Callers authorize and lock. */
export async function setPharmacySaleBuyerName(
  db: Pick<ScopedDb, 'pharmacySale'>,
  scope: BranchScope,
  input: { saleId: string; buyerName: string | null }
) {
  const buyerName = normalizeBuyerName(input.buyerName);
  const updated = await db.pharmacySale.updateMany({
    where: {
      id: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
      receiptNumber: null,
    },
    data: { buyerName },
  });
  if (updated.count !== 1) throw new PharmacyCashMemoError('SALE_NOT_OPEN');
  return { saleId: input.saleId, buyerName };
}
