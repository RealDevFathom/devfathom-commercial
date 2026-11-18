/**
 * DEV-912 — turn the reviewed rows of a staged legacy product file into catalogue medicines.
 *
 * Approval: an editor asks once for the whole batch; that request waits in the catalogue review
 * queue (DEV-19) and is approved once, by a different reviewer, or by the owner with a fresh PIN
 * when nobody else can review. Only an approved request lets `createStagedMedicinesChunk` run.
 *
 * What one source row becomes: a pharmaceutical medicine with the row's name, one presentation,
 * pack levels from the units-per-pack column (box of strips when strips per box is known), the
 * pack MRP as the organization price, the purchase price and the old system's code kept on the
 * link record, and accepted import provenance naming the approver. Anything the file does not
 * record is stored as not recorded, never invented, and never blocks (owner's rule on DEV-852 and
 * DEV-853): no units per pack means no pack level, no MRP means no price.
 *
 * Supplier and reorder level: a supplier cell is linked to the organization's existing supplier
 * of exactly that normalised name, otherwise reported on the row; no supplier is ever created.
 * A reorder level (packs) becomes the approved safety stock (PUR-07) of the branch the request
 * named, in units, when units per pack is known. Tax rate and shelf have no per-medicine field
 * in the catalogue; they stay in the row's source evidence.
 *
 * Idempotent: a row whose source identity (uploaded bytes' SHA-256 plus row number) already has a
 * link creates nothing again, whichever batch of those bytes is run. Each call creates at most
 * one chunk, so a 19,000-row catalogue is created in short transactions.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { deriveLooseUnitPrice, normalizeMedicineText, parseDefaultPackSize } from '../medicine';
import { applyLegacyControlledToMedicines } from './legacy-controlled';
import { isLegacyControlledRow } from './legacy-class';
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import { isStrengthPackLabel } from './source-values';

/**
 * Rows created per call. Every lookup is set-based, once per chunk (DEV-854's NARCOTICS rule
 * included), so a call stays a few seconds and a 19,000-row file finishes in about 19 calls.
 */
export const STAGED_CREATION_CHUNK = 1000;
export const STAGED_CREATION_OPERATION = 'createStagedMedicines';
const MAX_INT = 2_147_483_647;

/** Template and legacy headers this step reads from a row's source cells, after normalising. */
const GENERIC_HEADERS = ['genericname', 'generic', 'saltname', 'salt', 'formula'];
const LEGACY_CODE_HEADERS = ['legacycode', 'aliasname', 'oldcode', 'itemcode', 'productcode'];
const STRIPS_HEADERS = ['stripsperbox', 'stripsperpack', 'strips'];
const PACK_TYPE_HEADERS = ['packtype', 'packlevel'];
const SUPPLIER_HEADERS = ['supplier', 'suppliername', 'distributor', 'vendor'];
const REORDER_HEADERS = ['reorderlevel', 'reorderpoint', 'minimumstock', 'minstock'];

/** A whole number of packs above 0 ("20", "20.0"); anything else is not recorded. */
function reorderPacks(rawPayload: unknown): number | null {
  const cell = sourceCell(rawPayload, REORDER_HEADERS)?.replace(/\.0+$/, '') ?? '';
  if (!/^\d+$/.test(cell)) return null;
  return boundedInt(Number(cell), 1);
}

/** The pack level a "pack type" cell names; a legacy numeric pack column cannot say "strip". */
function namedLevel(rawPayload: unknown): PlannedPackLevel['level'] | null {
  const text = sourceCell(rawPayload, PACK_TYPE_HEADERS)?.toLowerCase() ?? '';
  if (/\b(?:strip|blister)s?\b/.test(text)) return 'STRIP';
  if (/\bcartons?\b/.test(text)) return 'CARTON';
  if (/\b(?:box|boxes|pack|packet)\b/.test(text)) return 'BOX';
  return null;
}

const COUNTED_PACKS = /\d+\s*(?:strip|blister|box|boxe|carton|pack|packet)s?\b/i;
const VOLUME = /\d\s*(?:ml|mls|l|ltr|litre|liter)(?![a-z])/i;

/**
 * Units in one pack. A strength ("500mg") is not a count and a volume ("100ML") is one
 * container, although the staged pack factor reads both as numbers; neither is ever taken as
 * a count of units.
 */
function unitsInPack(row: StagedRowForCreation): number | null {
  const label = row.packLabel ?? undefined;
  if (label && VOLUME.test(label)) return parseDefaultPackSize(label)?.unitsPerParent ?? null;
  if (isStrengthPackLabel(label)) return null;
  // "10 strips" or "2 boxes" counts packs, not units: what each holds is unknown, and the
  // publication path refuses the same labels. Only a label it can structure is kept.
  if (label && COUNTED_PACKS.test(label))
    return parseDefaultPackSize(label)?.unitsPerParent ?? null;
  return boundedInt(row.packFactor, 1);
}

const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function sourceCell(rawPayload: unknown, headers: readonly string[]): string | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;
  const cells = Object.entries(rawPayload as Record<string, unknown>);
  for (const wanted of headers)
    for (const [header, value] of cells)
      if (normalizeHeader(header) === wanted && typeof value === 'string' && value.trim())
        return value.trim().replace(/\s+/g, ' ');
  return null;
}

/** A stored money or count value, or null when absent or outside what the catalogue can hold. */
function boundedInt(value: bigint | number | null | undefined, min: number): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'bigint' ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= min && number <= MAX_INT ? number : null;
}

export type StagedRowForCreation = {
  id: string;
  sourceKey: string;
  rowNumber: number;
  productName: string | null;
  packLabel: string | null;
  packFactor: bigint | null;
  mrpMinor: bigint | null;
  costMinor: bigint | null;
  /** The staged barcode cell; absent on rows read before DEV-912. */
  barcode?: string | null;
  rawPayload: unknown;
};

export type PlannedPackLevel = {
  level: 'UNIT' | 'STRIP' | 'BOX' | 'CARTON';
  unitsPerParent: number;
};

export type StagedMedicinePlan = {
  productName: string;
  presentation: string;
  /** Outermost first; the first level carries the pack price. Empty: units per pack not recorded. */
  packLevels: PlannedPackLevel[];
  unitsPerPack: number | null;
  mrpMinor: number | null;
  purchasePriceMinor: number | null;
  genericName: string | null;
  legacyCode: string | null;
  /** The barcode printed on the pack, as read; null when the file had none. */
  barcode: string | null;
  /** The pack cell as read ("10 x 10", "500MG"); null when the file had none. */
  packLabel: string | null;
  /** The row itself is in the legacy NARCOTICS class (DEV-854). */
  narcoticsClass: boolean;
  /** The supplier cell as read; matched to an existing supplier, never created. */
  supplierName: string | null;
  /** Reorder level in whole packs; null when the file did not record one. */
  reorderLevelPacks: number | null;
};

/**
 * How many strips one box holds, when the file says so: a strips-per-box column, or a pack
 * written "10 x 10" (ten strips of ten). Only a whole split of the units per pack counts.
 */
function stripsPerBox(row: StagedRowForCreation, unitsPerPack: number): number | null {
  const column = sourceCell(row.rawPayload, STRIPS_HEADERS);
  const grid = row.packLabel?.trim().match(/^(\d+)\s*[x×*]\s*(\d+)(?:\s*[a-z']*)?$/i);
  const strips = column ? Number(column.replace(/\.0+$/, '')) : grid ? Number(grid[1]) : NaN;
  if (!Number.isSafeInteger(strips) || strips <= 1 || strips >= unitsPerPack) return null;
  return unitsPerPack % strips === 0 ? strips : null;
}

/** What one staged row becomes. Pure: no value is invented, a missing one stays null. */
export function planStagedMedicine(row: StagedRowForCreation): StagedMedicinePlan | null {
  const productName = row.productName?.trim().replace(/\s+/g, ' ').slice(0, 300) ?? '';
  if (!productName) return null;
  const unitsPerPack = unitsInPack(row);
  let packLevels: PlannedPackLevel[] = [];
  if (unitsPerPack === 1) packLevels = [{ level: 'UNIT', unitsPerParent: 1 }];
  else if (unitsPerPack !== null) {
    const strips = stripsPerBox(row, unitsPerPack);
    const described = row.packLabel ? parseDefaultPackSize(row.packLabel) : null;
    packLevels = strips
      ? [
          { level: 'BOX', unitsPerParent: strips },
          { level: 'STRIP', unitsPerParent: unitsPerPack / strips },
        ]
      : [
          {
            level:
              namedLevel(row.rawPayload) ??
              (described && described.unitsPerParent === unitsPerPack ? described.level : 'BOX'),
            unitsPerParent: unitsPerPack,
          },
        ];
  }
  const packLabel = row.packLabel?.trim().slice(0, 300);
  return {
    productName,
    presentation:
      packLabel ||
      (unitsPerPack
        ? `${unitsPerPack} unit${unitsPerPack === 1 ? '' : 's'} per pack`
        : 'Pack size not recorded'),
    packLevels,
    unitsPerPack,
    // A price of 0 is an empty cell in most legacy exports: stored as not recorded, never as 0.
    mrpMinor: boundedInt(row.mrpMinor, 1),
    purchasePriceMinor: boundedInt(row.costMinor, 1),
    genericName: sourceCell(row.rawPayload, GENERIC_HEADERS)?.slice(0, 300) ?? null,
    legacyCode: sourceCell(row.rawPayload, LEGACY_CODE_HEADERS)?.slice(0, 200) ?? null,
    barcode:
      row.barcode && normalizeMedicineText(row.barcode) ? row.barcode.trim().slice(0, 64) : null,
    packLabel: packLabel || null,
    narcoticsClass: isLegacyControlledRow(row.rawPayload),
    supplierName: sourceCell(row.rawPayload, SUPPLIER_HEADERS)?.slice(0, 300) ?? null,
    reorderLevelPacks: reorderPacks(row.rawPayload),
  };
}

/**
 * The approved safety stock (PUR-07) a reorder level becomes: packs times units per pack.
 * Null when either is not recorded, or the result is more than the catalogue can hold.
 */
export function stagedReorderUnits(
  plan: Pick<StagedMedicinePlan, 'reorderLevelPacks' | 'unitsPerPack'>
): number | null {
  if (plan.reorderLevelPacks === null || plan.unitsPerPack === null) return null;
  return boundedInt(plan.reorderLevelPacks * plan.unitsPerPack, 1);
}

/**
 * The price of one pack at each level, and of one unit, from the pack MRP. A level's price is
 * the pack MRP shared over how many of that level one pack holds, rounded down so the counter
 * never charges above the printed MRP. Null when the MRP or the units per pack is not recorded.
 */
export function stagedLevelPrices(plan: Pick<StagedMedicinePlan, 'mrpMinor' | 'packLevels'>) {
  const mrpMinor = plan.mrpMinor;
  if (mrpMinor === null || !plan.packLevels.length) return null;
  const share = (count: number) =>
    deriveLooseUnitPrice({
      printedMrpMinor: mrpMinor,
      canonicalUnitsInPack: count,
      roundingIncrementMinor: 1,
    }).unitPriceMinor;
  // How many packs of each level one outer pack holds: 1 for the outer, then the running product.
  let inside = 1;
  const levels = plan.packLevels.map((level, index) => {
    if (index > 0) inside *= plan.packLevels[index - 1]!.unitsPerParent;
    return { level: level.level, priceMinor: share(inside) };
  });
  const units = plan.packLevels.reduce((total, level) => total * level.unitsPerParent, 1);
  return { levels, unitPriceMinor: share(units) };
}

const candidate = (alias: string) => Prisma.sql`
      ${Prisma.raw(alias)}."targetModelKey" = ${MIGRATION_TARGET_KEYS.PRODUCT}
  AND btrim(COALESCE(${Prisma.raw(alias)}."productName", '')) <> ''`;
const linked = (organizationId: string, alias: string) => Prisma.sql`EXISTS (
  SELECT 1 FROM "pharmacy_staged_medicine_links" l
   WHERE l."organizationId" = ${organizationId} AND l."sourceKey" = ${Prisma.raw(alias)}."sourceKey")`;

export type StagedCreationProgress = {
  /** Named product rows that become medicines. */
  candidates: number;
  /** Of those, rows already done: a medicine created, or matched to one from an earlier file. */
  done: number;
  remaining: number;
  /** Rows with no medicine name; nothing is created for them. */
  unnamed: number;
  /** Done rows that named a medicine an earlier staged file already created; no copy was made. */
  matchedEarlier: number;
  /** Rows whose barcode already belonged to another pack: reported, not attached, never moved. */
  barcodesNotAttached: number;
  /** Rows naming a supplier that is not exactly one existing supplier: reported, not created. */
  suppliersNotMatched: number;
  /** Rows whose reorder level did not become a safety stock (no branch, pack size or match). */
  reorderLevelsNotApplied: number;
};

export async function stagedCreationProgress(
  db: Pick<ScopedDb, '$queryRaw'>,
  organizationId: string,
  batchId: string
): Promise<StagedCreationProgress> {
  const [counts] = await db.$queryRaw<
    { candidates: bigint; done: bigint; unnamed: bigint }[]
  >`SELECT count(*) FILTER (WHERE ${candidate('r')}) AS "candidates",
           count(*) FILTER (WHERE ${candidate('r')} AND ${linked(organizationId, 'r')}) AS "done",
           count(*) FILTER (WHERE NOT (${candidate('r')})) AS "unnamed"
      FROM "pharmacy_migration_rows" r
     WHERE r."organizationId" = ${organizationId} AND r."batchId" = ${batchId}`;
  const [outcomes] = await db.$queryRaw<
    { matched: bigint; barcodes: bigint; suppliers: bigint; reorders: bigint }[]
  >`
    SELECT count(*) FILTER (WHERE l."outcome" = 'MATCHED') AS "matched",
           count(*) FILTER (WHERE l."barcodeAttached" = false) AS "barcodes",
           count(*) FILTER (WHERE l."supplierName" IS NOT NULL AND l."supplierId" IS NULL) AS "suppliers",
           count(*) FILTER (WHERE l."reorderLevelApplied" = false) AS "reorders"
      FROM "pharmacy_staged_medicine_links" l
      JOIN "pharmacy_migration_rows" r
        ON r."organizationId" = l."organizationId" AND r."sourceKey" = l."sourceKey"
     WHERE l."organizationId" = ${organizationId} AND r."batchId" = ${batchId}`;
  const candidates = Number(counts?.candidates ?? 0);
  const done = Number(counts?.done ?? 0);
  return {
    candidates,
    done,
    remaining: candidates - done,
    unnamed: Number(counts?.unnamed ?? 0),
    matchedEarlier: Number(outcomes?.matched ?? 0),
    barcodesNotAttached: Number(outcomes?.barcodes ?? 0),
    suppliersNotMatched: Number(outcomes?.suppliers ?? 0),
    reorderLevelsNotApplied: Number(outcomes?.reorders ?? 0),
  };
}

type EarlierMedicine = {
  key: string;
  medicineId: string;
  packLevelId: string | null;
  productName: string;
  controlled: boolean;
};

/** The one normalisation rule for match keys: Unicode-compatible, trimmed, one space, lower case. */
export const normalizeMatchText = (text: string) =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * How a later file's row is recognised as a medicine an earlier file created: by its old code,
 * or, with no code, by name AND units per pack AND the pack cell as read, so "500MG" and
 * "250MG" of one name stay two medicines. A row with neither a pack size nor a pack cell is
 * never matched by name alone (null): it is created. The key is computed here once and stored
 * on the link, so the database only compares stored keys and never normalises text itself.
 */
export function stagedMatchKey(
  plan: Pick<StagedMedicinePlan, 'legacyCode' | 'productName' | 'unitsPerPack' | 'packLabel'>
): string | null {
  if (plan.legacyCode) return `code:${normalizeMatchText(plan.legacyCode)}`;
  const label = plan.packLabel ? normalizeMatchText(plan.packLabel) : '';
  if (plan.unitsPerPack === null && !label) return null;
  return `name:${normalizeMatchText(plan.productName)}|${plan.unitsPerPack ?? ''}|${label}`;
}

/**
 * Medicines an earlier staged file of this organization created, by stored match key. A
 * re-exported file of the same catalogue has different bytes, so its rows have new source
 * identities; this is what keeps it from creating every medicine a second time.
 */
async function earlierMedicines(
  tx: ScopedDb,
  organizationId: string,
  batchId: string,
  plans: readonly StagedMedicinePlan[]
) {
  const keys = [...new Set(plans.flatMap((plan) => stagedMatchKey(plan) ?? []))];
  const found = keys.length
    ? await tx.$queryRaw<EarlierMedicine[]>`
        SELECT DISTINCT ON (l."matchKey") l."matchKey" AS "key", l."medicineId", l."packLevelId",
               m."productName", m."controlled"
          FROM "pharmacy_staged_medicine_links" l
          JOIN "pharmacy_medicines" m
            ON m."organizationId" = l."organizationId" AND m."id" = l."medicineId"
         WHERE l."organizationId" = ${organizationId}
           AND l."batchId" <> ${batchId}
           AND l."outcome" = 'CREATED'
           AND l."matchKey" = ANY(${keys}::text[])
         ORDER BY l."matchKey", l."createdAt", l."id"`
    : [];
  const byKey = new Map(found.map((row) => [row.key, row]));
  return (plan: StagedMedicinePlan) => {
    const key = stagedMatchKey(plan);
    return key ? byKey.get(key) : undefined;
  };
}

/**
 * The organization's existing supplier a supplier cell names: exactly one supplier whose name is
 * the same after `normalizeMatchText`. None, or two that normalise alike, is no match: the row
 * reports the name and no supplier is ever created here.
 */
async function supplierMatcher(tx: ScopedDb, plans: readonly StagedMedicinePlan[]) {
  if (!plans.some((plan) => plan.supplierName)) return () => null;
  const byName = new Map<string, string | null>();
  for (const supplier of await tx.pharmacySupplier.findMany({ select: { id: true, name: true } })) {
    const key = normalizeMatchText(supplier.name);
    byName.set(key, byName.has(key) ? null : supplier.id);
  }
  return (name: string | null) => (name ? (byName.get(normalizeMatchText(name)) ?? null) : null);
}

/** A barcode of 8, 12, 13 or 14 digits is a GTIN; any other printed code is the maker's own. */
const barcodeType = (code: string) =>
  /^(?:\d{8}|\d{12,14})$/.test(code) ? 'GTIN' : 'MANUFACTURER';

/**
 * Create the next chunk of medicines for an approved request. Call inside one transaction; the
 * organization-wide lock makes concurrent runs (of this batch or another batch of the same
 * bytes) wait, and the unique source identity on the link refuses any double creation.
 */
export async function createStagedMedicinesChunk(
  tx: ScopedDb,
  scope: { organizationId: string; actorId: string },
  request: {
    editId: string;
    editorId: string;
    reviewerId: string;
    batchId: string;
    /**
     * The branch whose approved safety stock the file's reorder levels become; null when the
     * request named none (the requester could not set stock thresholds there).
     */
    reorderBranchId?: string | null;
  },
  limit = STAGED_CREATION_CHUNK
) {
  const { organizationId } = scope;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-staged-medicine-create:${organizationId}`}, 0))`;
  const rows = await tx.$queryRaw<StagedRowForCreation[]>`
    SELECT r."id", r."sourceKey", r."rowNumber", r."productName", r."packLabel", r."packFactor",
           r."mrpMinor", r."costMinor", r."barcode", r."rawPayload"
      FROM "pharmacy_migration_rows" r
     WHERE r."organizationId" = ${organizationId}
       AND r."batchId" = ${request.batchId}
       AND ${candidate('r')}
       AND NOT ${linked(organizationId, 'r')}
     ORDER BY r."rowNumber", r."id"
     LIMIT ${limit}`;
  const planned = rows.flatMap((row) => {
    const plan = planStagedMedicine(row);
    return plan ? [{ row, plan }] : [];
  });
  const earlier = await earlierMedicines(
    tx,
    organizationId,
    request.batchId,
    planned.map((item) => item.plan)
  );
  // A barcode is unique in the organization: one already on another pack is skipped and
  // reported on the row's link, never moved; within this chunk the first row keeps it.
  const wanted = [
    ...new Set(
      planned.flatMap(({ plan }) => (plan.barcode ? [normalizeMedicineText(plan.barcode)] : []))
    ),
  ];
  const taken = new Set(
    wanted.length
      ? (
          await tx.medicineBarcode.findMany({
            where: { normalizedCode: { in: wanted } },
            select: { normalizedCode: true },
          })
        ).map((barcode) => barcode.normalizedCode)
      : []
  );
  const supplierOf = await supplierMatcher(
    tx,
    planned.map((item) => item.plan)
  );
  const reorderBranchId = request.reorderBranchId ?? null;
  const now = new Date();
  const medicines: Prisma.MedicineCreateManyInput[] = [];
  const safetyStocks: Prisma.PharmacySafetyStockCreateManyInput[] = [];
  const presentations: Prisma.PresentationCreateManyInput[] = [];
  const outerLevels: Prisma.PackLevelCreateManyInput[] = [];
  const innerLevels: Prisma.PackLevelCreateManyInput[] = [];
  const prices: Prisma.PharmacyPackPriceCreateManyInput[] = [];
  const aliases: Prisma.MedicineAliasCreateManyInput[] = [];
  const barcodes: Prisma.MedicineBarcodeCreateManyInput[] = [];
  const provenance: Prisma.MedicineProvenanceCreateManyInput[] = [];
  const links: Prisma.PharmacyStagedMedicineLinkCreateManyInput[] = [];
  // The barcode each created row asked for, by its link, to confirm it was attached.
  const barcodeOfLink = new Map<Prisma.PharmacyStagedMedicineLinkCreateManyInput, string>();
  const created: { id: string; productName: string }[] = [];
  const matched = new Map<string, EarlierMedicine>();
  for (const { row, plan } of planned) {
    const link = {
      sourceKey: row.sourceKey,
      batchId: request.batchId,
      rowId: row.id,
      editId: request.editId,
      unitsPerPack: plan.unitsPerPack,
      mrpMinor: plan.mrpMinor,
      purchasePriceMinor: plan.purchasePriceMinor,
      legacyCode: plan.legacyCode,
      matchKey: stagedMatchKey(plan),
      supplierName: plan.supplierName,
      supplierId: supplierOf(plan.supplierName),
      reorderLevelPacks: plan.reorderLevelPacks,
      createdById: scope.actorId,
    };
    const existing = earlier(plan);
    if (existing) {
      // The medicine is already in the catalogue from an earlier file: link the row, add nothing.
      // Its barcode is reported as not added, because the existing medicine is not changed here.
      links.push({
        ...link,
        medicineId: existing.medicineId,
        packLevelId: existing.packLevelId,
        outcome: 'MATCHED',
        barcode: plan.barcode,
        barcodeAttached: plan.barcode ? false : null,
        // The existing medicine's thresholds are not changed here either.
        reorderLevelApplied: plan.reorderLevelPacks === null ? null : false,
      });
      matched.set(existing.medicineId, existing);
      continue;
    }
    const medicineId = randomUUID();
    const presentationId = randomUUID();
    medicines.push({
      id: medicineId,
      productName: plan.productName,
      productFamily: 'PHARMACEUTICAL',
      // The batch approval is the recorded review; missing strength and registration are
      // stored as not recorded for an imported identity (DEV-852), never a reason to hold sale.
      saleable: true,
    });
    presentations.push({ id: presentationId, medicineId, presentation: plan.presentation });
    let parentId: string | null = null;
    let outerId: string | null = null;
    for (const [index, level] of plan.packLevels.entries()) {
      const id = randomUUID();
      (index === 0 ? outerLevels : innerLevels).push({
        id,
        presentationId,
        parentPackLevelId: parentId,
        versionGroupId: randomUUID(),
        version: 1,
        level: level.level,
        unitsPerParent: level.unitsPerParent,
        effectiveFrom: now,
      });
      if (index === 0) outerId = id;
      parentId = id;
    }
    if (outerId && plan.mrpMinor !== null)
      prices.push({
        organizationId,
        presentationId,
        packLevelId: outerId,
        mrpMinor: plan.mrpMinor,
        sellingPriceMinor: null,
        effectiveFrom: now,
        source: 'import',
        // DEV-928: the approver wrote the price; the editor who asked for the creation proposed it.
        createdById: request.reviewerId,
        proposedById: request.editorId,
      });
    for (const [type, value] of [
      ['GENERIC', plan.genericName],
      ['LEGACY_CODE', plan.legacyCode],
    ] as const)
      if (value)
        aliases.push({ medicineId, type, value, normalizedValue: normalizeMedicineText(value) });
    let barcodeId: string | undefined;
    if (plan.barcode) {
      const normalizedCode = normalizeMedicineText(plan.barcode);
      if (!taken.has(normalizedCode)) {
        taken.add(normalizedCode);
        barcodeId = randomUUID();
        barcodes.push({
          id: barcodeId,
          presentationId,
          packLevelId: outerId,
          type: barcodeType(plan.barcode),
          code: plan.barcode,
          normalizedCode,
        });
      }
    }
    const evidence = {
      batchId: request.batchId,
      rowSourceKey: row.sourceKey,
      rowNumber: row.rowNumber,
    };
    const asserted: [string, string | number | null][] = [
      ['productName', plan.productName],
      ['pack', plan.unitsPerPack === null ? null : plan.presentation],
      ['unitsPerPack', plan.unitsPerPack],
      ['mrpMinor', plan.mrpMinor],
      ['purchasePriceMinor', plan.purchasePriceMinor],
      ['alias', plan.genericName],
      ['legacyCode', plan.legacyCode],
      ['barcode', barcodeId ? plan.barcode : null],
    ];
    for (const [field, value] of asserted)
      if (value !== null)
        provenance.push({
          medicineId,
          field,
          source: `staged-import:${row.sourceKey}`,
          sourceType: 'IMPORT',
          retrievedAt: now,
          editorId: request.editorId,
          reviewer: request.reviewerId,
          status: 'ACCEPTED',
          assertedValue: { value, ...evidence },
        });
    // PUR-07: a reorder level is the branch's approved safety stock, counted in units. The
    // batch approver approves it, as they approve the pack price.
    const reorderUnits = reorderBranchId ? stagedReorderUnits(plan) : null;
    if (reorderUnits !== null)
      safetyStocks.push({
        organizationId,
        branchId: reorderBranchId!,
        medicineId,
        safetyStockUnits: reorderUnits,
        approvedByUserId: request.reviewerId,
        approvedAt: now,
      });
    links.push({
      ...link,
      medicineId,
      packLevelId: outerId,
      barcode: plan.barcode,
      barcodeAttached: plan.barcode ? Boolean(barcodeId) : null,
      reorderLevelApplied: plan.reorderLevelPacks === null ? null : reorderUnits !== null,
    });
    if (barcodeId) barcodeOfLink.set(links.at(-1)!, barcodeId);
    created.push({ id: medicineId, productName: plan.productName });
  }
  if (medicines.length) {
    await tx.medicine.createMany({ data: medicines });
    await tx.presentation.createMany({ data: presentations });
    // Parents first: the hierarchy trigger reads a child's parent from an earlier statement.
    if (outerLevels.length) await tx.packLevel.createMany({ data: outerLevels });
    if (innerLevels.length) await tx.packLevel.createMany({ data: innerLevels });
    if (aliases.length) await tx.medicineAlias.createMany({ data: aliases, skipDuplicates: true });
    await tx.medicineProvenance.createMany({ data: provenance });
  }
  if (barcodes.length) {
    // A barcode another person added since it was checked is skipped too, and reported.
    await tx.medicineBarcode.createMany({ data: barcodes, skipDuplicates: true });
    const attached = new Set(
      (
        await tx.medicineBarcode.findMany({
          where: { id: { in: barcodes.map((barcode) => barcode.id!) } },
          select: { id: true },
        })
      ).map((barcode) => barcode.id)
    );
    for (const [link, barcodeId] of barcodeOfLink)
      if (!attached.has(barcodeId)) link.barcodeAttached = false;
  }
  if (safetyStocks.length) await tx.pharmacySafetyStock.createMany({ data: safetyStocks });
  if (links.length) await tx.pharmacyStagedMedicineLink.createMany({ data: links });
  // DEV-854: the shared legacy NARCOTICS rule, for every medicine this step creates or matches,
  // in one set-based statement for the chunk.
  const controlled = (
    await applyLegacyControlledToMedicines(tx, organizationId, [
      ...created.map((item) => ({ ...item, controlled: false })),
      ...[...matched.values()].map((item) => ({
        id: item.medicineId,
        productName: item.productName,
        controlled: item.controlled,
      })),
    ])
  ).length;
  if (prices.length) {
    // Pack prices are written under the organization's price lock, as every price write is.
    // Taken last, so the lock is held only while this chunk commits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('pharmacy-pack-prices'))`;
    await tx.pharmacyPackPrice.createMany({ data: prices });
  }
  return {
    created: created.length,
    matched: links.filter((link) => link.outcome === 'MATCHED').length,
    controlled,
    medicineIds: created.map((medicine) => medicine.id),
    ...(await stagedCreationProgress(tx, organizationId, request.batchId)),
  };
}
