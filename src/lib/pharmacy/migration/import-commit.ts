import 'server-only';

/**
 * Import 1/5 — commit and rollback, with concrete live-model adapters.
 *
 * Two adapters exist, and the manifest's CHECK admits exactly these:
 *   - SUPPLIER: creates a `pharmacy_suppliers` row (manifest CREATED). A supplier that already
 *     exists by name is matched, never re-created and never manifested, so a rollback can never
 *     delete it.
 *   - OPENING_STOCK: creates an inventory lot and posts one OPENING ledger movement into it
 *     (manifest STOCK_MOVEMENT, with the movement id and its signed quantity). The lot is ledger
 *     history like any received lot: a rollback compensates the movement and leaves the lot.
 *
 * IDEMPOTENCY. Each live write is preceded, in the same transaction, by an INSERT of its manifest
 * row carrying `applicationKey` = SHA-256 over a JSON array of (organization, branch, source
 * content hash, source row key, entity type, operation). JSON encoding makes the key injective
 * for arbitrary source keys; no generated id is part of it. The key is unique among a branch's
 * unreleased manifest rows, so a retried or concurrent commit of the same source content waits
 * on the unique index and then skips the row (ON CONFLICT DO NOTHING) instead of writing it
 * twice. A rolled-back row is released, so the same file can be imported again afterwards.
 *
 * LOCK ORDER (commit): the batch row; then one transaction advisory lock per supplier name the
 * request may create, in name order (two imports naming the same new supplier serialize, and the
 * second matches the first's supplier instead of failing on the name's unique key); then one
 * unique-index entry per manifest row, in source row order; then the new live rows.
 * (rollback): the batch row; then every manifest row of the batch ordered by id; then the created
 * suppliers ordered by id; then the original movements ordered by id; then their stock balances
 * ordered by (lot, location, disposition). References and quantities are rechecked after the
 * locks, then the exact opposite postings are written, linked, and the batch transitions, all in
 * the same transaction. A second worker waits on the batch row and then finds it already rolled
 * back.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { arrangementFor } from '../inventory';
import {
  enterImportBranch,
  inImportTransaction,
  PharmacyImportError,
  type ImportRequest,
  type ImportScope,
} from './import-authority';

const SUPPLIER = 'PharmacySupplier';
const MOVEMENT = 'PharmacyStockMovement';
const MAX_INT4 = 2_147_483_647;
const OPENING_LOCATION_KINDS = new Set(['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE']);

/** The persisted retry barrier. Collision-safe for any source key; no generated id inside. */
export function importApplicationKey(input: {
  organizationId: string;
  branchId: string;
  contentHash: string;
  rowSourceKey: string;
  entityType: string;
  operation: 'CREATED' | 'STOCK_MOVEMENT';
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pharmacy-import/v1',
        input.organizationId,
        input.branchId,
        input.contentHash,
        input.rowSourceKey,
        input.entityType,
        input.operation,
      ])
    )
    .digest('hex');
}

function reversalApplicationKey(scope: ImportScope, originalEntryId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pharmacy-import-reversal/v1',
        scope.organizationId,
        scope.branchId,
        originalEntryId,
      ])
    )
    .digest('hex');
}

export type ImportCommitInstruction =
  | { rowId: string; kind: 'SUPPLIER'; name: string }
  | {
      rowId: string;
      kind: 'OPENING_STOCK';
      manufacturingBatchId: string;
      packLevelId: string;
      stockLocationId: string;
      unitsPerPack: number;
      quantityUnits: number;
      unitCostMinor: number;
      printedMrpMinor: number;
    };

export type ImportCommitResult = {
  batchId: string;
  created: number;
  posted: number;
  matched: number;
  alreadyApplied: number;
  committedAt: Date;
};

export type ImportRollbackResult = {
  batchId: string;
  reversed: number;
  deleted: number;
  rolledBackAt: Date;
};

type LockedBatch = { id: string; status: string; legacy: boolean; contentHash: string };

/** Lock order step 1: the batch row, in this branch. */
async function lockBatch(tx: ScopedDb, scope: ImportScope, batchId: string): Promise<LockedBatch> {
  const [batch] = await tx.$queryRaw<LockedBatch[]>(Prisma.sql`
    SELECT b.id, b.status::text AS status, b.legacy, s."contentHash"
      FROM pharmacy_migration_batches b
      JOIN pharmacy_migration_sources s
        ON s."organizationId" = b."organizationId" AND s."branchId" = b."branchId" AND s.id = b."sourceId"
     WHERE b."organizationId" = ${scope.organizationId}
       AND b."branchId" = ${scope.branchId}
       AND b.id = ${batchId}
       FOR UPDATE OF b`);
  if (!batch) throw new PharmacyImportError('BATCH_NOT_FOUND');
  if (batch.legacy) throw new PharmacyImportError('BATCH_LEGACY');
  return batch;
}

async function moveBatch(
  tx: ScopedDb,
  scope: ImportScope,
  batchId: string,
  from: 'PREVIEW' | 'COMMITTING' | 'COMMITTED',
  to: 'COMMITTING' | 'COMMITTED' | 'ROLLED_BACK',
  data: { committedAt?: Date; rolledBackAt?: Date } = {}
): Promise<void> {
  const moved = await tx.pharmacyMigrationBatch.updateMany({
    where: {
      id: batchId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: from,
    },
    data: { status: to, ...data },
  });
  if (moved.count !== 1) throw new PharmacyImportError('MANIFEST_INCONSISTENT');
}

/** Claim one application key. False when a live manifest row already holds it. */
async function claimManifestEntry(
  tx: ScopedDb,
  scope: ImportScope,
  entry: {
    id: string;
    batchId: string;
    rowSourceKey: string;
    applicationKey: string;
    entityType: string;
    entityId: string;
    operation: 'CREATED' | 'STOCK_MOVEMENT';
    stockMovementId: string | null;
    quantityUnits: number | null;
  }
): Promise<boolean> {
  const claimed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO pharmacy_migration_batch_entities
      ("id", "organizationId", "branchId", "batchId", "rowSourceKey", "applicationKey",
       "entityType", "entityId", "operation", "stockMovementId", "quantityUnits")
    VALUES (${entry.id}, ${scope.organizationId}, ${scope.branchId}, ${entry.batchId},
       ${entry.rowSourceKey}, ${entry.applicationKey}, ${entry.entityType}, ${entry.entityId},
       ${entry.operation}::"PharmacyMigrationEntityOperation", ${entry.stockMovementId},
       ${entry.quantityUnits})
    ON CONFLICT ("organizationId", "branchId", "applicationKey") WHERE "releasedAt" IS NULL
    DO NOTHING
    RETURNING id`);
  return claimed.length === 1;
}

/** Prisma's unique (P2002) or foreign key (P2003) violation, without importing runtime classes. */
function prismaCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function positiveInt(value: number, max = MAX_INT4): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function nonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_INT4;
}

/**
 * Commit a previewed batch. Authorizes itself (central can() + branch), refuses while a
 * blocking exception is open, and applies each instruction at most once per live source row.
 */
export async function commitImportBatch(
  db: ScopedDb,
  request: ImportRequest,
  input: { batchId: string; instructions: readonly ImportCommitInstruction[] }
): Promise<ImportCommitResult> {
  return inImportTransaction(db, async (tx) => {
    const scope = await enterImportBranch(tx, request);
    const batch = await lockBatch(tx, scope, input.batchId);
    if (batch.status !== 'PREVIEW') throw new PharmacyImportError('BATCH_NOT_PREVIEW');

    const blocking = await tx.pharmacyMigrationException.count({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        batchId: batch.id,
        status: 'OPEN',
        severity: 'BLOCKING',
      },
    });
    if (blocking > 0) throw new PharmacyImportError('BLOCKING_EXCEPTIONS');

    const seen = new Set<string>();
    for (const instruction of input.instructions) {
      const identity = `${instruction.rowId}\u0000${instruction.kind}`;
      if (seen.has(identity)) throw new PharmacyImportError('DUPLICATE_INSTRUCTION');
      seen.add(identity);
    }
    const rowIds = [...new Set(input.instructions.map((instruction) => instruction.rowId))];
    const rows = await tx.pharmacyMigrationRow.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        batchId: batch.id,
        id: { in: rowIds },
      },
      select: { id: true, sourceKey: true, rowNumber: true },
    });
    if (rows.length !== rowIds.length) throw new PharmacyImportError('ROW_NOT_IN_BATCH');
    const rowById = new Map(rows.map((row) => [row.id, row]));

    // Lock order step 2: the supplier names this request may create, in one global order.
    const supplierNames = [
      ...new Set(
        input.instructions.flatMap((instruction) =>
          instruction.kind === 'SUPPLIER' ? [instruction.name.trim()] : []
        )
      ),
    ].sort();
    for (const name of supplierNames)
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['pharmacy-supplier', scope.organizationId, name])}, 0))`
      );

    await moveBatch(tx, scope, batch.id, 'PREVIEW', 'COMMITTING');
    const ordered = [...input.instructions].sort(
      (a, b) =>
        rowById.get(a.rowId)!.rowNumber - rowById.get(b.rowId)!.rowNumber ||
        a.kind.localeCompare(b.kind)
    );
    const result = { created: 0, posted: 0, matched: 0, alreadyApplied: 0 };
    const now = new Date();
    for (const instruction of ordered) {
      const row = rowById.get(instruction.rowId)!;
      if (instruction.kind === 'SUPPLIER') {
        const name = instruction.name.trim();
        if (name.length === 0 || name.length > 200)
          throw new PharmacyImportError('INVALID_INSTRUCTION');
        const existing = await tx.pharmacySupplier.findFirst({
          where: { organizationId: scope.organizationId, name },
          select: { id: true },
        });
        if (existing) {
          result.matched += 1;
          continue;
        }
        const supplierId = randomUUID();
        const claimed = await claimManifestEntry(tx, scope, {
          id: randomUUID(),
          batchId: batch.id,
          rowSourceKey: row.sourceKey,
          applicationKey: importApplicationKey({
            ...scope,
            contentHash: batch.contentHash,
            rowSourceKey: row.sourceKey,
            entityType: SUPPLIER,
            operation: 'CREATED',
          }),
          entityType: SUPPLIER,
          entityId: supplierId,
          operation: 'CREATED',
          stockMovementId: null,
          quantityUnits: null,
        });
        if (!claimed) {
          result.alreadyApplied += 1;
          continue;
        }
        try {
          await tx.pharmacySupplier.create({
            data: { id: supplierId, organizationId: scope.organizationId, name },
          });
        } catch (error) {
          // Created outside the import between the check and the insert; the retry matches it.
          if (prismaCode(error) === 'P2002') throw new PharmacyImportError('SUPPLIER_CONFLICT');
          throw error;
        }
        result.created += 1;
        continue;
      }

      if (
        !positiveInt(instruction.quantityUnits) ||
        !positiveInt(instruction.unitsPerPack) ||
        !nonNegativeInt(instruction.unitCostMinor) ||
        !nonNegativeInt(instruction.printedMrpMinor)
      )
        throw new PharmacyImportError('INVALID_INSTRUCTION');
      const manufacturingBatch = await tx.pharmacyManufacturingBatch.findFirst({
        where: { id: instruction.manufacturingBatchId, organizationId: scope.organizationId },
        select: {
          medicineId: true,
          state: true,
          expiresAt: true,
          expiryPrecision: true,
          medicine: { select: { coldChain: true, controlled: true } },
        },
      });
      const pack = await tx.packLevel.findFirst({
        where: { id: instruction.packLevelId, organizationId: scope.organizationId },
        select: { presentation: { select: { medicineId: true } } },
      });
      const location = await tx.pharmacyStockLocation.findFirst({
        where: {
          id: instruction.stockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
        },
        select: { kind: true, coldChain: true },
      });
      if (
        !manufacturingBatch ||
        !pack ||
        !location ||
        pack.presentation.medicineId !== manufacturingBatch.medicineId ||
        !OPENING_LOCATION_KINDS.has(location.kind)
      )
        throw new PharmacyImportError('REFERENCE_OUT_OF_SCOPE');
      if (manufacturingBatch.medicine.controlled)
        throw new PharmacyImportError('CONTROLLED_NOT_IMPORTABLE');
      if (manufacturingBatch.state !== 'ACTIVE') throw new PharmacyImportError('BATCH_NOT_ACTIVE');
      if (manufacturingBatch.medicine.coldChain && !location.coldChain)
        throw new PharmacyImportError('COLD_CHAIN_REQUIRED');

      const entryId = randomUUID();
      const movementId = randomUUID();
      const claimed = await claimManifestEntry(tx, scope, {
        id: entryId,
        batchId: batch.id,
        rowSourceKey: row.sourceKey,
        applicationKey: importApplicationKey({
          ...scope,
          contentHash: batch.contentHash,
          rowSourceKey: row.sourceKey,
          entityType: MOVEMENT,
          operation: 'STOCK_MOVEMENT',
        }),
        entityType: MOVEMENT,
        entityId: movementId,
        operation: 'STOCK_MOVEMENT',
        stockMovementId: movementId,
        quantityUnits: instruction.quantityUnits,
      });
      if (!claimed) {
        result.alreadyApplied += 1;
        continue;
      }
      const lot = await tx.pharmacyInventoryLot.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          manufacturingBatchId: instruction.manufacturingBatchId,
          packLevelId: instruction.packLevelId,
          unitsPerPack: instruction.unitsPerPack,
          supplierName: 'IMPORT',
          supplierInvoiceRef: `import:${entryId}`,
          unitCostMinor: instruction.unitCostMinor,
          printedMrpMinor: instruction.printedMrpMinor,
          receivedExpiresAt: manufacturingBatch.expiresAt,
          receivedExpiryPrecision: manufacturingBatch.expiryPrecision,
          receivedAt: now,
        },
        select: { id: true },
      });
      const arrangement = arrangementFor(instruction.quantityUnits, instruction.unitsPerPack);
      await tx.pharmacyStockMovement.create({
        data: {
          id: movementId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: lot.id,
          stockLocationId: instruction.stockLocationId,
          kind: 'OPENING',
          disposition: 'AVAILABLE',
          quantityUnits: instruction.quantityUnits,
          sealedPackDelta: arrangement.sealedPacks,
          looseUnitDelta: arrangement.looseUnits,
          actorId: scope.actorId,
          reason: `Import batch ${batch.id}, source row ${row.rowNumber}`,
          idempotencyKey: `import:${entryId}`,
          occurredAt: now,
        },
      });
      result.posted += 1;
    }

    const committedAt = new Date();
    await moveBatch(tx, scope, batch.id, 'COMMITTING', 'COMMITTED', { committedAt });
    return { batchId: batch.id, ...result, committedAt };
  });
}

type ManifestRow = {
  id: string;
  rowSourceKey: string;
  entityType: string;
  entityId: string;
  operation: 'CREATED' | 'STOCK_MOVEMENT' | 'STOCK_REVERSAL';
  stockMovementId: string | null;
  quantityUnits: number | null;
  reversedById: string | null;
  releasedAt: Date | null;
};
type OriginalMovement = {
  id: string;
  branchId: string;
  inventoryLotId: string;
  stockLocationId: string;
  disposition: string;
  kind: string;
  quantityUnits: number;
  sealedPackDelta: number;
  looseUnitDelta: number;
  idempotencyKey: string;
  reversesMovementId: string | null;
};
type Balance = {
  inventoryLotId: string;
  stockLocationId: string;
  disposition: string;
  onHandUnits: number;
  sealedPacks: number;
  looseUnits: number;
};

/**
 * Roll a committed batch back, all or nothing. Authorizes itself. Deletes only suppliers the
 * manifest says this batch created and nothing has used since; compensates every OPENING posting
 * with its exact opposite. Any blocker refuses the whole rollback with one reason per entry.
 */
export async function rollbackImportBatch(
  db: ScopedDb,
  request: ImportRequest,
  input: { batchId: string; reason: string }
): Promise<ImportRollbackResult> {
  return inImportTransaction(db, async (tx) => {
    const scope = await enterImportBranch(tx, request);
    const reason = input.reason.trim();
    if (reason.length < 10) throw new PharmacyImportError('INVALID_INSTRUCTION');

    // 1. The batch.
    const batch = await lockBatch(tx, scope, input.batchId);
    if (batch.status === 'ROLLED_BACK') throw new PharmacyImportError('BATCH_ROLLED_BACK');
    if (batch.status !== 'COMMITTED') throw new PharmacyImportError('BATCH_NOT_COMMITTED');

    // 2. The complete manifest.
    const entries = await tx.$queryRaw<ManifestRow[]>(Prisma.sql`
      SELECT id, "rowSourceKey", "entityType", "entityId", operation::text AS operation,
             "stockMovementId", "quantityUnits", "reversedById", "releasedAt"
        FROM pharmacy_migration_batch_entities
       WHERE "organizationId" = ${scope.organizationId}
         AND "branchId" = ${scope.branchId}
         AND "batchId" = ${batch.id}
       ORDER BY id
         FOR UPDATE`);
    if (
      entries.some(
        (entry) =>
          entry.operation === 'STOCK_REVERSAL' ||
          entry.releasedAt !== null ||
          entry.reversedById !== null
      )
    )
      throw new PharmacyImportError('MANIFEST_INCONSISTENT');
    const created = entries.filter((entry) => entry.operation === 'CREATED');
    const posted = entries.filter((entry) => entry.operation === 'STOCK_MOVEMENT');

    // 3. The targets, each class in id order.
    const supplierIds = created.map((entry) => entry.entityId).sort();
    const suppliers = supplierIds.length
      ? await tx.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
          SELECT id, name FROM pharmacy_suppliers
           WHERE "organizationId" = ${scope.organizationId} AND id IN (${Prisma.join(supplierIds)})
           ORDER BY id
             FOR UPDATE`)
      : [];
    const movementIds = posted.map((entry) => entry.stockMovementId!).sort();
    const originals = movementIds.length
      ? await tx.$queryRaw<OriginalMovement[]>(Prisma.sql`
          SELECT id, "branchId", "inventoryLotId", "stockLocationId", disposition::text AS disposition,
                 kind::text AS kind, "quantityUnits", "sealedPackDelta", "looseUnitDelta",
                 "idempotencyKey", "reversesMovementId"
            FROM pharmacy_stock_movements
           WHERE "organizationId" = ${scope.organizationId} AND id IN (${Prisma.join(movementIds)})
           ORDER BY id
             FOR UPDATE`)
      : [];
    const originalById = new Map(originals.map((movement) => [movement.id, movement]));
    const balanceKeys = [
      ...new Map(
        originals.map((movement) => [
          `${movement.inventoryLotId}|${movement.stockLocationId}|${movement.disposition}`,
          movement,
        ])
      ).values(),
    ].sort(
      (a, b) =>
        a.inventoryLotId.localeCompare(b.inventoryLotId) ||
        a.stockLocationId.localeCompare(b.stockLocationId) ||
        a.disposition.localeCompare(b.disposition)
    );
    const balances = balanceKeys.length
      ? await tx.$queryRaw<Balance[]>(Prisma.sql`
          SELECT "inventoryLotId", "stockLocationId", disposition::text AS disposition,
                 "onHandUnits", "sealedPacks", "looseUnits"
            FROM pharmacy_stock_balances
           WHERE "organizationId" = ${scope.organizationId}
             AND ("inventoryLotId", "stockLocationId", disposition::text) IN (${Prisma.join(
               balanceKeys.map(
                 (key) =>
                   Prisma.sql`(${key.inventoryLotId}, ${key.stockLocationId}, ${key.disposition})`
               )
             )})
           ORDER BY "inventoryLotId", "stockLocationId", disposition
             FOR UPDATE`)
      : [];
    const balanceByKey = new Map(
      balances.map((balance) => [
        `${balance.inventoryLotId}|${balance.stockLocationId}|${balance.disposition}`,
        balance,
      ])
    );

    // 4. Recheck, after the locks, everything the rollback relies on.
    const blocked: string[] = [];
    if (suppliers.length !== created.length) throw new PharmacyImportError('MANIFEST_INCONSISTENT');
    const usage = supplierIds.length
      ? await tx.pharmacySupplier.findMany({
          where: { organizationId: scope.organizationId, id: { in: supplierIds } },
          select: {
            id: true,
            name: true,
            _count: {
              select: {
                licences: true,
                quotes: true,
                purchaseOrders: true,
                goodsReceipts: true,
                purchaseReturns: true,
                debitNotes: true,
                credits: true,
                relationships: true,
              },
            },
          },
        })
      : [];
    for (const supplier of usage) {
      if (Object.values(supplier._count).some((count) => count > 0))
        blocked.push(`Supplier "${supplier.name}" has been used since the import.`);
    }
    const reversedAlready = movementIds.length
      ? await tx.pharmacyStockMovement.count({
          where: { organizationId: scope.organizationId, reversesMovementId: { in: movementIds } },
        })
      : 0;
    if (reversedAlready > 0) throw new PharmacyImportError('MANIFEST_INCONSISTENT');
    const needed = new Map<string, { units: number; packs: number; loose: number }>();
    for (const entry of posted) {
      const original = originalById.get(entry.stockMovementId!);
      if (
        !original ||
        original.branchId !== scope.branchId ||
        original.kind !== 'OPENING' ||
        original.reversesMovementId !== null ||
        original.quantityUnits !== entry.quantityUnits
      )
        throw new PharmacyImportError('MANIFEST_INCONSISTENT');
      const key = `${original.inventoryLotId}|${original.stockLocationId}|${original.disposition}`;
      const total = needed.get(key) ?? { units: 0, packs: 0, loose: 0 };
      needed.set(key, {
        units: total.units + original.quantityUnits,
        packs: total.packs + original.sealedPackDelta,
        loose: total.loose + original.looseUnitDelta,
      });
    }
    for (const entry of posted) {
      const original = originalById.get(entry.stockMovementId!)!;
      const key = `${original.inventoryLotId}|${original.stockLocationId}|${original.disposition}`;
      const balance = balanceByKey.get(key);
      const need = needed.get(key)!;
      if (
        !balance ||
        balance.onHandUnits < need.units ||
        balance.sealedPacks < need.packs ||
        balance.looseUnits < need.loose
      )
        blocked.push(
          `Opening stock from source row ${entry.rowSourceKey} has been used since the import.`
        );
    }
    if (blocked.length > 0) throw new PharmacyImportError('ROLLBACK_BLOCKED', blocked);

    // 5. Exact opposite postings, linked both ways; then the created suppliers.
    const at = new Date();
    for (const entry of posted) {
      const original = originalById.get(entry.stockMovementId!)!;
      const reversalEntryId = randomUUID();
      const reversalMovementId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO pharmacy_migration_batch_entities
          ("id", "organizationId", "branchId", "batchId", "rowSourceKey", "applicationKey",
           "entityType", "entityId", "operation", "stockMovementId", "quantityUnits", "reversesEntryId")
        VALUES (${reversalEntryId}, ${scope.organizationId}, ${scope.branchId}, ${batch.id},
           ${entry.rowSourceKey}, ${reversalApplicationKey(scope, entry.id)}, ${MOVEMENT},
           ${reversalMovementId}, 'STOCK_REVERSAL', ${reversalMovementId},
           ${-original.quantityUnits}, ${entry.id})`);
      await tx.pharmacyStockMovement.create({
        data: {
          id: reversalMovementId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: original.inventoryLotId,
          stockLocationId: original.stockLocationId,
          kind: 'ADJUSTMENT',
          disposition:
            original.disposition as Prisma.PharmacyStockMovementUncheckedCreateInput['disposition'],
          quantityUnits: -original.quantityUnits,
          sealedPackDelta: -original.sealedPackDelta,
          looseUnitDelta: -original.looseUnitDelta,
          actorId: scope.actorId,
          reason: `Import rollback ${batch.id}: ${reason}`,
          idempotencyKey: `${original.idempotencyKey}:reversal`,
          reversesMovementId: original.id,
          occurredAt: at,
        },
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE pharmacy_migration_batch_entities
           SET "reversedById" = ${reversalEntryId}, "releasedAt" = ${at}
         WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
           AND "batchId" = ${batch.id} AND id = ${entry.id}`);
    }
    for (const entry of created) {
      try {
        await tx.pharmacySupplier.delete({
          where: {
            organizationId_id: { organizationId: scope.organizationId, id: entry.entityId },
          },
        });
      } catch (error) {
        // A reference the usage counts above do not know about still blocks, all or nothing.
        if (prismaCode(error) === 'P2003')
          throw new PharmacyImportError('ROLLBACK_BLOCKED', [
            `A supplier created by source row ${entry.rowSourceKey} is referenced elsewhere.`,
          ]);
        throw error;
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE pharmacy_migration_batch_entities SET "releasedAt" = ${at}
         WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
           AND "batchId" = ${batch.id} AND id = ${entry.id}`);
    }

    // 6. The transition, in the same transaction.
    const rolledBackAt = new Date();
    await moveBatch(tx, scope, batch.id, 'COMMITTED', 'ROLLED_BACK', { rolledBackAt });
    return { batchId: batch.id, reversed: posted.length, deleted: created.length, rolledBackAt };
  });
}
