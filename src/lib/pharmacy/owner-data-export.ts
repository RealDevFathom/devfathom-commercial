import 'server-only';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PlatformJob } from '@/generated/prisma/client';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { deleteUpload, getUploadStream, putUploadFile } from '@/lib/storage';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { ZipFileWriter, ZipSizeLimitError } from '@/lib/zip';
import {
  OWNER_DATA_EXPORT_FILES,
  exportCsvHeader,
  exportCsvRows,
  exportReadme,
  exportRowCounts,
  formatDateOnly,
  formatMinor,
  type ExportFileSpec,
  type ExportRow,
  type OwnerDataExportCounts,
  type OwnerDataExportFileKey,
  type OwnerDataExportRows,
  type OwnerDataExportView,
} from './owner-data-export-format';
import {
  newOwnerDataExportObjectName,
  storedOwnerDataExportObjectName,
} from './owner-data-export-object';
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

/** The archive name used before DEV-783 (no token). Kept to purge older archives. */
export function ownerDataExportFilename(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error('Invalid export job id.');
  return `owner-data-export-${jobId}.zip`;
}

/**
 * The stored archive as a stream: a download never holds the whole ZIP in
 * memory. The object name comes from the job's own result, never the request.
 */
export async function streamOwnerDataExport(
  organizationId: string,
  job: { id: string; result: unknown }
) {
  const filename = storedOwnerDataExportObjectName(job.id, job.result);
  if (!filename) throw new Error('That export has no stored archive.');
  return getUploadStream(organizationId, filename);
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

/** Per-owner rate limit: at most this many exports per rolling window. */
export const OWNER_DATA_EXPORT_REQUEST_LIMIT = 3;
export const OWNER_DATA_EXPORT_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export type QueueOwnerDataExportResult =
  | { kind: 'created' | 'pending'; job: ExportJob }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/**
 * Queue an export for one owner, or return the export already in flight for
 * the workspace. A per-workspace transaction lock makes the in-flight check,
 * the per-owner rate limit and the insert one step, so two simultaneous
 * requests can neither queue twice nor both slip under the limit. Every export
 * the owner queued in the window counts, whatever became of it.
 */
export async function queueOwnerDataExport(
  db: ScopedDb,
  input: { organizationId: string; userId: string; range: SalesRange; now: Date }
): Promise<QueueOwnerDataExportResult> {
  const { organizationId, userId, range, now } = input;
  await db.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    `owner-data-export:${organizationId}`
  );
  const pending = await db.platformJob.findFirst({
    where: {
      organizationId,
      type: OWNER_DATA_EXPORT_JOB_TYPE,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
    orderBy: { createdAt: 'desc' },
    select: OWNER_DATA_EXPORT_JOB_SELECT,
  });
  if (pending) return { kind: 'pending', job: pending };
  const windowStart = new Date(now.getTime() - OWNER_DATA_EXPORT_REQUEST_WINDOW_MS);
  const recent = await db.platformJob.findMany({
    where: {
      organizationId,
      type: OWNER_DATA_EXPORT_JOB_TYPE,
      requestedById: userId,
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: 'asc' },
    take: OWNER_DATA_EXPORT_REQUEST_LIMIT,
    select: { createdAt: true },
  });
  if (recent.length >= OWNER_DATA_EXPORT_REQUEST_LIMIT) {
    // A slot frees when the oldest export in the window ages out of it.
    const freesAt = recent[0]!.createdAt.getTime() + OWNER_DATA_EXPORT_REQUEST_WINDOW_MS;
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)),
    };
  }
  const job = await db.platformJob.create({
    data: {
      organizationId,
      type: OWNER_DATA_EXPORT_JOB_TYPE,
      requestedById: userId,
      payload: { from: range.from, to: range.to, requestedByTenant: true },
    },
    select: OWNER_DATA_EXPORT_JOB_SELECT,
  });
  return { kind: 'created', job };
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
    await deleteUpload(
      job.organizationId,
      storedOwnerDataExportObjectName(job.id, job.result) ?? ownerDataExportFilename(job.id)
    );
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

/** Rows read per query. Every exported table is read in pages of this size. */
export const OWNER_DATA_EXPORT_PAGE_SIZE = 500;

type PageArgs = { take: number; skip?: number; cursor?: { id: string } };

/**
 * Keyset pages over one table. Each `read` must order by a unique key ending in
 * `id`, so the cursor resumes exactly after the last row of the previous page.
 */
async function* pages<T extends { id: string }>(
  read: (page: PageArgs) => Promise<T[]>,
  size: number = OWNER_DATA_EXPORT_PAGE_SIZE
): AsyncGenerator<T[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows: T[] = await read({
      take: size,
      ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (rows.length > 0) yield rows;
    if (rows.length < size) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

async function eachRow<T extends { id: string }>(
  read: (page: PageArgs) => Promise<T[]>,
  visit: (row: T) => void
) {
  for await (const page of pages(read)) for (const row of page) visit(row);
}

const addTo = (map: Map<string, number>, key: string, value: number) =>
  map.set(key, (map.get(key) ?? 0) + value);

export type OwnerDataExportSources = Record<
  OwnerDataExportFileKey,
  () => AsyncIterable<ExportRow[]>
>;

/**
 * Every exported file as a stream of row pages for one organization. Every
 * query names the tenant. Only small lookups (codes, pack labels, per-account
 * and per-supplier totals) are held for the whole export; the rows themselves
 * are read and released one page at a time.
 */
export function ownerDataExportSources(
  db: ScopedDb,
  organizationId: string,
  range: SalesRange
): OwnerDataExportSources {
  const where = { organizationId };
  const bounds = rangeBounds(range);

  const once = <T>(load: () => Promise<T>) => {
    let value: Promise<T> | null = null;
    return () => (value ??= load());
  };

  const codes = once(async () => {
    const branchCode = new Map<string, string>();
    const locationCode = new Map<string, string>();
    await eachRow(
      (page) =>
        db.pharmacyBranch.findMany({
          where,
          orderBy: { id: 'asc' },
          select: { id: true, code: true },
          ...page,
        }),
      (branch) => branchCode.set(branch.id, branch.code)
    );
    await eachRow(
      (page) =>
        db.pharmacyStockLocation.findMany({
          where,
          orderBy: { id: 'asc' },
          select: { id: true, code: true },
          ...page,
        }),
      (location) => locationCode.set(location.id, location.code)
    );
    return {
      branch: (id: string) => branchCode.get(id) ?? id,
      location: (id: string) => locationCode.get(id) ?? id,
    };
  });

  const packs = once(async () => {
    const levels: PackNode[] = [];
    const label = new Map<string, string>();
    await eachRow(
      (page) =>
        db.packLevel.findMany({
          where,
          orderBy: { id: 'asc' },
          select: {
            id: true,
            level: true,
            parentPackLevelId: true,
            unitsPerParent: true,
            effectiveTo: true,
            presentation: { select: { presentation: true } },
          },
          ...page,
        }),
      (pack) => {
        levels.push({
          id: pack.id,
          parentPackLevelId: pack.parentPackLevelId,
          unitsPerParent: pack.unitsPerParent,
          effectiveTo: pack.effectiveTo,
        });
        label.set(pack.id, `${pack.level} · ${pack.presentation.presentation}`);
      }
    );
    return { label, baseUnits: basePackUnits(levels) };
  });

  const khata = once(async () => {
    const accounts = new Map<string, { payerCustomerId: string; displayName: string }>();
    await eachRow(
      (page) =>
        db.pharmacyFamilyAccount.findMany({
          where,
          orderBy: { id: 'asc' },
          select: { id: true, payerCustomerId: true, displayName: true },
          ...page,
        }),
      (account) => accounts.set(account.id, account)
    );
    const accountBalance = new Map<string, number>();
    await eachRow(
      (page) =>
        db.pharmacyKhataEvent.findMany({
          where,
          orderBy: { id: 'asc' },
          select: { id: true, familyAccountId: true, kind: true, amountMinor: true },
          ...page,
        }),
      (event) =>
        addTo(
          accountBalance,
          event.familyAccountId,
          event.kind === 'PAYMENT' ? -event.amountMinor : event.amountMinor
        )
    );
    const customerBalance = new Map<string, number>();
    for (const [id, account] of accounts) {
      addTo(customerBalance, account.payerCustomerId, accountBalance.get(id) ?? 0);
    }
    return { accounts, customerBalance };
  });

  const supplierTotals = once(async () => {
    const received = new Map<string, number>();
    await eachRow(
      (page) =>
        db.pharmacyGoodsReceipt.findMany({
          where,
          orderBy: { id: 'asc' },
          select: {
            id: true,
            supplierId: true,
            postedAt: true,
            reversedAt: true,
            lines: { select: { acceptedCanonicalUnits: true, unitCostMinor: true } },
          },
          ...page,
        }),
      (receipt) => {
        if (!receipt.postedAt || receipt.reversedAt) return;
        addTo(
          received,
          receipt.supplierId,
          sumBy(receipt.lines, (line) => line.acceptedCanonicalUnits * line.unitCostMinor)
        );
      }
    );
    const credits = new Map<string, number>();
    await eachRow(
      (page) =>
        db.pharmacySupplierCredit.findMany({
          where,
          orderBy: { id: 'asc' },
          select: { id: true, supplierId: true, amountMinor: true },
          ...page,
        }),
      (credit) => addTo(credits, credit.supplierId, credit.amountMinor)
    );
    return { received, credits };
  });

  const salePages = () =>
    pages((page) =>
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
        ...page,
      })
    );

  const receiptPages = () =>
    pages((page) =>
      db.pharmacyGoodsReceipt.findMany({
        where,
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        include: {
          lines: {
            orderBy: { lineNumber: 'asc' },
            include: { medicine: { select: { productName: true } } },
          },
        },
        ...page,
      })
    );

  return {
    async *medicines() {
      const { label, baseUnits } = await packs();
      for await (const page of pages((args) =>
        db.packLevel.findMany({
          where,
          orderBy: { id: 'asc' },
          include: { presentation: { include: { medicine: true } } },
          ...args,
        })
      )) {
        // A pack's own barcodes, plus presentation-wide ones on its top level.
        const barcodes = await db.medicineBarcode.findMany({
          where: {
            ...where,
            OR: [
              { packLevelId: { in: page.map((pack) => pack.id) } },
              {
                packLevelId: null,
                presentationId: {
                  in: page.filter((pack) => !pack.parentPackLevelId).map((p) => p.presentationId),
                },
              },
            ],
          },
          orderBy: { code: 'asc' },
          select: { presentationId: true, packLevelId: true, code: true },
        });
        const byPack = new Map<string, string[]>();
        const byPresentation = new Map<string, string[]>();
        for (const barcode of barcodes) {
          const [map, key] = barcode.packLevelId
            ? [byPack, barcode.packLevelId]
            : [byPresentation, barcode.presentationId];
          map.set(key, [...(map.get(key) ?? []), barcode.code]);
        }
        yield page.map((pack) => {
          const medicine = pack.presentation.medicine;
          return {
            code: pack.id,
            product: medicine.productName,
            pack: unitsLabel(baseUnits.get(pack.id)),
            pack_level: label.get(pack.id),
            barcode: [
              ...(byPack.get(pack.id) ?? []),
              ...(pack.parentPackLevelId ? [] : (byPresentation.get(pack.presentationId) ?? [])),
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
      }
    },

    async *stockLots() {
      const code = await codes();
      const { label } = await packs();
      for await (const page of pages((args) =>
        db.pharmacyInventoryLot.findMany({
          where,
          orderBy: { id: 'asc' },
          include: {
            batch: { include: { medicine: { select: { productName: true } } } },
            packLevel: { select: { level: true } },
            balances: { orderBy: [{ stockLocationId: 'asc' }, { disposition: 'asc' }] },
          },
          ...args,
        })
      )) {
        yield page.flatMap((lot) =>
          lot.balances.map((balance) => ({
            code: lot.id,
            product: lot.batch.medicine.productName,
            pack: unitsLabel(lot.unitsPerPack),
            pack_level: label.get(lot.packLevelId) ?? lot.packLevel.level,
            batch: lot.batch.batchNumber,
            expiry: formatDateOnly(lot.batch.expiresAt),
            mrp: formatMinor(lot.printedMrpMinor),
            cost: formatMinor(lot.unitCostMinor),
            quantity: balance.onHandUnits,
            supplier: lot.supplierName,
            branch: code.branch(lot.branchId),
            location: code.location(balance.stockLocationId),
            disposition: balance.disposition,
            supplier_invoice: lot.supplierInvoiceRef,
          }))
        );
      }
    },

    async *customers() {
      const { customerBalance } = await khata();
      for await (const page of pages((args) =>
        db.pharmacyCustomer.findMany({ where, orderBy: { id: 'asc' }, ...args })
      )) {
        yield page.map((customer) => ({
          code: customer.id,
          customer: customer.displayName,
          balance: formatMinor(customerBalance.get(customer.id) ?? 0),
          credit_limit: formatMinor(customer.creditLimitMinor),
          phone_last4: customer.phoneLast4,
          active: customer.active,
          created_at: customer.createdAt,
        }));
      }
    },

    async *khataLedger() {
      const code = await codes();
      const { accounts } = await khata();
      for await (const page of pages((args) =>
        db.pharmacyKhataEvent.findMany({
          where,
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          ...args,
        })
      )) {
        yield page.map((event) => {
          const account = accounts.get(event.familyAccountId);
          return {
            account_id: event.familyAccountId,
            account_name: account?.displayName,
            payer_customer_id: account?.payerCustomerId,
            branch: code.branch(event.branchId),
            kind: event.kind,
            amount: formatMinor(event.amountMinor),
            occurred_at: event.occurredAt,
            due_at: event.dueAt,
            note: event.note,
          };
        });
      }
    },

    async *suppliers() {
      const { received, credits } = await supplierTotals();
      for await (const page of pages((args) =>
        db.pharmacySupplier.findMany({ where, orderBy: { id: 'asc' }, ...args })
      )) {
        yield page.map((supplier) => ({
          code: supplier.id,
          supplier: supplier.name,
          goods_received_value: formatMinor(received.get(supplier.id) ?? 0),
          supplier_credits: formatMinor(credits.get(supplier.id) ?? 0),
          legal_name: supplier.legalName,
          contact_name: supplier.contactName,
          contact_phone: supplier.contactPhone,
          payment_terms_days: supplier.paymentTermsDays,
          credit_limit: formatMinor(supplier.creditLimitMinor),
          authorized: supplier.authorized,
          active: supplier.active,
        }));
      }
    },

    async *sales() {
      const code = await codes();
      for await (const page of salePages()) {
        yield page.map((sale) => {
          const gross = sumBy(sale.lines, (line) => line.grossMinor);
          const discount = sumBy(sale.lines, (line) => line.discountMinor);
          return {
            sale_id: sale.id,
            branch: code.branch(sale.branchId),
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
      }
    },

    async *saleLines() {
      for await (const page of salePages()) {
        yield page.flatMap((sale) =>
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
      }
    },

    async *purchaseOrders() {
      const code = await codes();
      for await (const page of pages((args) =>
        db.pharmacyPurchaseOrder.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          ...args,
        })
      )) {
        yield page.map((order) => ({
          purchase_order_id: order.id,
          reference: order.reference,
          supplier_id: order.supplierId,
          branch: order.branchId ? code.branch(order.branchId) : null,
          status: order.status,
          created_at: order.createdAt,
          approved_at: order.approvedAt,
          sent_at: order.sentAt,
          expected_delivery_at: order.expectedDeliveryAt,
        }));
      }
    },

    async *goodsReceipts() {
      const code = await codes();
      for await (const page of receiptPages()) {
        yield page.map((receipt) => ({
          goods_receipt_id: receipt.id,
          reference: receipt.reference,
          branch: code.branch(receipt.branchId),
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
      }
    },

    async *goodsReceiptLines() {
      for await (const page of receiptPages()) {
        yield page.flatMap((receipt) =>
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
      }
    },

    async *controlledRegister() {
      const code = await codes();
      for await (const page of pages((args) =>
        db.pharmacyControlledRegisterEntry.findMany({
          where,
          orderBy: [{ branchId: 'asc' }, { serial: 'asc' }, { id: 'asc' }],
          include: {
            patient: { select: { displayName: true } },
            prescriber: { select: { name: true, registrationNumber: true } },
            medicine: { select: { productName: true, manufacturer: true } },
            line: { select: { medicine: { select: { productName: true, manufacturer: true } } } },
            correctsEntry: { select: { serial: true } },
          },
          ...args,
        })
      )) {
        // Names resolve exactly as the register screen does: staff profile first.
        const personIds = [
          ...new Set(page.flatMap((entry) => [entry.recordedByUserId, entry.witnessedByUserId])),
        ];
        const [users, staff] = await Promise.all([
          db.user.findMany({
            where: { organizationId, id: { in: personIds } },
            select: { id: true, name: true },
          }),
          db.restaurantStaffProfile.findMany({
            where: { organizationId, userId: { in: personIds } },
            select: { userId: true, displayName: true },
          }),
        ]);
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

        yield page.map((entry) => {
          const medicine = entry.medicine ?? entry.line?.medicine ?? null;
          return {
            branch: code.branch(entry.branchId),
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
      }
    },
  };
}

/** Every exported row in memory. For small fixtures and tests; the job streams. */
export async function loadOwnerDataExportRows(
  db: ScopedDb,
  organizationId: string,
  range: SalesRange
): Promise<OwnerDataExportRows> {
  const sources = ownerDataExportSources(db, organizationId, range);
  const rows = {} as Record<OwnerDataExportFileKey, ExportRow[]>;
  for (const key of Object.keys(OWNER_DATA_EXPORT_FILES) as OwnerDataExportFileKey[]) {
    rows[key] = [];
    for await (const page of sources[key]()) rows[key].push(...page);
  }
  return rows;
}

/** A file's CSV as chunks: the header, then one chunk per page of rows. */
async function* csvChunks(
  spec: ExportFileSpec,
  source: AsyncIterable<ExportRow[]>,
  onRows: (count: number) => void
): AsyncGenerator<string> {
  yield exportCsvHeader(spec);
  for await (const page of source) {
    onRows(page.length);
    yield exportCsvRows(spec, page);
  }
}

/** The largest archive the export will build: 512 MiB. Larger exports fail. */
export const OWNER_DATA_EXPORT_MAX_BYTES = 512 * 1024 * 1024;

/** A size-cap failure is permanent: retrying the same export cannot shrink it. */
export class OwnerDataExportTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(
      `The export is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB. Choose a shorter sales date range.`
    );
    this.name = 'OwnerDataExportTooLargeError';
  }
}

/**
 * The platform worker's handler. It runs inside `withPlatformDb`, so it first
 * drops to the job's tenant scope: every read below is then held to that
 * organization by row-level security as well as by its own `where`.
 *
 * Tables are read a page at a time and each page is written straight into a
 * ZIP on local disk, so neither the rows nor the archive is held in memory; the
 * finished file is then streamed to storage. The archive stops at
 * `maxBytes` and the job fails permanently instead. The worker runs this in a
 * REPEATABLE READ transaction, so files read in separate passes (sales and
 * sale lines, receipts and receipt lines) all come from one snapshot.
 */
export async function runPharmacyOwnerDataExportJob(
  db: ScopedDb,
  job: Pick<PlatformJob, 'id' | 'organizationId'>,
  payload: Record<string, unknown>,
  now: () => Date = () => new Date(),
  options: { maxBytes?: number } = {}
) {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('Owner data export requires an organization.');
  const range = parseSalesRange(payload);
  if (!range) throw new Error('Owner data export has an invalid sales range.');
  const maxBytes = options.maxBytes ?? OWNER_DATA_EXPORT_MAX_BYTES;
  const filename = newOwnerDataExportObjectName(job.id);
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
  const generatedAt = now();
  const sources = ownerDataExportSources(db, organizationId, range);
  const directory = await mkdtemp(join(tmpdir(), 'owner-data-export-'));
  try {
    const path = join(directory, filename);
    const zip = await ZipFileWriter.create(path, { maxBytes });
    const counts = {} as OwnerDataExportCounts;
    let bytes: number;
    try {
      for (const key of Object.keys(OWNER_DATA_EXPORT_FILES) as OwnerDataExportFileKey[]) {
        counts[key] = 0;
        const spec: ExportFileSpec = OWNER_DATA_EXPORT_FILES[key];
        await zip.addEntry(
          spec.name,
          csvChunks(spec, sources[key](), (count) => (counts[key] += count))
        );
      }
      const readme = exportReadme(
        {
          organizationName: organization?.displayName || organization?.legalName || 'Pharmacy',
          generatedAt,
          salesFrom: range.from ? new Date(`${range.from}T00:00:00.000Z`) : null,
          salesTo: range.to ? new Date(`${range.to}T00:00:00.000Z`) : null,
        },
        counts
      );
      await zip.addEntry('README.md', [readme]);
      bytes = await zip.close();
    } catch (error) {
      await zip.abort();
      if (error instanceof ZipSizeLimitError) throw new OwnerDataExportTooLargeError(maxBytes);
      throw error;
    }
    await putUploadFile(organizationId, filename, path, 'application/zip');
    return {
      filename,
      bytes,
      rowCounts: exportRowCounts(counts),
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + OWNER_DATA_EXPORT_LINK_TTL_MS).toISOString(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
