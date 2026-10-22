import 'server-only';

/**
 * PH-MIG / MIG-01, MIG-02 — the migration workbench's write and read paths.
 *
 * The ONLY module that persists profiling results. Every exported function opens
 * its transaction through `enterImportBranch`: central `can()` for
 * `pharmacy:data-import`, the branch check, then the branch binding that the
 * forced organization-and-branch row-level security decides every statement by.
 * There is no exported write that skips that door; the raw inserts are private.
 *
 * MIG-01's "source never modified" holds trivially here: this module hashes the
 * source bytes and never retains, rewrites or re-encodes them. There is no
 * update path for `pharmacy_migration_sources` at all — the database refuses one
 * (SELECT/INSERT-only policies plus a trigger), and no function here attempts it.
 *
 * MIG-02's "missing batch/expiry/MRP is never silently defaulted" holds because
 * `persistProfile` writes exactly what `profileTable` produced: nullable columns
 * receive `null`, and the matching exception row is written in the SAME
 * transaction, so a batch can never exist with the gap but without the exception.
 */
import { createHash } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { abuzarProfiler } from './abuzar-profiler';
import { excelCsvProfiler } from './excel-csv-profiler';
import {
  enterImportBranch,
  inImportTransaction,
  PharmacyImportError,
  type ImportRequest,
  type ImportScope,
} from './import-authority';
import { ASYNC_IMPORT_THRESHOLD_BYTES, parseImportFile } from './import-core';
import {
  profileTable,
  type ExceptionBucket,
  type MigrationSourceKind,
  type ProfileResult,
  type SourceProfiler,
} from './profiler';

/** SHA-256 of the handed-over bytes, lowercase hex. The source's identity. */
export function hashSourceBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type RecordedSource = {
  id: string;
  kind: MigrationSourceKind;
  fileName: string;
  byteSize: bigint;
  contentHash: string;
};

/**
 * Register an incumbent export as read-only evidence of one branch.
 *
 * Registering the same bytes twice in a branch returns the existing source rather than
 * creating a second one: the file is the same file, and a duplicate would let two batches claim
 * different evidence for one handover. Authorizes itself (`pharmacy:data-import`, branch).
 */
export async function recordSource(
  db: ScopedDb,
  request: ImportRequest,
  input: { kind: MigrationSourceKind; fileName: string; bytes: Uint8Array | string }
): Promise<RecordedSource> {
  return inImportTransaction(db, async (tx) =>
    insertSource(tx, await enterImportBranch(tx, request), input)
  );
}

async function insertSource(
  tx: ScopedDb,
  scope: ImportScope,
  input: { kind: MigrationSourceKind; fileName: string; bytes: Uint8Array | string }
): Promise<RecordedSource> {
  const contentHash = hashSourceBytes(input.bytes);
  const byteSize = BigInt(
    typeof input.bytes === 'string' ? Buffer.byteLength(input.bytes) : input.bytes.byteLength
  );

  const existing = await tx.pharmacyMigrationSource.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, contentHash },
  });
  if (existing) {
    return {
      id: existing.id,
      kind: existing.kind,
      fileName: existing.fileName,
      byteSize: existing.byteSize,
      contentHash: existing.contentHash,
    };
  }

  const created = await tx.pharmacyMigrationSource.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: input.kind,
      fileName: input.fileName,
      byteSize,
      contentHash,
      createdByUserId: scope.actorId,
    },
  });

  return {
    id: created.id,
    kind: created.kind,
    fileName: created.fileName,
    byteSize: created.byteSize,
    contentHash: created.contentHash,
  };
}

export type PersistedProfile = {
  batchId: string;
  rowCount: number;
  exceptionCount: number;
  /** Count per bucket, for the workbench queue. Buckets with none are absent. */
  buckets: Partial<Record<ExceptionBucket, number>>;
};

/**
 * Persist one profiling pass as a new batch.
 *
 * A re-profile of the same source is a NEW batch. Rows are append-only, so the
 * earlier batch stays exactly as it was profiled and the two can be compared.
 */
export async function persistProfile(
  db: ScopedDb,
  request: ImportRequest,
  input: {
    sourceId: string;
    label: string;
    profiler: Pick<SourceProfiler, 'version'>;
    result: ProfileResult;
  }
): Promise<PersistedProfile> {
  return inImportTransaction(db, async (tx) =>
    insertProfile(tx, await enterImportBranch(tx, request), input)
  );
}

async function insertProfile(
  db: ScopedDb,
  scope: ImportScope,
  input: {
    sourceId: string;
    label: string;
    profiler: Pick<SourceProfiler, 'version'>;
    result: ProfileResult;
  }
): Promise<PersistedProfile> {
  const { rows, exceptions } = input.result;

  const batch = await db.pharmacyMigrationBatch.create({
    data: {
      organizationId: scope.organizationId,
      sourceId: input.sourceId,
      branchId: scope.branchId,
      label: input.label,
      profilerVersion: input.profiler.version,
      createdByUserId: scope.actorId,
      status: 'PARSING',
    },
  });

  if (rows.length > 0) {
    await db.pharmacyMigrationRow.createMany({
      data: rows.map((row) => ({
        organizationId: scope.organizationId,
        batchId: batch.id,
        branchId: scope.branchId,
        sourceKey: row.sourceKey,
        rowNumber: row.rowNumber,
        rawPayload: row.rawPayload,
        targetModelKey: row.targetModelKey,
        targetNaturalKey: row.targetNaturalKey,
        productName: row.productName,
        packLabel: row.packLabel,
        packFactor: row.packFactor,
        barcode: row.barcode,
        batchNumber: row.batchNumber,
        expiryDate: row.expiryDate,
        mrpMinor: row.mrpMinor,
        costMinor: row.costMinor,
        quantityCanonical: row.quantityCanonical,
        supplierName: row.supplierName,
        customerName: row.customerName,
        balanceMinor: row.balanceMinor,
      })),
    });
  }

  // `createMany` returns no identifiers, so read the batch's rows back to link
  // exceptions. `sourceKey` is unique within a batch, which is what makes this
  // a lookup rather than a positional guess.
  const persistedRows = await db.pharmacyMigrationRow.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, batchId: batch.id },
    select: { id: true, sourceKey: true },
  });
  const rowIdBySourceKey = new Map(persistedRows.map((row) => [row.sourceKey, row.id]));

  if (exceptions.length > 0) {
    await db.pharmacyMigrationException.createMany({
      data: exceptions.map((exception) => {
        const sourceKey = exception.rowIndex === null ? null : rows[exception.rowIndex]?.sourceKey;
        return {
          organizationId: scope.organizationId,
          batchId: batch.id,
          branchId: scope.branchId,
          rowId:
            sourceKey === null || sourceKey === undefined
              ? null
              : (rowIdBySourceKey.get(sourceKey) ?? null),
          bucket: exception.bucket,
          severity: exception.severity,
          detail: exception.detail,
        };
      }),
    });
  }

  const transitioned = await db.pharmacyMigrationBatch.updateMany({
    where: {
      id: batch.id,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'PARSING',
    },
    data: {
      status: 'PREVIEW',
      rowCount: rows.length,
      exceptionCount: exceptions.length,
      profiledAt: new Date(),
    },
  });
  if (transitioned.count !== 1) throw new Error('Import profile lost its batch lifecycle race');

  const buckets: Partial<Record<ExceptionBucket, number>> = {};
  for (const exception of exceptions) {
    buckets[exception.bucket] = (buckets[exception.bucket] ?? 0) + 1;
  }

  return {
    batchId: batch.id,
    rowCount: rows.length,
    exceptionCount: exceptions.length,
    buckets,
  };
}

/**
 * Sign one exception off.
 *
 * Sign-off is a decision, not a repair: it records who accepted the gap and
 * when. It never writes a value into the profiled row, because the row is
 * evidence of what the incumbent supplied. The database enforces that sign-off
 * is one-way and that the exception's identity cannot change with it.
 */
export async function signOffException(
  db: ScopedDb,
  request: ImportRequest,
  input: { exceptionId: string; note?: string }
): Promise<void> {
  await inImportTransaction(db, async (tx) => {
    const scope = await enterImportBranch(tx, request);
    const updated = await tx.pharmacyMigrationException.updateMany({
      where: {
        id: input.exceptionId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'OPEN',
      },
      data: {
        status: 'SIGNED_OFF',
        signedOffByUserId: scope.actorId,
        signedOffAt: new Date(),
        signOffNote: input.note ?? null,
      },
    });
    if (updated.count === 0) throw new PharmacyImportError('EXCEPTION_NOT_FOUND');
  });
}

/** Open exception counts per bucket for one batch — the workbench queue. */
export async function openExceptionCounts(
  db: ScopedDb,
  request: ImportRequest,
  batchId: string
): Promise<Partial<Record<ExceptionBucket, number>>> {
  return inImportTransaction(db, async (tx) => {
    const scope = await enterImportBranch(tx, request);
    const grouped = await tx.pharmacyMigrationException.groupBy({
      by: ['bucket'],
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        batchId,
        status: 'OPEN',
      },
      _count: { _all: true },
    });
    const counts: Partial<Record<ExceptionBucket, number>> = {};
    for (const group of grouped) counts[group.bucket] = group._count._all;
    return counts;
  });
}

const PROFILERS: Readonly<Record<MigrationSourceKind, SourceProfiler>> = {
  ABUZAR: abuzarProfiler,
  EXCEL_CSV: excelCsvProfiler,
};

/**
 * The synchronous upload entry point: parse untrusted bytes (limits, no formulas, no macros),
 * profile them, then record the source and its preview batch in ONE authorized transaction.
 * Files at or above the async threshold belong to the background scheduler.
 */
export async function importSourceFile(
  db: ScopedDb,
  request: ImportRequest,
  input: { kind: MigrationSourceKind; fileName: string; bytes: Uint8Array; label: string }
): Promise<PersistedProfile & { sourceId: string; contentHash: string }> {
  if (input.bytes.byteLength >= ASYNC_IMPORT_THRESHOLD_BYTES)
    throw new PharmacyImportError('ASYNC_REQUIRED');
  const profiler = PROFILERS[input.kind];
  const result = profileTable(profiler, await parseImportFile(input.fileName, input.bytes));
  return inImportTransaction(db, async (tx) => {
    const scope = await enterImportBranch(tx, request);
    const source = await insertSource(tx, scope, input);
    const persisted = await insertProfile(tx, scope, {
      sourceId: source.id,
      label: input.label,
      profiler,
      result,
    });
    return { ...persisted, sourceId: source.id, contentHash: source.contentHash };
  });
}
