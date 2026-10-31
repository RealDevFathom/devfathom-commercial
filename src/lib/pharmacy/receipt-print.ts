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
  cashMemoHeaderLines,
  cashMemoLineRows,
  cashMemoSignatureLine,
  isCashMemo,
} from './cash-memo';
import {
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  type CounterReceipt,
  type CounterReceiptLocale,
  type PharmacyReceiptTaxIdentity,
} from './counter-receipt';

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
    : 'Historical identity unavailable';
}

/** English facts with ASCII separators; mirrors counter-receipt-presentation semantics. */
function escPosFacts(
  receipt: CounterReceipt & { receiptNumber: number; completedAt: string },
  taxIdentity: PharmacyReceiptTaxIdentity,
  reprint: boolean
): ReceiptPreviewFacts {
  const strings = COUNTER_RECEIPT_STRINGS.en;
  const date = `${strings.date}: ${receipt.businessDate ?? formatReceiptDate(receipt.completedAt)}`;
  // #708: Sindh cash memo rows; every other receipt keeps its exact facts.
  const memo = isCashMemo(receipt);
  const dated = memo ? [date, ...cashMemoHeaderLines(receipt, 'en')].join('\n') : date;
  return {
    businessName: receipt.branchName,
    invoiceNumber: `${strings.receipt} ${receipt.receiptNumber}`,
    issuedAt: reprint ? `${dated}\n${REPRINT_MARKER}` : dated,
    lines: receipt.lines.map((line) => {
      const issued = line.identityStatus === 'ISSUED';
      return [
        lineIdentity(line),
        ...(memo
          ? cashMemoLineRows(line, 'en', ' | ')
          : [
              `${line.quantity} ${strings.saleUnit[line.saleUnit]} x ${formatMinor(line.unitPriceMinor)}`,
            ]),
        ...(line.allocations ?? []).map((allocation) => {
          const batch = issued ? allocation.batchNumber : null;
          const expiry = issued && allocation.expiresAt ? allocation.expiresAt : null;
          return `${strings.batch}: ${batch ?? 'Unavailable'} | ${strings.expiry}: ${
            expiry ? formatReceiptDate(expiry) : 'Unavailable'
          } | Units: ${allocation.canonicalUnits}`;
        }),
        `${strings.lineTotal}: ${formatMinor(line.lineTotalMinor)}`,
      ].join('\n');
    }),
    // The Pharmacy receipt model supplies no tax breakdown. Never invent zero tax.
    taxLines: [
      ...(taxIdentity.ntn ? [`NTN: ${taxIdentity.ntn}`] : []),
      ...(taxIdentity.strn ? [`STRN: ${taxIdentity.strn}`] : []),
      'Tax breakdown unavailable in receipt source',
    ],
    totals: [
      receipt.currency,
      `${strings.gross}: ${formatMinor(receipt.totals.grossMinor)}`,
      `${strings.discount}: ${formatMinor(receipt.totals.discountMinor)}`,
      `${strings.net}: ${formatMinor(receipt.totals.netMinor)}`,
      `${strings.tendered}: ${formatMinor(receipt.totals.tenderedMinor)}`,
      `${strings.change}: ${formatMinor(receipt.totals.changeMinor)}`,
    ],
    payments: [
      ...(receipt.tenders.length
        ? receipt.tenders.map((tender) => `${tender.type}: ${formatMinor(tender.amountMinor)}`)
        : ['Payment details unavailable']),
      ...(memo ? [cashMemoSignatureLine('en')] : []),
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
  at: Date
): Promise<PharmacyReceiptTaxIdentity> {
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    select: { ntn: true, strn: true },
  });
  return { ntn: profile?.ntn?.trim() || null, strn: profile?.strn?.trim() || null };
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
