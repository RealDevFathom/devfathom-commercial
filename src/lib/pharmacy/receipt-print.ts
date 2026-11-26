/** Build pharmacy thermal documents from issued facts and branch-owned settings. */
import { TRPCError } from '@trpc/server';

import { DEFAULT_RECEIPT_LAYOUT, type ReceiptLayout } from '@/lib/receipts/configuration';
import { readReceiptLogo } from './receipt-logo';
import {
  safePharmacyLayout,
  SavePharmacyReceiptLayoutSchema,
  type PharmacyReceiptLayout,
} from './receipt-layout';
import { renderPharmacyThermal, type PharmacyPrintDocument } from './receipt-thermal-design';
import {
  RawPrintValidationError,
  validateRawPrintDocument,
} from '@/lib/restaurant/printing/contract';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  COUNTER_RECEIPT_STRINGS,
  type CounterReceipt,
  type CounterReceiptLocale,
  type PharmacyReceiptTaxIdentity,
} from './counter-receipt';
import { counterReceiptFacts } from './counter-receipt-presentation';
import { regulatoryProfileInForceWhere } from './regulatory-start';

/** Registered tax identity printed on the receipt; null fields are omitted, never invented. */
export type { PharmacyReceiptTaxIdentity } from './counter-receipt';

export type PharmacyReceiptEscPosJob = {
  document: PharmacyPrintDocument;
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

/**
 * The settled receipt as a raw-printable `RECEIPT` document, validated by the
 * shared contract before it is returned. Throws `RawPrintValidationError`
 * (`UNSUPPORTED_PRINT_TEXT` carries the `BROWSER_OS` fallback).
 */
export function buildPharmacyReceiptPrintDocument(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  options: {
    layout: PharmacyReceiptLayout;
    taxIdentity: PharmacyReceiptTaxIdentity;
    reprint: boolean;
  }
): PharmacyPrintDocument {
  if (receipt.receiptNumber === null || !receipt.completedAt) {
    throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
  }
  // The ESC/POS baseline has no Urdu code page; Urdu stays on the browser path.
  const layout = safePharmacyLayout(options.layout);
  if (locale !== 'en' || (layout.version === 2 && layout.locale !== 'en'))
    throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
  let facts;
  try {
    facts = counterReceiptFacts({ ...receipt, taxIdentity: options.taxIdentity }, 'en', true);
  } catch {
    throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  }
  // Historic v1 documents carry their copy mark in the text; v2 uses the fixed mark block.
  if (layout.version === 1 && options.reprint) facts.issuedAt += '\n' + REPRINT_MARKER;
  const base = validateRawPrintDocument({
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
      layout:
        layout.version === 1
          ? layout
          : { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: layout.paperWidth },
      facts,
    },
  });
  return layout.version === 2 ? { ...base, pharmacyDesign: layout } : base;
}

/** Validated document plus its ESC/POS bytes. Nothing is queued or persisted. */
export function buildPharmacyReceiptEscPosJob(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  options: {
    layout: PharmacyReceiptLayout;
    taxIdentity: PharmacyReceiptTaxIdentity;
    reprint: boolean;
  }
): PharmacyReceiptEscPosJob {
  const document = buildPharmacyReceiptPrintDocument(receipt, locale, options);
  const bytes = renderPharmacyThermal(document);
  return {
    document,
    escPos: {
      encoding: 'base64',
      data: Buffer.from(bytes).toString('base64'),
      byteCount: bytes.length,
    },
    paperWidth: document.receiptSnapshot!.layout.paperWidth,
    reprint: options.reprint,
  };
}

type FormatDb = Pick<ScopedDb, 'pharmacyBranch' | 'branchRegulatoryProfile'>;
type BranchScope = { organizationId: string; branchId: string };

/**
 * The branch's saved receipt format (shared `ReceiptLayout` on
 * `PharmacyBranch.receiptLayout`). Absent configuration gets the shared default;
 * an invalid stored design falls back to the shared default.
 */
export async function readPharmacyReceiptFormat(db: FormatDb, scope: BranchScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { receiptLayout: true, receiptLayoutRevision: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
  const layout = safePharmacyLayout(branch.receiptLayout);
  return {
    layout,
    ...(layout.version === 2 && layout.logo
      ? { receiptLogoPng: await readReceiptLogo(scope, layout.logo.assetId).catch(() => undefined) }
      : {}),
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
    | { addressLine?: unknown; city?: unknown; phone?: unknown; registeredName?: unknown }
    | undefined;
  const address = [premises?.addressLine, premises?.city]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim())
    .join(', ');
  return {
    ...(typeof premises?.registeredName === 'string' && premises.registeredName.trim()
      ? { registeredName: premises.registeredName.trim() }
      : {}),
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
  db: ScopedDb,
  organizationId: string,
  request: import('zod').infer<typeof SavePharmacyReceiptLayoutSchema> & { actorId: string }
) {
  const { actorId, ...fields } = request;
  const input = SavePharmacyReceiptLayoutSchema.parse(fields);
  if (input.layout.version === 2 && input.layout.logo) {
    try {
      await readReceiptLogo(
        { organizationId, branchId: input.branchId },
        input.layout.logo.assetId
      );
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Upload this logo again for this branch.',
      });
    }
  }
  return db.$transaction(async (tx) => {
    const updated = await tx.pharmacyBranch.updateMany({
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
    await tx.auditLog.create({
      data: {
        organizationId,
        actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacySales.counterSaveReceiptFormat',
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        outcome: 'SUCCESS',
        metadata: { oldRevision: input.revision, newRevision: input.revision + 1 },
      },
    });
    return { layout: input.layout, revision: input.revision + 1 };
  });
}
