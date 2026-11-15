import 'server-only';

import type { PlatformJob } from '@/generated/prisma/client';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { deleteUpload, getUpload, putUpload } from '@/lib/storage';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  buildOwnerDataExportZip,
  exportRowCounts,
  formatDateOnly,
  formatMinor,
  type ExportRow,
  type OwnerDataExportRows,
  type OwnerDataExportView,
} from './owner-data-export-format';
import { chooseRegisterPersonName } from './register-print';

/**
 * DEV-93 — owner full data export. The owner asks for it, the platform worker
 * builds the ZIP in the background (`processPlatformJobs`), and the owner then
 * downloads it from the same page for 24 hours. Requesting and downloading are
 * both owner-only and both audit-logged by the route.
 */
export const OWNER_DATA_EXPORT_JOB_TYPE = 'PHARMACY_OWNER_DATA_EXPORT_V1' as const;
export const OWNER_DATA_EXPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type SalesRange = { from: string | null; to: string | null };

/** A YYYY-MM-DD pair, either side optional. Returns null when malformed. */
export function parseSalesRange(input: { from?: unknown; to?: unknown }): SalesRange | null {
  const side = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !DATE_ONLY.test(value)) return undefined;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
      ? undefined
      : value;
  };
  const from = side(input.from);
  const to = side(input.to);
  if (from === undefined || to === undefined) return null;
  if (from && to && from > to) return null;
  return { from, to };
}

function rangeBounds(range: SalesRange) {
  return {
    from: range.from ? new Date(`${range.from}T00:00:00.000Z`) : null,
    // Inclusive end date: everything before the next day starts.
    toExclusive: range.to
      ? new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + 86_400_000)
      : null,
  };
}

/** The live owner identity: the system Owner role, or an ADMIN with a `*` grant. */
export async function isLiveOrganizationOwner(
  db: ScopedDb,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: {
      role: true,
      status: true,
      organizationRole: { select: { key: true, isSystem: true, permissions: true } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  return hasAllCapabilityAccess({
    ...user,
    organizationRole: user.organizationRole
      ? {
          ...user.organizationRole,
          permissions: Array.isArray(user.organizationRole.permissions)
            ? (user.organizationRole.permissions as { capability: string; effect: string }[])
            : [],
        }
      : null,
  });
}

export function ownerDataExportFilename(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error('Invalid export job id.');
  return `owner-data-export-${jobId}.zip`;
}

export function readOwnerDataExport(organizationId: string, jobId: string): Promise<Buffer> {
  return getUpload(organizationId, ownerDataExportFilename(jobId));
}

export const OWNER_DATA_EXPORT_JOB_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  finishedAt: true,
  result: true,
} as const;

type ExportJob = {
  id: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  result: unknown;
};

/** What the owner sees of an export job. The link lasts 24 hours from completion. */
export function ownerDataExportView(job: ExportJob, now: number): OwnerDataExportView {
  const result = (job.result && typeof job.result === 'object' ? job.result : {}) as Record<
    string,
    unknown
  >;
  const expiresAt =
    job.status === 'SUCCEEDED' && job.finishedAt
      ? new Date(job.finishedAt.getTime() + OWNER_DATA_EXPORT_LINK_TTL_MS)
      : null;
  return {
    id: job.id,
    status: job.status,
    requestedAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    downloadable: expiresAt !== null && expiresAt.getTime() > now,
    rowCounts:
      result.rowCounts && typeof result.rowCounts === 'object'
        ? (result.rowCounts as Record<string, number>)
        : null,
  };
}

/** The workspace's ten most recent exports. platform_jobs is control-plane only. */
export async function listOwnerDataExports(
  organizationId: string,
  now: number = Date.now()
): Promise<OwnerDataExportView[]> {
  const jobs = await withPlatformDb((db) =>
    db.platformJob.findMany({
      where: { organizationId, type: OWNER_DATA_EXPORT_JOB_TYPE },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: OWNER_DATA_EXPORT_JOB_SELECT,
    })
  );
  return jobs.map((job) => ownerDataExportView(job, now));
}

const PURGE_BATCH = 50;

/**
 * Delete archives whose 24-hour link has lapsed. Runs from the platform worker
 * on every pass. Clearing `result.filename` marks a job purged, so it is never
 * selected again; the row counts and timestamps stay as the export's record.
 * `deleteUpload` is idempotent, so a pass interrupted between the delete and the
 * update simply repeats the delete next time.
 */
export async function purgeExpiredOwnerDataExports(
  db: ScopedDb,
  now: Date = new Date()
): Promise<number> {
  const expired = await db.platformJob.findMany({
    where: {
      type: OWNER_DATA_EXPORT_JOB_TYPE,
      status: 'SUCCEEDED',
      finishedAt: { lt: new Date(now.getTime() - OWNER_DATA_EXPORT_LINK_TTL_MS) },
      result: { path: ['filename'], string_starts_with: 'owner-data-export-' },
    },
    orderBy: { finishedAt: 'asc' },
    take: PURGE_BATCH,
    select: { id: true, organizationId: true, result: true },
  });
  let purged = 0;
  for (const job of expired) {
    if (!job.organizationId) continue;
    await deleteUpload(job.organizationId, ownerDataExportFilename(job.id));
    const result = (job.result && typeof job.result === 'object' ? job.result : {}) as Record<
      string,
      unknown
    >;
    await db.platformJob.update({
      where: { id: job.id },
      data: { result: { ...result, filename: null, purgedAt: now.toISOString() } },
    });
    purged += 1;
  }
  return purged;
}

/** `10 units`: a counted label the migration importer's `readPackFactor` reads. */
const unitsLabel = (units: number | null | undefined) =>
  units && units > 0 ? `${units} units` : null;

type PackNode = {
  id: string;
  parentPackLevelId: string | null;
  unitsPerParent: number;
  effectiveTo: Date | null;
};

/**
 * Base units in one pack at each level, by the same rule as the counter's pack
 * setup: a lone top level counts its own `unitsPerParent`; otherwise a leaf is
 * one base unit and each level holds its current child's `unitsPerParent` of it.
 * A level whose chain cannot be resolved is left blank, never guessed.
 */
export function basePackUnits(levels: readonly PackNode[]): Map<string, number | null> {
  const children = new Map<string, PackNode[]>();
  for (const level of levels) {
    if (!level.parentPackLevelId) continue;
    children.set(level.parentPackLevelId, [
      ...(children.get(level.parentPackLevelId) ?? []),
      level,
    ]);
  }
  const memo = new Map<string, number | null>();
  const units = (level: PackNode, depth: number): number | null => {
    if (memo.has(level.id)) return memo.get(level.id)!;
    if (depth > 16) return null;
    const current = (children.get(level.id) ?? []).filter((child) => child.effectiveTo === null);
    let result: number | null;
    if (current.length === 0) result = level.parentPackLevelId ? 1 : level.unitsPerParent;
    else if (current.length > 1) result = null;
    else {
      const child = units(current[0]!, depth + 1);
      result = child === null ? null : current[0]!.unitsPerParent * child;
    }
    if (result !== null && (!Number.isSafeInteger(result) || result <= 0)) result = null;
    memo.set(level.id, result);
    return result;
  };
  return new Map(levels.map((level) => [level.id, units(level, 0)]));
}

const sumBy = <T>(items: readonly T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0);

/** Read every exported table for one organization. Every query names the tenant. */
export async function loadOwnerDataExportRows(
  db: ScopedDb,
  organizationId: string,
  range: SalesRange
): Promise<OwnerDataExportRows> {
  const where = { organizationId };
  const bounds = rangeBounds(range);
  const [
    branches,
    locations,
    packLevels,
    barcodes,
    lots,
    customers,
    familyAccounts,
    khataEvents,
    suppliers,
    supplierCredits,
    sales,
    purchaseOrders,
    goodsReceipts,
    registerEntries,
  ] = await Promise.all([
    db.pharmacyBranch.findMany({ where, select: { id: true, code: true } }),
    db.pharmacyStockLocation.findMany({ where, select: { id: true, code: true } }),
    db.packLevel.findMany({
      where,
      orderBy: { id: 'asc' },
      include: { presentation: { include: { medicine: true } } },
    }),
    db.medicineBarcode.findMany({
      where,
      orderBy: { code: 'asc' },
      select: { presentationId: true, packLevelId: true, code: true },
    }),
    db.pharmacyInventoryLot.findMany({
      where,
      orderBy: { id: 'asc' },
      include: {
        batch: { include: { medicine: { select: { productName: true } } } },
        packLevel: { select: { level: true } },
        balances: { orderBy: [{ stockLocationId: 'asc' }, { disposition: 'asc' }] },
      },
    }),
    db.pharmacyCustomer.findMany({ where, orderBy: { id: 'asc' } }),
    db.pharmacyFamilyAccount.findMany({ where, orderBy: { id: 'asc' } }),
    db.pharmacyKhataEvent.findMany({ where, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] }),
    db.pharmacySupplier.findMany({ where, orderBy: { id: 'asc' } }),
    db.pharmacySupplierCredit.findMany({ where, select: { supplierId: true, amountMinor: true } }),
    db.pharmacySale.findMany({
      where: {
        ...where,
        status: { in: ['COMPLETED', 'VOID'] },
        completedAt: {
          not: null,
          ...(bounds.from ? { gte: bounds.from } : {}),
          ...(bounds.toExclusive ? { lt: bounds.toExclusive } : {}),
        },
      },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      include: {
        lines: {
          orderBy: { id: 'asc' },
          include: { medicine: { select: { productName: true } } },
        },
      },
    }),
    db.pharmacyPurchaseOrder.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.pharmacyGoodsReceipt.findMany({
      where,
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      include: {
        lines: {
          orderBy: { lineNumber: 'asc' },
          include: { medicine: { select: { productName: true } } },
        },
      },
    }),
    db.pharmacyControlledRegisterEntry.findMany({
      where,
      orderBy: [{ branchId: 'asc' }, { serial: 'asc' }],
      include: {
        patient: { select: { displayName: true } },
        prescriber: { select: { name: true, registrationNumber: true } },
        medicine: { select: { productName: true, manufacturer: true } },
        line: { select: { medicine: { select: { productName: true, manufacturer: true } } } },
        correctsEntry: { select: { serial: true } },
      },
    }),
  ]);

  const branchCode = new Map(branches.map((branch) => [branch.id, branch.code]));
  const locationCode = new Map(locations.map((location) => [location.id, location.code]));
  const packLabel = new Map(
    packLevels.map((pack) => [pack.id, `${pack.level} · ${pack.presentation.presentation}`])
  );
  const packBaseUnits = basePackUnits(packLevels);

  const barcodesByPack = new Map<string, string[]>();
  const barcodesByPresentationOnly = new Map<string, string[]>();
  for (const barcode of barcodes) {
    const [map, key] = barcode.packLevelId
      ? [barcodesByPack, barcode.packLevelId]
      : [barcodesByPresentationOnly, barcode.presentationId];
    map.set(key, [...(map.get(key) ?? []), barcode.code]);
  }

  const medicines: ExportRow[] = packLevels.map((pack) => {
    const medicine = pack.presentation.medicine;
    return {
      code: pack.id,
      product: medicine.productName,
      pack: unitsLabel(packBaseUnits.get(pack.id)),
      pack_level: packLabel.get(pack.id),
      barcode: [
        ...(barcodesByPack.get(pack.id) ?? []),
        ...(pack.parentPackLevelId
          ? []
          : (barcodesByPresentationOnly.get(pack.presentationId) ?? [])),
      ].join(' '),
      medicine_id: medicine.id,
      brand: medicine.brandName,
      manufacturer: medicine.manufacturer,
      drap_registration: medicine.drapRegistrationNumber,
      units_per_parent: pack.unitsPerParent,
      product_family: medicine.productFamily,
      rx: medicine.rx,
      otc: medicine.otc,
      controlled: medicine.controlled,
      saleable: medicine.saleable,
    };
  });

  const stockLots: ExportRow[] = lots.flatMap((lot) =>
    lot.balances.map((balance) => ({
      code: lot.id,
      product: lot.batch.medicine.productName,
      pack: unitsLabel(lot.unitsPerPack),
      pack_level: packLabel.get(lot.packLevelId) ?? lot.packLevel.level,
      batch: lot.batch.batchNumber,
      expiry: formatDateOnly(lot.batch.expiresAt),
      mrp: formatMinor(lot.printedMrpMinor),
      cost: formatMinor(lot.unitCostMinor),
      quantity: balance.onHandUnits,
      supplier: lot.supplierName,
      branch: branchCode.get(lot.branchId) ?? lot.branchId,
      location: locationCode.get(balance.stockLocationId) ?? balance.stockLocationId,
      disposition: balance.disposition,
      supplier_invoice: lot.supplierInvoiceRef,
    }))
  );

  const accountBalance = new Map<string, number>();
  for (const event of khataEvents) {
    const signed = event.kind === 'PAYMENT' ? -event.amountMinor : event.amountMinor;
    accountBalance.set(
      event.familyAccountId,
      (accountBalance.get(event.familyAccountId) ?? 0) + signed
    );
  }
  const customerBalance = new Map<string, number>();
  for (const account of familyAccounts) {
    customerBalance.set(
      account.payerCustomerId,
      (customerBalance.get(account.payerCustomerId) ?? 0) + (accountBalance.get(account.id) ?? 0)
    );
  }
  const accountById = new Map(familyAccounts.map((account) => [account.id, account]));

  const customerRows: ExportRow[] = customers.map((customer) => ({
    code: customer.id,
    customer: customer.displayName,
    balance: formatMinor(customerBalance.get(customer.id) ?? 0),
    credit_limit: formatMinor(customer.creditLimitMinor),
    phone_last4: customer.phoneLast4,
    active: customer.active,
    created_at: customer.createdAt,
  }));

  const khataLedger: ExportRow[] = khataEvents.map((event) => {
    const account = accountById.get(event.familyAccountId);
    return {
      account_id: event.familyAccountId,
      account_name: account?.displayName,
      payer_customer_id: account?.payerCustomerId,
      branch: branchCode.get(event.branchId) ?? event.branchId,
      kind: event.kind,
      amount: formatMinor(event.amountMinor),
      occurred_at: event.occurredAt,
      due_at: event.dueAt,
      note: event.note,
    };
  });

  const receivedValue = new Map<string, number>();
  for (const receipt of goodsReceipts) {
    if (!receipt.postedAt || receipt.reversedAt) continue;
    receivedValue.set(
      receipt.supplierId,
      (receivedValue.get(receipt.supplierId) ?? 0) +
        sumBy(receipt.lines, (line) => line.acceptedCanonicalUnits * line.unitCostMinor)
    );
  }
  const creditValue = new Map<string, number>();
  for (const credit of supplierCredits) {
    creditValue.set(
      credit.supplierId,
      (creditValue.get(credit.supplierId) ?? 0) + credit.amountMinor
    );
  }

  const supplierRows: ExportRow[] = suppliers.map((supplier) => ({
    code: supplier.id,
    supplier: supplier.name,
    goods_received_value: formatMinor(receivedValue.get(supplier.id) ?? 0),
    supplier_credits: formatMinor(creditValue.get(supplier.id) ?? 0),
    legal_name: supplier.legalName,
    contact_name: supplier.contactName,
    contact_phone: supplier.contactPhone,
    payment_terms_days: supplier.paymentTermsDays,
    credit_limit: formatMinor(supplier.creditLimitMinor),
    authorized: supplier.authorized,
    active: supplier.active,
  }));

  const saleRows: ExportRow[] = sales.map((sale) => {
    const gross = sumBy(sale.lines, (line) => line.grossMinor);
    const discount = sumBy(sale.lines, (line) => line.discountMinor);
    return {
      sale_id: sale.id,
      branch: branchCode.get(sale.branchId) ?? sale.branchId,
      receipt_number: sale.receiptNumber,
      business_date: formatDateOnly(sale.businessDate),
      completed_at: sale.completedAt,
      status: sale.status,
      customer_id: sale.customerId,
      original_sale_id: sale.originalSaleId,
      gross: formatMinor(gross),
      discount: formatMinor(discount),
      net: formatMinor(gross - discount),
    };
  });
  const saleLines: ExportRow[] = sales.flatMap((sale) =>
    sale.lines.map((line) => ({
      sale_id: sale.id,
      line_id: line.id,
      medicine_id: line.medicineId,
      medicine_name: line.medicine.productName,
      pack_level_id: line.packLevelId,
      sale_unit: line.saleUnit,
      sold_quantity: line.quantity,
      base_units: line.canonicalUnits,
      unit_price: formatMinor(line.unitPriceMinor),
      gross: formatMinor(line.grossMinor),
      discount: formatMinor(line.discountMinor),
      net: formatMinor(line.grossMinor - line.discountMinor),
      unit_cost: formatMinor(line.unitCostMinor),
    }))
  );

  const purchaseOrderRows: ExportRow[] = purchaseOrders.map((order) => ({
    purchase_order_id: order.id,
    reference: order.reference,
    supplier_id: order.supplierId,
    branch: order.branchId ? (branchCode.get(order.branchId) ?? order.branchId) : null,
    status: order.status,
    created_at: order.createdAt,
    approved_at: order.approvedAt,
    sent_at: order.sentAt,
    expected_delivery_at: order.expectedDeliveryAt,
  }));

  const goodsReceiptRows: ExportRow[] = goodsReceipts.map((receipt) => ({
    goods_receipt_id: receipt.id,
    reference: receipt.reference,
    branch: branchCode.get(receipt.branchId) ?? receipt.branchId,
    supplier_id: receipt.supplierId,
    purchase_order_id: receipt.purchaseOrderId,
    supplier_invoice: receipt.supplierInvoiceRef,
    supplier_invoice_date: formatDateOnly(receipt.supplierInvoiceDate),
    status: receipt.status,
    received_at: receipt.receivedAt,
    posted_at: receipt.postedAt,
    reversed_at: receipt.reversedAt,
    freight: formatMinor(receipt.freightMinor),
  }));
  const goodsReceiptLines: ExportRow[] = goodsReceipts.flatMap((receipt) =>
    receipt.lines.map((line) => ({
      goods_receipt_id: receipt.id,
      line_number: line.lineNumber,
      medicine_id: line.medicineId,
      medicine_name: line.medicine.productName,
      pack_level_id: line.packLevelId,
      received_batch: line.batchNumber,
      printed_expiry: formatDateOnly(line.printedExpiry),
      printed_mrp: formatMinor(line.printedMrpMinor),
      received_packs: line.receivedPacks,
      bonus_packs: line.bonusPacks,
      accepted_units: line.acceptedCanonicalUnits,
      rejected_units: line.rejectedCanonicalUnits,
      price_per_pack: formatMinor(line.invoicedPricePerPackMinor),
      discount_bps: line.discountBps,
      tax_bps: line.taxBps,
      unit_cost: formatMinor(line.unitCostMinor),
      stock_lot_id: line.inventoryLotId,
    }))
  );

  // Names resolve exactly as the register screen does: staff profile first.
  const personIds = [
    ...new Set(
      registerEntries.flatMap((entry) => [entry.recordedByUserId, entry.witnessedByUserId])
    ),
  ];
  const [users, staff] = personIds.length
    ? await Promise.all([
        db.user.findMany({
          where: { organizationId, id: { in: personIds } },
          select: { id: true, name: true },
        }),
        db.restaurantStaffProfile.findMany({
          where: { organizationId, userId: { in: personIds } },
          select: { userId: true, displayName: true },
        }),
      ])
    : [[], []];
  const userNames = new Map(users.map((user) => [user.id, user.name]));
  const staffNames = new Map<string, string[]>();
  for (const profile of staff) {
    if (!profile.userId) continue;
    staffNames.set(profile.userId, [
      ...(staffNames.get(profile.userId) ?? []),
      profile.displayName,
    ]);
  }
  const personName = (id: string) =>
    chooseRegisterPersonName([...(staffNames.get(id) ?? []), userNames.get(id)], id);

  const controlledRegister: ExportRow[] = registerEntries.map((entry) => {
    const medicine = entry.medicine ?? entry.line?.medicine ?? null;
    return {
      branch: branchCode.get(entry.branchId) ?? entry.branchId,
      register_serial: entry.serial,
      recorded_at: entry.createdAt,
      entry_kind: entry.entryKind,
      medicine_name: medicine?.productName,
      manufacturer: entry.manufacturer ?? medicine?.manufacturer,
      register_batch: entry.batchNumber,
      quantity_units: entry.quantityCanonicalUnits,
      balance_change: entry.balanceDelta,
      running_balance: entry.runningBalance,
      patient: entry.patient?.displayName,
      prescriber: entry.prescriberName ?? entry.prescriber?.name,
      prescriber_reg_no: entry.prescriberRegNo ?? entry.prescriber?.registrationNumber,
      counterparty: entry.counterpartyName,
      rx_serial_written: entry.rxSerialWritten,
      emergency: entry.emergency,
      corrects_serial: entry.correctsEntry?.serial,
      correction_reason: entry.correctionReason,
      recorded_by: personName(entry.recordedByUserId),
      witnessed_by: personName(entry.witnessedByUserId),
    };
  });

  return {
    medicines,
    stockLots,
    customers: customerRows,
    khataLedger,
    suppliers: supplierRows,
    sales: saleRows,
    saleLines,
    purchaseOrders: purchaseOrderRows,
    goodsReceipts: goodsReceiptRows,
    goodsReceiptLines,
    controlledRegister,
  };
}

/**
 * The platform worker's handler. It runs inside `withPlatformDb`, so it first
 * drops to the job's tenant scope: every read below is then held to that
 * organization by row-level security as well as by its own `where`.
 */
export async function runPharmacyOwnerDataExportJob(
  db: ScopedDb,
  job: Pick<PlatformJob, 'id' | 'organizationId'>,
  payload: Record<string, unknown>,
  now: () => Date = () => new Date()
) {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('Owner data export requires an organization.');
  const range = parseSalesRange(payload);
  if (!range) throw new Error('Owner data export has an invalid sales range.');
  await db.$queryRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.current_user_id', '', true),
            set_config('app.is_platform_admin', 'false', true)`,
    organizationId
  );
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { displayName: true, legalName: true },
  });
  const rows = await loadOwnerDataExportRows(db, organizationId, range);
  const generatedAt = now();
  const archive = buildOwnerDataExportZip(
    {
      organizationName: organization?.displayName || organization?.legalName || 'Pharmacy',
      generatedAt,
      salesFrom: range.from ? new Date(`${range.from}T00:00:00.000Z`) : null,
      salesTo: range.to ? new Date(`${range.to}T00:00:00.000Z`) : null,
    },
    rows
  );
  const filename = ownerDataExportFilename(job.id);
  await putUpload(organizationId, filename, archive, 'application/zip');
  return {
    filename,
    bytes: archive.length,
    rowCounts: exportRowCounts(rows),
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + OWNER_DATA_EXPORT_LINK_TTL_MS).toISOString(),
  };
}
