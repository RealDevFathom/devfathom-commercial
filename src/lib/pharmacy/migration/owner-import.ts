import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from '../stock-ledger';
import { expiryInstant, normalizeExpiryBoundary } from '../stock-ledger';
import { postOpeningStockEntry } from '../finance-postings';
import { lockStockRowsFrom } from '../stock-lock-order';
import { isEffective, type PackLevelNode } from '../pack-conversion';
import { draftLine, explainVariance, postOpeningSession } from './opening-stock';
import { IMPORT_FIELDS, type ImportField, type OwnerImportInput } from './owner-import-input';
import { OwnerImportError, parseOwnerUpload } from './owner-import-upload';
import { readExpiryDate, readMoneyMinor, readQuantity } from './source-values';

const INT_MAX = 2_147_483_647;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function openingImportIdentity(organizationId: string, branchId: string, bytes: Buffer) {
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  // Mapping changes and renames cannot turn the same handover into more stock.
  return { sourceHash, sessionId: `owner_${digest([organizationId, branchId, sourceHash])}` };
}

function exactInteger(value: bigint | null): number | null {
  return value === null || value < 0 || value > BigInt(INT_MAX) ? null : Number(value);
}

function conversion(levels: PackLevelNode[], packId: string, at: Date): number | null {
  const active = levels.filter((level) => isEffective(level, at));
  let cursor = active.find((level) => level.id === packId);
  const seen = new Set<string>();
  let units = 1;
  if (!cursor) return null;
  if (cursor.parentPackLevelId && !active.some((level) => level.id === cursor!.parentPackLevelId)) return null;
  while (cursor) {
    if (seen.has(cursor.id) || !Number.isInteger(cursor.unitsPerParent) || cursor.unitsPerParent <= 0) return null;
    seen.add(cursor.id);
    units *= cursor.unitsPerParent;
    if (!Number.isSafeInteger(units) || units > INT_MAX) return null;
    const children = active.filter((child) => child.parentPackLevelId === cursor!.id);
    if (children.length > 1) return null;
    cursor = children[0];
  }
  return units;
}

export async function previewOwnerImport(db: ScopedDb, scope: LedgerScope, input: OwnerImportInput, lockReferences = false) {
  const bytes = Buffer.from(input.content, 'base64');
  const identity = openingImportIdentity(scope.organizationId, scope.branchId, bytes);
  const table = await parseOwnerUpload(input.fileName, bytes);
  const indices = Object.values(input.mapping).filter((value): value is number => value !== undefined);
  if (new Set(indices).size !== indices.length || indices.some((value) => value >= table.headers.length) ||
      IMPORT_FIELDS.some(([field, , required]) => required && input.mapping[field] === undefined)) {
    throw new OwnerImportError('Map each required field to a different column.');
  }
  const branch = await db.pharmacyBranch.findFirst({ where: { organizationId: scope.organizationId, id: scope.branchId, active: true } });
  const location = await db.pharmacyStockLocation.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.stockLocationId, active: true },
  });
  if (!branch || !location) throw new OwnerImportError('Choose an active branch and one of its stock locations.');
  const prior = await db.pharmacyOpeningSession.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: identity.sessionId },
  });
  const existingMovements = await db.pharmacyStockMovement.count({ where: { organizationId: scope.organizationId, branchId: scope.branchId } });
  const operatingMovements = await db.pharmacyStockMovement.count({ where: { organizationId: scope.organizationId, branchId: scope.branchId, kind: { not: 'OPENING' } } });
  const blockers: string[] = [];
  if (prior) blockers.push('This file has already been committed for this branch.');
  else if (operatingMovements > 0) blockers.push('Opening imports must finish before sales, receiving, or other stock operations begin. Use inventory receiving or counts for an operating branch.');
  const now = new Date();
  const seenRefs = new Set<string>();
  const seenLots = new Set<string>();
  const batchExpiries = new Map<string, string>();
  const lines = [];
  let totalUnits = 0;
  let totalValueMinor = BigInt(0);
  for (const [index, row] of table.rows.entries()) {
    const cell = (field: ImportField) => {
      const position = input.mapping[field];
      return position === undefined ? '' : row[position]!.trim();
    };
    const errors: string[] = [];
    const warnings: string[] = [];
    const sourceRef = cell('sourceRef');
    const batchNumber = cell('batch');
    const packReference = cell('pack');
    const varianceNote = cell('varianceNote');
    if (!sourceRef || sourceRef.length > 160 || seenRefs.has(sourceRef)) errors.push('Source reference must be nonempty and unique (up to 160 characters).');
    seenRefs.add(sourceRef);
    if (!batchNumber || batchNumber.length > 160) errors.push('Supply the printed manufacturing batch (up to 160 characters).');
    const expiryText = cell('expiry');
    const expiryDate = /^\d{4}-\d{2}(-\d{2})?$/.test(expiryText) ? readExpiryDate(expiryText) : null;
    const expiryPrecision = expiryText.length === 7 ? 'MONTH' as const : 'DAY' as const;
    const expiresAt = expiryDate ? expiryInstant(expiryDate, expiryPrecision) : null;
    if (!expiryDate || !expiresAt || expiresAt <= now) errors.push('Supply a future expiry as YYYY-MM or YYYY-MM-DD.');
    const money = (field: 'mrp' | 'cost') => /^\d+(?:\.\d{1,2})?$/.test(cell(field)) ? exactInteger(readMoneyMinor(cell(field))) : null;
    const units = (field: 'expected' | 'counted') => /^\d+(?:\.0+)?$/.test(cell(field)) ? exactInteger(readQuantity(cell(field))) : null;
    const printedMrpMinor = money('mrp');
    const unitCostMinor = money('cost');
    const expectedUnits = units('expected');
    const countedUnits = units('counted');
    if (printedMrpMinor === null || unitCostMinor === null) errors.push('MRP and cost must be nonnegative PKR amounts with at most two decimals, within the supported range.');
    if (expectedUnits === null || countedUnits === null) errors.push('Exported and physical counts must be explicit nonnegative whole base units, within the supported range.');
    if (expectedUnits !== null && countedUnits !== null && expectedUnits !== countedUnits && !varianceNote) errors.push('Explain the difference between the exported and physical counts.');
    // A barcode without a specific pack is intentionally not enough to infer a conversion.
    const findPacks = () => db.packLevel.findMany({
      where: { organizationId: scope.organizationId, OR: [{ id: packReference }, { barcodes: { some: { organizationId: scope.organizationId, code: packReference } } }] },
      include: { presentation: { include: { medicine: true, packLevels: true } } },
      take: 2,
    });
    let packs = packReference ? await findPacks() : [];
    if (lockReferences && packs.length === 1) {
      const candidate = packs[0]!;
      // Freeze publication, cold-chain requirements and the whole conversion
      // hierarchy until its lot has been written. The presentation lock also
      // excludes new child packs while the multiplier is being resolved.
      await lockStockRowsFrom(db, scope.organizationId, Prisma.sql`SELECT ${candidate.presentation.medicineId}::text AS "medicineId"`, { medicine: 'share' });
      await db.$queryRaw`SELECT id FROM pharmacy_presentations WHERE "organizationId" = ${scope.organizationId} AND id = ${candidate.presentationId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM pharmacy_pack_levels WHERE "organizationId" = ${scope.organizationId} AND "presentationId" = ${candidate.presentationId} ORDER BY id FOR SHARE`;
      await db.$queryRaw`SELECT id FROM pharmacy_medicine_barcodes WHERE "organizationId" = ${scope.organizationId} AND code = ${packReference} FOR SHARE`;
      packs = await findPacks();
    }
    const pack = packs.length === 1 ? packs[0]! : null;
    const unitsPerPack = pack ? conversion(pack.presentation.packLevels, pack.id, now) : null;
    if (!pack || !pack.presentation.medicine.saleable || unitsPerPack === null) errors.push('Match exactly one published medicine pack with a valid current conversion, using its barcode or pack ID.');
    if (printedMrpMinor !== null && unitCostMinor !== null && unitCostMinor > 0 && unitsPerPack !== null &&
        BigInt(unitCostMinor) * BigInt(unitsPerPack) >= BigInt(printedMrpMinor)) {
      warnings.push('Cost per tablet/unit is greater than or equal to MRP per tablet/unit. Check that cost uses individual base units, not the selected pack.');
    }
    if (pack?.presentation.medicine.coldChain && !location.coldChain) errors.push('This medicine requires a cold-chain stock location.');
    const medicineId = pack?.presentation.medicineId ?? null;
    const lotKey = JSON.stringify([medicineId, batchNumber, pack?.id]);
    if (seenLots.has(lotKey)) errors.push('Duplicate medicine/batch/pack row. Combine its physical count in the source file.');
    seenLots.add(lotKey);
    const batchKey = JSON.stringify([medicineId, batchNumber]);
    const expiryKey = JSON.stringify([expiresAt, expiryPrecision]);
    if (batchExpiries.has(batchKey) && batchExpiries.get(batchKey) !== expiryKey) errors.push('Rows for the same medicine and batch must agree on expiry.');
    batchExpiries.set(batchKey, expiryKey);
    const findBatch = (matchedMedicineId: string) => db.pharmacyManufacturingBatch.findFirst({
      where: { organizationId: scope.organizationId, medicineId: matchedMedicineId, batchNumber },
    });
    let batch = medicineId && batchNumber ? await findBatch(medicineId) : null;
    if (lockReferences && batch && medicineId) {
      await lockStockRowsFrom(db, scope.organizationId, Prisma.sql`SELECT ${batch.id}::text AS "batchId"`, { batch: 'share' });
      batch = await findBatch(medicineId);
    }
    if (batch && (batch.state !== 'ACTIVE' || batch.expiryPrecision !== expiryPrecision ||
        !expiresAt || normalizeExpiryBoundary(batch.expiresAt).getTime() !== normalizeExpiryBoundary(expiresAt).getTime())) errors.push('Existing batch is blocked or its expiry conflicts with this row.');
    const existingLots = batch && pack ? await db.pharmacyInventoryLot.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, manufacturingBatchId: batch.id, packLevelId: pack.id },
      select: { balances: { select: { onHandUnits: true } } },
    }) : [];
    const currentUnits = existingLots.reduce((sum, lot) => sum + lot.balances.reduce((units, balance) => units + balance.onHandUnits, 0), 0);
    if (existingLots.length) errors.push('This branch already holds a lot for this medicine/batch/pack. Use inventory counts to reconcile it; it cannot be imported twice.');
    // Opening lots are keyed organization-wide by (OPENING, sourceRef, batch):
    // another branch or an earlier file may already own this reference.
    const referenceTaken = batch && sourceRef ? await db.pharmacyInventoryLot.findFirst({
      where: { organizationId: scope.organizationId, supplierName: 'OPENING', supplierInvoiceRef: sourceRef, manufacturingBatchId: batch.id },
      select: { id: true },
    }) : null;
    if (referenceTaken) errors.push('This source reference was already used for this batch in an earlier opening import (possibly another branch). Use a distinct source reference, e.g. prefix it with the branch code.');
    // Headline totals include only rows that pass row validation.
    if (errors.length === 0 && countedUnits !== null && unitCostMinor !== null) {
      totalUnits += countedUnits;
      totalValueMinor += BigInt(countedUnits) * BigInt(unitCostMinor);
    }
    lines.push({
      rowNumber: index + 2, sourceRef, packReference, medicineId,
      medicineName: pack?.presentation.medicine.productName ?? null,
      batchNumber, expiryDate, expiryPrecision, expiresAt,
      manufacturingBatchId: batch?.id ?? null, packLevelId: pack?.id ?? null, unitsPerPack,
      printedMrpMinor, unitCostMinor, expectedUnits, countedUnits, currentUnits,
      proposedUnits: countedUnits === null ? null : currentUnits + countedUnits, varianceNote,
      varianceUnits: countedUnits !== null && expectedUnits !== null ? countedUnits - expectedUnits : null,
      errors, warnings,
    });
  }
  if (totalUnits > INT_MAX || totalValueMinor > BigInt(INT_MAX)) blockers.push('The total exceeds the supported stock or journal amount range. Arrange the handover with staff assistance.');
  const canCommit = blockers.length === 0 && lines.every((line) => line.errors.length === 0);
  const previewHash = digest({ ...identity, stockLocationId: input.stockLocationId, mapping: input.mapping, lines, existingMovements, blockers });
  return { ...identity, previewHash, canCommit, blockers, lines, totalUnits, totalValueMinor: totalValueMinor.toString() };
}

/** Must run on the request's tenant transaction: stock, valuation and retry marker are one commit. */
export async function commitOwnerImport(
  db: ScopedDb, scope: LedgerScope, input: OwnerImportInput & { previewHash: string }
) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-owner-import:${scope.organizationId}`}, 0))`;
  const identity = openingImportIdentity(scope.organizationId, scope.branchId, Buffer.from(input.content, 'base64'));
  const existing = await db.pharmacyOpeningTotal.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, sessionId: identity.sessionId },
  });
  if (existing) return { sessionId: identity.sessionId, sourceHash: identity.sourceHash, totalUnits: existing.totalUnits, totalValueMinor: existing.totalValueMinor.toString(), replayed: true };
  // FK row locks serialize this initial opening against ordinary receiving as
  // well as other imports. Lock existing lots/locations too: an unreceived lot
  // can acquire its first movement without creating another branch reference.
  await db.$queryRaw`SELECT id FROM pharmacy_branches WHERE "organizationId" = ${scope.organizationId} AND id = ${scope.branchId} FOR UPDATE`;
  await db.$queryRaw`SELECT id FROM pharmacy_stock_locations WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} ORDER BY id FOR UPDATE`;
  // DEV-825: stock rows in the global order (stock-lock-order.ts). A lock-free
  // dry run names the batches and medicines the rows resolve to, so they are
  // locked before the lots; the locked preview below re-enters those locks.
  const draft = await previewOwnerImport(db, scope, input, false);
  const draftIds = (pick: (line: (typeof draft.lines)[number]) => string | null) =>
    [...new Set(draft.lines.map(pick).filter((id): id is string => Boolean(id)))];
  const draftBatchIds = draftIds((line) => line.manufacturingBatchId);
  const draftMedicineIds = draftIds((line) => line.medicineId);
  if (draftBatchIds.length) await lockStockRowsFrom(db, scope.organizationId, Prisma.sql`SELECT unnest(${draftBatchIds}::text[]) AS "batchId"`, { batch: 'share' });
  if (draftMedicineIds.length) await lockStockRowsFrom(db, scope.organizationId, Prisma.sql`SELECT unnest(${draftMedicineIds}::text[]) AS "medicineId"`, { medicine: 'share' });
  // FOR UPDATE, not NO KEY UPDATE: it must block a first movement into an existing lot.
  await lockStockRowsFrom(db, scope.organizationId, Prisma.sql`SELECT id AS "inventoryLotId" FROM pharmacy_inventory_lots WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}`, { lot: 'exclusive' });
  const preview = await previewOwnerImport(db, scope, input, true);
  if (!preview.canCommit) throw new OwnerImportError('Fix every blocking row and run the dry run again before committing.');
  if (preview.previewHash !== input.previewHash) throw new OwnerImportError('The source, mapping, or inventory changed. Run the dry run again and review the new diff.');
  const openingAt = new Date();
  // Retain the handover's immutable hash using the existing source-evidence
  // table. The original file is never rewritten or used as the physical count.
  const recordedSource = await db.pharmacyMigrationSource.findFirst({ where: { organizationId: scope.organizationId, contentHash: identity.sourceHash } });
  if (!recordedSource) await db.pharmacyMigrationSource.create({ data: {
    organizationId: scope.organizationId, kind: 'EXCEL_CSV', fileName: input.fileName,
    byteSize: BigInt(Buffer.from(input.content, 'base64').length), contentHash: identity.sourceHash,
  } });
  await db.pharmacyOpeningSession.create({ data: {
    id: preview.sessionId, organizationId: scope.organizationId, branchId: scope.branchId,
    openingAt, createdByActorId: scope.actorId,
  } });
  const batchIds = new Map<string, string>();
  for (const line of preview.lines) {
    // canCommit proved completeness. No missing value is replaced with a default.
    const batchKey = JSON.stringify([line.medicineId, line.batchNumber]);
    const knownBatchId = line.manufacturingBatchId ?? batchIds.get(batchKey);
    const batch = knownBatchId ? { id: knownBatchId } : await db.pharmacyManufacturingBatch.create({ data: {
      organizationId: scope.organizationId, medicineId: line.medicineId!, batchNumber: line.batchNumber,
      expiresAt: line.expiresAt!, expiryPrecision: line.expiryPrecision,
    } });
    batchIds.set(batchKey, batch.id);
    const drafted = await draftLine(db, scope, {
      sessionId: preview.sessionId, sourceRef: line.sourceRef, manufacturingBatchId: batch.id,
      batchNumber: line.batchNumber, expiryDate: line.expiryDate, expiryPrecision: line.expiryPrecision,
      printedMrpMinor: line.printedMrpMinor, unitCostMinor: line.unitCostMinor,
      stockLocationId: input.stockLocationId, packLevelId: line.packLevelId, unitsPerPack: line.unitsPerPack,
      expectedUnits: line.expectedUnits, countedUnits: line.countedUnits,
    });
    if (line.varianceNote) await explainVariance(db, scope, { lineId: drafted.line.id, note: line.varianceNote });
  }
  const { total } = await postOpeningSession(db, scope, {
    sessionId: preview.sessionId, idempotencyKeyPrefix: preview.sessionId,
  });
  if (total.totalValueMinor > BigInt(0)) await postOpeningStockEntry(db, scope, { sessionId: preview.sessionId, at: openingAt });
  return { sessionId: preview.sessionId, sourceHash: identity.sourceHash, totalUnits: total.totalUnits, totalValueMinor: total.totalValueMinor.toString(), replayed: false };
}
