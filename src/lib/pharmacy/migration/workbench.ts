import 'server-only';

/**
 * PH-MIG / MIG-01, MIG-02 — the migration workbench's write and read paths.
 *
 * The ONLY module that persists profiling results. It takes an already-scoped
 * client, so tenant scope is the caller's `withTenantDb` and every statement
 * below is decided by row-level security rather than by a `where` clause anyone
 * could forget.
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

import type {
  ExceptionBucket,
  MigrationSourceKind,
  ProfileResult,
  SourceProfiler,
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
 * Register an incumbent export as read-only evidence.
 *
 * Registering the same bytes twice returns the existing source rather than
 * creating a second one: the file is the same file, and a duplicate would let
 * two batches claim different evidence for one handover.
 */
export async function recordSource(
  db: Pick<ScopedDb, 'pharmacyMigrationSource'>,
  input: { kind: MigrationSourceKind; fileName: string; bytes: Uint8Array | string }
): Promise<RecordedSource> {
  const contentHash = hashSourceBytes(input.bytes);
  const byteSize = BigInt(
    typeof input.bytes === 'string' ? Buffer.byteLength(input.bytes) : input.bytes.byteLength
  );

  const existing = await db.pharmacyMigrationSource.findFirst({ where: { contentHash } });
  if (existing) {
    return {
      id: existing.id,
      kind: existing.kind,
      fileName: existing.fileName,
      byteSize: existing.byteSize,
      contentHash: existing.contentHash,
    };
  }

  const created = await db.pharmacyMigrationSource.create({
    data: { kind: input.kind, fileName: input.fileName, byteSize, contentHash },
  });

  return {
    id: created.id,
    kind: created.kind,
    fileName: created.fileName,
    byteSize: created.byteSize,
    contentHash: created.contentHash,
  };
}

/**
 * Rows per `createMany` statement. A catalogue export holds about 19,000 rows
 * of 18 columns each; one statement for all of them would exceed PostgreSQL's
 * 65,535 bind parameter limit, so the inserts are split, in source order, inside
 * the caller's single transaction.
 */
export const PERSIST_ROW_CHUNK = 1_000;
export const PERSIST_EXCEPTION_CHUNK = 5_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
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
  db: Pick<
    ScopedDb,
    'pharmacyMigrationBatch' | 'pharmacyMigrationRow' | 'pharmacyMigrationException'
  >,
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
      sourceId: input.sourceId,
      label: input.label,
      profilerVersion: input.profiler.version,
      quantityUnit: input.result.quantityUnit,
      quantityColumn: input.result.quantityColumn,
      status: 'PROFILING',
    },
  });

  for (const part of chunks(rows, PERSIST_ROW_CHUNK)) {
    await db.pharmacyMigrationRow.createMany({
      data: part.map((row) => ({
        batchId: batch.id,
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
    where: { batchId: batch.id },
    select: { id: true, sourceKey: true },
  });
  const rowIdBySourceKey = new Map(persistedRows.map((row) => [row.sourceKey, row.id]));

  for (const part of chunks(exceptions, PERSIST_EXCEPTION_CHUNK)) {
    await db.pharmacyMigrationException.createMany({
      data: part.map((exception) => {
        const sourceKey = exception.rowIndex === null ? null : rows[exception.rowIndex]?.sourceKey;
        return {
          batchId: batch.id,
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

  await db.pharmacyMigrationBatch.update({
    where: { id: batch.id },
    data: {
      status: 'PROFILED',
      rowCount: rows.length,
      exceptionCount: exceptions.length,
      profiledAt: new Date(),
    },
  });

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
  input: { exceptionId: string; actorUserId: string; note?: string }
): Promise<void> {
  const updated = await db.pharmacyMigrationException.updateMany({
    where: { id: input.exceptionId, status: 'OPEN' },
    data: {
      status: 'SIGNED_OFF',
      signedOffByUserId: input.actorUserId,
      signedOffAt: new Date(),
      signOffNote: input.note ?? null,
    },
  });

  if (updated.count === 0) {
    throw new Error('No open migration exception with that identifier in this organization.');
  }
}

/** Open exception counts per bucket for one batch — the workbench queue. */
export async function openExceptionCounts(
  db: ScopedDb,
  batchId: string
): Promise<Partial<Record<ExceptionBucket, number>>> {
  const grouped = await db.pharmacyMigrationException.groupBy({
    by: ['bucket'],
    where: { batchId, status: 'OPEN' },
    _count: { _all: true },
  });

  const counts: Partial<Record<ExceptionBucket, number>> = {};
  for (const group of grouped) counts[group.bucket] = group._count._all;
  return counts;
}
