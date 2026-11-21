import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { stagedReference, exceptionWorkflow } from './staged-review';

const id = z.string().trim().min(1).max(128);
export const reviewScopeInput = z.object({ branchId: id }).strict();
export const reviewBatchInput = reviewScopeInput.extend({ sourceId: id, batchId: id });
export const reviewListInput = reviewBatchInput
  .extend({
    query: z.string().trim().max(120).default(''),
    page: z.number().int().min(1).max(10000).default(1),
    filter: z
      .enum(['all', 'stock', 'price', 'collision', 'not-created', 'codes-not-added'])
      .default('all'),
  })
  .strict();
export const REVIEW_PAGE_SIZE = 25;

/** Staging is organization-wide: only workspace admins may review it, after branch validation. */
export async function assertReviewBranch(db: ScopedDb, organizationId: string, branchId: string) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Choose an active branch in this workspace.',
    });
}
async function sourceBatch(
  db: ScopedDb,
  organizationId: string,
  input: z.infer<typeof reviewBatchInput>
) {
  await assertReviewBranch(db, organizationId, input.branchId);
  const batch = await db.pharmacyMigrationBatch.findFirst({
    where: {
      organizationId,
      id: input.batchId,
      sourceId: input.sourceId,
      source: { organizationId },
    },
    select: {
      id: true,
      label: true,
      status: true,
      profilerVersion: true,
      quantityUnit: true,
      quantityColumn: true,
      source: { select: { id: true, contentHash: true, fileName: true } },
    },
  });
  if (!batch)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Source and batch not found in this workspace.',
    });
  return batch;
}
export async function listStagedMedicines(
  db: ScopedDb,
  organizationId: string,
  input: z.infer<typeof reviewListInput>
) {
  const batch = await sourceBatch(db, organizationId, input);
  const base = { organizationId, batchId: batch.id, targetModelKey: 'med.product' };
  const where: Prisma.PharmacyMigrationRowWhereInput = { ...base };
  if (input.query)
    where.OR = [
      { productName: { contains: input.query, mode: 'insensitive' } },
      { sourceKey: { contains: input.query, mode: 'insensitive' } },
      { rawPayload: { path: ['aliasname'], string_contains: input.query } },
      { rawPayload: { path: ['Name'], string_contains: input.query, mode: 'insensitive' } },
    ];
  if (input.filter === 'collision')
    where.AND = [
      {
        OR: [
          { exceptions: { some: { organizationId, bucket: 'DUPLICATE_PRODUCT' } } },
          {
            rawPayload: {
              path: ['__review_flags'],
              string_contains: 'NORMALIZED_NAME_COLLISION_NO_MERGE',
            },
          },
        ],
      },
    ];
  // DEV-1002: the rows a bulk creation could not turn into medicines, each with its reason.
  if (input.filter === 'not-created')
    where.sourceKey = {
      in: (
        await db.pharmacyStagedMedicineLink.findMany({
          where: { organizationId, batchId: batch.id, outcome: 'NOT_CREATED' },
          select: { sourceKey: true },
        })
      ).map((link) => link.sourceKey),
    };
  // DEV-1004: the created rows whose old code, generic name or barcode was not added, so the
  // person who imported the file can see each of them (the creation step names only counts).
  if (input.filter === 'codes-not-added')
    where.sourceKey = {
      in: (
        await db.pharmacyStagedMedicineLink.findMany({
          where: {
            organizationId,
            batchId: batch.id,
            OR: [{ aliasesNotAdded: { isEmpty: false } }, { barcodeAttached: false }],
          },
          select: { sourceKey: true },
        })
      ).map((link) => link.sourceKey),
    };
  if (input.filter === 'stock' || input.filter === 'price')
    where.exceptions = {
      some: {
        organizationId,
        status: 'OPEN',
        bucket: {
          in:
            input.filter === 'stock'
              ? ['MISSING_BATCH', 'MISSING_EXPIRY', 'EXPIRED_STOCK']
              : ['MISSING_MRP'],
        },
      },
    };
  const total = await db.pharmacyMigrationRow.count({ where });
  const rows = await db.pharmacyMigrationRow.findMany({
    where,
    orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
    skip: (input.page - 1) * REVIEW_PAGE_SIZE,
    take: REVIEW_PAGE_SIZE,
    include: {
      exceptions: {
        where: { organizationId },
        select: { bucket: true, status: true, severity: true },
      },
    },
  });
  const candidateCount = await db.pharmacyMigrationRow.count({ where: base });
  const notCreated = new Map(
    (
      await db.pharmacyStagedMedicineLink.findMany({
        where: {
          organizationId,
          outcome: 'NOT_CREATED',
          sourceKey: { in: rows.map((row) => row.sourceKey) },
        },
        select: { sourceKey: true, notCreatedReason: true },
      })
    ).map((link) => [link.sourceKey, link.notCreatedReason])
  );
  const groups = await db.pharmacyMigrationException.groupBy({
    by: ['bucket'],
    where: { organizationId, batchId: batch.id, status: 'OPEN' },
    _count: { _all: true },
  });
  return {
    batch,
    total,
    candidateCount,
    page: input.page,
    pageSize: REVIEW_PAGE_SIZE,
    exceptions: groups.map((g) => ({
      bucket: g.bucket,
      count: g._count._all,
      workflow: exceptionWorkflow(g.bucket),
    })),
    rows: rows.map((row) => ({
      ...stagedReference(row, batch.source, batch.id, batch.quantityUnit, batch.quantityColumn),
      notCreatedReason: notCreated.get(row.sourceKey) ?? null,
    })),
  };
}
export async function stagedMedicineDetail(
  db: ScopedDb,
  organizationId: string,
  input: z.infer<typeof reviewBatchInput> & { rowId: string }
) {
  const batch = await sourceBatch(db, organizationId, input);
  const row = await db.pharmacyMigrationRow.findFirst({
    where: { organizationId, batchId: batch.id, id: input.rowId, targetModelKey: 'med.product' },
    include: {
      exceptions: {
        where: { organizationId },
        select: { bucket: true, severity: true, status: true },
      },
    },
  });
  if (!row)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Candidate not found in this batch.' });
  // DEV-912: the catalogue medicine an approved bulk creation made from this source row.
  const created = await db.pharmacyStagedMedicineLink.findFirst({
    where: { organizationId, sourceKey: row.sourceKey },
    select: {
      medicineId: true,
      mrpMinor: true,
      purchasePriceMinor: true,
      unitsPerPack: true,
      outcome: true,
      notCreatedReason: true,
      aliasesNotAdded: true,
      barcode: true,
      barcodeAttached: true,
      supplierName: true,
      supplierId: true,
      reorderLevelPacks: true,
      reorderLevelApplied: true,
    },
  });
  return {
    ...stagedReference(row, batch.source, batch.id, batch.quantityUnit, batch.quantityColumn),
    catalogueMedicine: created,
  };
}
