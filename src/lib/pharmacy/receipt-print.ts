/**
 * PH-A7 — the Pharmacy thermal receipt as an ESC/POS job on the shared print seam.
 *
 * One `RECEIPT` document with a shared layout + facts snapshot, rendered by the
 * Restaurant ESC/POS baseline. Pharmacy gets no second print contract and no
 * second queue: `RestaurantPrintJob` references `RestaurantBranch`, so the job
 * is returned to the caller for a local bridge hand-off and never persisted.
 *
 * The raw baseline is printable ASCII only. Urdu (or any non-ASCII medicine or
 * branch name) is refused with the contract's `BROWSER_OS` fallback — the
 * browser receipt in `counter-browser-print.ts` is unchanged and remains the
 * Unicode path.
 *
 * Reprint is a read. The receipt number comes from the settled sale; this
 * module only marks the paper as a reprint and can never issue a number.
 */

import { TRPCError } from '@trpc/server';

import {
  readReceiptLayout,
  SaveReceiptLayoutSchema,
  type ReceiptLayout,
} from '@/lib/receipts/configuration';
import type { ReceiptPreviewFacts } from '@/lib/receipts/preview';
import {
  RawPrintValidationError,
  validateRawPrintDocument,
  type PrintDocument,
} from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  cashMemoManufacturer,
  counterReceiptCashMemo,
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptExpiry,
  formatReceiptIssuedAt,
  receiptCashReceived,
  receiptOfflineReferenceLine,
  receiptPromotionLabel,
  type CounterReceipt,
  type CounterReceiptLocale,
  type PharmacyReceiptTaxIdentity,
} from './counter-receipt';
import { counterLinePricing } from './counter-receipt-presentation';
import { regulatoryProfileInForceWhere } from './regulatory-start';

/** Registered tax identity printed on the receipt; null fields are omitted, never invented. */
export type { PharmacyReceiptTaxIdentity } from './counter-receipt';

export type PharmacyReceiptEscPosJob = {
  document: PrintDocument;
  escPos: { encoding: 'base64'; data: string; byteCount: number };
  paperWidth: ReceiptLayout['paperWidth'];
  reprint: boolean;
};

export class PharmacyReceiptPrintError extends Error {
  constructor(readonly reason: 'RECEIPT_NOT_ISSUED') {
    super(reason);
    this.name = 'PharmacyReceiptPrintError';
  }
}

const REPRINT_MARKER = 'REPRINT - not a new sale';

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function lineIdentity(line: CounterReceipt['lines'][number]): string {
  return line.identityStatus === 'ISSUED'
    ? [line.medicineName, line.strength, line.presentation].filter(Boolean).join(' - ')
    : 'Original item details unavailable';
}

/** English facts with ASCII separators; mirrors counter-receipt-presentation semantics. */
function escPosFacts(
  receipt: CounterReceipt & { receiptNumber: number; completedAt: string },
  currentTaxIdentity: PharmacyReceiptTaxIdentity,
  reprint: boolean
): ReceiptPreviewFacts {
  // #708: a cash memo reprints every identity fact frozen at issuance; other receipts
  // (and older snapshots without the frozen identity) keep the profile read for the sale.
  const taxIdentity = receipt.cashMemoIdentity ?? currentTaxIdentity;
  const strings = COUNTER_RECEIPT_STRINGS.en;
  const date = `${strings.date}: ${formatReceiptIssuedAt(receipt.completedAt, receipt.timeZone)}`;
  let cashReceived: number | null;
  try {
    cashReceived = receiptCashReceived(receipt.tenders);
  } catch {
    throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  }
  const memo = counterReceiptCashMemo(receipt, taxIdentity, 'en');
  // DEV-637: the issuing counter, and the number printed offline when replay renumbered
  // the sale, exactly as the browser receipt prints them.
  const offlineReference = receiptOfflineReferenceLine(receipt, 'en');
  return {
    businessName: receipt.branchName,
    invoiceNumber: String(receipt.receiptNumber),
    invoiceLabel: memo ? memo.title : strings.invoice,
    issuedAt: `${memo ? `${memo.licence.join('\n')}\n${memo.buyer}\n` : ''}${date}${receipt.counterLabel ? `\n${receipt.counterLabel}` : ''}${offlineReference ? `\n${offlineReference}` : ''}${receipt.cashierName ? `\n${strings.cashier}: ${receipt.cashierName}` : ''}${reprint ? `\n${REPRINT_MARKER}` : ''}`,
    lines: receipt.lines.map((line) => {
      const issued = line.identityStatus === 'ISSUED';
      const promotion = receiptPromotionLabel(line, 'en');
      return [
        lineIdentity(line),
        ...(memo ? [cashMemoManufacturer(line, 'en')] : []),
        memo
          ? `${strings.quantity} x ${strings.unitPrice}: ${counterLinePricing(line, 'en', 'x')}`
          : counterLinePricing(line, 'en', 'x'),
        ...(line.allocations ?? []).map((allocation) => {
          // DEV-853: plain words for an issued lot that never recorded them.
          const batch = !issued
            ? `${strings.batch}: Unavailable`
            : allocation.batchNumber === null
              ? strings.batchNotRecorded
              : `${strings.batch}: ${allocation.batchNumber}`;
          const expiry = !issued
            ? `${strings.expiry}: Unavailable`
            : allocation.expiresAt === null
              ? strings.expiryNotRecorded
              : `${strings.expiry}: ${formatReceiptExpiry(allocation.expiresAt)}`;
          return `${batch} | ${expiry} | Tablets/units: ${allocation.canonicalUnits}`;
        }),
        ...(promotion ? [promotion] : []),
        `${strings.lineTotal}: ${formatMinor(line.lineTotalMinor)}`,
      ].join('\n');
    }),
    taxBreakdown: 'UNAVAILABLE',
    // The Pharmacy receipt model supplies no tax breakdown. Never invent zero tax.
    taxLines: [
      ...(taxIdentity.address ? [taxIdentity.address] : []),
      ...(taxIdentity.phone ? [`${strings.phone}: ${taxIdentity.phone}`] : []),
      ...(memo
        ? []
        : taxIdentity.licenceNumber
          ? [`${strings.licence}: ${taxIdentity.licenceNumber}`]
          : []),
      ...(taxIdentity.ntn ? [`NTN: ${taxIdentity.ntn}`] : []),
      ...(taxIdentity.strn ? [`STRN: ${taxIdentity.strn}`] : []),
    ],
    totals: [
      receipt.currency,
      `${strings.gross}: ${formatMinor(receipt.totals.grossMinor)}`,
      `${strings.discount}: ${formatMinor(receipt.totals.discountMinor)}`,
      `${strings.net}: ${formatMinor(receipt.totals.netMinor)}`,
      `${strings.tendered}: ${formatMinor(receipt.totals.tenderedMinor)}`,
      ...(cashReceived !== null ? [`Cash received: ${formatMinor(cashReceived)}`] : []),
      `${strings.change}: ${formatMinor(receipt.totals.changeMinor)}`,
    ],
    payments: [
      ...(receipt.tenders.length
        ? receipt.tenders.map(
            (tender) =>
              `${strings.tenderName[tender.type] ?? tender.type}: ${formatMinor(tender.amountMinor)}`
          )
        : ['Payment details unavailable']),
      ...(memo ? [`\n${memo.signature}`] : []),
    ],
  };
}

/**
 * The settled receipt as a raw-printable `RECEIPT` document, validated by the
 * shared contract before it is returned. Throws `RawPrintValidationError`
 * (`UNSUPPORTED_PRINT_TEXT` carries the `BROWSER_OS` fallback).
 */
export function buildPharmacyReceiptPrintDocument(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  options: { layout: ReceiptLayout; taxIdentity: PharmacyReceiptTaxIdentity; reprint: boolean }
): PrintDocument {
  if (receipt.receiptNumber === null || !receipt.completedAt) {
    throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
  }
  // The ESC/POS baseline has no Urdu code page; Urdu stays on the browser path.
  if (locale !== 'en') throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
  const amounts = [
    ...Object.values(receipt.totals),
    ...receipt.lines.flatMap((line) => [line.unitPriceMinor, line.lineTotalMinor]),
    ...receipt.tenders.map((tender) => tender.amountMinor),
  ];
  if (!amounts.every(Number.isSafeInteger)) {
    throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  }
  const settled = {
    ...receipt,
    receiptNumber: receipt.receiptNumber,
    completedAt: receipt.completedAt,
  };
  return validateRawPrintDocument({
    type: 'RECEIPT',
    reference: `receipt:${receipt.receiptNumber}`,
    title: `${COUNTER_RECEIPT_STRINGS.en.receipt} ${receipt.receiptNumber}${
      options.reprint ? ' (reprint)' : ''
    }`,
    createdAt: new Date(receipt.completedAt).toISOString(),
    lines: receipt.lines.map((line) => ({
      quantity: line.quantity,
      label: clamp(lineIdentity(line), 160),
    })),
    receiptSnapshot: {
      layout: options.layout,
      facts: escPosFacts(settled, options.taxIdentity, options.reprint),
    },
  });
}

/** Validated document plus its ESC/POS bytes. Nothing is queued or persisted. */
export function buildPharmacyReceiptEscPosJob(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  options: { layout: ReceiptLayout; taxIdentity: PharmacyReceiptTaxIdentity; reprint: boolean }
): PharmacyReceiptEscPosJob {
  const document = buildPharmacyReceiptPrintDocument(receipt, locale, options);
  const bytes = renderEscPos(document);
  return {
    document,
    escPos: {
      encoding: 'base64',
      data: Buffer.from(bytes).toString('base64'),
      byteCount: bytes.length,
    },
    paperWidth: options.layout.paperWidth,
    reprint: options.reprint,
  };
}

type FormatDb = Pick<ScopedDb, 'pharmacyBranch' | 'branchRegulatoryProfile'>;
type BranchScope = { organizationId: string; branchId: string };

/**
 * The branch's saved receipt format (shared `ReceiptLayout` on
 * `PharmacyBranch.receiptLayout`). Absent configuration gets the shared default;
 * a corrupt stored value fails closed.
 */
export async function readPharmacyReceiptFormat(db: FormatDb, scope: BranchScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { receiptLayout: true, receiptLayoutRevision: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
  return {
    layout: readReceiptLayout(branch.receiptLayout),
    revision: branch.receiptLayoutRevision,
  };
}

/**
 * NTN/STRN from the regulatory profile in force when the sale completed, so a
 * reprint from history carries the identity the original receipt was issued under.
 */
export async function readPharmacyReceiptTaxIdentity(
  db: FormatDb,
  scope: BranchScope,
  at: Date,
  timeZone?: string | null
): Promise<PharmacyReceiptTaxIdentity> {
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      // DEV-298: a sale on a profile's start day uses it from local midnight.
      ...regulatoryProfileInForceWhere(at, timeZone),
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    select: {
      premises: true,
      licenceNumber: true,
      ntn: true,
      strn: true,
      provinceCode: true,
      licenceValidFrom: true,
      licenceValidTo: true,
      qualifiedPersonRegistration: true,
    },
  });
  const premises = profile?.premises as
    { addressLine?: unknown; city?: unknown; phone?: unknown } | undefined;
  const address = [premises?.addressLine, premises?.city]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim())
    .join(', ');
  return {
    address: address || null,
    phone: typeof premises?.phone === 'string' ? premises.phone.trim() || null : null,
    licenceNumber: profile?.licenceNumber?.trim() || null,
    ntn: profile?.ntn?.trim() || null,
    strn: profile?.strn?.trim() || null,
    // #708: the province and licence facts the Sindh cash memo prints.
    provinceCode: profile?.provinceCode?.trim() || null,
    licenceValidFrom: profile?.licenceValidFrom?.toISOString() ?? null,
    licenceValidTo: profile?.licenceValidTo?.toISOString() ?? null,
    pharmacistRegistration: profile?.qualifiedPersonRegistration?.trim() || null,
  };
}

/** Caller must authorize configuration writes. Organization comes only from the session. */
export async function savePharmacyReceiptFormat(
  db: Pick<ScopedDb, 'pharmacyBranch'>,
  organizationId: string,
  raw: unknown
) {
  const input = SaveReceiptLayoutSchema.parse(raw);
  const updated = await db.pharmacyBranch.updateMany({
    where: {
      id: input.branchId,
      organizationId,
      active: true,
      receiptLayoutRevision: input.revision,
    },
    data: { receiptLayout: input.layout, receiptLayoutRevision: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Branch unavailable or format changed. Reload saved settings before trying again.',
    });
  return { layout: input.layout, revision: input.revision + 1 };
}
