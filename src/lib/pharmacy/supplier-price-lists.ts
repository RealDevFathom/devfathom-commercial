import 'server-only';

import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { normalizeMedicineText } from './medicine';
import { parseOwnerUpload } from './migration/owner-import-upload';
import { readMoneyMinor, readText, type SourceTable } from './migration/source-values';
import { currentPackPrice, lockPrices } from './pricing';
import {
  APPROVAL_BLOCKED,
  SOLO_OWNER_POLICY,
  soloOwnerApprovalAllowed,
  verifyPurchaseApprover,
} from './purchase-approval';

/**
 * DEV-681 — supplier price-list import and price-change alerts.
 *
 * A distributor's CSV/XLSX price list is stored row by row exactly as read.
 * SQL compares each matched row with this supplier's last posted invoice price
 * (trade price) and the organization's current price policy (MRP), and drafts
 * a shelf-price change where the MRP differs. Nothing here changes a price:
 * only `decideSupplierPriceDrafts`, called by a person, writes a price policy.
 */

export type SupplierPriceListScope = { organizationId: string; actorId: string };

const bad = (message: string): never => {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
};

const HEADERS = {
  product: ['product', 'productname', 'item', 'itemname', 'description', 'medicine', 'name'],
  pack: ['pack', 'packing', 'packsize', 'packlevel', 'uom', 'unit'],
  barcode: ['barcode', 'ean', 'ean13', 'gtin', 'upc'],
  tradePrice: ['tp', 'tradeprice', 'trade', 'rate', 'netrate', 'purchaseprice', 'cost'],
  mrp: ['mrp', 'retailprice', 'rp', 'consumerprice', 'maximumretailprice'],
} as const;
type Column = keyof typeof HEADERS;

const header = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Exact header synonyms; a header claimed twice is refused rather than guessed. */
export function priceListColumns(headers: readonly string[]): Partial<Record<Column, number>> {
  const columns: Partial<Record<Column, number>> = {};
  headers.forEach((raw, index) => {
    const name = header(raw);
    for (const column of Object.keys(HEADERS) as Column[]) {
      if (!(HEADERS[column] as readonly string[]).includes(name)) continue;
      if (columns[column] !== undefined) bad(`Two columns look like "${column}". Rename one.`);
      columns[column] = index;
    }
  });
  if (columns.product === undefined)
    bad('Add a "Product" column naming each medicine as it appears in your catalogue.');
  if (columns.tradePrice === undefined && columns.mrp === undefined)
    bad('Add a "TP" (trade price) or "MRP" column. Prices are per pack in PKR.');
  return columns;
}

export type PriceListRow = {
  rowNumber: number;
  productText: string;
  packText: string | null;
  barcode: string | null;
  listTradePriceMinor: number | null;
  listMrpMinor: number | null;
};

const money = (raw: string | undefined, label: string, rowNumber: number) => {
  const text = readText(raw);
  if (text === null) return null;
  const minor = readMoneyMinor(text);
  if (minor === null || minor < BigInt(0) || minor > BigInt(2_000_000_000))
    return bad(`Row ${rowNumber}: ${label} "${text}" is not a PKR amount with up to two decimals.`);
  return Number(minor);
};

/** Every row is read exactly or the whole file is refused; nothing is dropped silently. */
export function readPriceListRows(table: SourceTable): PriceListRow[] {
  const columns = priceListColumns(table.headers);
  const cell = (row: readonly string[], column: Column) =>
    columns[column] === undefined ? undefined : row[columns[column]!];
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    const productText = readText(cell(row, 'product'));
    if (!productText) return bad(`Row ${rowNumber}: the product name is empty.`);
    const listTradePriceMinor = money(cell(row, 'tradePrice'), 'trade price', rowNumber);
    const listMrpMinor = money(cell(row, 'mrp'), 'MRP', rowNumber);
    if (listTradePriceMinor === null && listMrpMinor === null)
      return bad(`Row ${rowNumber}: give a trade price or an MRP.`);
    return {
      rowNumber,
      productText,
      packText: readText(cell(row, 'pack')),
      barcode: readText(cell(row, 'barcode')),
      listTradePriceMinor,
      listMrpMinor,
    };
  });
}

type Match =
  | { matchStatus: 'MATCHED'; medicineId: string; packLevelId: string }
  | { matchStatus: 'NO_MATCH' | 'AMBIGUOUS'; medicineId: null; packLevelId: null };
const unmatched = (matchStatus: 'NO_MATCH' | 'AMBIGUOUS'): Match => ({
  matchStatus,
  medicineId: null,
  packLevelId: null,
});

const PACK_LEVELS = ['BOX', 'STRIP', 'UNIT'];

/**
 * A pack barcode wins outright. Otherwise the exact catalogue name or alias
 * must name one medicine, and that medicine must have exactly one current pack
 * at the named level (or one outer pack when no level is named). Anything else
 * is left for a person to map; no fuzzy match ever reaches a price.
 */
export async function matchPriceListRow(
  db: ScopedDb,
  organizationId: string,
  row: Pick<PriceListRow, 'productText' | 'packText' | 'barcode'>,
  at = new Date()
): Promise<Match> {
  const current = { effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] };
  if (row.barcode) {
    const barcode = await db.medicineBarcode.findFirst({
      where: { organizationId, normalizedCode: normalizeMedicineText(row.barcode) },
      select: { packLevelId: true, presentation: { select: { medicineId: true } } },
    });
    if (barcode) {
      if (!barcode.packLevelId) return unmatched('AMBIGUOUS');
      const pack = await db.packLevel.findFirst({
        where: { organizationId, id: barcode.packLevelId, ...current },
        select: { id: true },
      });
      return pack
        ? { matchStatus: 'MATCHED', medicineId: barcode.presentation.medicineId, packLevelId: pack.id }
        : unmatched('AMBIGUOUS');
    }
  }
  const normalized = normalizeMedicineText(row.productText);
  if (!normalized) return unmatched('NO_MATCH');
  const [byName, byAlias] = await Promise.all([
    db.medicine.findMany({
      where: { organizationId, productName: { equals: row.productText, mode: 'insensitive' } },
      select: { id: true },
    }),
    db.medicineAlias.findMany({
      where: { organizationId, normalizedValue: normalized },
      select: { medicineId: true },
    }),
  ]);
  const medicineIds = [...new Set([...byName.map((m) => m.id), ...byAlias.map((a) => a.medicineId)])];
  if (medicineIds.length !== 1) return unmatched(medicineIds.length ? 'AMBIGUOUS' : 'NO_MATCH');
  // An unrecognized pack (for example "10 tablets") is never read as the outer
  // pack: comparing a unit or strip price with a box would draft a wrong MRP.
  const level = row.packText?.trim().toUpperCase() || null;
  if (level && !PACK_LEVELS.includes(level)) return unmatched('AMBIGUOUS');
  const packs = await db.packLevel.findMany({
    where: {
      organizationId,
      presentation: { organizationId, medicineId: medicineIds[0] },
      ...current,
      ...(level ? { level } : { parentPackLevelId: null }),
    },
    select: { id: true },
  });
  return packs.length === 1
    ? { matchStatus: 'MATCHED', medicineId: medicineIds[0]!, packLevelId: packs[0]!.id }
    : unmatched(packs.length ? 'AMBIGUOUS' : 'NO_MATCH');
}

/**
 * Snapshot the records each matched row is compared with, and draft a shelf
 * price where the list MRP differs from the current policy. SQL computes every
 * figure; a draft never sells above the new MRP.
 */
async function snapshotAndDraft(db: ScopedDb, organizationId: string, priceListId: string) {
  await db.$executeRaw(Prisma.sql`
    WITH snap AS (
      SELECT l.id,
        (SELECT gl."invoicedPricePerPackMinor"
           FROM pharmacy_goods_receipt_lines gl
           JOIN pharmacy_goods_receipts g
             ON g."organizationId" = gl."organizationId" AND g."branchId" = gl."branchId" AND g.id = gl."goodsReceiptId"
          WHERE gl."organizationId" = l."organizationId" AND gl."packLevelId" = l."packLevelId"
            AND g."supplierId" = p."supplierId" AND g.status = 'POSTED'
          ORDER BY g."postedAt" DESC NULLS LAST, gl."createdAt" DESC, gl.id DESC
          LIMIT 1) AS prev_tp,
        cp.id AS cp_id, cp."mrpMinor" AS cp_mrp, cp."sellingPriceMinor" AS cp_sell
      FROM pharmacy_supplier_price_list_lines l
      JOIN pharmacy_supplier_price_lists p ON p."organizationId" = l."organizationId" AND p.id = l."priceListId"
      LEFT JOIN LATERAL (
        SELECT pp.id, pp."mrpMinor", pp."sellingPriceMinor" FROM pharmacy_pack_prices pp
         WHERE pp."organizationId" = l."organizationId" AND pp."packLevelId" = l."packLevelId"
           AND pp."branchId" IS NULL AND pp."effectiveFrom" <= now()
         ORDER BY pp."effectiveFrom" DESC, pp.id DESC LIMIT 1
      ) cp ON true
      WHERE l."organizationId" = ${organizationId} AND l."priceListId" = ${priceListId}
        AND l."matchStatus" = 'MATCHED'
    ), drafted AS (
      SELECT s.*, (l."listMrpMinor" IS NOT NULL AND l."listMrpMinor" IS DISTINCT FROM s.cp_mrp) AS changes
      FROM snap s JOIN pharmacy_supplier_price_list_lines l ON l.id = s.id
    )
    UPDATE pharmacy_supplier_price_list_lines l SET
      "previousTradePriceMinor" = d.prev_tp,
      "currentPackPriceId" = d.cp_id,
      "currentMrpMinor" = d.cp_mrp,
      "currentSellingPriceMinor" = d.cp_sell,
      "draftStatus" = CASE WHEN d.changes THEN 'DRAFT' ELSE 'NONE' END,
      "draftMrpMinor" = CASE WHEN d.changes THEN l."listMrpMinor" END,
      "draftSellingPriceMinor" = CASE
        WHEN d.changes AND d.cp_sell IS NOT NULL THEN LEAST(d.cp_sell, l."listMrpMinor")
      END
    FROM drafted d
    WHERE l.id = d.id AND l."organizationId" = ${organizationId}
  `);
}

/** Open drafts whose compared organization price is no longer the current one. */
async function stalePriceDrafts(db: ScopedDb, organizationId: string, priceListId: string) {
  const [row] = await db.$queryRaw<Array<{ stale: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS stale FROM pharmacy_supplier_price_list_lines l
     WHERE l."organizationId" = ${organizationId} AND l."priceListId" = ${priceListId}
       AND l."draftStatus" = 'DRAFT'
       AND (SELECT pp.id FROM pharmacy_pack_prices pp
             WHERE pp."organizationId" = l."organizationId" AND pp."packLevelId" = l."packLevelId"
               AND pp."branchId" IS NULL AND pp."effectiveFrom" <= now()
             ORDER BY pp."effectiveFrom" DESC, pp.id DESC LIMIT 1) IS DISTINCT FROM l."currentPackPriceId"
  `);
  return row?.stale ?? 0;
}

export async function importSupplierPriceList(
  db: ScopedDb,
  scope: SupplierPriceListScope,
  input: { supplierId: string; fileName: string; bytes: Buffer }
) {
  const table = await parseOwnerUpload(input.fileName, input.bytes);
  const rows = readPriceListRows(table);
  const sourceHash = createHash('sha256').update(input.bytes).digest('hex');
  const supplier = await db.pharmacySupplier.findFirst({
    where: { organizationId: scope.organizationId, id: input.supplierId },
    select: { id: true, name: true },
  });
  if (!supplier) throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
  const at = new Date();
  const matches: Match[] = [];
  for (const row of rows) matches.push(await matchPriceListRow(db, scope.organizationId, row, at));
  return db.$transaction(async (tx) => {
    const scoped = tx as ScopedDb;
    // Serialize imports of one file so a replay check and its insert agree.
    await scoped.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${scope.organizationId}), hashtext(${`price-list:${supplier.id}:${sourceHash}`}))`
    );
    const existing = await scoped.pharmacySupplierPriceList.findFirst({
      where: { organizationId: scope.organizationId, supplierId: supplier.id, sourceHash },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    // The same file replays its comparison only while that comparison is still
    // current. Once a compared price changed, importing it again takes a fresh
    // snapshot; the earlier list, its snapshot and its decisions stay as they were.
    if (existing && (await stalePriceDrafts(scoped, scope.organizationId, existing.id)) === 0)
      return { priceListId: existing.id, replayed: true };
    const list = await scoped.pharmacySupplierPriceList.create({
      data: {
        organizationId: scope.organizationId,
        supplierId: supplier.id,
        fileName: input.fileName,
        sourceHash,
        rowCount: rows.length,
        importedById: scope.actorId,
      },
    });
    await scoped.pharmacySupplierPriceListLine.createMany({
      data: rows.map((row, index) => ({
        ...row,
        ...matches[index]!,
        organizationId: scope.organizationId,
        priceListId: list.id,
      })),
    });
    await snapshotAndDraft(scoped, scope.organizationId, list.id);
    await scoped.auditLog.create({
      data: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'CREATE',
        action: 'pharmacySupplierPriceLists.import',
        targetType: 'PharmacySupplierPriceList',
        targetId: list.id,
        changes: { supplierId: supplier.id, fileName: input.fileName, sourceHash, rowCount: rows.length },
      },
    });
    return { priceListId: list.id, replayed: false };
  });
}

export async function listSupplierPriceLists(db: ScopedDb, organizationId: string) {
  return db.$queryRaw<
    Array<{
      id: string;
      supplierName: string;
      fileName: string;
      createdAt: Date;
      rowCount: number;
      matched: number;
      alerts: number;
      drafts: number;
    }>
  >(Prisma.sql`
    SELECT p.id, s.name AS "supplierName", p."fileName", p."createdAt", p."rowCount",
      COUNT(*) FILTER (WHERE l."matchStatus" = 'MATCHED')::int AS matched,
      COUNT(*) FILTER (WHERE
        (l."listTradePriceMinor" <> l."previousTradePriceMinor") OR
        (l."listMrpMinor" <> l."currentMrpMinor"))::int AS alerts,
      COUNT(*) FILTER (WHERE l."draftStatus" = 'DRAFT')::int AS drafts
    FROM pharmacy_supplier_price_lists p
    JOIN pharmacy_suppliers s ON s."organizationId" = p."organizationId" AND s.id = p."supplierId"
    LEFT JOIN pharmacy_supplier_price_list_lines l ON l."organizationId" = p."organizationId" AND l."priceListId" = p.id
    WHERE p."organizationId" = ${organizationId}
    GROUP BY p.id, s.name
    ORDER BY p."createdAt" DESC, p.id DESC
    LIMIT 50
  `);
}

export type SupplierPriceListReviewLine = {
  id: string;
  rowNumber: number;
  productText: string;
  packText: string | null;
  matchStatus: 'MATCHED' | 'NO_MATCH' | 'AMBIGUOUS';
  medicineName: string | null;
  packLevel: string | null;
  listTradePriceMinor: number | null;
  previousTradePriceMinor: number | null;
  tradeChangeMinor: number | null;
  tradeChangeBps: number | null;
  listMrpMinor: number | null;
  currentMrpMinor: number | null;
  mrpChangeMinor: number | null;
  mrpChangeBps: number | null;
  currentSellingPriceMinor: number | null;
  draftStatus: 'NONE' | 'DRAFT' | 'APPROVED' | 'REJECTED';
  draftMrpMinor: number | null;
  draftSellingPriceMinor: number | null;
  tradeAboveMrp: boolean;
  stale: boolean;
};

/** The alert figures are computed here, in SQL, from the stored snapshot. */
export async function supplierPriceListReview(
  db: ScopedDb,
  organizationId: string,
  priceListId: string
) {
  const list = await db.pharmacySupplierPriceList.findFirst({
    where: { organizationId, id: priceListId },
    include: { supplier: { select: { name: true } } },
  });
  if (!list) throw new TRPCError({ code: 'NOT_FOUND', message: 'Price list not found.' });
  const lines = await db.$queryRaw<SupplierPriceListReviewLine[]>(Prisma.sql`
    SELECT l.id, l."rowNumber", l."productText", l."packText", l."matchStatus",
      m."productName" AS "medicineName", pl.level AS "packLevel",
      l."listTradePriceMinor", l."previousTradePriceMinor",
      (l."listTradePriceMinor" - l."previousTradePriceMinor")::int AS "tradeChangeMinor",
      CASE WHEN l."previousTradePriceMinor" > 0 THEN
        ROUND((l."listTradePriceMinor" - l."previousTradePriceMinor") * 10000.0 / l."previousTradePriceMinor")::int
      END AS "tradeChangeBps",
      l."listMrpMinor", l."currentMrpMinor",
      (l."listMrpMinor" - l."currentMrpMinor")::int AS "mrpChangeMinor",
      CASE WHEN l."currentMrpMinor" > 0 THEN
        ROUND((l."listMrpMinor" - l."currentMrpMinor") * 10000.0 / l."currentMrpMinor")::int
      END AS "mrpChangeBps",
      l."currentSellingPriceMinor", l."draftStatus", l."draftMrpMinor", l."draftSellingPriceMinor",
      COALESCE(l."listTradePriceMinor" > l."listMrpMinor", false) AS "tradeAboveMrp",
      (l."draftStatus" = 'DRAFT' AND (
        SELECT pp.id FROM pharmacy_pack_prices pp
         WHERE pp."organizationId" = l."organizationId" AND pp."packLevelId" = l."packLevelId"
           AND pp."branchId" IS NULL AND pp."effectiveFrom" <= now()
         ORDER BY pp."effectiveFrom" DESC, pp.id DESC LIMIT 1
      ) IS DISTINCT FROM l."currentPackPriceId") AS stale
    FROM pharmacy_supplier_price_list_lines l
    LEFT JOIN pharmacy_medicines m ON m."organizationId" = l."organizationId" AND m.id = l."medicineId"
    LEFT JOIN pharmacy_pack_levels pl ON pl."organizationId" = l."organizationId" AND pl.id = l."packLevelId"
    WHERE l."organizationId" = ${organizationId} AND l."priceListId" = ${priceListId}
    ORDER BY l."rowNumber"
  `);
  return {
    id: list.id,
    supplierName: list.supplier.name,
    fileName: list.fileName,
    createdAt: list.createdAt,
    importedById: list.importedById,
    lines,
  };
}

/**
 * A person approves or rejects shelf-price drafts. An approval writes a new
 * organization price policy (source `supplier`) only when the policy the draft
 * was compared with is still current, and never above the new MRP.
 */
export const SELF_PRICE_APPROVAL =
  'You imported this price list, so another owner or administrator must approve it.';

export async function decideSupplierPriceDrafts(
  db: ScopedDb,
  scope: SupplierPriceListScope,
  input: { lineIds: readonly string[]; decision: 'APPROVE' | 'REJECT'; pin?: string }
) {
  const ids = input.lineIds;
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
    return bad('Select 1–100 distinct drafts.');
  return db.$transaction(async (tx) => {
    const scoped = tx as ScopedDb;
    await lockPrices(scoped, scope);
    const now = new Date();
    const lines = await scoped.pharmacySupplierPriceListLine.findMany({
      where: { organizationId: scope.organizationId, id: { in: [...ids] } },
      include: { priceList: { select: { importedById: true } } },
    });
    if (lines.length !== ids.length)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Price draft not found.' });
    // Segregation of duties: whoever imported a list does not approve its
    // prices. The one exception is a solo owner, who has nobody else to ask:
    // they re-enter their PIN now, and the approval names that policy.
    const selfApproval =
      input.decision === 'APPROVE' &&
      lines.some((line) => line.priceList.importedById === scope.actorId);
    if (selfApproval) {
      if (!(await soloOwnerApprovalAllowed(scoped, scope.organizationId, scope.actorId)))
        throw new TRPCError({ code: 'FORBIDDEN', message: SELF_PRICE_APPROVAL });
      const attempt = await verifyPurchaseApprover(scoped, {
        organizationId: scope.organizationId,
        approverId: scope.actorId,
        actorId: scope.actorId,
        pin: input.pin,
      });
      if ('blocked' in attempt) throw new TRPCError({ code: 'FORBIDDEN', message: APPROVAL_BLOCKED });
    }
    const results = [];
    for (const id of [...ids].sort()) {
      const line = lines.find((candidate) => candidate.id === id)!;
      if (line.draftStatus !== 'DRAFT' || !line.packLevelId || line.draftMrpMinor === null)
        return bad(`Row ${line.rowNumber} has no open price draft.`);
      let packPriceId: string | null = null;
      if (input.decision === 'APPROVE') {
        if (line.draftSellingPriceMinor !== null && line.draftSellingPriceMinor > line.draftMrpMinor)
          return bad('Selling price cannot exceed MRP');
        const pack = await scoped.packLevel.findFirst({
          where: {
            organizationId: scope.organizationId,
            id: line.packLevelId,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          select: { id: true, presentationId: true },
        });
        if (!pack) return bad(`Row ${line.rowNumber}: this pack has been superseded. Import the list again.`);
        const current = await currentPackPrice(scoped, scope.organizationId, pack.id, now);
        if ((current?.id ?? null) !== line.currentPackPriceId)
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Row ${line.rowNumber}: the price changed after this list was imported. Import the list again.`,
          });
        const price = await scoped.pharmacyPackPrice.create({
          data: {
            organizationId: scope.organizationId,
            presentationId: pack.presentationId,
            packLevelId: pack.id,
            mrpMinor: line.draftMrpMinor,
            sellingPriceMinor: line.draftSellingPriceMinor,
            effectiveFrom: now,
            source: 'supplier',
            createdById: scope.actorId,
          },
        });
        packPriceId = price.id;
      }
      const updated = await scoped.pharmacySupplierPriceListLine.updateMany({
        where: { organizationId: scope.organizationId, id, draftStatus: 'DRAFT' },
        data: {
          draftStatus: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedById: scope.actorId,
          decidedAt: now,
          packPriceId,
        },
      });
      if (updated.count !== 1)
        throw new TRPCError({ code: 'CONFLICT', message: 'This draft was decided by someone else.' });
      await scoped.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'UPDATE',
          action:
            input.decision === 'APPROVE'
              ? 'pharmacySupplierPriceLists.approveDraft'
              : 'pharmacySupplierPriceLists.rejectDraft',
          targetType: 'PharmacySupplierPriceListLine',
          targetId: id,
          changes: {
            priceListId: line.priceListId,
            packLevelId: line.packLevelId,
            previousMrpMinor: line.currentMrpMinor,
            previousSellingPriceMinor: line.currentSellingPriceMinor,
            mrpMinor: line.draftMrpMinor,
            sellingPriceMinor: line.draftSellingPriceMinor,
            packPriceId,
          },
          ...(selfApproval && line.priceList.importedById === scope.actorId
            ? { metadata: { policy: SOLO_OWNER_POLICY, pinVerified: true, importedById: scope.actorId } }
            : {}),
        },
      });
      results.push({ id, decision: input.decision, packPriceId });
    }
    return results;
  });
}
