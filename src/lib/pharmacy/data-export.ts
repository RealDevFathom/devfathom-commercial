import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma, type PlatformJob } from '@/generated/prisma/client';
import { deleteUpload, getUpload, putUpload } from '@/lib/storage';
import { withOrganizationDefaults, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from '@/server/audit';
import {
  buildPharmacyExportFiles,
  formatCalendarDate,
  formatInstant,
  formatKarachiDate,
  formatMinor,
  pharmacyExportRowCounts,
  type ExportRow,
  type PharmacyExportDataset,
} from './data-export-format';
import { buildZip } from './data-export-zip';
import { packConversions } from './pack-conversion';
import { maskCnic } from './patient-prescriptions';
import { costPurchaseOrderLine } from './purchasing';
import { chooseRegisterPersonName } from './register-print';

/**
 * #716 — the owner's "Download my data" export.
 *
 * Flow: the owner requests an export (a `pharmacy_data_exports` row, QUEUED);
 * the platform worker relays it to a `pharmacy.data.export.v1` job, which
 * narrows to the tenant, reads the pharmacy's data, writes a ZIP to the
 * organization's private upload namespace and marks the row READY with a link
 * that expires 24 hours later. The download route re-checks owner access and
 * expiry on every request. Request, build and every download are audit-logged.
 */

export const PHARMACY_DATA_EXPORT_JOB = 'pharmacy.data.export.v1';
export const PHARMACY_DATA_EXPORT_LINK_TTL_MS = 24 * 60 * 60_000;
export const PHARMACY_DATA_EXPORT_MAX_RANGE_DAYS = 366;
/** Requests per organization in any rolling 24 hours. */
export const PHARMACY_DATA_EXPORT_DAILY_LIMIT = 5;
/** A request still QUEUED after this long is reported as stalled, not pending. */
export const PHARMACY_DATA_EXPORT_STALE_MS = 6 * 60 * 60_000;
const RELAY_LIMIT = 20;
const EXPIRY_LIMIT = 50;
const MS_PER_DAY = 24 * 60 * 60_000;
const KARACHI_OFFSET_MS = 5 * 60 * 60_000;

export class PharmacyDataExportError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_RANGE'
      | 'RATE_LIMITED'
      | 'NOT_FOUND'
      | 'NOT_READY'
      | 'EXPIRED'
      | 'STORAGE_UNAVAILABLE'
  ) {
    super(reason);
    this.name = 'PharmacyDataExportError';
  }
}

export type SalesRange = { from: string; to: string };

function calendarDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new PharmacyDataExportError('INVALID_RANGE');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new PharmacyDataExportError('INVALID_RANGE');
  }
  return date;
}

/** Validate an inclusive business-date range: ordered, not in the future, at most a year. */
export function parseSalesRange(range: SalesRange, now: Date = new Date()) {
  const from = calendarDate(range.from);
  const to = calendarDate(range.to);
  const today = calendarDate(formatKarachiDate(now)!);
  if (from.getTime() > to.getTime() || to.getTime() > today.getTime()) {
    throw new PharmacyDataExportError('INVALID_RANGE');
  }
  if ((to.getTime() - from.getTime()) / MS_PER_DAY + 1 > PHARMACY_DATA_EXPORT_MAX_RANGE_DAYS) {
    throw new PharmacyDataExportError('INVALID_RANGE');
  }
  return {
    from,
    to,
    /** The same range as instants: Pakistan midnight to the next Pakistan midnight. */
    startsAt: new Date(from.getTime() - KARACHI_OFFSET_MS),
    endsBefore: new Date(to.getTime() + MS_PER_DAY - KARACHI_OFFSET_MS),
  };
}

function exportNamespace(organizationId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(organizationId)) {
    throw new PharmacyDataExportError('NOT_FOUND');
  }
  return `${organizationId}/pharmacy-data-exports`;
}

export type PharmacyDataExportView = {
  id: string;
  status: 'QUEUED' | 'READY' | 'FAILED' | 'EXPIRED';
  salesFrom: string;
  salesTo: string;
  requestedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  sizeBytes: number | null;
  rowCounts: Record<string, number> | null;
  downloadCount: number;
  downloadable: boolean;
  error: string | null;
};

type ExportRecord = {
  id: string;
  status: 'QUEUED' | 'READY' | 'FAILED' | 'EXPIRED';
  salesFrom: Date;
  salesTo: Date;
  requestedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  sizeBytes: number | null;
  rowCounts: Prisma.JsonValue | null;
  downloadCount: number;
  error: string | null;
};

/** The owner-facing state: a lapsed link reads EXPIRED, a lost job reads FAILED. */
export function viewPharmacyDataExport(record: ExportRecord, now: Date): PharmacyDataExportView {
  let status = record.status;
  let error = record.error;
  if (status === 'READY' && (!record.expiresAt || record.expiresAt.getTime() <= now.getTime())) {
    status = 'EXPIRED';
  }
  if (
    status === 'QUEUED' &&
    now.getTime() - record.requestedAt.getTime() > PHARMACY_DATA_EXPORT_STALE_MS
  ) {
    status = 'FAILED';
    error = error ?? 'The export did not finish. Request a new one.';
  }
  const counts =
    record.rowCounts && typeof record.rowCounts === 'object' && !Array.isArray(record.rowCounts)
      ? Object.fromEntries(
          Object.entries(record.rowCounts).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number'
          )
        )
      : null;
  return {
    id: record.id,
    status,
    salesFrom: formatCalendarDate(record.salesFrom)!,
    salesTo: formatCalendarDate(record.salesTo)!,
    requestedAt: record.requestedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    sizeBytes: record.sizeBytes,
    rowCounts: counts,
    downloadCount: record.downloadCount,
    downloadable: status === 'READY',
    error,
  };
}

const exportSelect = {
  id: true,
  status: true,
  salesFrom: true,
  salesTo: true,
  requestedAt: true,
  completedAt: true,
  expiresAt: true,
  sizeBytes: true,
  rowCounts: true,
  downloadCount: true,
  error: true,
} as const;

export async function listPharmacyDataExports(
  db: ScopedDb,
  organizationId: string,
  now: Date = new Date()
): Promise<PharmacyDataExportView[]> {
  const rows = await db.pharmacyDataExport.findMany({
    where: { organizationId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: 10,
    select: exportSelect,
  });
  return rows.map((row) => viewPharmacyDataExport(row, now));
}

/**
 * Queue an export. A still-pending request is returned instead of a second
 * one, and an organization may queue at most PHARMACY_DATA_EXPORT_DAILY_LIMIT
 * exports in a rolling day, so the button cannot be used to load the worker.
 */
export async function requestPharmacyDataExport(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; range: SalesRange },
  now: Date = new Date()
): Promise<{ export: PharmacyDataExportView; created: boolean }> {
  const range = parseSalesRange(input.range, now);
  return db.$transaction(async (tx) => {
    // Keep lookup, count and insertion behind the same tenant-specific lock.
    // Scoped clients reuse the caller's transaction; the RSC facade opens one.
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`pharmacy-data-export:${input.organizationId}`}, 0))
    `);
    const pending = await tx.pharmacyDataExport.findFirst({
      where: {
        organizationId: input.organizationId,
        status: 'QUEUED',
        requestedAt: { gt: new Date(now.getTime() - PHARMACY_DATA_EXPORT_STALE_MS) },
      },
      orderBy: { requestedAt: 'desc' },
      select: exportSelect,
    });
    if (pending) return { export: viewPharmacyDataExport(pending, now), created: false };
    const recent = await tx.pharmacyDataExport.count({
      where: {
        organizationId: input.organizationId,
        requestedAt: { gt: new Date(now.getTime() - MS_PER_DAY) },
      },
    });
    if (recent >= PHARMACY_DATA_EXPORT_DAILY_LIMIT) {
      throw new PharmacyDataExportError('RATE_LIMITED');
    }
    const created = await tx.pharmacyDataExport.create({
      data: {
        organizationId: input.organizationId,
        requestedByUserId: input.actorId,
        salesFrom: range.from,
        salesTo: range.to,
        requestedAt: now,
      },
      select: exportSelect,
    });
    return { export: viewPharmacyDataExport(created, now), created: true };
  });
}

/**
 * Read a READY, unexpired archive for download and count the download. The
 * caller has already proven owner access to `organizationId`.
 */
export async function readPharmacyDataExportArchive(
  db: ScopedDb,
  input: { organizationId: string; exportId: string },
  now: Date = new Date()
): Promise<{ fileName: string; data: Buffer; sha256: string | null }> {
  const record = await db.pharmacyDataExport.findFirst({
    where: { id: input.exportId, organizationId: input.organizationId },
    select: { ...exportSelect, storageKey: true, fileName: true, sha256: true },
  });
  if (!record) throw new PharmacyDataExportError('NOT_FOUND');
  const view = viewPharmacyDataExport(record, now);
  if (view.status === 'EXPIRED') throw new PharmacyDataExportError('EXPIRED');
  if (view.status !== 'READY' || !record.storageKey || !record.fileName) {
    throw new PharmacyDataExportError('NOT_READY');
  }
  let data: Buffer;
  try {
    data = await getUpload(exportNamespace(input.organizationId), record.storageKey);
  } catch (error) {
    const missing = error as { code?: string; statusCode?: number };
    if (
      missing.code === 'ENOENT' ||
      missing.code === 'BlobNotFound' ||
      missing.statusCode === 404
    ) {
      throw new PharmacyDataExportError('EXPIRED');
    }
    throw new PharmacyDataExportError('STORAGE_UNAVAILABLE');
  }
  await db.pharmacyDataExport.update({
    where: { id: record.id },
    data: { downloadCount: { increment: 1 }, lastDownloadedAt: now },
  });
  return { fileName: record.fileName, data, sha256: record.sha256 };
}

// ---------------------------------------------------------------------------
// Collection — every read is explicitly filtered by organization and also
// bounded by the tenant RLS the caller installed.
// ---------------------------------------------------------------------------

type KhataTotals = Map<string, { balanceMinor: number; accounts: number }>;

/**
 * Khata tables require exactly one branch in the RLS context, so they are read
 * per branch under that branch's own context and the caller's context is put
 * back afterwards (the same pattern as the owner command centre).
 */
async function readKhata(db: ScopedDb, organizationId: string, branchIds: readonly string[]) {
  const context = await db.$queryRaw<Array<{ branchId: string | null }>>(
    Prisma.sql`SELECT NULLIF(current_setting('app.current_branch_id', true), '') AS "branchId"`
  );
  const previousBranchId = context[0]?.branchId ?? '';
  const accounts: Array<{
    id: string;
    branchId: string;
    displayName: string;
    payerCustomerId: string;
  }> = [];
  const events: Array<{
    id: string;
    branchId: string;
    familyAccountId: string;
    kind: 'CHARGE' | 'PAYMENT' | 'DISHONOURED_CHEQUE';
    amountMinor: number;
    occurredAt: Date;
    dueAt: Date | null;
    settlesChargeId: string | null;
    note: string | null;
  }> = [];
  try {
    for (const branchId of branchIds) {
      await db.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
      accounts.push(
        ...(await db.pharmacyFamilyAccount.findMany({
          where: { organizationId, branchId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, branchId: true, displayName: true, payerCustomerId: true },
        }))
      );
      events.push(
        ...(await db.pharmacyKhataEvent.findMany({
          where: { organizationId, branchId },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            branchId: true,
            familyAccountId: true,
            kind: true,
            amountMinor: true,
            occurredAt: true,
            dueAt: true,
            settlesChargeId: true,
            note: true,
          },
        }))
      );
    }
  } finally {
    await db.$queryRaw(
      Prisma.sql`SELECT set_config('app.current_branch_id', ${previousBranchId}, true)`
    );
  }
  return { accounts, events };
}

function signedKhata(kind: 'CHARGE' | 'PAYMENT' | 'DISHONOURED_CHEQUE', amountMinor: number) {
  return kind === 'PAYMENT' ? -amountMinor : amountMinor;
}

function grnLinePayableMinor(line: {
  receivedPacks: number;
  bonusPacks: number;
  canonicalUnitsPerPack: number;
  invoicedPricePerPackMinor: number;
  discountBps: number;
  taxBps: number;
  taxCreditable: boolean;
}): number {
  if (line.receivedPacks <= 0) return 0;
  const cost = costPurchaseOrderLine({
    orderedPacks: line.receivedPacks,
    bonusPacks: line.bonusPacks,
    canonicalUnitsPerPack: line.canonicalUnitsPerPack,
    listPricePerPackMinor: line.invoicedPricePerPackMinor,
    discountBps: line.discountBps,
    taxBps: line.taxBps,
    taxCreditable: line.taxCreditable,
  });
  return cost.netMinor - cost.rebateMinor + cost.taxMinor;
}

function registerEntryType(entry: {
  entryKind: string;
  emergency: boolean;
  correctsEntry: { serial: number } | null;
  refEntry: { serial: number } | null;
}): string {
  const base =
    entry.entryKind === 'PURCHASE'
      ? 'Purchase'
      : entry.entryKind === 'CORRECTION'
        ? `Correction of ${entry.correctsEntry?.serial ?? '—'}`
        : entry.emergency
          ? 'Emergency sale'
          : 'Sale';
  return entry.refEntry ? `${base} · repeats ${entry.refEntry.serial}` : base;
}

export async function collectPharmacyDataExport(
  db: ScopedDb,
  organizationId: string,
  range: SalesRange,
  now: Date = new Date()
): Promise<{ dataset: PharmacyExportDataset; organizationName: string }> {
  const parsed = parseSalesRange(range, now);
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { displayName: true, legalName: true },
  });
  if (!organization) throw new PharmacyDataExportError('NOT_FOUND');

  const branches = await db.pharmacyBranch.findMany({
    where: { organizationId },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, name: true, city: true, provinceCode: true, active: true },
  });
  const branchCode = new Map(branches.map((branch) => [branch.id, branch.code]));

  // ── Medicines and packs ────────────────────────────────────────────────
  const medicines = await db.medicine.findMany({
    where: { organizationId },
    orderBy: [{ productName: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productName: true,
      brandName: true,
      manufacturer: true,
      drapRegistrationNumber: true,
      productFamily: true,
      rx: true,
      otc: true,
      restricted: true,
      controlled: true,
      highAlert: true,
      lasa: true,
      coldChain: true,
      saleable: true,
      strengths: {
        where: { organizationId },
        orderBy: [{ ingredient: { name: 'asc' } }, { value: 'asc' }, { unit: 'asc' }],
        select: { value: true, unit: true, ingredient: { select: { name: true } } },
      },
      presentations: {
        where: { organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          presentation: true,
          dosageForm: true,
          route: true,
          packLevels: {
            where: { organizationId },
            select: {
              id: true,
              level: true,
              unitsPerParent: true,
              parentPackLevelId: true,
              effectiveFrom: true,
              effectiveTo: true,
            },
          },
          barcodes: {
            where: { organizationId },
            orderBy: [{ code: 'asc' }, { id: 'asc' }],
            select: { id: true, type: true, code: true, normalizedCode: true, packLevelId: true },
          },
        },
      },
    },
  });
  const medicineRows: ExportRow[] = [];
  const barcodeRows: ExportRow[] = [];
  for (const medicine of medicines) {
    const shared = {
      product: medicine.productName,
      brand_name: medicine.brandName,
      manufacturer: medicine.manufacturer,
      drap_registration_no: medicine.drapRegistrationNumber,
      product_family: medicine.productFamily,
      rx: medicine.rx,
      otc: medicine.otc,
      restricted: medicine.restricted,
      controlled: medicine.controlled,
      high_alert: medicine.highAlert,
      lasa: medicine.lasa,
      cold_chain: medicine.coldChain,
      saleable: medicine.saleable,
      medicine_code: medicine.id,
      strength_components: JSON.stringify(medicine.strengths.map((component) => ({
        ingredient: component.ingredient.name, value: component.value.toString(), unit: component.unit,
      }))),
    };
    if (medicine.presentations.length === 0) {
      medicineRows.push({ code: medicine.id, ...shared });
      continue;
    }
    for (const presentation of medicine.presentations) {
      const barcodeData = (barcode: typeof presentation.barcodes[number]) => ({
        code: barcode.code, type: barcode.type, normalized_code: barcode.normalizedCode,
      });
      for (const barcode of presentation.barcodes) {
        barcodeRows.push({
          code: barcode.id, medicine_code: medicine.id, presentation_code: presentation.id,
          pack_level_code: barcode.packLevelId, barcode_value: barcode.code,
          barcode_type: barcode.type, normalized_code: barcode.normalizedCode,
        });
      }
      const base = {
        ...shared,
        presentation: presentation.presentation,
        dosage_form: presentation.dosageForm,
        route: presentation.route,
        presentation_code: presentation.id,
        presentation_barcodes: JSON.stringify(presentation.barcodes
          .filter((barcode) => barcode.packLevelId === null).map(barcodeData)),
      };
      const conversions = packConversions(presentation.packLevels, now);
      if (conversions.length === 0) {
        medicineRows.push({ code: presentation.id, ...base });
        continue;
      }
      for (const conversion of conversions) {
        medicineRows.push({
          code: conversion.packLevelId,
          ...base,
          pack: conversion.canonicalUnitsPerPack,
          pack_level: conversion.level,
          pack_barcodes: JSON.stringify(presentation.barcodes
            .filter((barcode) => barcode.packLevelId === conversion.packLevelId).map(barcodeData)),
          barcode:
            presentation.barcodes.find((barcode) => barcode.packLevelId === conversion.packLevelId)
              ?.code ?? null,
        });
      }
    }
  }

  // ── Stock lots ─────────────────────────────────────────────────────────
  const lots = await db.pharmacyInventoryLot.findMany({
    where: { organizationId },
    orderBy: [{ branchId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      branchId: true,
      unitsPerPack: true,
      supplierName: true,
      supplierInvoiceRef: true,
      unitCostMinor: true,
      printedMrpMinor: true,
      receivedExpiresAt: true,
      receivedAt: true,
      batch: {
        select: {
          batchNumber: true,
          state: true,
          medicine: { select: { id: true, productName: true } },
        },
      },
      balances: {
        where: { organizationId },
        select: {
          onHandUnits: true,
          sealedPacks: true,
          looseUnits: true,
          disposition: true,
          location: { select: { code: true, name: true } },
        },
      },
    },
  });
  const stockRows: ExportRow[] = [];
  for (const lot of lots) {
    const shared = {
      product: lot.batch.medicine.productName,
      pack: lot.unitsPerPack,
      batch: lot.batch.batchNumber,
      expiry: formatKarachiDate(lot.receivedExpiresAt),
      cost: formatMinor(lot.unitCostMinor),
      mrp: formatMinor(lot.printedMrpMinor),
      supplier: lot.supplierName,
      supplier_invoice: lot.supplierInvoiceRef,
      branch_code: branchCode.get(lot.branchId) ?? lot.branchId,
      batch_state: lot.batch.state,
      received_at: formatInstant(lot.receivedAt),
      lot_code: lot.id,
      medicine_code: lot.batch.medicine.id,
    };
    const held = lot.balances
      .filter((balance) => balance.onHandUnits !== 0)
      .sort(
        (a, b) =>
          a.location.code.localeCompare(b.location.code) ||
          a.disposition.localeCompare(b.disposition)
      );
    if (held.length === 0) {
      stockRows.push({ code: lot.id, ...shared, quantity: 0, sealed_packs: 0, loose_units: 0 });
      continue;
    }
    for (const balance of held) {
      stockRows.push({
        code: `${lot.id}:${balance.location.code}:${balance.disposition}`,
        ...shared,
        quantity: balance.onHandUnits,
        sealed_packs: balance.sealedPacks,
        loose_units: balance.looseUnits,
        location_code: balance.location.code,
        location_name: balance.location.name,
        disposition: balance.disposition,
      });
    }
  }

  // ── Customers and khata ────────────────────────────────────────────────
  const customers = await db.pharmacyCustomer.findMany({
    where: { organizationId },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      displayName: true,
      phoneLast4: true,
      creditLimitMinor: true,
      active: true,
      createdAt: true,
    },
  });
  const customerName = new Map(customers.map((customer) => [customer.id, customer.displayName]));
  const khata = await readKhata(
    db,
    organizationId,
    branches.map((branch) => branch.id)
  );
  const accountById = new Map(khata.accounts.map((account) => [account.id, account]));
  const totals: KhataTotals = new Map();
  for (const account of khata.accounts) {
    const current = totals.get(account.payerCustomerId) ?? { balanceMinor: 0, accounts: 0 };
    current.accounts += 1;
    totals.set(account.payerCustomerId, current);
  }
  for (const event of khata.events) {
    const account = accountById.get(event.familyAccountId);
    if (!account) continue;
    const current = totals.get(account.payerCustomerId) ?? { balanceMinor: 0, accounts: 0 };
    current.balanceMinor += signedKhata(event.kind, event.amountMinor);
    totals.set(account.payerCustomerId, current);
  }
  const customerRows: ExportRow[] = customers.map((customer) => {
    const total = totals.get(customer.id);
    return {
      code: customer.id,
      customer: customer.displayName,
      balance: formatMinor(total?.balanceMinor ?? 0),
      khata_accounts: total?.accounts ?? 0,
      credit_limit: formatMinor(customer.creditLimitMinor),
      phone_last4: customer.phoneLast4,
      active: customer.active,
      created_at: formatInstant(customer.createdAt),
    };
  });
  const khataRows: ExportRow[] = khata.events
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
    .map((event) => {
      const account = accountById.get(event.familyAccountId);
      return {
        code: event.id,
        customer: account ? (customerName.get(account.payerCustomerId) ?? null) : null,
        family_account: account?.displayName ?? null,
        family_account_code: event.familyAccountId,
        branch_code: branchCode.get(event.branchId) ?? event.branchId,
        kind: event.kind,
        amount: formatMinor(event.amountMinor),
        occurred_at: formatInstant(event.occurredAt),
        due_at: formatInstant(event.dueAt),
        settles_charge_code: event.settlesChargeId,
        note: event.note,
      };
    });

  // ── Suppliers, purchase orders and goods receipts ──────────────────────
  const suppliers = await db.pharmacySupplier.findMany({
    where: { organizationId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      legalName: true,
      contactName: true,
      contactPhone: true,
      serviceArea: true,
      paymentTermsDays: true,
      creditLimitMinor: true,
      authorized: true,
      active: true,
      createdAt: true,
    },
  });
  const supplierName = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

  const purchaseOrders = await db.pharmacyPurchaseOrder.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      reference: true,
      status: true,
      branchId: true,
      supplierId: true,
      createdAt: true,
      submittedAt: true,
      approvedAt: true,
      sentAt: true,
      expectedDeliveryAt: true,
      freightMinor: true,
      otherChargesMinor: true,
      note: true,
      lines: {
        where: { organizationId },
        orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          lineNumber: true,
          orderedPacks: true,
          bonusPacks: true,
          canonicalUnitsPerPack: true,
          orderedCanonicalUnits: true,
          bonusCanonicalUnits: true,
          listPricePerPackMinor: true,
          discountBps: true,
          rebateBps: true,
          taxBps: true,
          taxCreditable: true,
          medicine: { select: { productName: true } },
        },
      },
    },
  });
  const poReference = new Map(purchaseOrders.map((order) => [order.id, order.reference]));
  const purchaseOrderRows: ExportRow[] = purchaseOrders.map((order) => ({
    code: order.id,
    reference: order.reference,
    supplier: supplierName.get(order.supplierId) ?? null,
    branch_code: order.branchId ? (branchCode.get(order.branchId) ?? order.branchId) : null,
    status: order.status,
    created_at: formatInstant(order.createdAt),
    submitted_at: formatInstant(order.submittedAt),
    approved_at: formatInstant(order.approvedAt),
    sent_at: formatInstant(order.sentAt),
    expected_delivery_at: formatInstant(order.expectedDeliveryAt),
    freight: formatMinor(order.freightMinor),
    other_charges: formatMinor(order.otherChargesMinor),
    note: order.note,
  }));
  const purchaseOrderLineRows: ExportRow[] = purchaseOrders.flatMap((order) =>
    order.lines.map((line) => ({
      code: line.id,
      po_reference: order.reference,
      line_no: line.lineNumber,
      supplier: supplierName.get(order.supplierId) ?? null,
      product: line.medicine.productName,
      pack: line.canonicalUnitsPerPack,
      ordered_packs: line.orderedPacks,
      bonus_packs: line.bonusPacks,
      quantity: line.orderedCanonicalUnits,
      bonus_quantity: line.bonusCanonicalUnits,
      list_price_per_pack: formatMinor(line.listPricePerPackMinor),
      discount_bps: line.discountBps,
      rebate_bps: line.rebateBps,
      tax_bps: line.taxBps,
      tax_creditable: line.taxCreditable,
    }))
  );

  const receipts = await db.pharmacyGoodsReceipt.findMany({
    where: { organizationId },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      reference: true,
      status: true,
      branchId: true,
      supplierId: true,
      purchaseOrderId: true,
      supplierInvoiceRef: true,
      supplierInvoiceDate: true,
      distributorNtn: true,
      distributorStrn: true,
      receivedAt: true,
      postedAt: true,
      reversedAt: true,
      reversalReason: true,
      directPurchase: true,
      note: true,
      lines: {
        where: { organizationId },
        orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          lineNumber: true,
          batchNumber: true,
          printedExpiry: true,
          printedMrpMinor: true,
          canonicalUnitsPerPack: true,
          receivedPacks: true,
          bonusPacks: true,
          receivedCanonicalUnits: true,
          bonusCanonicalUnits: true,
          acceptedCanonicalUnits: true,
          rejectedCanonicalUnits: true,
          rejectionReason: true,
          invoicedPricePerPackMinor: true,
          discountBps: true,
          taxBps: true,
          taxCreditable: true,
          unitCostMinor: true,
          inventoryLotId: true,
          gtin: true,
          serialNumber: true,
          medicine: { select: { productName: true } },
        },
      },
    },
  });
  const receiptSupplier = new Map<string, string>();
  const purchasedBySupplier = new Map<string, number>();
  const goodsReceiptRows: ExportRow[] = [];
  const goodsReceiptLineRows: ExportRow[] = [];
  for (const receipt of receipts) {
    receiptSupplier.set(receipt.id, receipt.supplierId);
    const payableMinor = receipt.lines.reduce((sum, line) => sum + grnLinePayableMinor(line), 0);
    if (receipt.status === 'POSTED' && !receipt.reversedAt) {
      purchasedBySupplier.set(
        receipt.supplierId,
        (purchasedBySupplier.get(receipt.supplierId) ?? 0) + payableMinor
      );
    }
    const supplier = supplierName.get(receipt.supplierId) ?? null;
    goodsReceiptRows.push({
      code: receipt.id,
      reference: receipt.reference,
      supplier,
      branch_code: branchCode.get(receipt.branchId) ?? receipt.branchId,
      status: receipt.status,
      po_reference: receipt.purchaseOrderId
        ? (poReference.get(receipt.purchaseOrderId) ?? null)
        : null,
      supplier_invoice: receipt.supplierInvoiceRef,
      supplier_invoice_date: formatKarachiDate(receipt.supplierInvoiceDate),
      received_at: formatInstant(receipt.receivedAt),
      posted_at: formatInstant(receipt.postedAt),
      reversed_at: formatInstant(receipt.reversedAt),
      reversal_reason: receipt.reversalReason,
      direct_purchase: receipt.directPurchase,
      payable: formatMinor(payableMinor),
      distributor_ntn: receipt.distributorNtn,
      distributor_strn: receipt.distributorStrn,
      note: receipt.note,
    });
    for (const line of receipt.lines) {
      goodsReceiptLineRows.push({
        code: line.id,
        grn_reference: receipt.reference,
        line_no: line.lineNumber,
        supplier,
        product: line.medicine.productName,
        pack: line.canonicalUnitsPerPack,
        batch: line.batchNumber,
        expiry: formatKarachiDate(line.printedExpiry),
        mrp: formatMinor(line.printedMrpMinor),
        cost: formatMinor(line.unitCostMinor),
        quantity: line.acceptedCanonicalUnits,
        received_quantity: line.receivedCanonicalUnits,
        bonus_quantity: line.bonusCanonicalUnits,
        rejected_quantity: line.rejectedCanonicalUnits,
        rejection_reason: line.rejectionReason,
        received_packs: line.receivedPacks,
        bonus_packs: line.bonusPacks,
        invoiced_price_per_pack: formatMinor(line.invoicedPricePerPackMinor),
        discount_bps: line.discountBps,
        tax_bps: line.taxBps,
        barcode: line.gtin,
        serial_number: line.serialNumber,
        lot_code: line.inventoryLotId,
      });
    }
  }
  const payments = await db.pharmacyBookkeepingAllocation.findMany({
    where: {
      organizationId,
      sourceKind: 'PURCHASE_INVOICE',
      transaction: {
        organizationId,
        kind: { in: ['SUPPLIER_PAYMENT', 'CHEQUE', 'VOUCHER'] },
        status: 'POSTED',
      },
    },
    select: { sourceId: true, amountMinor: true },
  });
  const paidBySupplier = new Map<string, number>();
  for (const payment of payments) {
    const supplierId = receiptSupplier.get(payment.sourceId);
    if (!supplierId) continue;
    paidBySupplier.set(supplierId, (paidBySupplier.get(supplierId) ?? 0) + payment.amountMinor);
  }
  const supplierRows: ExportRow[] = suppliers.map((supplier) => {
    const purchased = purchasedBySupplier.get(supplier.id) ?? 0;
    const paid = paidBySupplier.get(supplier.id) ?? 0;
    return {
      code: supplier.id,
      supplier: supplier.name,
      balance: formatMinor(purchased - paid),
      purchased_total: formatMinor(purchased),
      paid_total: formatMinor(paid),
      legal_name: supplier.legalName,
      contact_name: supplier.contactName,
      contact_phone: supplier.contactPhone,
      service_area: supplier.serviceArea,
      payment_terms_days: supplier.paymentTermsDays,
      credit_limit: formatMinor(supplier.creditLimitMinor),
      authorized: supplier.authorized,
      active: supplier.active,
      created_at: formatInstant(supplier.createdAt),
    };
  });

  // ── Sales in the requested range ───────────────────────────────────────
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId,
      OR: [
        { businessDate: { gte: parsed.from, lte: parsed.to } },
        { businessDate: null, createdAt: { gte: parsed.startsAt, lt: parsed.endsBefore } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      branchId: true,
      status: true,
      createdAt: true,
      completedAt: true,
      businessDate: true,
      receiptNumber: true,
      customerId: true,
      lines: {
        where: { organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          saleUnit: true,
          quantity: true,
          canonicalUnitsPerSaleUnit: true,
          canonicalUnits: true,
          unitPriceMinor: true,
          unitCostMinor: true,
          discountKind: true,
          discountMinor: true,
          medicineId: true,
          packLevelId: true,
          medicine: { select: { productName: true } },
        },
      },
    },
  });
  const saleRows: ExportRow[] = [];
  const saleLineRows: ExportRow[] = [];
  for (const sale of sales) {
    const saleDate = sale.businessDate
      ? formatCalendarDate(sale.businessDate)
      : formatKarachiDate(sale.createdAt);
    const branch = branchCode.get(sale.branchId) ?? sale.branchId;
    let gross = 0;
    let discount = 0;
    for (const line of sale.lines) {
      const lineGross = line.quantity * line.unitPriceMinor;
      gross += lineGross;
      discount += line.discountMinor;
      saleLineRows.push({
        code: line.id,
        sale_code: sale.id,
        sale_date: saleDate,
        branch_code: branch,
        product: line.medicine.productName,
        pack: line.canonicalUnitsPerSaleUnit,
        sale_unit: line.saleUnit,
        sale_quantity: line.quantity,
        quantity: line.canonicalUnits,
        unit_price: formatMinor(line.unitPriceMinor),
        cost: formatMinor(line.unitCostMinor),
        gross: formatMinor(lineGross),
        discount: formatMinor(line.discountMinor),
        net: formatMinor(lineGross - line.discountMinor),
        discount_kind: line.discountKind,
        medicine_code: line.medicineId,
        pack_level_code: line.packLevelId,
      });
    }
    saleRows.push({
      code: sale.id,
      sale_date: saleDate,
      created_at: formatInstant(sale.createdAt),
      completed_at: formatInstant(sale.completedAt),
      receipt_no: sale.receiptNumber,
      branch_code: branch,
      status: sale.status,
      customer: sale.customerId ? (customerName.get(sale.customerId) ?? null) : null,
      customer_code: sale.customerId,
      line_count: sale.lines.length,
      gross: formatMinor(gross),
      discount: formatMinor(discount),
      net: formatMinor(gross - discount),
    });
  }

  // ── Controlled register — the printed register's rows and order ────────
  const entries = await db.pharmacyControlledRegisterEntry.findMany({
    where: { organizationId },
    orderBy: [{ branchId: 'asc' }, { serial: 'asc' }],
    include: {
      patient: { select: { displayName: true, cnic: true } },
      prescriber: { select: { name: true, registrationNumber: true } },
      prescription: { select: { sourceFileRef: true } },
      medicine: { select: { productName: true, manufacturer: true } },
      line: { select: { medicine: { select: { productName: true } } } },
      correctsEntry: { select: { serial: true } },
      refEntry: { select: { serial: true } },
    },
  });
  const witnessIds = [...new Set(entries.map((entry) => entry.witnessedByUserId))];
  const [witnesses, staff] = witnessIds.length
    ? await Promise.all([
        db.user.findMany({
          where: { organizationId, id: { in: witnessIds } },
          select: { id: true, name: true },
        }),
        db.restaurantStaffProfile.findMany({
          where: { organizationId, userId: { in: witnessIds } },
          select: { userId: true, displayName: true },
        }),
      ])
    : [[], []];
  const userNames = new Map(witnesses.map((user) => [user.id, user.name]));
  const staffNames = new Map<string, string[]>();
  for (const profile of staff) {
    if (!profile.userId) continue;
    const names = staffNames.get(profile.userId) ?? [];
    names.push(profile.displayName);
    staffNames.set(profile.userId, names);
  }
  const registerRows: ExportRow[] = entries
    .map((entry) => ({
      branch: branchCode.get(entry.branchId) ?? entry.branchId,
      entry,
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.entry.serial - b.entry.serial)
    .map(({ branch, entry }) => ({
      code: entry.id,
      branch_code: branch,
      serial_no: entry.serial,
      recorded_at: formatInstant(entry.createdAt),
      entry_type: registerEntryType(entry),
      prescriber: entry.prescriber?.name ?? entry.prescriberName ?? null,
      prescriber_reg_no: entry.prescriber?.registrationNumber ?? entry.prescriberRegNo ?? null,
      patient: entry.patient?.displayName ?? entry.counterpartyName ?? null,
      patient_cnic: maskCnic(entry.patient?.cnic ?? null),
      patient_address: entry.patientAddress,
      product: entry.medicine?.productName ?? entry.line?.medicine.productName ?? null,
      manufacturer: entry.manufacturer ?? entry.medicine?.manufacturer ?? null,
      quantity: entry.quantityCanonicalUnits,
      balance_delta: entry.balanceDelta,
      batch: entry.batchNumber,
      qualified_person: chooseRegisterPersonName(
        [...(staffNames.get(entry.witnessedByUserId) ?? []), userNames.get(entry.witnessedByUserId)],
        entry.witnessedByUserId
      ),
      pin_witnessed: Boolean(entry.signatureRef),
      running_balance: entry.runningBalance,
      rx_reference: entry.prescription?.sourceFileRef ?? null,
      rx_serial_written: entry.rxSerialWritten,
      correction_reason: entry.correctionReason,
      lot_code: entry.inventoryLotId,
    }));

  const branchRows: ExportRow[] = branches.map((branch) => ({
    code: branch.id,
    branch_code: branch.code,
    name: branch.name,
    city: branch.city,
    province: branch.provinceCode,
    active: branch.active,
  }));

  return {
    organizationName: organization.displayName || organization.legalName,
    dataset: {
      branches: branchRows,
      medicines: medicineRows,
      medicineBarcodes: barcodeRows,
      stockLots: stockRows,
      customers: customerRows,
      khataLedger: khataRows,
      suppliers: supplierRows,
      sales: saleRows,
      saleLines: saleLineRows,
      purchaseOrders: purchaseOrderRows,
      purchaseOrderLines: purchaseOrderLineRows,
      goodsReceipts: goodsReceiptRows,
      goodsReceiptLines: goodsReceiptLineRows,
      controlledRegister: registerRows,
    },
  };
}

/** Build the archive bytes for a collected dataset. */
export function buildPharmacyDataExportArchive(input: {
  dataset: PharmacyExportDataset;
  organizationName: string;
  generatedAt: Date;
  range: SalesRange;
}) {
  const files = buildPharmacyExportFiles(input.dataset, {
    organizationName: input.organizationName,
    generatedAt: input.generatedAt,
    salesFrom: input.range.from,
    salesTo: input.range.to,
  });
  const zip = buildZip(files, input.generatedAt);
  return {
    zip,
    sha256: createHash('sha256').update(zip).digest('hex'),
    rowCounts: pharmacyExportRowCounts(input.dataset),
  };
}

// ---------------------------------------------------------------------------
// Platform worker
// ---------------------------------------------------------------------------

const FAILURE_MESSAGE = 'The export could not be built. Request a new one.';

/**
 * The pharmacy.data.export.v1 handler. Runs inside the platform transaction,
 * narrows it to the requesting organization before reading anything, and
 * records the outcome on the request row and in the tenant audit log.
 */
export async function runPharmacyDataExportJob(
  db: ScopedDb,
  job: Pick<PlatformJob, 'id' | 'organizationId' | 'attempts' | 'maxAttempts'>,
  payload: Record<string, unknown>,
  options: { now?: Date } = {}
) {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('pharmacy.data.export.v1 requires an organization.');
  const exportId = payload.exportId;
  if (typeof exportId !== 'string' || !exportId) {
    throw new Error('Job payload requires "exportId".');
  }
  return withOrganizationDefaults(db, organizationId, async (tx) => {
    // Cleanup takes the same row lock, so it cannot delete an in-flight upload.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "pharmacy_data_exports"
      WHERE "id" = ${exportId} AND "organizationId" = ${organizationId}
      FOR UPDATE
    `);
    const request = await tx.pharmacyDataExport.findFirst({
      where: { id: exportId, organizationId },
      select: { id: true, status: true, salesFrom: true, salesTo: true, requestedByUserId: true, requestedAt: true },
    });
    if (!request) return { exportId, skipped: 'missing' };
    if (request.status !== 'QUEUED') return { exportId, skipped: request.status };
    const now = options.now ?? new Date();
    // Never recreate an orphan after its retention cleanup becomes due.
    if (now.getTime() - request.requestedAt.getTime() > PHARMACY_DATA_EXPORT_STALE_MS) {
      return { exportId, skipped: 'stale' };
    }
    const range = {
      from: formatCalendarDate(request.salesFrom)!,
      to: formatCalendarDate(request.salesTo)!,
    };
    try {
      const collected = await collectPharmacyDataExport(tx, organizationId, range, now);
      const archive = buildPharmacyDataExportArchive({ ...collected, generatedAt: now, range });
      const storageKey = `${request.id}.zip`;
      const fileName = `devfathom-pharmacy-export-${formatKarachiDate(now)}-${request.id}.zip`;
      await putUpload(exportNamespace(organizationId), storageKey, archive.zip, 'application/zip');
      const expiresAt = new Date(now.getTime() + PHARMACY_DATA_EXPORT_LINK_TTL_MS);
      await tx.pharmacyDataExport.update({
        where: { id: request.id },
        data: {
          status: 'READY',
          storageKey,
          fileName,
          sizeBytes: archive.zip.length,
          sha256: archive.sha256,
          rowCounts: archive.rowCounts,
          error: null,
          completedAt: now,
          expiresAt,
        },
      });
      await recordAudit(
        {
          organizationId,
          actorType: 'SYSTEM',
          source: 'SYSTEM',
          category: 'pharmacy',
          operation: 'EXECUTE',
          action: 'pharmacy.dataExport.generated',
          description: 'Owner data export archive generated.',
          targetType: 'PharmacyDataExport',
          targetId: request.id,
          metadata: {
            requestedByUserId: request.requestedByUserId,
            salesFrom: range.from,
            salesTo: range.to,
            sizeBytes: archive.zip.length,
            sha256: archive.sha256,
            rowCounts: archive.rowCounts,
            expiresAt: expiresAt.toISOString(),
            jobId: job.id,
          },
        },
        tx
      );
      return { exportId: request.id, sizeBytes: archive.zip.length, rowCounts: archive.rowCounts };
    } catch (error) {
      // Retry while attempts remain; on the last one, tell the owner instead of
      // leaving the request pending forever.
      if (job.attempts < job.maxAttempts) throw error;
      await tx.pharmacyDataExport.update({
        where: { id: request.id },
        data: { status: 'FAILED', error: FAILURE_MESSAGE, completedAt: now },
      });
      await recordAudit(
        {
          organizationId,
          actorType: 'SYSTEM',
          source: 'SYSTEM',
          category: 'pharmacy',
          operation: 'EXECUTE',
          action: 'pharmacy.dataExport.generated',
          description: 'Owner data export archive failed.',
          targetType: 'PharmacyDataExport',
          targetId: request.id,
          outcome: 'FAILURE',
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
          metadata: { jobId: job.id },
        },
        tx
      );
      return { exportId: request.id, failed: true };
    }
  });
}

/**
 * Relay QUEUED requests that have no job yet into keyed platform jobs. Safe to
 * repeat on every worker pass: the idempotency key is the request id.
 */
export async function relayPharmacyDataExportJobs(db: ScopedDb): Promise<number> {
  const pending = await db.$queryRaw<Array<{ id: string; organizationId: string }>>(Prisma.sql`
    SELECT e."id", e."organizationId"
    FROM "pharmacy_data_exports" e
    WHERE e."status" = 'QUEUED'
      AND NOT EXISTS (
        SELECT 1 FROM "platform_jobs" pj
        WHERE pj."idempotencyKey" = ${`${PHARMACY_DATA_EXPORT_JOB}:`} || e."id"
      )
    ORDER BY e."requestedAt" ASC, e."id" ASC
    LIMIT ${RELAY_LIMIT}
  `);
  if (pending.length === 0) return 0;
  const created = await db.platformJob.createMany({
    data: pending.map((request) => ({
      organizationId: request.organizationId,
      type: 'PHARMACY_DATA_EXPORT_V1' as const,
      payload: { exportId: request.id },
      idempotencyKey: `${PHARMACY_DATA_EXPORT_JOB}:${request.id}`,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Remove lapsed READY archives and failed/stale attempts. Every upload uses
 * the durable request id as its key, including when READY metadata rolls back.
 * Lock against the builder, and retry storage or commit failures next pass.
 */
export async function expirePharmacyDataExports(db: ScopedDb, now: Date): Promise<number> {
  const expired = await db.$queryRaw<
    Array<{ id: string; organizationId: string; storageKey: string }>
  >(Prisma.sql`
    SELECT x."id", x."organizationId", COALESCE(x."storageKey", x."id" || '.zip') AS "storageKey"
    FROM "pharmacy_data_exports" x
    WHERE (x."status" = 'READY' AND x."expiresAt" <= ${now})
       OR x."status" = 'FAILED'
       OR (x."status" = 'QUEUED' AND x."requestedAt" < ${new Date(now.getTime() - PHARMACY_DATA_EXPORT_STALE_MS)})
    ORDER BY COALESCE(x."expiresAt", x."requestedAt") ASC, x."id" ASC
    LIMIT ${EXPIRY_LIMIT}
    FOR UPDATE SKIP LOCKED
  `);
  let count = 0;
  for (const row of expired) {
    try {
      if (row.storageKey) await deleteUpload(exportNamespace(row.organizationId), row.storageKey);
    } catch {
      continue;
    }
    await db.pharmacyDataExport.updateMany({
      where: { id: row.id, organizationId: row.organizationId, status: { in: ['READY', 'FAILED', 'QUEUED'] } },
      data: { status: 'EXPIRED', storageKey: null },
    });
    count += 1;
  }
  return count;
}
