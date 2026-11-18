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
 * Idempotent: a row whose source identity (uploaded bytes' SHA-256 plus row number) already has a
 * link creates nothing again, whichever batch of those bytes is run. Each call creates at most
 * one chunk, so a 19,000-row catalogue is created in short transactions.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { deriveLooseUnitPrice, normalizeMedicineText, parseDefaultPackSize } from '../medicine';
import { applyLegacyControlledToMedicine } from './legacy-controlled';
import { isLegacyControlledRow } from './legacy-class';
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import { isStrengthPackLabel } from './source-values';

/**
 * Rows created per call. DEV-854's shared lookup runs once for every medicine and reads the
 * organization's staged rows under row-level security (about 40 ms each on a 19,000-row file),
 * so one call stays near ten seconds and a 19,000-row file finishes in about 80 calls.
 */
export const STAGED_CREATION_CHUNK = 250;
export const STAGED_CREATION_OPERATION = 'createStagedMedicines';
const MAX_INT = 2_147_483_647;

/** Template and legacy headers this step reads from a row's source cells, after normalising. */
const GENERIC_HEADERS = ['genericname', 'generic', 'saltname', 'salt', 'formula'];
const LEGACY_CODE_HEADERS = ['legacycode', 'aliasname', 'oldcode', 'itemcode', 'productcode'];
const STRIPS_HEADERS = ['stripsperbox', 'stripsperpack', 'strips'];
const PACK_TYPE_HEADERS = ['packtype', 'packlevel'];

/** The pack level a "pack type" cell names; a legacy numeric pack column cannot say "strip". */
function namedLevel(rawPayload: unknown): PlannedPackLevel['level'] | null {
  const text = sourceCell(rawPayload, PACK_TYPE_HEADERS)?.toLowerCase() ?? '';
  if (/\b(?:strip|blister)s?\b/.test(text)) return 'STRIP';
  if (/\bcartons?\b/.test(text)) return 'CARTON';
  if (/\b(?:box|boxes|pack|packet)\b/.test(text)) return 'BOX';
  return null;
}

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
  /** The row itself is in the legacy NARCOTICS class (DEV-854). */
  narcoticsClass: boolean;
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
    mrpMinor: boundedInt(row.mrpMinor, 0),
    purchasePriceMinor: boundedInt(row.costMinor, 0),
    genericName: sourceCell(row.rawPayload, GENERIC_HEADERS)?.slice(0, 300) ?? null,
    legacyCode: sourceCell(row.rawPayload, LEGACY_CODE_HEADERS)?.slice(0, 200) ?? null,
    narcoticsClass: isLegacyControlledRow(row.rawPayload),
  };
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
  /** Of those, rows that already have a catalogue medicine. */
  done: number;
  remaining: number;
  /** Rows with no medicine name; nothing is created for them. */
  unnamed: number;
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
  const candidates = Number(counts?.candidates ?? 0);
  const done = Number(counts?.done ?? 0);
  return { candidates, done, remaining: candidates - done, unnamed: Number(counts?.unnamed ?? 0) };
}

/**
 * Create the next chunk of medicines for an approved request. Call inside one transaction; the
 * organization-wide lock makes concurrent runs (of this batch or another batch of the same
 * bytes) wait, and the unique source identity on the link refuses any double creation.
 */
export async function createStagedMedicinesChunk(
  tx: ScopedDb,
  scope: { organizationId: string; actorId: string },
  request: { editId: string; editorId: string; reviewerId: string; batchId: string },
  limit = STAGED_CREATION_CHUNK
) {
  const { organizationId } = scope;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-staged-medicine-create:${organizationId}`}, 0))`;
  const rows = await tx.$queryRaw<StagedRowForCreation[]>`
    SELECT r."id", r."sourceKey", r."rowNumber", r."productName", r."packLabel", r."packFactor",
           r."mrpMinor", r."costMinor", r."rawPayload"
      FROM "pharmacy_migration_rows" r
     WHERE r."organizationId" = ${organizationId}
       AND r."batchId" = ${request.batchId}
       AND ${candidate('r')}
       AND NOT ${linked(organizationId, 'r')}
     ORDER BY r."rowNumber", r."id"
     LIMIT ${limit}`;
  const now = new Date();
  const medicines: Prisma.MedicineCreateManyInput[] = [];
  const presentations: Prisma.PresentationCreateManyInput[] = [];
  const outerLevels: Prisma.PackLevelCreateManyInput[] = [];
  const innerLevels: Prisma.PackLevelCreateManyInput[] = [];
  const prices: Prisma.PharmacyPackPriceCreateManyInput[] = [];
  const aliases: Prisma.MedicineAliasCreateManyInput[] = [];
  const provenance: Prisma.MedicineProvenanceCreateManyInput[] = [];
  const links: Prisma.PharmacyStagedMedicineLinkCreateManyInput[] = [];
  const created: { id: string; productName: string }[] = [];
  for (const row of rows) {
    const plan = planStagedMedicine(row);
    if (!plan) continue;
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
        createdById: request.reviewerId,
      });
    for (const [type, value] of [
      ['GENERIC', plan.genericName],
      ['LEGACY_CODE', plan.legacyCode],
    ] as const)
      if (value)
        aliases.push({ medicineId, type, value, normalizedValue: normalizeMedicineText(value) });
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
    links.push({
      sourceKey: row.sourceKey,
      batchId: request.batchId,
      rowId: row.id,
      editId: request.editId,
      medicineId,
      packLevelId: outerId,
      unitsPerPack: plan.unitsPerPack,
      mrpMinor: plan.mrpMinor,
      purchasePriceMinor: plan.purchasePriceMinor,
      legacyCode: plan.legacyCode,
      createdById: scope.actorId,
    });
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
    await tx.pharmacyStagedMedicineLink.createMany({ data: links });
  }
  // DEV-854: the shared legacy NARCOTICS rule, for every medicine this step creates.
  let controlled = 0;
  for (const medicine of created)
    if (
      await applyLegacyControlledToMedicine(tx, organizationId, {
        ...medicine,
        controlled: false,
      })
    )
      controlled += 1;
  if (prices.length) {
    // Pack prices are written under the organization's price lock, as every price write is.
    // Taken last, so the lock is held only while this chunk commits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('pharmacy-pack-prices'))`;
    await tx.pharmacyPackPrice.createMany({ data: prices });
  }
  return {
    created: created.length,
    controlled,
    medicineIds: created.map((medicine) => medicine.id),
    ...(await stagedCreationProgress(tx, organizationId, request.batchId)),
  };
}
