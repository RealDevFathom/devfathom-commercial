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

import {
  importPharmacyExportCatalogue,
  parsePharmacyExportCatalogue,
  PharmacyCatalogueImportError,
} from '../data-export-catalogue';
import { devfathomCatalogueProfiler } from './devfathom-catalogue-profiler';
import {
  profileTable,
  type ExceptionBucket,
  type MigrationSourceKind,
  type ProfileResult,
  type SourceProfiler,
} from './profiler';
import { parseDelimitedText } from './source-values';

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
  db: ScopedDb,
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
      status: 'PROFILING',
    },
  });

  if (rows.length > 0) {
    await db.pharmacyMigrationRow.createMany({
      data: rows.map((row) => ({
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

  if (exceptions.length > 0) {
    await db.pharmacyMigrationException.createMany({
      data: exceptions.map((exception) => {
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

export type CatalogueSourceImport = {
  sourceId: string;
  batchId: string;
  exceptionCount: number;
  rows: number;
  medicines: number;
  presentations: number;
  packs: number;
};

/**
 * #716 — re-import a DevFathom owner-export `medicines.csv` through the wizard.
 *
 * One transaction: the file is registered as read-only source evidence, profiled
 * by the catalogue-only adapter and persisted as a batch (one migration row per
 * CSV row, keeping each exported row code as its source key), and then loaded as
 * new, non-saleable catalogue drafts. A file the adapter does not recognise, or
 * one that raises any BLOCKING exception, writes nothing at all.
 *
 * Stock is never created here: batch, expiry and MRP arrive with
 * `stock-lots.csv`, which goes through the ordinary Excel/CSV profiler and its
 * MIG-02 exception review.
 */
export async function importCatalogueSource(
  db: ScopedDb,
  input: {
    organizationId: string;
    fileName: string;
    csv: string;
    now?: Date;
    /** Only the local database-operator command uses this; never supplied by HTTP input. */
    source?: 'local-file';
  }
): Promise<CatalogueSourceImport> {
  const now = input.now ?? new Date();
  const options = input.source ? { source: input.source } : {};
  // Validate size, headers and identities before any evidence is written.
  parsePharmacyExportCatalogue(input.csv, options);
  const profile = profileTable(devfathomCatalogueProfiler, parseDelimitedText(input.csv));
  if (profile.exceptions.some((exception) => exception.severity === 'BLOCKING')) {
    throw new PharmacyCatalogueImportError();
  }
  return db.$transaction(async (tx) => {
    const source = await recordSource(tx, {
      kind: devfathomCatalogueProfiler.kind,
      fileName: input.fileName,
      bytes: input.csv,
    });
    const persisted = await persistProfile(tx, {
      sourceId: source.id,
      label: `DevFathom catalogue import: ${input.fileName}`,
      profiler: devfathomCatalogueProfiler,
      result: profile,
    });
    const imported = await importPharmacyExportCatalogue(
      tx,
      input.organizationId,
      input.csv,
      now,
      options
    );
    return {
      sourceId: source.id,
      batchId: persisted.batchId,
      exceptionCount: persisted.exceptionCount,
      ...imported,
    };
  });
}
