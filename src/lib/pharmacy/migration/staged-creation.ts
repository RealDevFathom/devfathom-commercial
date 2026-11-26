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
 *
 * One row never blocks the others (DEV-1002): a value the catalogue cannot hold as an alias or a
 * barcode is left off and the medicine is still created; a row the database still refuses is
 * found by retrying halves of the chunk under a savepoint, recorded on its link as NOT_CREATED
 * with a plain reason, and every other row is created. A refusal is never retried, so pressing
 * Create medicines again always moves on to the rest of the file.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { deriveLooseUnitPrice, normalizeMedicineText, parseDefaultPackSize } from '../medicine';
import { abuzarMedicines } from './abuzar-catalogue';
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

/**
 * DEV-1002: what the screen says when a creation step stops for a reason that is not a row of
 * the file (rows are recorded one by one and never stop a step). Plain words and a next step;
 * the codes go to the server log and the audit record.
 */
export const STAGED_CREATION_BUSY =
  'The server was busy, so this step was undone. Medicines already created are kept. Press Create medicines to carry on.';
export const STAGED_CREATION_STOPPED =
  'Creating stopped because of a problem on the server, not a row in your file. Medicines already created are kept and none is made twice. Press Create medicines once more; if this message comes back, contact DevFathom support and say when it happened.';

/** A failure that passes by itself: a timeout, a lock, a lost or busy connection. */
export function isPassingFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^P(?:1001|1002|1008|1017|2024|2028|2034)$/.test(code))
    return true;
  const state = sqlState(error);
  return state !== null && /^(?:08|40|53|55P03|57014|57P0)/.test(state);
}

const MAX_INT = 2_147_483_647;

/**
 * At most `max` UTF-16 units of `text`, never ending inside a character: half an emoji is not
 * valid text, and PostgreSQL refuses it in the import provenance (DEV-1002).
 */
export function cutText(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** A code or name with no letter or digit ("-", ".", "*") records nothing: not recorded. */
function recorded(value: string | null | undefined, max: number): string | null {
  return value && normalizeMedicineText(value) ? cutText(value, max) : null;
}

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
  preparedAbuzar?: boolean;
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
  const productName = cutText(row.productName?.trim().replace(/\s+/g, ' ') ?? '', 300);
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
  const packLabel = row.packLabel && cutText(row.packLabel.trim(), 300);
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
    genericName: recorded(sourceCell(row.rawPayload, GENERIC_HEADERS), 300),
    legacyCode: recorded(sourceCell(row.rawPayload, LEGACY_CODE_HEADERS), 200),
    barcode: recorded(row.barcode?.trim(), 64),
    packLabel: packLabel || null,
    narcoticsClass: isLegacyControlledRow(row.rawPayload),
    supplierName: recorded(sourceCell(row.rawPayload, SUPPLIER_HEADERS), 300),
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
  /** Of those, rows the database refused (DEV-1002): recorded with a reason, nothing created. */
  notCreated: number;
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
  /** Rows whose old code or generic name was left off: the catalogue cannot search it. */
  aliasesNotAdded: number;
};

export async function stagedCreationProgress(
  db: Pick<ScopedDb, '$queryRaw'>,
  organizationId: string,
  batchId: string
): Promise<StagedCreationProgress> {
  const [counts] = await db.$queryRaw<
    { candidates: bigint; linked: bigint; unnamed: bigint }[]
  >`SELECT count(*) FILTER (WHERE ${candidate('r')}) AS "candidates",
           count(*) FILTER (WHERE ${candidate('r')} AND ${linked(organizationId, 'r')}) AS "linked",
           count(*) FILTER (WHERE NOT (${candidate('r')})) AS "unnamed"
      FROM "pharmacy_migration_rows" r
     WHERE r."organizationId" = ${organizationId} AND r."batchId" = ${batchId}`;
  const [outcomes] = await db.$queryRaw<
    {
      matched: bigint;
      notCreated: bigint;
      barcodes: bigint;
      suppliers: bigint;
      reorders: bigint;
      aliases: bigint;
    }[]
  >`
    SELECT count(*) FILTER (WHERE l."outcome" = 'MATCHED') AS "matched",
           count(*) FILTER (WHERE l."outcome" = 'NOT_CREATED') AS "notCreated",
           count(*) FILTER (WHERE l."barcodeAttached" = false) AS "barcodes",
           count(*) FILTER (WHERE l."supplierName" IS NOT NULL AND l."supplierId" IS NULL) AS "suppliers",
           count(*) FILTER (WHERE l."reorderLevelApplied" = false) AS "reorders",
           count(*) FILTER (WHERE cardinality(l."aliasesNotAdded") > 0) AS "aliases"
      FROM "pharmacy_staged_medicine_links" l
      JOIN "pharmacy_migration_rows" r
        ON r."organizationId" = l."organizationId" AND r."sourceKey" = l."sourceKey"
     WHERE l."organizationId" = ${organizationId} AND r."batchId" = ${batchId}`;
  const candidates = Number(counts?.candidates ?? 0);
  const linkedRows = Number(counts?.linked ?? 0);
  const notCreated = Number(outcomes?.notCreated ?? 0);
  return {
    candidates,
    done: linkedRows - notCreated,
    notCreated,
    remaining: candidates - linkedRows,
    unnamed: Number(counts?.unnamed ?? 0),
    matchedEarlier: Number(outcomes?.matched ?? 0),
    barcodesNotAttached: Number(outcomes?.barcodes ?? 0),
    suppliersNotMatched: Number(outcomes?.suppliers ?? 0),
    reorderLevelsNotApplied: Number(outcomes?.reorders ?? 0),
    aliasesNotAdded: Number(outcomes?.aliases ?? 0),
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
 * The database's own normalised form of each alias and barcode value, in one statement. The
 * catalogue triggers compare stored values with `pharmacy_normalize_catalog_text`, which reads
 * some characters differently from `normalizeMedicineText` ("B₁₂", "½", "①"), and an empty
 * result cannot be stored at all (DEV-1002). Empty: leave the value off.
 */
export async function catalogueNormalizer(tx: ScopedDb, values: readonly string[]) {
  const unique = [...new Set(values)];
  const found = unique.length
    ? await tx.$queryRaw<{ value: string; normalized: string | null }[]>`
        SELECT v AS "value", pharmacy_normalize_catalog_text(v) AS "normalized"
          FROM unnest(${unique}::text[]) AS v`
    : [];
  const byValue = new Map(found.map((row) => [row.value, row.normalized ?? '']));
  return (value: string) => byValue.get(value) ?? '';
}

type DriverError = {
  code?: unknown;
  meta?: {
    modelName?: unknown;
    code?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } };
  };
};

/** The SQLSTATE of a database error, as Prisma's PostgreSQL adapter reports it. */
function sqlState(error: unknown): string | null {
  const meta = (error as DriverError | null)?.meta;
  const code = meta?.driverAdapterError?.cause?.originalCode ?? meta?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * True when the database refused the data itself, which happens again on every retry: a data
 * exception (class 22), a broken constraint (23), a value past a limit (54) or a catalogue
 * trigger's own refusal (P0001). A busy server, a lost connection, a lock or a timeout is not:
 * the whole step is undone and can simply run again.
 */
export function isRowRefusal(error: unknown): boolean {
  const state = sqlState(error);
  return state !== null && (/^(?:22|23|54)/.test(state) || state === 'P0001');
}

const CORRECT_AND_UPLOAD =
  ' Correct the row in the file and upload the file again: medicines already created are matched, never made twice.';

/** What the person who imported the file reads on a row the database refused. */
export function notCreatedReason(error: unknown): string {
  const state = sqlState(error) ?? '';
  if (state === '23505')
    return `A code or barcode in this row is already used in your catalogue.${CORRECT_AND_UPLOAD}`;
  if (state === '22001' || state.startsWith('54'))
    return `A cell in this row is too long for the catalogue.${CORRECT_AND_UPLOAD}`;
  if (state === '22003')
    return `A number in this row is too large for the catalogue.${CORRECT_AND_UPLOAD}`;
  if (state.startsWith('22'))
    return `A cell in this row has characters the catalogue cannot store.${CORRECT_AND_UPLOAD}`;
  return `A value in this row is not accepted by the catalogue.${CORRECT_AND_UPLOAD}`;
}

const NO_NAME_REASON = `This row has no medicine name the catalogue can use.${CORRECT_AND_UPLOAD}`;

/** The cause of a refusal in a few plain words, for the message when many rows share it. */
export function refusalCause(error: unknown): string {
  const state = sqlState(error) ?? '';
  if (state === '23505') return 'a code or barcode is already used in your catalogue';
  if (state === '22001' || state.startsWith('54')) return 'a cell is too long for the catalogue';
  if (state === '22003') return 'a number is too large for the catalogue';
  if (state.startsWith('22')) return 'a cell has characters the catalogue cannot store';
  return 'a value is not accepted by the catalogue';
}

/**
 * DEV-1002: more rows than this refused for one and the same reason in a step (or every row of
 * a step of two or more, all for that one reason: DEV-1004) is not a few bad rows in the file but a cause that would refuse any row,
 * such as a broken rule in the database. A NOT_CREATED record is permanent, so such a step is
 * undone and nothing is recorded; it stops as soon as the bound is passed.
 */
export const STAGED_SYSTEMIC_REFUSALS = 25;
export const STAGED_CREATION_SYSTEMIC_PREFIX = 'Creating stopped:';

/** A step stopped because many rows were refused for the same reason: nothing is recorded. */
export class StagedCreationSystemicRefusal extends Error {
  constructor(
    readonly refusal: unknown,
    readonly rows: number
  ) {
    super(
      `${STAGED_CREATION_SYSTEMIC_PREFIX} many rows were refused for the same reason: ${refusalCause(refusal)}. Nothing was recorded for these rows, and medicines already created are kept. Tell your administrator.`
    );
    this.name = 'StagedCreationSystemicRefusal';
  }
}

/** One key per cause: the same code on the same table and constraint. */
const causeKey = (error: unknown) => {
  const detail = failureDetail(error);
  return [detail.prismaCode, detail.sqlState, detail.model, detail.constraint].join('|');
};

/**
 * What a failure was, for the server log and the audit record: codes and the constraint's name,
 * never a cell value (a database message can quote one).
 */
export function failureDetail(error: unknown) {
  const failure = error as DriverError | null;
  const message = failure?.meta?.driverAdapterError?.cause?.originalMessage;
  const constraint =
    typeof message === 'string' ? (/constraint "([^"]{1,128})"/.exec(message)?.[1] ?? null) : null;
  return {
    prismaCode: typeof failure?.code === 'string' ? failure.code.slice(0, 40) : null,
    sqlState: sqlState(error),
    model:
      typeof failure?.meta?.modelName === 'string' ? failure.meta.modelName.slice(0, 80) : null,
    constraint,
    errorName: error instanceof Error ? error.name.slice(0, 80) : null,
  };
}
export type FailureDetail = ReturnType<typeof failureDetail>;

/** Everything one staged row writes, kept together so a refused row can be set apart. */
type RowWrite = {
  row: StagedRowForCreation;
  link: Prisma.PharmacyStagedMedicineLinkCreateManyInput;
  medicine?: Prisma.MedicineCreateManyInput;
  presentation?: Prisma.PresentationCreateManyInput;
  /** Outermost first. */
  levels: Prisma.PackLevelCreateManyInput[];
  price?: Prisma.PharmacyPackPriceCreateManyInput;
  aliases: Prisma.MedicineAliasCreateManyInput[];
  barcode?: Prisma.MedicineBarcodeCreateManyInput & { id: string };
  provenance: Prisma.MedicineProvenanceCreateManyInput[];
  safetyStock?: Prisma.PharmacySafetyStockCreateManyInput;
  created?: { id: string; productName: string };
  matched?: EarlierMedicine;
};

/** Write these rows' records, set-based: one statement per table for the whole group. */
async function writeRows(tx: ScopedDb, organizationId: string, writes: readonly RowWrite[]) {
  const medicines = writes.flatMap((write) => (write.medicine ? [write.medicine] : []));
  if (medicines.length) {
    await tx.medicine.createMany({ data: medicines });
    await tx.presentation.createMany({
      data: writes.flatMap((write) => (write.presentation ? [write.presentation] : [])),
    });
    // Parents first: the hierarchy trigger reads a child's parent from an earlier statement.
    const outerLevels = writes.flatMap((write) => write.levels.slice(0, 1));
    const innerLevels = writes.flatMap((write) => write.levels.slice(1));
    if (outerLevels.length) await tx.packLevel.createMany({ data: outerLevels });
    if (innerLevels.length) await tx.packLevel.createMany({ data: innerLevels });
    const aliases = writes.flatMap((write) => write.aliases);
    if (aliases.length) await tx.medicineAlias.createMany({ data: aliases, skipDuplicates: true });
  }
  const barcodes = writes.flatMap((write) => (write.barcode ? [write.barcode] : []));
  if (barcodes.length) {
    // A barcode another person added since it was checked is skipped too, and reported. Two rows
    // of this group with one barcode: the first row (in file order) keeps it. A row refused
    // before this write never holds it, so the next row with it gets it (DEV-1004).
    await tx.medicineBarcode.createMany({ data: barcodes, skipDuplicates: true });
    const attached = new Set(
      (
        await tx.medicineBarcode.findMany({
          where: { id: { in: barcodes.map((barcode) => barcode.id) } },
          select: { id: true },
        })
      ).map((barcode) => barcode.id)
    );
    for (const write of writes)
      if (write.barcode) write.link.barcodeAttached = attached.has(write.barcode.id);
  }
  if (medicines.length)
    // The import asserts a barcode only for the rows that hold it.
    await tx.medicineProvenance.createMany({
      data: writes.flatMap((write) =>
        write.provenance.filter(
          (item) => item.field !== 'barcode' || write.link.barcodeAttached === true
        )
      ),
    });
  const safetyStocks = writes.flatMap((write) => (write.safetyStock ? [write.safetyStock] : []));
  if (safetyStocks.length) await tx.pharmacySafetyStock.createMany({ data: safetyStocks });
  await tx.pharmacyStagedMedicineLink.createMany({ data: writes.map((write) => write.link) });
  const prices = writes.flatMap((write) => (write.price ? [write.price] : []));
  if (prices.length) {
    // Pack prices are written under the organization's price lock, as every price write is.
    // Taken last, so the lock is held only while this chunk commits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('pharmacy-pack-prices'))`;
    await tx.pharmacyPackPrice.createMany({ data: prices });
  }
}

/**
 * DEV-1002: write the rows, and when the database refuses the group, undo it to a savepoint and
 * write each half again, until every refused row stands alone. A chunk with no bad row is still
 * one write; one bad row among 1,000 costs about twenty small writes. Anything other than a
 * refusal of the data (a timeout, a lost connection) undoes the whole step instead.
 */
async function writeIsolated(
  tx: ScopedDb,
  organizationId: string,
  writes: readonly RowWrite[],
  refused: { write: RowWrite; error: unknown }[],
  causes = new Map<string, number>()
): Promise<RowWrite[]> {
  if (!writes.length) return [];
  await tx.$executeRaw`SAVEPOINT staged_medicine_rows`;
  try {
    await writeRows(tx, organizationId, writes);
  } catch (error) {
    if (!isRowRefusal(error)) throw error;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT staged_medicine_rows`;
    await tx.$executeRaw`RELEASE SAVEPOINT staged_medicine_rows`;
    if (writes.length === 1) {
      const key = causeKey(error);
      const count = (causes.get(key) ?? 0) + 1;
      causes.set(key, count);
      // Stop early: the cause is not this row, and isolating every row would only take longer.
      if (count > STAGED_SYSTEMIC_REFUSALS) throw new StagedCreationSystemicRefusal(error, count);
      refused.push({ write: writes[0]!, error });
      return [];
    }
    const half = Math.ceil(writes.length / 2);
    return [
      ...(await writeIsolated(tx, organizationId, writes.slice(0, half), refused, causes)),
      ...(await writeIsolated(tx, organizationId, writes.slice(half), refused, causes)),
    ];
  }
  await tx.$executeRaw`RELEASE SAVEPOINT staged_medicine_rows`;
  return [...writes];
}

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
           r."mrpMinor", r."costMinor", r."barcode", r."rawPayload",
           (b."profilerVersion"='abuzar/2' AND s.kind='ABUZAR') AS "preparedAbuzar"
      FROM "pharmacy_migration_rows" r
      JOIN pharmacy_migration_batches b ON b."organizationId"=r."organizationId" AND b.id=r."batchId"
      JOIN pharmacy_migration_sources s ON s."organizationId"=b."organizationId" AND s.id=b."sourceId"
     WHERE r."organizationId" = ${organizationId}
       AND r."batchId" = ${request.batchId}
       AND ${candidate('r')}
       AND NOT ${linked(organizationId, 'r')}
     ORDER BY r."rowNumber", r."id"
     LIMIT ${limit}`;
  // Rows that create nothing: recorded on their link with a plain reason, never left to block
  // the file, and never retried (DEV-1002).
  const notCreated: { row: StagedRowForCreation; reason: string; detail: FailureDetail | null }[] =
    [];
  const planned = rows.flatMap((row) => {
    try {
      const plan = planStagedMedicine(row);
      if (plan) return [{ row, plan }];
      notCreated.push({ row, reason: NO_NAME_REASON, detail: null });
    } catch (error) {
      notCreated.push({ row, reason: notCreatedReason(error), detail: failureDetail(error) });
    }
    return [];
  });
  const nativeRows = planned.filter((item) => item.row.preparedAbuzar);
  const native = await abuzarMedicines(
    tx,
    organizationId,
    nativeRows.map(({ row, plan }) => ({
      sourceId: row.sourceKey.slice('abuzar-item:'.length),
      legacyCode: plan.legacyCode,
      uniqueLegacy: sourceCell(row.rawPayload, ['abuzaruniquelegacy']) === 'true',
    }))
  );
  const earlier = await earlierMedicines(
    tx,
    organizationId,
    request.batchId,
    planned.map((item) => item.plan)
  );
  const normalized = await catalogueNormalizer(
    tx,
    planned.flatMap(({ plan }) =>
      [plan.genericName, plan.legacyCode, plan.barcode].filter((value) => value !== null)
    )
  );
  // A barcode is unique in the organization: one already on another pack is skipped and
  // reported on the row's link, never moved. Within this chunk the first row written keeps it
  // (writeRows), so a row refused by the database never takes it from the next (DEV-1004).
  const wanted = [
    ...new Set(planned.flatMap(({ plan }) => (plan.barcode ? [normalized(plan.barcode)] : []))),
  ].filter(Boolean);
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
  const writes: RowWrite[] = [];
  for (const { row, plan } of planned) {
    // DEV-1004: a barcode longer than the catalogue holds is reported as read, never cut to a
    // shorter code that is not the one on the pack.
    const read = row.barcode?.trim() ?? null;
    const whole = plan.barcode !== null && read === plan.barcode;
    const barcodeAsRead =
      plan.barcode === null ? null : whole ? plan.barcode : cutText(read ?? '', 300);
    const link = {
      sourceKey: row.sourceKey,
      batchId: request.batchId,
      rowId: row.id,
      editId: request.editId,
      unitsPerPack: plan.unitsPerPack,
      mrpMinor: plan.mrpMinor,
      purchasePriceMinor: plan.purchasePriceMinor,
      legacyCode: plan.legacyCode,
      matchKey: row.preparedAbuzar ? row.sourceKey : stagedMatchKey(plan),
      supplierName: plan.supplierName,
      supplierId: supplierOf(plan.supplierName),
      reorderLevelPacks: plan.reorderLevelPacks,
      createdById: scope.actorId,
    };
    const existing = row.preparedAbuzar
      ? native.get(row.sourceKey.slice('abuzar-item:'.length))
      : earlier(plan);
    if (existing === null) {
      notCreated.push({
        row,
        reason: 'Ambiguous Abuzar product identity. Review the source codes.',
        detail: null,
      });
      continue;
    }
    if (existing) {
      // The medicine is already in the catalogue from an earlier file: link the row, add nothing.
      // Its barcode is reported as not added, because the existing medicine is not changed here.
      writes.push({
        row,
        link: {
          ...link,
          medicineId: existing.medicineId,
          packLevelId: existing.packLevelId,
          outcome: 'MATCHED',
          barcode: barcodeAsRead,
          barcodeAttached: plan.barcode ? false : null,
          // The existing medicine's thresholds are not changed here either.
          reorderLevelApplied: plan.reorderLevelPacks === null ? null : false,
        },
        levels: [],
        aliases: [],
        provenance: [],
        matched: existing,
      });
      continue;
    }
    const medicineId = randomUUID();
    const presentationId = randomUUID();
    const levels: Prisma.PackLevelCreateManyInput[] = [];
    let parentId: string | null = null;
    for (const level of plan.packLevels) {
      const id = randomUUID();
      levels.push({
        id,
        presentationId,
        parentPackLevelId: parentId,
        versionGroupId: randomUUID(),
        version: 1,
        level: level.level,
        unitsPerParent: level.unitsPerParent,
        effectiveFrom: now,
      });
      parentId = id;
    }
    const outerId = (levels[0]?.id as string | undefined) ?? null;
    const aliases: Prisma.MedicineAliasCreateManyInput[] = [];
    // A value the catalogue cannot search ("½", "①") is left off and reported on the link.
    const aliasesNotAdded: string[] = [];
    for (const [type, value] of [
      ['GENERIC', plan.genericName],
      ['LEGACY_CODE', plan.legacyCode],
    ] as const) {
      if (!value) continue;
      const normalizedValue = normalized(value);
      if (normalizedValue) aliases.push({ medicineId, type, value, normalizedValue });
      else aliasesNotAdded.push(value);
    }
    let barcode: RowWrite['barcode'];
    if (plan.barcode && whole) {
      const normalizedCode = normalized(plan.barcode);
      // DEV-1004: attached only when the database and the counter's scan read the code alike;
      // a code they read differently ("AB½12") could be stored but never scanned.
      if (
        normalizedCode &&
        normalizedCode === normalizeMedicineText(plan.barcode) &&
        !taken.has(normalizedCode)
      ) {
        barcode = {
          id: randomUUID(),
          presentationId,
          packLevelId: outerId,
          type: barcodeType(plan.barcode),
          code: plan.barcode,
          normalizedCode,
        };
      }
    }
    const evidence = {
      batchId: request.batchId,
      rowSourceKey: row.sourceKey,
      rowNumber: row.rowNumber,
    };
    const genericStored = aliases.some((alias) => alias.type === 'GENERIC');
    const asserted: [string, string | number | null][] = [
      ['productName', plan.productName],
      ['pack', plan.unitsPerPack === null ? null : plan.presentation],
      ['unitsPerPack', plan.unitsPerPack],
      ['mrpMinor', plan.mrpMinor],
      ['purchasePriceMinor', plan.purchasePriceMinor],
      ['alias', genericStored ? plan.genericName : null],
      ['legacyCode', plan.legacyCode],
      ['barcode', barcode ? plan.barcode : null],
    ];
    const provenance: Prisma.MedicineProvenanceCreateManyInput[] = [];
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
    writes.push({
      row,
      link: {
        ...link,
        medicineId,
        packLevelId: outerId,
        barcode: barcodeAsRead,
        barcodeAttached: plan.barcode ? Boolean(barcode) : null,
        reorderLevelApplied: plan.reorderLevelPacks === null ? null : reorderUnits !== null,
        aliasesNotAdded,
      },
      medicine: {
        id: medicineId,
        productName: plan.productName,
        productFamily: 'PHARMACEUTICAL',
        // The batch approval is the recorded review; missing strength and registration are
        // stored as not recorded for an imported identity (DEV-852), never a reason to hold sale.
        saleable: row.preparedAbuzar
          ? plan.mrpMinor !== null && sourceCell(row.rawPayload, ['active']) === '1'
          : true,
        ...(row.preparedAbuzar && plan.narcoticsClass ? { controlled: true } : {}),
      },
      presentation: { id: presentationId, medicineId, presentation: plan.presentation },
      levels,
      price:
        outerId && plan.mrpMinor !== null && !row.preparedAbuzar
          ? {
              organizationId,
              presentationId,
              packLevelId: outerId,
              mrpMinor: plan.mrpMinor,
              sellingPriceMinor: null,
              effectiveFrom: now,
              source: 'import',
              // DEV-928: the approver wrote the price; the editor who asked for the creation
              // proposed it.
              createdById: request.reviewerId,
              proposedById: request.editorId,
            }
          : undefined,
      aliases,
      barcode,
      provenance,
      safetyStock:
        reorderUnits === null
          ? undefined
          : {
              organizationId,
              branchId: reorderBranchId!,
              medicineId,
              safetyStockUnits: reorderUnits,
              approvedByUserId: request.reviewerId,
              approvedAt: now,
            },
      created: { id: medicineId, productName: plan.productName },
    });
  }
  const refused: { write: RowWrite; error: unknown }[] = [];
  const written = await writeIsolated(tx, organizationId, writes, refused);
  // Every row of a step refused for one and the same cause is a cause that would refuse any row:
  // undo, record nothing. Rows refused for different causes are each recorded (DEV-1004).
  if (
    writes.length > 1 &&
    refused.length === writes.length &&
    new Set(refused.map(({ error }) => causeKey(error))).size === 1
  )
    throw new StagedCreationSystemicRefusal(refused[0]!.error, refused.length);
  for (const { write, error } of refused)
    notCreated.push({
      row: write.row,
      reason: notCreatedReason(error),
      detail: failureDetail(error),
    });
  if (notCreated.length)
    await tx.pharmacyStagedMedicineLink.createMany({
      data: notCreated.map(({ row, reason }) => ({
        sourceKey: row.sourceKey,
        batchId: request.batchId,
        rowId: row.id,
        editId: request.editId,
        medicineId: null,
        outcome: 'NOT_CREATED',
        notCreatedReason: reason,
        createdById: scope.actorId,
      })),
    });
  const created = written.flatMap((write) => (write.created ? [write.created] : []));
  const ordinary = written.filter((write) => !write.row.preparedAbuzar);
  const ordinaryMatches = new Map(
    ordinary.flatMap((write) => (write.matched ? [[write.matched.medicineId, write.matched]] : []))
  );
  let controlled = (
    await applyLegacyControlledToMedicines(tx, organizationId, [
      ...ordinary.flatMap((write) =>
        write.created ? [{ ...write.created, controlled: false }] : []
      ),
      ...[...ordinaryMatches.values()].map((item) => ({
        id: item.medicineId,
        productName: item.productName,
        controlled: item.controlled,
      })),
    ])
  ).length;
  const nativeControlled = written.filter(
    (write) => write.row.preparedAbuzar && isLegacyControlledRow(write.row.rawPayload)
  );
  controlled += nativeControlled.filter((write) => write.created).length;
  const tighten = nativeControlled.flatMap((write) =>
    write.matched && !write.matched.controlled ? [write.matched.medicineId] : []
  );
  if (tighten.length)
    controlled += (
      await tx.medicine.updateMany({
        where: { organizationId, id: { in: tighten }, controlled: false },
        data: { controlled: true },
      })
    ).count;
  return {
    created: created.length,
    matched: written.filter((write) => write.matched).length,
    /** Rows of this step recorded as not created, each with its reason on its link. */
    refused: notCreated.length,
    /** Row numbers and database codes of those rows, for the server log and the audit record. */
    refusals: notCreated.map(({ row, detail }) => ({ rowNumber: row.rowNumber, ...detail })),
    controlled,
    medicineIds: created.map((medicine) => medicine.id),
    ...(await stagedCreationProgress(tx, organizationId, request.batchId)),
  };
}
